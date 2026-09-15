// Test suite for route (a) end to end: connection, vault, matching, marking.
// Every run builds its own throwaway local (no-server) budget in a temp dir — no server,
// no fixtures checked into the repo (tests.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as api from '@actual-app/api';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { PNG } from 'pngjs';

import {
  resolveVaultRoot,
  sanitizeFilename,
  vaultPathFor,
  sha256File,
  readVaultIndex,
  parseFilenameConvention,
  extractPdfTotalAndDate,
  parseAmountFlag,
  cmdAdd,
  cmdPair,
  cmdVerify,
  cmdShow,
  cmdRelink,
  cmdList,
  HELP_TEXT,
  parseArgs,
} from './receipt2actual.mjs';

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Six deliberately-overlapping transactions, same shape as the Phase L probes' fixture set.
async function setupBudget() {
  const dataDir = tmpDir('r2a-test-data-');
  await api.init({ dataDir });

  const budgetName = 'r2a-test-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  await api.runImport(budgetName, async () => {});
  const budgets = await api.getBudgets();
  const target = budgets.find((b) => b.name === budgetName) ?? budgets[budgets.length - 1];
  await api.loadBudget(target.id);

  const acct = await api.createAccount({ name: 'Checking', type: 'checking', offbudget: false }, 0);

  const specs = [
    { date: '2026-09-01', amount: -4523, payee_name: 'Costco' },
    { date: '2026-09-03', amount: -4523, payee_name: 'Costco Dup' }, // same cents, 2 days later
    { date: '2026-09-10', amount: -1200, payee_name: 'Coffee' },
    { date: '2026-09-25', amount: -9900, payee_name: 'Amazon Far' }, // outside a 09-20 +/-3d window
  ];
  for (const s of specs) {
    await api.addTransactions(acct, [{ date: s.date, amount: s.amount, payee_name: s.payee_name }]);
  }
  const txns = await api.getTransactions(acct, '2026-01-01', '2026-12-31');

  return { dataDir, acct, txns };
}

async function teardown() {
  await api.shutdown();
}

// GOTCHA, confirmed live: api.deleteTransaction(id)'s promise resolves before aqlQuery's
// backing store reflects the deletion — an unfiltered aqlQuery('transactions') right after
// still returns the row with tombstone:false, while api.getTransactions() (a different code
// path) already shows it gone. Not documented anywhere read beforehand; found by running it.
// Only a same-process race in a test that queries immediately after deleting — a real user's
// verify run happens in a separate invocation, well after the deletion has settled — but the
// test must wait for it rather than assume synchronous consistency.
async function waitForTransactionGone(txnId, timeoutMs = 2000) {
  const { q } = api;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await api.aqlQuery(q('transactions').filter({ id: txnId }).select('*'));
    if (result.data.length === 0) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`transaction ${txnId} still visible to aqlQuery after ${timeoutMs}ms`);
}

function txnByAmountDate(txns, amount, date) {
  const t = txns.find((t) => t.amount === amount && t.date === date);
  assert.ok(t, `fixture missing amount=${amount} date=${date}`);
  return t;
}

function writeReceiptFile(dir, name, content = 'receipt bytes') {
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  return file;
}

// ------------------------------------------------------------------ PDF fixture builders
// Built fresh per test run with pdf-lib/pngjs — no binaries checked into the repo.

async function buildTextLayerPdf(dir, { date = '2026-09-08', total = '32.17' } = {}) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 400]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText('ACME HARDWARE', { x: 50, y: 360, size: 14, font });
  page.drawText(`Date: ${date}`, { x: 50, y: 300, size: 12, font });
  page.drawText('Item: Hammer', { x: 50, y: 270, size: 10, font });
  page.drawText(`Total: $${total}`, { x: 50, y: 220, size: 12, font });
  const file = path.join(dir, 'text-layer-receipt.pdf');
  fs.writeFileSync(file, await doc.save());
  return file;
}

async function buildTwoAmountsPdf(dir) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 400]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText('AMBIGUOUS RECEIPT', { x: 50, y: 360, size: 14, font });
  page.drawText('Date: 2026-09-08', { x: 50, y: 320, size: 12, font });
  page.drawText('Subtotal Total: $12.00', { x: 50, y: 280, size: 12, font });
  page.drawText('Total: $32.17', { x: 50, y: 250, size: 12, font });
  const file = path.join(dir, 'two-amounts-receipt.pdf');
  fs.writeFileSync(file, await doc.save());
  return file;
}

async function buildImageOnlyPdf(dir) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 400]);
  const png = new PNG({ width: 200, height: 300 });
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const idx = (png.width * y + x) << 2;
      const shade = Math.floor(200 - (y / png.height) * 100);
      png.data[idx] = shade;
      png.data[idx + 1] = shade;
      png.data[idx + 2] = shade;
      png.data[idx + 3] = 255;
    }
  }
  const pngImage = await doc.embedPng(PNG.sync.write(png));
  page.drawImage(pngImage, { x: 50, y: 50, width: 200, height: 300 });
  const file = path.join(dir, 'image-only-scan.pdf');
  fs.writeFileSync(file, await doc.save());
  return file;
}

// Builds a plain PDF then AES-256-encrypts it with qpdf (confirmed present in Phase L,
// findings.md). Returns null (test skips) rather than failing hard if qpdf isn't on this
// machine, since it's a system dependency of the fixture builder, not of the shipped tool.
function qpdfAvailable() {
  try {
    execFileSync('qpdf', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function buildEncryptedPdf(dir) {
  if (!qpdfAvailable()) return null;
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 400]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText('CONFIDENTIAL RECEIPT', { x: 50, y: 360, size: 14, font });
  page.drawText('Date: 2026-09-09', { x: 50, y: 300, size: 12, font });
  page.drawText('Total: $99.00', { x: 50, y: 270, size: 12, font });
  const sourceFile = path.join(dir, 'to-encrypt-source.pdf');
  fs.writeFileSync(sourceFile, await doc.save());
  const encryptedFile = path.join(dir, 'encrypted-receipt.pdf');
  execFileSync('qpdf', [
    '--encrypt', 'throwaway-user-pw', 'throwaway-owner-pw', '256',
    '--', sourceFile, encryptedFile,
  ]);
  return encryptedFile;
}

// ------------------------------------------------------------------ unit-level

test('sanitizeFilename strips whitespace, illegal chars, and lowercases the extension', () => {
  assert.equal(sanitizeFilename('my receipt.PDF'), 'my-receipt.pdf');
  assert.equal(sanitizeFilename('a:b/c\\d|e?f*g.jpg'), 'a-b-c-d-e-f-g.jpg');
  assert.equal(sanitizeFilename('a&b^c%d!e$f`g;h(i)j\'k.pdf'), 'a-b-c-d-e-f-g-h-i-j-k.pdf', 'shell and cmd metacharacters');
  assert.equal(sanitizeFilename('Bäckerei_Übersicht.PDF'), 'Bäckerei_Übersicht.pdf', 'letters of any script survive');
});

test('sanitizeFilename handles a Windows-style embedded path in the original filename', () => {
  // On a POSIX box, backslashes in a filename are just characters, not separators —
  // this simulates a file whose original name carries Windows path junk (vault.md: strip
  // Windows-illegal characters on every platform, not just when running on Windows).
  const result = sanitizeFilename('45.23_2026-09-01_sub\\dir\\my receipt.PDF');
  assert.equal(result, '45.23_2026-09-01_sub-dir-my-receipt.pdf');
  assert.doesNotMatch(result, /[\\\s]/);
});

test('sanitizeFilename truncates a long basename but keeps the extension', () => {
  const long = 'x'.repeat(200) + '.pdf';
  const result = sanitizeFilename(long);
  assert.equal(result.length, 104);
  assert.ok(result.endsWith('.pdf'));
});

test('resolveVaultRoot refuses a path with whitespace', () => {
  assert.throws(
    () => resolveVaultRoot({ vaultFlag: '/tmp/my vault', env: {} }),
    /whitespace/,
  );
});

test('resolveVaultRoot: flag wins over env, env wins over default', () => {
  // resolveVaultRoot resolves through path.resolve, which is OS-native (a leading '/' input
  // resolves onto the current drive on Windows, not literally 'C:\tmp\...') — compare against
  // the same resolution the function itself does, not a hardcoded POSIX string.
  assert.equal(
    resolveVaultRoot({ vaultFlag: '/tmp/flag-vault', env: { RECEIPT_VAULT: '/tmp/env-vault' } }),
    path.resolve('/tmp/flag-vault'),
  );
  assert.equal(
    resolveVaultRoot({ vaultFlag: null, env: { RECEIPT_VAULT: '/tmp/env-vault' } }),
    path.resolve('/tmp/env-vault'),
  );
});

test('parseFilenameConvention: decimal amount, no sign, forced to a negative (debit)', () => {
  const parsed = parseFilenameConvention('45.23_2026-09-01_costco.pdf');
  assert.deepEqual(parsed, { amountCents: -4523, date: '2026-09-01' });
});

test('parseFilenameConvention: invalid calendar date falls through (returns null)', () => {
  assert.equal(parseFilenameConvention('45.23_2026-02-30_costco.pdf'), null);
});

test('parseFilenameConvention: no filename-convention match returns null', () => {
  assert.equal(parseFilenameConvention('IMG_20260901.pdf'), null);
});

// ------------------------------------------------------------------ cmdAdd, against a live throwaway budget

test('happy path: single candidate auto-pairs, vault file + note + index all written', async () => {
  const { txns } = await setupBudget();
  const workDir = tmpDir('r2a-test-work-');
  const vaultRoot = tmpDir('r2a-test-vault-');
  try {
    const txn = txnByAmountDate(txns, -1200, '2026-09-10');
    const file = writeReceiptFile(workDir, '12.00_2026-09-10_coffee.pdf');

    const result = await cmdAdd(file, { vault: vaultRoot, dryRun: false });
    assert.equal(result.status, 'paired');
    assert.equal(result.txnId, txn.id);
    assert.ok(fs.existsSync(result.vaultPath), 'vault copy should exist on disk');
    assert.equal(fs.readFileSync(result.vaultPath, 'utf8'), 'receipt bytes');

    const note = await api.getNote(txn.id);
    assert.equal(note.note, result.vaultPath);

    const { entries } = readVaultIndex(vaultRoot);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].txn_id, txn.id);
    assert.equal(entries[0].file_sha256, sha256File(file));
    assert.equal(entries[0].route, 'filename');
  } finally {
    await teardown();
  }
});

test('double-ingest: re-running the same file on the same transaction is a no-op', async () => {
  const { txns } = await setupBudget();
  const workDir = tmpDir('r2a-test-work-');
  const vaultRoot = tmpDir('r2a-test-vault-');
  try {
    const file = writeReceiptFile(workDir, '12.00_2026-09-10_coffee.pdf');

    const first = await cmdAdd(file, { vault: vaultRoot, dryRun: false });
    assert.equal(first.status, 'paired');

    const second = await cmdAdd(file, { vault: vaultRoot, dryRun: false });
    assert.equal(second.status, 'noop');
    assert.equal(second.vaultPath, first.vaultPath);

    const { entries } = readVaultIndex(vaultRoot);
    assert.equal(entries.length, 1, 'no duplicate index line on re-run');
  } finally {
    await teardown();
  }
});

test('a transaction with its own note keeps it: the marker is appended after one space, and a re-run is a noop', async () => {
  const { txns } = await setupBudget();
  const workDir = tmpDir('r2a-test-work-');
  const vaultRoot = tmpDir('r2a-test-vault-');
  try {
    const txn = txnByAmountDate(txns, -1200, '2026-09-10');
    await api.updateNote(txn.id, 'a human wrote this note already ');
    const file = writeReceiptFile(workDir, '12.00_2026-09-10_coffee.pdf');

    const result = await cmdAdd(file, { vault: vaultRoot, dryRun: false });
    assert.equal(result.status, 'paired');

    const note = await api.getNote(txn.id);
    assert.equal(note.note, `a human wrote this note already ${result.vaultPath}`);

    const again = await cmdAdd(file, { vault: vaultRoot, dryRun: false });
    assert.equal(again.status, 'noop');
    const noteAgain = await api.getNote(txn.id);
    assert.equal(noteAgain.note, note.note, 'second run must not append a second marker');

    const verify = await cmdVerify({ vault: vaultRoot });
    assert.equal(verify.exit_code, 0, 'verify must accept a marker that follows other text');

    const shown = await cmdShow(txn.id, { dryRun: true });
    assert.equal(shown.status, 'would-open');
    assert.equal(shown.vaultPath, result.vaultPath, 'show must find the marker inside a longer note');
  } finally {
    await teardown();
  }
});

test('two candidates at the same cents within the window is ambiguous, not auto-picked', async () => {
  const { txns } = await setupBudget();
  const workDir = tmpDir('r2a-test-work-');
  const vaultRoot = tmpDir('r2a-test-vault-');
  try {
    // -4523 exists on both 2026-09-01 and 2026-09-03 — two days apart, inside +/-3d.
    const file = writeReceiptFile(workDir, '45.23_2026-09-01_costco.pdf');
    const result = await cmdAdd(file, { vault: vaultRoot, dryRun: false });
    assert.equal(result.status, 'ambiguous');
    assert.equal(result.candidates.length, 2);

    const { entries } = readVaultIndex(vaultRoot);
    assert.equal(entries.length, 0);
  } finally {
    await teardown();
  }
});

test('no candidate transactions found', async () => {
  await setupBudget();
  const workDir = tmpDir('r2a-test-work-');
  const vaultRoot = tmpDir('r2a-test-vault-');
  try {
    const file = writeReceiptFile(workDir, '99.99_2026-01-01_nothing.pdf');
    const result = await cmdAdd(file, { vault: vaultRoot, dryRun: false });
    assert.equal(result.status, 'no-candidates');

    const { entries } = readVaultIndex(vaultRoot);
    assert.equal(entries.length, 0);
  } finally {
    await teardown();
  }
});

test('--dry-run writes nothing to disk, the vault index, or the budget', async () => {
  const { txns } = await setupBudget();
  const workDir = tmpDir('r2a-test-work-');
  const vaultRoot = tmpDir('r2a-test-vault-');
  try {
    const txn = txnByAmountDate(txns, -1200, '2026-09-10');
    const file = writeReceiptFile(workDir, '12.00_2026-09-10_coffee.pdf');

    const result = await cmdAdd(file, { vault: vaultRoot, dryRun: true });
    assert.equal(result.status, 'dry-run');
    assert.equal(result.txnId, txn.id);

    assert.ok(!fs.existsSync(result.vaultPath), 'dry-run must not copy the file');
    assert.ok(!fs.existsSync(path.join(vaultRoot, 'vault.jsonl')), 'dry-run must not touch the index');

    const note = await api.getNote(txn.id);
    assert.ok(!note?.note, 'dry-run must not write the note');
  } finally {
    await teardown();
  }
});

test('Windows-style path input: a filename carrying embedded backslashes sanitizes cleanly end to end', async (t) => {
  if (os.platform() === 'win32') {
    // The scenario this simulates — backslashes as literal filename characters, the way they'd
    // arrive in a name carried over from a Windows-authored path on a POSIX box — only makes
    // sense where backslash isn't itself a path separator. On Windows, writeReceiptFile's own
    // path.join would treat "sub\dir\..." as real subdirectories that don't exist, which tests
    // path.join, not sanitizeFilename. The plain string-level unit test above already covers
    // sanitizeFilename's backslash-stripping cross-platform.
    t.skip('backslash is a real path separator on Windows; covered by the string-level unit test above');
    return;
  }
  const { txns } = await setupBudget();
  const workDir = tmpDir('r2a-test-work-');
  const vaultRoot = tmpDir('r2a-test-vault-');
  try {
    const txn = txnByAmountDate(txns, -1200, '2026-09-10');
    const file = writeReceiptFile(workDir, '12.00_2026-09-10_sub\\dir\\my receipt.PDF');

    const result = await cmdAdd(file, { vault: vaultRoot, dryRun: false });
    assert.equal(result.status, 'paired');
    assert.equal(result.txnId, txn.id);
    assert.doesNotMatch(result.vaultPath, /[\\\s]/, 'vault path must carry no backslash or space');
    assert.ok(result.vaultPath.endsWith('sub-dir-my-receipt.pdf'));
    assert.ok(fs.existsSync(result.vaultPath));
  } finally {
    await teardown();
  }
});

test('vaultPathFor lays files out under <root>/YYYY/MM/<8-char-txn-id>__<name>', () => {
  const txn = { id: 'abcdef12-3456-7890-abcd-ef1234567890', date: '2026-09-03' };
  const p = vaultPathFor('/vault', txn, 'costco.pdf');
  // vaultPathFor joins with node:path, which is OS-native (backslashes on Windows) — build the
  // expectation the same way rather than hardcoding POSIX separators.
  assert.equal(p, path.join('/vault', '2026', '09', 'abcdef12__costco.pdf'));
});

test('parseAmountFlag: decimal, bare integer, and explicit sign', () => {
  assert.equal(parseAmountFlag('45.23'), -4523);
  assert.equal(parseAmountFlag('4523'), -4523);
  assert.equal(parseAmountFlag('-45.23'), -4523);
  assert.equal(parseAmountFlag('not a number'), null);
});

// ------------------------------------------------------------------ route (b): text-layer PDF

test('extractPdfTotalAndDate: real text-layer PDF extracts total and date correctly', async () => {
  const dir = tmpDir('r2a-test-pdf-');
  try {
    const file = await buildTextLayerPdf(dir, { date: '2026-09-08', total: '32.17' });
    const result = await extractPdfTotalAndDate(file);
    assert.deepEqual(result, { amountCents: -3217, date: '2026-09-08' });
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test('extractPdfTotalAndDate: image-only PDF refuses with NO_TEXT_LAYER, never guesses', async () => {
  const dir = tmpDir('r2a-test-pdf-');
  try {
    const file = await buildImageOnlyPdf(dir);
    await assert.rejects(() => extractPdfTotalAndDate(file), (e) => {
      assert.equal(e.pdfRefusal, 'NO_TEXT_LAYER');
      return true;
    });
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test('extractPdfTotalAndDate: password-protected PDF refuses with PASSWORD_PROTECTED', async (t) => {
  const dir = tmpDir('r2a-test-pdf-');
  try {
    const file = await buildEncryptedPdf(dir);
    if (!file) {
      t.skip('qpdf not available on this machine to build an encrypted fixture');
      return;
    }
    await assert.rejects(() => extractPdfTotalAndDate(file), (e) => {
      assert.equal(e.pdfRefusal, 'PASSWORD_PROTECTED');
      return true;
    });
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test('extractPdfTotalAndDate: two amounts in the text refuses AMBIGUOUS_EXTRACTION, never picks one', async () => {
  const dir = tmpDir('r2a-test-pdf-');
  try {
    const file = await buildTwoAmountsPdf(dir);
    await assert.rejects(() => extractPdfTotalAndDate(file), (e) => {
      assert.equal(e.pdfRefusal, 'AMBIGUOUS_EXTRACTION');
      return true;
    });
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test('cmdAdd: route (b) auto-pairs a text-layer PDF that does not match the filename convention', async () => {
  const { acct } = await setupBudget();
  const dir = tmpDir('r2a-test-pdf-');
  const vaultRoot = tmpDir('r2a-test-vault-');
  try {
    await api.addTransactions(acct, [{ date: '2026-09-08', amount: -3217, payee_name: 'Acme' }]);
    const txns = await api.getTransactions(acct, '2026-01-01', '2026-12-31');
    const txn = txnByAmountDate(txns, -3217, '2026-09-08');

    const file = await buildTextLayerPdf(dir, { date: '2026-09-08', total: '32.17' });
    const renamed = path.join(dir, 'IMG_scan_from_phone.pdf'); // not the filename convention
    fs.renameSync(file, renamed);

    const result = await cmdAdd(renamed, { vault: vaultRoot, dryRun: false });
    assert.equal(result.status, 'paired');
    assert.equal(result.txnId, txn.id);

    const { entries } = readVaultIndex(vaultRoot);
    assert.equal(entries[0].route, 'pdf-text');
  } finally {
    await teardown();
  }
});

test('cmdAdd: route (b) refusal (no text layer) exits non-zero and writes nothing, never falls to pair automatically', async () => {
  await setupBudget();
  const dir = tmpDir('r2a-test-pdf-');
  const vaultRoot = tmpDir('r2a-test-vault-');
  try {
    const file = await buildImageOnlyPdf(dir);
    const result = await cmdAdd(file, { vault: vaultRoot, dryRun: false });
    assert.equal(result.status, 'pdf-refused');
    assert.equal(result.code, 'NO_TEXT_LAYER');
    assert.ok(!fs.existsSync(path.join(vaultRoot, 'vault.jsonl')));
  } finally {
    await teardown();
  }
});

// ------------------------------------------------------------------ route (c): interactive pair

test('cmdPair: --txn pairs directly to a known transaction, no search, no candidate list', async () => {
  const { txns } = await setupBudget();
  const workDir = tmpDir('r2a-test-work-');
  const vaultRoot = tmpDir('r2a-test-vault-');
  try {
    const txn = txnByAmountDate(txns, -1200, '2026-09-10');
    const file = writeReceiptFile(workDir, 'anything.pdf');

    const result = await cmdPair(file, { vault: vaultRoot, dryRun: false, txn: txn.id, amount: null, date: null, pick: null });
    assert.equal(result.status, 'paired');
    assert.equal(result.txnId, txn.id);

    const { entries } = readVaultIndex(vaultRoot);
    assert.equal(entries[0].route, 'interactive');
  } finally {
    await teardown();
  }
});

test('cmdPair: --txn on a nonexistent transaction id refuses cleanly', async () => {
  await setupBudget();
  const workDir = tmpDir('r2a-test-work-');
  const vaultRoot = tmpDir('r2a-test-vault-');
  try {
    const file = writeReceiptFile(workDir, 'anything.pdf');
    const result = await cmdPair(file, {
      vault: vaultRoot, dryRun: false, txn: 'not-a-real-id', amount: null, date: null, pick: null,
    });
    assert.equal(result.status, 'no-such-transaction');
  } finally {
    await teardown();
  }
});

test('cmdPair: --amount/--date/--pick resolves an ambiguous pair without prompting, tests drive it through --pick', async () => {
  const { txns } = await setupBudget();
  const workDir = tmpDir('r2a-test-work-');
  const vaultRoot = tmpDir('r2a-test-vault-');
  try {
    // -4523 exists on both 2026-09-01 and 2026-09-03 — the ambiguous pair from route (a)'s test.
    const wanted = txnByAmountDate(txns, -4523, '2026-09-03');
    const file = writeReceiptFile(workDir, 'costco-receipt.pdf');

    const result = await cmdPair(file, {
      vault: vaultRoot, dryRun: false, txn: null, amount: '45.23', date: '2026-09-01', pick: 2,
    });
    assert.equal(result.status, 'paired');
    assert.equal(result.txnId, wanted.id);
  } finally {
    await teardown();
  }
});

test('cmdPair: --pick out of range refuses with a clear error, nothing written', async () => {
  const { txns } = await setupBudget();
  const workDir = tmpDir('r2a-test-work-');
  const vaultRoot = tmpDir('r2a-test-vault-');
  try {
    const file = writeReceiptFile(workDir, 'costco-receipt.pdf');
    await assert.rejects(
      () => cmdPair(file, {
        vault: vaultRoot, dryRun: false, txn: null, amount: '45.23', date: '2026-09-01', pick: 99,
      }),
      /out of range/,
    );
    const { entries } = readVaultIndex(vaultRoot);
    assert.equal(entries.length, 0);
  } finally {
    await teardown();
  }
});

test('cmdPair: no candidates for the given amount/date refuses cleanly, nothing written', async () => {
  await setupBudget();
  const workDir = tmpDir('r2a-test-work-');
  const vaultRoot = tmpDir('r2a-test-vault-');
  try {
    const file = writeReceiptFile(workDir, 'nothing.pdf');
    const result = await cmdPair(file, {
      vault: vaultRoot, dryRun: false, txn: null, amount: '99.99', date: '2026-01-01', pick: null,
    });
    assert.equal(result.status, 'no-candidates');
  } finally {
    await teardown();
  }
});

test('cmdPair: non-interactive stdin with no --amount/--date and no --txn fails cleanly, never hangs', async () => {
  await setupBudget();
  const workDir = tmpDir('r2a-test-work-');
  const vaultRoot = tmpDir('r2a-test-vault-');
  try {
    const file = writeReceiptFile(workDir, 'anything.pdf');
    // node --test's stdin is not a TTY, so this must refuse rather than block on a prompt.
    await assert.rejects(
      () => cmdPair(file, { vault: vaultRoot, dryRun: false, txn: null, amount: null, date: null, pick: null }),
    );
  } finally {
    await teardown();
  }
});

test('cmdPair: --pick given without --amount/--date refuses cleanly rather than guessing what to search', async () => {
  await setupBudget();
  const workDir = tmpDir('r2a-test-work-');
  const vaultRoot = tmpDir('r2a-test-vault-');
  try {
    const file = writeReceiptFile(workDir, 'anything.pdf');
    await assert.rejects(
      () => cmdPair(file, { vault: vaultRoot, dryRun: false, txn: null, amount: null, date: null, pick: 1 }),
    );
  } finally {
    await teardown();
  }
});

test('cmdPair: --dry-run writes nothing to disk, the vault index, or the budget', async () => {
  const { txns } = await setupBudget();
  const workDir = tmpDir('r2a-test-work-');
  const vaultRoot = tmpDir('r2a-test-vault-');
  try {
    const txn = txnByAmountDate(txns, -1200, '2026-09-10');
    const file = writeReceiptFile(workDir, 'coffee-receipt.pdf');

    const result = await cmdPair(file, { vault: vaultRoot, dryRun: true, txn: txn.id, amount: null, date: null, pick: null });
    assert.equal(result.status, 'dry-run');
    assert.ok(!fs.existsSync(result.vaultPath));
    assert.ok(!fs.existsSync(path.join(vaultRoot, 'vault.jsonl')));

    const note = await api.getNote(txn.id);
    assert.ok(!note?.note);
  } finally {
    await teardown();
  }
});

// ------------------------------------------------------------------ verify

test('verify: healthy vault reports ok === pairings_checked, both orphan arrays empty, exit 0', async () => {
  const { txns } = await setupBudget();
  const workDir = tmpDir('r2a-test-work-');
  const vaultRoot = tmpDir('r2a-test-vault-');
  try {
    const txn = txnByAmountDate(txns, -1200, '2026-09-10');
    const file = writeReceiptFile(workDir, '12.00_2026-09-10_coffee.pdf');
    const paired = await cmdAdd(file, { vault: vaultRoot, dryRun: false });
    assert.equal(paired.status, 'paired');

    const report = await cmdVerify({ vault: vaultRoot });
    assert.equal(report.exit_code, 0);
    assert.equal(report.pairings_checked, 1);
    assert.equal(report.ok, 1);
    assert.deepEqual(report.orphan_files, []);
    assert.deepEqual(report.orphan_index_entries, []);
    assert.deepEqual(report.malformed_lines, []);
    assert.equal(report.vault_root, vaultRoot);
  } finally {
    await teardown();
  }
});

test('verify: a deleted vault file is reported as file_missing, exit non-zero', async () => {
  const { txns } = await setupBudget();
  const workDir = tmpDir('r2a-test-work-');
  const vaultRoot = tmpDir('r2a-test-vault-');
  try {
    const txn = txnByAmountDate(txns, -1200, '2026-09-10');
    const file = writeReceiptFile(workDir, '12.00_2026-09-10_coffee.pdf');
    const paired = await cmdAdd(file, { vault: vaultRoot, dryRun: false });

    fs.rmSync(paired.vaultPath);

    const report = await cmdVerify({ vault: vaultRoot });
    assert.equal(report.exit_code, 1);
    assert.equal(report.orphan_index_entries.length, 1);
    assert.equal(report.orphan_index_entries[0].reason, 'file_missing');
    assert.equal(report.orphan_index_entries[0].txn_id, txn.id);
  } finally {
    await teardown();
  }
});

test('verify: a deleted transaction is reported as txn_missing', async () => {
  const { txns } = await setupBudget();
  const workDir = tmpDir('r2a-test-work-');
  const vaultRoot = tmpDir('r2a-test-vault-');
  try {
    const txn = txnByAmountDate(txns, -1200, '2026-09-10');
    const file = writeReceiptFile(workDir, '12.00_2026-09-10_coffee.pdf');
    await cmdAdd(file, { vault: vaultRoot, dryRun: false });

    await api.deleteTransaction(txn.id);
    await waitForTransactionGone(txn.id);

    const report = await cmdVerify({ vault: vaultRoot });
    assert.equal(report.exit_code, 1);
    assert.equal(report.orphan_index_entries.length, 1);
    assert.equal(report.orphan_index_entries[0].reason, 'txn_missing');
  } finally {
    await teardown();
  }
});

test('verify: a stripped/changed note marker is reported as note_marker_missing_or_changed', async () => {
  const { txns } = await setupBudget();
  const workDir = tmpDir('r2a-test-work-');
  const vaultRoot = tmpDir('r2a-test-vault-');
  try {
    const txn = txnByAmountDate(txns, -1200, '2026-09-10');
    const file = writeReceiptFile(workDir, '12.00_2026-09-10_coffee.pdf');
    await cmdAdd(file, { vault: vaultRoot, dryRun: false });

    await api.updateNote(txn.id, null);

    const report = await cmdVerify({ vault: vaultRoot });
    assert.equal(report.exit_code, 1);
    assert.equal(report.orphan_index_entries.length, 1);
    assert.equal(report.orphan_index_entries[0].reason, 'note_marker_missing_or_changed');
  } finally {
    await teardown();
  }
});

test('verify: a corrupted vault file (hash mismatch) is reported as hash_mismatch', async () => {
  const { txns } = await setupBudget();
  const workDir = tmpDir('r2a-test-work-');
  const vaultRoot = tmpDir('r2a-test-vault-');
  try {
    const txn = txnByAmountDate(txns, -1200, '2026-09-10');
    const file = writeReceiptFile(workDir, '12.00_2026-09-10_coffee.pdf');
    const paired = await cmdAdd(file, { vault: vaultRoot, dryRun: false });

    fs.writeFileSync(paired.vaultPath, 'corrupted bytes, not the original content');

    const report = await cmdVerify({ vault: vaultRoot });
    assert.equal(report.exit_code, 1);
    assert.equal(report.orphan_index_entries.length, 1);
    assert.equal(report.orphan_index_entries[0].reason, 'hash_mismatch');
  } finally {
    await teardown();
  }
});

test('verify: a file dropped in the vault with no index line is an orphan_files entry', async () => {
  await setupBudget();
  const vaultRoot = tmpDir('r2a-test-vault-');
  try {
    const strayDir = path.join(vaultRoot, '2026', '09');
    fs.mkdirSync(strayDir, { recursive: true });
    const stray = path.join(strayDir, 'stray-file.pdf');
    fs.writeFileSync(stray, 'nobody indexed me');

    const report = await cmdVerify({ vault: vaultRoot });
    assert.equal(report.exit_code, 1);
    assert.deepEqual(report.orphan_files, [stray]);
  } finally {
    await teardown();
  }
});

test('verify: a malformed vault.jsonl line is reported in malformed_lines without crashing the walk', async () => {
  const { txns } = await setupBudget();
  const workDir = tmpDir('r2a-test-work-');
  const vaultRoot = tmpDir('r2a-test-vault-');
  try {
    const txn = txnByAmountDate(txns, -1200, '2026-09-10');
    const file = writeReceiptFile(workDir, '12.00_2026-09-10_coffee.pdf');
    await cmdAdd(file, { vault: vaultRoot, dryRun: false });

    fs.appendFileSync(path.join(vaultRoot, 'vault.jsonl'), 'not valid json at all\n');

    const report = await cmdVerify({ vault: vaultRoot });
    assert.equal(report.exit_code, 1);
    assert.equal(report.malformed_lines.length, 1);
    assert.equal(report.malformed_lines[0].raw, 'not valid json at all');
    // the well-formed entry is still checked normally, not skipped because of the bad line
    assert.equal(report.pairings_checked, 1);
    assert.equal(report.ok, 1);
  } finally {
    await teardown();
  }
});

// ------------------------------------------------------------------ show

test('show: resolves by transaction id, opens with dry-run reporting would-open', async () => {
  const { txns } = await setupBudget();
  const workDir = tmpDir('r2a-test-work-');
  const vaultRoot = tmpDir('r2a-test-vault-');
  try {
    const txn = txnByAmountDate(txns, -1200, '2026-09-10');
    const file = writeReceiptFile(workDir, '12.00_2026-09-10_coffee.pdf');
    const paired = await cmdAdd(file, { vault: vaultRoot, dryRun: false });

    const result = await cmdShow(txn.id, { dryRun: true });
    assert.equal(result.status, 'would-open');
    assert.equal(result.vaultPath, paired.vaultPath);
    assert.equal(result.txnId, txn.id);
  } finally {
    await teardown();
  }
});

test('show: resolves by payee search text when unique', async () => {
  const { txns } = await setupBudget();
  const workDir = tmpDir('r2a-test-work-');
  const vaultRoot = tmpDir('r2a-test-vault-');
  try {
    const txn = txnByAmountDate(txns, -1200, '2026-09-10');
    const file = writeReceiptFile(workDir, '12.00_2026-09-10_coffee.pdf');
    await cmdAdd(file, { vault: vaultRoot, dryRun: false });

    const result = await cmdShow('Coffee', { dryRun: true });
    assert.equal(result.status, 'would-open');
    assert.equal(result.txnId, txn.id);
  } finally {
    await teardown();
  }
});

test('show: ambiguous search text refuses and lists candidates, never auto-picks', async () => {
  await setupBudget();
  try {
    // "Costco" and "Costco Dup" both match a case-insensitive substring search on "costco".
    const result = await cmdShow('costco', { dryRun: true });
    assert.equal(result.status, 'ambiguous');
    assert.equal(result.candidates.length, 2);
  } finally {
    await teardown();
  }
});

test('show: no match reports no-match, exit non-zero', async () => {
  await setupBudget();
  try {
    const result = await cmdShow('nonexistent-payee-xyz', { dryRun: true });
    assert.equal(result.status, 'no-match');
  } finally {
    await teardown();
  }
});

test('show: transaction with no marker reports no-marker', async () => {
  const { txns } = await setupBudget();
  try {
    const txn = txnByAmountDate(txns, -1200, '2026-09-10');
    const result = await cmdShow(txn.id, { dryRun: true });
    assert.equal(result.status, 'no-marker');
  } finally {
    await teardown();
  }
});

test('show: marker present but the file is missing on disk reports file-missing', async () => {
  const { txns } = await setupBudget();
  const workDir = tmpDir('r2a-test-work-');
  const vaultRoot = tmpDir('r2a-test-vault-');
  try {
    const txn = txnByAmountDate(txns, -1200, '2026-09-10');
    const file = writeReceiptFile(workDir, '12.00_2026-09-10_coffee.pdf');
    const paired = await cmdAdd(file, { vault: vaultRoot, dryRun: false });
    fs.rmSync(paired.vaultPath);

    const result = await cmdShow(txn.id, { dryRun: true });
    assert.equal(result.status, 'file-missing');
  } finally {
    await teardown();
  }
});

// ------------------------------------------------------------------ relink

test('relink: rewrites every marker under --from to --to, note and index both updated, re-verifies clean', async () => {
  const { txns } = await setupBudget();
  const workDir = tmpDir('r2a-test-work-');
  const oldRoot = tmpDir('r2a-test-vault-old-');
  try {
    const txn = txnByAmountDate(txns, -1200, '2026-09-10');
    await api.updateNote(txn.id, 'split with Sam');
    const file = writeReceiptFile(workDir, '12.00_2026-09-10_coffee.pdf');
    const paired = await cmdAdd(file, { vault: oldRoot, dryRun: false });

    // Simulate the user's own `mv` of the vault directory to a new location.
    const newRoot = oldRoot + '-moved';
    fs.renameSync(oldRoot, newRoot);

    const result = await cmdRelink({ vault: newRoot, from: oldRoot, to: newRoot, dryRun: false });
    assert.equal(result.status, 'relinked');
    assert.equal(result.rewrittenCount, 1);
    assert.equal(result.failures.length, 0);
    assert.equal(result.verify.exit_code, 0);

    const newVaultPath = paired.vaultPath.replace(oldRoot, newRoot);
    const note = await api.getNote(txn.id);
    assert.equal(note.note, `split with Sam ${newVaultPath}`, 'relink swaps the marker word and keeps the rest of the note');

    const { entries } = readVaultIndex(newRoot);
    const latest = entries[entries.length - 1];
    assert.equal(latest.vault_path, newVaultPath);
    assert.equal(entries.length, 2, 'append-only: the relink correction is a new line, not a rewrite');
  } finally {
    await teardown();
  }
});

test('relink: --dry-run previews without calling updateNote or touching the index', async () => {
  const { txns } = await setupBudget();
  const workDir = tmpDir('r2a-test-work-');
  const oldRoot = tmpDir('r2a-test-vault-old-');
  try {
    const txn = txnByAmountDate(txns, -1200, '2026-09-10');
    const file = writeReceiptFile(workDir, '12.00_2026-09-10_coffee.pdf');
    await cmdAdd(file, { vault: oldRoot, dryRun: false });
    const noteBefore = await api.getNote(txn.id);

    const newRoot = oldRoot + '-moved-preview-only';
    const result = await cmdRelink({ vault: oldRoot, from: oldRoot, to: newRoot, dryRun: true });
    assert.equal(result.status, 'dry-run');
    assert.equal(result.wouldRewrite.length, 1);

    const noteAfter = await api.getNote(txn.id);
    assert.equal(noteAfter.note, noteBefore.note, 'dry-run must not touch the note');

    const { entries } = readVaultIndex(oldRoot);
    assert.equal(entries.length, 1, 'dry-run must not append to the index');
  } finally {
    await teardown();
  }
});

test('relink: nothing under --from reports nothing-to-relink', async () => {
  const { txns } = await setupBudget();
  const workDir = tmpDir('r2a-test-work-');
  const vaultRoot = tmpDir('r2a-test-vault-');
  try {
    const file = writeReceiptFile(workDir, '12.00_2026-09-10_coffee.pdf');
    await cmdAdd(file, { vault: vaultRoot, dryRun: false });

    const result = await cmdRelink({
      vault: vaultRoot, from: '/nowhere/near/anything', to: '/also/nowhere', dryRun: false,
    });
    assert.equal(result.status, 'nothing-to-relink');
  } finally {
    await teardown();
  }
});

test('relink: refuses a --to path with whitespace, same rule as any other vault root', async () => {
  await setupBudget();
  const vaultRoot = tmpDir('r2a-test-vault-');
  try {
    await assert.rejects(
      () => cmdRelink({ vault: vaultRoot, from: vaultRoot, to: '/tmp/has space', dryRun: false }),
      /whitespace/,
    );
  } finally {
    await teardown();
  }
});

// ------------------------------------------------------------------ list

test('list: prints the current (latest-wins) entries', async () => {
  const { txns } = await setupBudget();
  const workDir = tmpDir('r2a-test-work-');
  const vaultRoot = tmpDir('r2a-test-vault-');
  try {
    const txn = txnByAmountDate(txns, -1200, '2026-09-10');
    const file = writeReceiptFile(workDir, '12.00_2026-09-10_coffee.pdf');
    await cmdAdd(file, { vault: vaultRoot, dryRun: false });

    const result = await cmdList({ vault: vaultRoot, all: true, orphans: false });
    assert.equal(result.status, 'entries');
    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0].txn_id, txn.id);
  } finally {
    await teardown();
  }
});

test('list --orphans: surfaces the same orphans verify would find', async () => {
  const { txns } = await setupBudget();
  const workDir = tmpDir('r2a-test-work-');
  const vaultRoot = tmpDir('r2a-test-vault-');
  try {
    const file = writeReceiptFile(workDir, '12.00_2026-09-10_coffee.pdf');
    const paired = await cmdAdd(file, { vault: vaultRoot, dryRun: false });
    fs.rmSync(paired.vaultPath);

    const result = await cmdList({ vault: vaultRoot, all: false, orphans: true });
    assert.equal(result.status, 'orphans');
    assert.equal(result.report.orphan_index_entries.length, 1);
  } finally {
    await teardown();
  }
});

// ------------------------------------------------------------------ CLI surface

test('parseArgs: --help is recognized whether it appears before or after the subcommand', () => {
  assert.equal(parseArgs(['--help']).opts.help, true);
  assert.equal(parseArgs(['add', '--help']).opts.help, true);
  assert.equal(parseArgs(['--help', 'add']).opts.help, true);
});

test('HELP_TEXT matches the documented usage text exactly', () => {
  const expected = `receipt2actual — pair receipt files to Actual Budget transactions, locally.

Usage:
  receipt2actual add <file> [--vault <path>] [--dry-run] [--json] [--no-interactive]
  receipt2actual pair <file> [--txn <id>] [--vault <path>] [--dry-run] [--json]
  receipt2actual show <transaction id or search text> [--vault <path>]
  receipt2actual verify [--vault <path>] [--json]
  receipt2actual relink --from <old-root> --to <new-root> [--vault <path>] [--dry-run] [--json]
  receipt2actual list [--all | --orphans] [--vault <path>] [--json]

Global flags:
  --vault <path>     Vault root for this run (overrides RECEIPT_VAULT and the ~/ActualReceipts default)
  --dry-run          Show what would happen; touch nothing on disk or in the budget
  --json             Machine-readable output
  --help             Show this text

Env vars:
  RECEIPT_VAULT              Sticky vault root
  ACTUAL_URL                 Server mode: budget server URL
  ACTUAL_PASSWORD            Server mode: password
  ACTUAL_SYNC_ID             Server mode: sync id
  ACTUAL_ENCRYPTION_PASSWORD Server mode: e2e budget encryption password (optional)
  ACTUAL_DATA_DIR            Local mode: on-disk data directory
  ACTUAL_BUDGET_ID           Local mode: budget id

No cloud, no OCR, no telemetry. One machine per budget: vault paths are absolute and only resolve
on the machine that wrote them — see \`relink\` if you move the vault or the budget to a new machine.
`;
  assert.equal(HELP_TEXT, expected);
});
