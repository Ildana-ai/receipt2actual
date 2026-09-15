#!/usr/bin/env node
// receipt2actual — pair receipt files to Actual Budget transactions, locally.
import * as api from '@actual-app/api';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  mkdirSync,
  existsSync,
  statSync,
  copyFileSync,
  readFileSync,
  appendFileSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
import { resolve, join, dirname, extname, basename, sep, isAbsolute } from 'node:path';
import { homedir, platform } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';

// ------------------------------------------------------------------ connection
// Copied in discipline from actual2ics's connectionFromEnv/openBudget.

function connectionFromEnv(env) {
  const dataDir = resolve(env.ACTUAL_DATA_DIR || './.actual-data');
  const { ACTUAL_URL, ACTUAL_PASSWORD, ACTUAL_SYNC_ID, ACTUAL_BUDGET_ID } = env;

  if (ACTUAL_URL || ACTUAL_SYNC_ID) {
    const missing = [
      ['ACTUAL_URL', ACTUAL_URL],
      ['ACTUAL_PASSWORD', ACTUAL_PASSWORD],
      ['ACTUAL_SYNC_ID', ACTUAL_SYNC_ID],
    ]
      .filter(([, v]) => !v)
      .map(([k]) => k);
    if (missing.length) {
      throw new Error(`server mode needs ${missing.join(', ')}`);
    }
    return { mode: 'server', dataDir };
  }
  if (ACTUAL_BUDGET_ID) return { mode: 'local', dataDir };
  throw new Error(
    'no budget configured — set ACTUAL_URL, ACTUAL_PASSWORD and ACTUAL_SYNC_ID, ' +
      'or ACTUAL_BUDGET_ID for a budget already on this machine',
  );
}

async function openBudget(conn, env) {
  mkdirSync(conn.dataDir, { recursive: true }); // dataDir must pre-exist
  if (conn.mode === 'server') {
    await api.init({
      dataDir: conn.dataDir,
      serverURL: env.ACTUAL_URL,
      password: env.ACTUAL_PASSWORD,
    });
    await api.downloadBudget(env.ACTUAL_SYNC_ID, {
      password: env.ACTUAL_ENCRYPTION_PASSWORD,
    });
  } else {
    await api.init({ dataDir: conn.dataDir });
    await api.loadBudget(env.ACTUAL_BUDGET_ID);
  }
}

// ------------------------------------------------------------------ vault

// Anything that is not a letter or digit (any script), dot, underscore or dash. Shell and cmd
// metacharacters (& ^ % ! $ ` ; quotes, parens) are in here on purpose: `show` hands the path to
// the OS opener, and on Windows that goes through cmd.
const ILLEGAL_FILENAME_CHARS = /[^\p{L}\p{N}._-]/gu;

// Shared by resolveVaultRoot and relink's --to: absolute, no whitespace anywhere, per
// Actual's note-link regex stops matching at the first space.
function validateVaultPath(resolved) {
  if (/\s/.test(resolved)) {
    const err = new Error(
      `vault path contains whitespace, which Actual's note-link detector won't match: ${resolved}`,
    );
    err.userError = true;
    throw err;
  }
  return resolved;
}

function expandHome(raw) {
  return raw === '~' || raw.startsWith('~/') ? join(homedir(), raw.slice(1)) : raw;
}

function resolveVaultRoot({ vaultFlag, env }) {
  const raw = vaultFlag || env.RECEIPT_VAULT || join(homedir(), 'ActualReceipts');
  return validateVaultPath(resolve(expandHome(raw)));
}

// Applied on every platform, not just Windows, so a vault built on one OS relinks cleanly
// on another.
function sanitizeFilename(name) {
  const ext = extname(name).toLowerCase();
  const base = name.slice(0, name.length - extname(name).length);
  let sanitized = base.replace(/\s+/g, '-').replace(ILLEGAL_FILENAME_CHARS, '-');
  if (sanitized.length > 100) sanitized = sanitized.slice(0, 100);
  return sanitized + ext;
}

function vaultPathFor(vaultRoot, txn, sanitizedFilename) {
  const [year, month] = txn.date.split('-');
  return join(vaultRoot, year, month, `${txn.id.slice(0, 8)}__${sanitizedFilename}`);
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function readVaultIndex(vaultRoot) {
  const indexPath = join(vaultRoot, 'vault.jsonl');
  if (!existsSync(indexPath)) return { entries: [], malformed: [] };
  const lines = readFileSync(indexPath, 'utf8').split('\n').filter((l) => l.trim());
  const entries = [];
  const malformed = [];
  lines.forEach((line, i) => {
    try {
      entries.push(JSON.parse(line));
    } catch {
      malformed.push({ line_number: i + 1, raw: line });
    }
  });
  return { entries, malformed };
}

function appendVaultIndexLine(vaultRoot, entry) {
  appendFileSync(join(vaultRoot, 'vault.jsonl'), JSON.stringify(entry) + '\n');
}

// "Latest wins" per txn_id — vault.jsonl is append-only, so a relink correction
// or re-pair is simply the last line for that txn_id, not a rewrite in place.
function latestByTxnId(entries) {
  const latestByTxn = new Map();
  for (const e of entries) latestByTxn.set(e.txn_id, e);
  return [...latestByTxn.values()];
}

function checkDoubleIngest(vaultRoot, fileSha256, txnId) {
  const { entries } = readVaultIndex(vaultRoot);
  for (const e of latestByTxnId(entries)) {
    if (e.file_sha256 === fileSha256) {
      return e.txn_id === txnId
        ? { status: 'already-paired', entry: e }
        : { status: 'conflict', entry: e };
    }
  }
  return { status: 'new' };
}

// ------------------------------------------------------------------ matching, route (a)

const FILENAME_PATTERN = /^(-?\d+(?:\.\d+)?)_(\d{4}-\d{2}-\d{2})_.+$/;

function isValidCalendarDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function parseFilenameConvention(filename) {
  const base = basename(filename, extname(filename));
  const m = FILENAME_PATTERN.exec(base);
  if (!m) return null;
  const [, amountStr, dateStr] = m;
  if (!isValidCalendarDate(dateStr)) return null;
  const parsed = amountStr.includes('.')
    ? Math.round(parseFloat(amountStr) * 100)
    : parseInt(amountStr, 10);
  // No explicit '-' in the filename is a debit; v1 never infers a credit from filename
  // alone — every route-(a) match is queried as a negative amount.
  const amountCents = -Math.abs(parsed);
  return { amountCents, date: dateStr };
}

function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function queryCandidates(amountCents, anchorDate, days = 3) {
  const { q } = api;
  // GOTCHA: {date:{$gte,$lte}} on one key silently
  // drops a bound. Each bound must be its own clause under an explicit $and.
  const result = await api.aqlQuery(
    q('transactions')
      .filter({
        $and: [
          { amount: amountCents },
          { date: { $gte: addDays(anchorDate, -days) } },
          { date: { $lte: addDays(anchorDate, days) } },
        ],
      })
      .select('*'),
  );
  // "exact cents first, then the +/-3-day window" (route (c)): the query is
  // already exact-cents-only, so this orders by closeness to the anchor date, exact-date
  // matches first.
  const dayDiff = (d) => Math.abs((Date.parse(d) - Date.parse(anchorDate)) / 86400000);
  return [...result.data].sort((x, y) => dayDiff(x.date) - dayDiff(y.date));
}

async function queryTransactionById(txnId) {
  const { q } = api;
  const result = await api.aqlQuery(q('transactions').filter({ id: txnId }).select('*'));
  return result.data[0] ?? null;
}

function formatCents(cents) {
  const sign = cents < 0 ? '-' : '';
  return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`;
}

// ------------------------------------------------------------------ matching, route (b)

// Regexes run globally so an ambiguous multi-total
// receipt is detected and refused rather than silently taking the first match.
const DATE_RE = /Date:\s*(\d{4}-\d{2}-\d{2})/g;
const TOTAL_RE = /Total:\s*\$?([\d.]+)/g;

function refusePdf(code, message) {
  const err = new Error(message);
  err.pdfRefusal = code;
  return err;
}

// Extracts a single unambiguous total + date from a text-layer PDF. Throws (never guesses)
// when there is no text layer, the PDF is password-protected, or the text yields zero or
// more than one candidate total/date (route (b)).
async function extractPdfTotalAndDate(filePath) {
  const data = new Uint8Array(readFileSync(filePath));
  const loadingTask = getDocument({ data });
  let doc;
  try {
    doc = await loadingTask.promise; // throws PasswordException if protected
  } catch (e) {
    if (e.name === 'PasswordException') {
      throw refusePdf('PASSWORD_PROTECTED', `password-protected PDF, refusing: ${filePath}`);
    }
    throw e;
  }
  let fullText = '';
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    fullText += content.items.map((it) => it.str).join(' ') + '\n';
  }
  await loadingTask.destroy(); // PDFDocumentProxy has no destroy() in pdfjs-dist 6.3.289

  if (!fullText.trim()) {
    throw refusePdf('NO_TEXT_LAYER', `no extractable text (scanned/image-only PDF): ${filePath}`);
  }

  const dates = [...fullText.matchAll(DATE_RE)].map((m) => m[1]);
  const totals = [...fullText.matchAll(TOTAL_RE)].map((m) => m[1]);

  if (dates.length === 0 || totals.length === 0) {
    throw refusePdf(
      'NO_UNAMBIGUOUS_MATCH',
      `text layer present but no total/date found unambiguously in: ${filePath}`,
    );
  }
  if (dates.length > 1 || totals.length > 1) {
    throw refusePdf(
      'AMBIGUOUS_EXTRACTION',
      `multiple candidate total(s)/date(s) found, refusing to guess — totals: ` +
        `${JSON.stringify(totals)}, dates: ${JSON.stringify(dates)} (${filePath})`,
    );
  }

  const amountCents = -Math.abs(Math.round(parseFloat(totals[0]) * 100));
  return { amountCents, date: dates[0] };
}

// ------------------------------------------------------------------ marking

// Actual's note-link parser (desktop-client/src/notes/linkParser.ts) splits the note on
// whitespace and links any word that is an absolute path, so the marker can sit after a note
// the user already wrote. It is appended with one space, never replaces anything.
function noteHasMarker(noteText, marker) {
  return (noteText ?? '').split(/\s+/).includes(marker);
}

function noteWithMarker(noteText, marker) {
  const existing = (noteText ?? '').trimEnd();
  return existing ? `${existing} ${marker}` : marker;
}

function noteWithMarkerReplaced(noteText, oldMarker, newMarker) {
  const words = (noteText ?? '').split(/(\s+)/);
  const replaced = words.map((w) => (w === oldMarker ? newMarker : w)).join('');
  return noteHasMarker(replaced, newMarker) ? replaced : noteWithMarker(replaced, newMarker);
}

// The last absolute-path word in a note is the current marker (relink appends the newest one).
function markerFromNote(noteText) {
  const paths = (noteText ?? '').split(/\s+/).filter((w) => w && isAbsolute(w));
  return paths.length ? paths[paths.length - 1] : null;
}

async function checkNoteIdempotency(txnId, markerString) {
  const note = await api.getNote(txnId);
  if (noteHasMarker(note?.note, markerString)) return 'noop';
  return 'proceed';
}

// Shared tail end of every pairing, once a single transaction has been settled on — by
// route (a)/(b) auto-match, or by a route (c) pick. Order of operations:
// double-ingest guard, then the note idempotency guard, then copy, then note write, then
// the index append — index append is always last.
async function finalizePairing(file, txn, vaultRoot, opts, route) {
  const sha256 = sha256File(file);

  const dbl = checkDoubleIngest(vaultRoot, sha256, txn.id);
  if (dbl.status === 'already-paired') {
    return { status: 'noop', vaultPath: dbl.entry.vault_path, txnId: txn.id };
  }
  if (dbl.status === 'conflict') {
    return { status: 'conflict', existing: dbl.entry };
  }

  const sanitized = sanitizeFilename(basename(file));
  const vaultPath = vaultPathFor(vaultRoot, txn, sanitized);

  const idempotency = await checkNoteIdempotency(txn.id, vaultPath);
  if (idempotency === 'noop') {
    return { status: 'noop', vaultPath, txnId: txn.id };
  }
  if (opts.dryRun) {
    return { status: 'dry-run', vaultPath, txnId: txn.id };
  }

  mkdirSync(dirname(vaultPath), { recursive: true });
  copyFileSync(file, vaultPath);
  const existingNote = await api.getNote(txn.id);
  await api.updateNote(txn.id, noteWithMarker(existingNote?.note, vaultPath));
  appendVaultIndexLine(vaultRoot, {
    txn_id: txn.id,
    file_sha256: sha256,
    amount_cents: txn.amount,
    date: txn.date,
    vault_path: vaultPath,
    original_filename: basename(file),
    paired_at: new Date().toISOString(),
    route,
  });

  return { status: 'paired', vaultPath, txnId: txn.id };
}

// ------------------------------------------------------------------ add (routes a, b)

async function cmdAdd(file, opts) {
  const vaultRoot = resolveVaultRoot({ vaultFlag: opts.vault, env: process.env });

  if (!existsSync(file) || !statSync(file).isFile()) {
    const err = new Error(`file not found or not readable: ${file}`);
    err.userError = true;
    throw err;
  }

  // Wire order: (a) filename convention, else (b) PDF text layer if it's a
  // PDF, else tell the user to run `pair` directly. A route match that resolves to zero or
  // more than one candidate is terminal here — `add` never auto-picks and never silently
  // chains into (b) or interactive prompting; the user re-runs with `pair`.
  let parsed = parseFilenameConvention(basename(file));
  let route = 'filename';

  if (!parsed) {
    if (extname(file).toLowerCase() === '.pdf') {
      try {
        parsed = await extractPdfTotalAndDate(file);
        route = 'pdf-text';
      } catch (e) {
        if (e.pdfRefusal) {
          return { status: 'pdf-refused', message: e.message, code: e.pdfRefusal };
        }
        throw e;
      }
    } else {
      return {
        status: 'no-match',
        message:
          `filename does not match AMOUNT_YYYY-MM-DD_name.ext and is not a PDF: ` +
          `${basename(file)} — run 'pair' to match it by hand`,
      };
    }
  }

  const candidates = await queryCandidates(parsed.amountCents, parsed.date);
  if (candidates.length === 0) {
    return {
      status: 'no-candidates',
      message:
        `no candidate transactions found for ${formatCents(parsed.amountCents)} within 3 days ` +
        `of ${parsed.date} — run 'pair ${file}' to search by hand`,
    };
  }
  if (candidates.length > 1) {
    return {
      status: 'ambiguous',
      candidates,
      parsed,
      message: `no unique match — run 'pair ${file}' to pick among the candidates below`,
    };
  }

  return finalizePairing(file, candidates[0], vaultRoot, opts, route);
}

const ADD_OK_STATUSES = new Set(['paired', 'noop', 'dry-run']);

function printAddResult(result, opts) {
  if (opts.json) {
    process.stdout.write(JSON.stringify(result) + '\n');
    return;
  }
  switch (result.status) {
    case 'paired':
      process.stdout.write(`paired -> ${result.txnId} (${result.vaultPath})\n`);
      break;
    case 'noop':
      process.stdout.write(`already paired: ${result.vaultPath}\n`);
      break;
    case 'dry-run':
      process.stdout.write(`[dry-run] would pair -> ${result.txnId} (${result.vaultPath})\n`);
      break;
    case 'no-match':
    case 'no-candidates':
    case 'pdf-refused':
      process.stdout.write(`${result.message}\n`);
      break;
    case 'ambiguous':
      process.stdout.write(
        `no unique match for ${formatCents(result.parsed.amountCents)} within 3 days of ${result.parsed.date} — ${result.candidates.length} candidates:\n`,
      );
      for (const c of result.candidates) {
        process.stdout.write(`  ${c.id}  ${c.date}  ${formatCents(c.amount)}\n`);
      }
      process.stdout.write(`${result.message}\n`);
      break;
    case 'conflict':
      process.stdout.write(
        `this file is already paired to a different transaction (${result.existing.txn_id}) at ${result.existing.vault_path}\n`,
      );
      break;
  }
}

// ------------------------------------------------------------------ pair (route c)

async function resolveDisplayMaps() {
  const [accounts, payees] = await Promise.all([api.getAccounts(), api.getPayees()]);
  return {
    accountById: new Map(accounts.map((a) => [a.id, a.name])),
    payeeById: new Map(payees.map((p) => [p.id, p.name])),
  };
}

function payeeDisplay(txn, payeeById) {
  return txn.imported_payee || (txn.payee && payeeById.get(txn.payee)) || '(no payee)';
}

function accountDisplay(txn, accountById) {
  return accountById.get(txn.account) || txn.account;
}

function formatCandidateLine(n, c, maps) {
  return (
    `  ${n}) ${c.date}  ${formatCents(c.amount)}  ` +
    `${payeeDisplay(c, maps.payeeById)}  (${accountDisplay(c, maps.accountById)})`
  );
}

// Parses a user- or flag-supplied amount the same way route (a) parses a filename amount:
// a decimal is dollars-and-cents, a bare integer is dollars, and no explicit
// sign means a debit — except here the caller may supply an explicit sign for a credit.
function parseAmountFlag(str) {
  const m = /^(-?\d+(?:\.\d+)?)$/.exec(str.trim());
  if (!m) return null;
  const raw = m[1];
  const cents = raw.includes('.') ? Math.round(parseFloat(raw) * 100) : parseInt(raw, 10);
  return raw.startsWith('-') ? cents : -Math.abs(cents);
}

function isValidDateFlag(str) {
  return /^\d{4}-\d{2}-\d{2}$/.test(str) && isValidCalendarDate(str);
}

// Non-interactive stdin (tests, cron, CI) must never hang waiting on a prompt — refuse
// cleanly instead.
function requireInteractive(reason) {
  const err = new Error(reason);
  err.userError = true;
  throw err;
}

async function promptLine(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

async function promptForAmountDate() {
  if (!process.stdin.isTTY) {
    requireInteractive(
      "pair needs --amount and --date (or --txn) when stdin isn't interactive — refusing rather than hanging",
    );
  }
  const amountStr = await promptLine('Amount (e.g. 45.23, or -45.23 for a credit): ');
  const amountCents = parseAmountFlag(amountStr);
  if (amountCents === null) requireInteractive(`could not parse amount: ${amountStr}`);
  const dateStr = await promptLine('Date (YYYY-MM-DD): ');
  if (!isValidDateFlag(dateStr)) requireInteractive(`could not parse date: ${dateStr}`);
  return { amountCents, date: dateStr };
}

// Presents the numbered candidate list and returns the chosen transaction, or null if the
// user picked "none of these" / declined. `opts.pick` skips the prompt for scripts.
async function pickCandidate(candidates, opts, maps) {
  if (candidates.length === 0) return null;

  for (const [i, c] of candidates.entries()) {
    process.stdout.write(formatCandidateLine(i + 1, c, maps) + '\n');
  }

  if (opts.pick != null) {
    const idx = opts.pick;
    if (!Number.isInteger(idx) || idx < 1 || idx > candidates.length) {
      const err = new Error(`--pick ${opts.pick} is out of range (1-${candidates.length})`);
      err.userError = true;
      throw err;
    }
    return candidates[idx - 1];
  }

  if (!process.stdin.isTTY) {
    requireInteractive(
      "pair found multiple/one candidate(s) and stdin isn't interactive — pass --pick N to choose one, refusing rather than hanging",
    );
  }

  const answer = await promptLine(`Pick 1-${candidates.length}, or 0 for none of these: `);
  const idx = parseInt(answer, 10);
  if (idx === 0 || !Number.isInteger(idx)) return null;
  if (idx < 1 || idx > candidates.length) {
    const err = new Error(`invalid pick: ${answer}`);
    err.userError = true;
    throw err;
  }
  return candidates[idx - 1];
}

async function cmdPair(file, opts) {
  const vaultRoot = resolveVaultRoot({ vaultFlag: opts.vault, env: process.env });

  if (!existsSync(file) || !statSync(file).isFile()) {
    const err = new Error(`file not found or not readable: ${file}`);
    err.userError = true;
    throw err;
  }

  if (opts.txn) {
    const txn = await queryTransactionById(opts.txn);
    if (!txn) {
      return { status: 'no-such-transaction', message: `no transaction with id ${opts.txn}` };
    }
    return finalizePairing(file, txn, vaultRoot, opts, 'interactive');
  }

  let amountCents = opts.amount != null ? parseAmountFlag(opts.amount) : null;
  if (opts.amount != null && amountCents === null) {
    const err = new Error(`could not parse --amount ${opts.amount}`);
    err.userError = true;
    throw err;
  }
  let date = opts.date ?? null;
  if (date != null && !isValidDateFlag(date)) {
    const err = new Error(`could not parse --date ${date} (want YYYY-MM-DD)`);
    err.userError = true;
    throw err;
  }

  if (amountCents === null || date === null) {
    if (opts.pick != null) {
      requireInteractive('pair --pick needs --amount and --date to search with (no filename/PDF parsing in pair)');
    }
    ({ amountCents, date } = await promptForAmountDate());
  }

  const candidates = await queryCandidates(amountCents, date);
  if (candidates.length === 0) {
    return {
      status: 'no-candidates',
      message: `no candidate transactions found for ${formatCents(amountCents)} within 3 days of ${date}`,
    };
  }

  const maps = await resolveDisplayMaps();
  const chosen = await pickCandidate(candidates, opts, maps);
  if (!chosen) {
    return { status: 'no-pairing-made', message: 'no pairing made — nothing written' };
  }

  return finalizePairing(file, chosen, vaultRoot, opts, 'interactive');
}

function printPairResult(result, opts) {
  if (opts.json) {
    process.stdout.write(JSON.stringify(result) + '\n');
    return;
  }
  switch (result.status) {
    case 'paired':
      process.stdout.write(`paired -> ${result.txnId} (${result.vaultPath})\n`);
      break;
    case 'noop':
      process.stdout.write(`already paired: ${result.vaultPath}\n`);
      break;
    case 'dry-run':
      process.stdout.write(`[dry-run] would pair -> ${result.txnId} (${result.vaultPath})\n`);
      break;
    case 'conflict':
      process.stdout.write(
        `this file is already paired to a different transaction (${result.existing.txn_id}) at ${result.existing.vault_path}\n`,
      );
      break;
    case 'no-candidates':
    case 'no-pairing-made':
    case 'no-such-transaction':
      process.stdout.write(`${result.message}\n`);
      break;
  }
}

const PAIR_OK_STATUSES = new Set(['paired', 'noop', 'dry-run']);

// ------------------------------------------------------------------ verify

// Walks every vault file under vaultRoot (excluding vault.jsonl itself), returning absolute
// paths — used to find orphan_files .
function walkVaultFiles(vaultRoot) {
  const indexPath = resolve(join(vaultRoot, 'vault.jsonl'));
  const found = [];
  function walk(dir) {
    let names;
    try {
      names = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of names) {
      const full = join(dir, d.name);
      if (d.isDirectory()) walk(full);
      else if (resolve(full) !== indexPath) found.push(resolve(full));
    }
  }
  walk(vaultRoot);
  return found;
}

// The full reconciliation walk: current (latest-wins) index entries checked in both
// directions against disk and the budget, plus vault.jsonl's own malformed lines. Order per
// entry is file-existence, then the recorded hash, then the transaction, then the note — file
// existence first since it's free, before spending an API call on the rest.
// `hash_mismatch`: the file existing with the wrong bytes is exactly the kind of silent drift
// the reconciliation guard exists to catch.
async function buildVerifyReport(vaultRoot) {
  const { entries, malformed } = readVaultIndex(vaultRoot);
  const current = latestByTxnId(entries);
  const referencedPaths = new Set(current.map((e) => resolve(e.vault_path)));

  const orphanIndexEntries = [];
  let ok = 0;

  for (const e of current) {
    let reason = null;
    if (!existsSync(e.vault_path)) {
      reason = 'file_missing';
    } else if (sha256File(e.vault_path) !== e.file_sha256) {
      reason = 'hash_mismatch';
    } else {
      const txn = await queryTransactionById(e.txn_id);
      if (!txn || txn.tombstone) {
        reason = 'txn_missing';
      } else {
        const note = await api.getNote(e.txn_id);
        if (!noteHasMarker(note?.note, e.vault_path)) {
          reason = 'note_marker_missing_or_changed';
        }
      }
    }
    if (reason) orphanIndexEntries.push({ txn_id: e.txn_id, vault_path: e.vault_path, reason });
    else ok++;
  }

  const orphanFiles = walkVaultFiles(vaultRoot).filter((p) => !referencedPaths.has(p));

  const exitCode =
    orphanFiles.length || orphanIndexEntries.length || malformed.length ? 1 : 0;

  return {
    checked_at: new Date().toISOString(),
    vault_root: vaultRoot,
    pairings_checked: current.length,
    ok,
    orphan_files: orphanFiles,
    orphan_index_entries: orphanIndexEntries,
    malformed_lines: malformed,
    exit_code: exitCode,
  };
}

async function cmdVerify(opts) {
  const vaultRoot = resolveVaultRoot({ vaultFlag: opts.vault, env: process.env });
  return buildVerifyReport(vaultRoot);
}

function printVerifyReport(report, opts) {
  if (opts.json) {
    process.stdout.write(JSON.stringify(report) + '\n');
    return;
  }
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  const orphanCount = report.orphan_files.length + report.orphan_index_entries.length +
    report.malformed_lines.length;
  process.stdout.write(
    `${report.ok}/${report.pairings_checked} pairings ok, ${orphanCount} orphan(s)\n`,
  );
}

// ------------------------------------------------------------------ show

function isProbablyTransactionId(str) {
  // Actual transaction ids are UUIDs; this is a cheap shape check, not a validator — an
  // exact-id lookup either finds a transaction or it doesn't, so a false positive here just
  // means we tried the id lookup first and fell through to search, which is harmless.
  return /^[0-9a-f-]{20,}$/i.test(str);
}

async function findTransactionForShow(arg) {
  if (isProbablyTransactionId(arg)) {
    const txn = await queryTransactionById(arg);
    if (txn && !txn.tombstone) return { status: 'resolved', txn };
  }

  const { q } = api;
  const result = await api.aqlQuery(q('transactions').select('*'));
  const live = result.data.filter((t) => !t.tombstone);
  const maps = await resolveDisplayMaps();
  const needle = arg.toLowerCase();

  const matches = [];
  for (const t of live) {
    const payee = payeeDisplay(t, maps.payeeById).toLowerCase();
    if (payee.includes(needle)) {
      matches.push(t);
      continue;
    }
    const note = await api.getNote(t.id);
    if (note?.note && note.note.toLowerCase().includes(needle)) matches.push(t);
  }

  if (matches.length === 0) return { status: 'no-match' };
  if (matches.length > 1) return { status: 'ambiguous', candidates: matches, maps };
  return { status: 'resolved', txn: matches[0] };
}

function openInOsViewer(path) {
  const plat = platform();
  if (plat === 'darwin') return spawn('open', [path], { detached: true, stdio: 'ignore' });
  if (plat === 'win32') {
    return spawn('cmd', ['/c', 'start', '', path], { detached: true, stdio: 'ignore' });
  }
  return spawn('xdg-open', [path], { detached: true, stdio: 'ignore' });
}

async function cmdShow(arg, opts) {
  const found = await findTransactionForShow(arg);
  if (found.status === 'no-match') {
    return { status: 'no-match', message: `no transaction matches: ${arg}` };
  }
  if (found.status === 'ambiguous') {
    return {
      status: 'ambiguous',
      candidates: found.candidates,
      maps: found.maps,
      message: `more than one transaction matches "${arg}" — pass the transaction id instead`,
    };
  }

  const txn = found.txn;
  const note = await api.getNote(txn.id);
  const marker = markerFromNote(note?.note);
  if (!marker) {
    return { status: 'no-marker', txnId: txn.id, message: `transaction ${txn.id} has no receipt marker` };
  }
  if (!existsSync(marker)) {
    return {
      status: 'file-missing',
      txnId: txn.id,
      vaultPath: marker,
      message: `transaction ${txn.id} is marked ${marker} but that file doesn't exist on disk — run 'verify' or 'relink'`,
    };
  }

  if (opts.dryRun) {
    return { status: 'would-open', txnId: txn.id, vaultPath: marker };
  }
  const child = openInOsViewer(marker);
  child.unref();
  return { status: 'opened', txnId: txn.id, vaultPath: marker };
}

function printShowResult(result, opts) {
  if (opts.json) {
    process.stdout.write(JSON.stringify(result) + '\n');
    return;
  }
  switch (result.status) {
    case 'opened':
      process.stdout.write(`opened ${result.vaultPath} (${result.txnId})\n`);
      break;
    case 'would-open':
      process.stdout.write(`[dry-run] would open ${result.vaultPath} (${result.txnId})\n`);
      break;
    case 'ambiguous':
      for (const c of result.candidates) {
        process.stdout.write(
          `  ${c.id}  ${c.date}  ${formatCents(c.amount)}  ${payeeDisplay(c, result.maps.payeeById)}\n`,
        );
      }
      process.stdout.write(`${result.message}\n`);
      break;
    case 'no-match':
    case 'no-marker':
    case 'file-missing':
      process.stdout.write(`${result.message}\n`);
      break;
  }
}

const SHOW_OK_STATUSES = new Set(['opened', 'would-open']);

// ------------------------------------------------------------------ relink

// Rewrites every current marker whose vault_path starts with `from` to the equivalent path
// under `to`. Does not move files on disk — that's the user's `mv`/`Move-Item`,
// done before running this for real. `--dry-run` previews without calling updateNote or
// appending to the index.
async function cmdRelink(opts) {
  if (!opts.from || !opts.to) {
    const err = new Error('relink needs both --from <old-root> and --to <new-root>');
    err.userError = true;
    err.usageError = true;
    throw err;
  }
  const from = validateVaultPath(resolve(expandHome(opts.from)));
  const to = validateVaultPath(resolve(expandHome(opts.to)));
  const vaultRoot = resolveVaultRoot({ vaultFlag: opts.vault, env: process.env });

  const { entries } = readVaultIndex(vaultRoot);
  const current = latestByTxnId(entries);
  const prefix = from.endsWith(sep) ? from : from + sep;
  const toRewrite = current.filter((e) => e.vault_path === from || e.vault_path.startsWith(prefix));

  if (toRewrite.length === 0) {
    return { status: 'nothing-to-relink', message: `no current entries under ${from}` };
  }

  const rewritten = toRewrite.map((e) => ({
    ...e,
    vault_path: to + e.vault_path.slice(from.length),
  }));

  if (opts.dryRun) {
    return { status: 'dry-run', from, to, wouldRewrite: rewritten };
  }

  const failures = [];
  for (const e of rewritten) {
    try {
      const note = await api.getNote(e.txn_id);
      const oldPath = from + e.vault_path.slice(to.length);
      await api.updateNote(e.txn_id, noteWithMarkerReplaced(note?.note, oldPath, e.vault_path));
      appendVaultIndexLine(vaultRoot, e);
    } catch (err) {
      failures.push({ txn_id: e.txn_id, vault_path: e.vault_path, error: err.message });
    }
  }

  const verifyReport = await buildVerifyReport(vaultRoot);
  const exitOk = failures.length === 0 && verifyReport.exit_code === 0;

  return {
    status: exitOk ? 'relinked' : 'partial',
    from,
    to,
    rewrittenCount: rewritten.length - failures.length,
    failures,
    verify: verifyReport,
  };
}

function printRelinkResult(result, opts) {
  if (opts.json) {
    process.stdout.write(JSON.stringify(result) + '\n');
    return;
  }
  switch (result.status) {
    case 'nothing-to-relink':
      process.stdout.write(`${result.message}\n`);
      break;
    case 'dry-run':
      process.stdout.write(`[dry-run] would rewrite ${result.wouldRewrite.length} marker(s):\n`);
      for (const e of result.wouldRewrite) {
        process.stdout.write(`  ${e.txn_id}  ->  ${e.vault_path}\n`);
      }
      break;
    case 'relinked':
    case 'partial':
      process.stdout.write(`relinked ${result.rewrittenCount} marker(s) from ${result.from} to ${result.to}\n`);
      for (const f of result.failures) {
        process.stdout.write(`  FAILED ${f.txn_id}: ${f.error}\n`);
      }
      printVerifyReport(result.verify, opts);
      break;
  }
}

const RELINK_OK_STATUSES = new Set(['nothing-to-relink', 'dry-run', 'relinked']);

// ------------------------------------------------------------------ list

async function cmdList(opts) {
  const vaultRoot = resolveVaultRoot({ vaultFlag: opts.vault, env: process.env });
  if (opts.orphans) {
    return { status: 'orphans', report: await buildVerifyReport(vaultRoot) };
  }
  const { entries } = readVaultIndex(vaultRoot);
  return { status: 'entries', entries: latestByTxnId(entries) };
}

function printListResult(result, opts) {
  if (opts.json) {
    process.stdout.write(JSON.stringify(result) + '\n');
    return;
  }
  if (result.status === 'orphans') {
    for (const f of result.report.orphan_files) process.stdout.write(`orphan file: ${f}\n`);
    for (const e of result.report.orphan_index_entries) {
      process.stdout.write(`orphan entry: ${e.txn_id}  ${e.vault_path}  (${e.reason})\n`);
    }
    for (const m of result.report.malformed_lines) {
      process.stdout.write(`malformed line ${m.line_number}: ${m.raw}\n`);
    }
    if (
      !result.report.orphan_files.length &&
      !result.report.orphan_index_entries.length &&
      !result.report.malformed_lines.length
    ) {
      process.stdout.write('no orphans\n');
    }
    return;
  }
  for (const e of result.entries) {
    process.stdout.write(`${e.txn_id}  ${e.date}  ${formatCents(e.amount_cents)}  ${e.vault_path}  (${e.route})\n`);
  }
}

// ------------------------------------------------------------------ CLI

const HELP_TEXT = `receipt2actual — pair receipt files to Actual Budget transactions, locally.

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

const KNOWN_COMMANDS = new Set(['add', 'pair', 'show', 'verify', 'relink', 'list']);

// `--help` is a global flag, valid before or instead of a subcommand — the first non-flag
// token found anywhere is the command, every other bare token is positional.
function parseArgs(argv) {
  const opts = {
    vault: null,
    dryRun: false,
    json: false,
    help: false,
    txn: null,
    amount: null,
    date: null,
    pick: null,
    from: null,
    to: null,
    all: false,
    orphans: false,
    noInteractive: false,
  };
  let cmd = null;
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--vault') opts.vault = argv[++i];
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--help') opts.help = true;
    else if (a === '--txn') opts.txn = argv[++i];
    else if (a === '--amount') opts.amount = argv[++i];
    else if (a === '--date') opts.date = argv[++i];
    else if (a === '--pick') opts.pick = parseInt(argv[++i], 10);
    else if (a === '--from') opts.from = argv[++i];
    else if (a === '--to') opts.to = argv[++i];
    else if (a === '--all') opts.all = true;
    else if (a === '--orphans') opts.orphans = true;
    else if (a === '--no-interactive') opts.noInteractive = true;
    else if (cmd === null) cmd = a;
    else positional.push(a);
  }
  return { cmd, positional, opts };
}

async function main() {
  const { cmd, positional, opts } = parseArgs(process.argv.slice(2));

  if (opts.help) {
    process.stdout.write(HELP_TEXT);
    process.exitCode = 0;
    return;
  }
  if (!cmd) {
    process.stdout.write(HELP_TEXT);
    process.exitCode = 2;
    return;
  }
  if (!KNOWN_COMMANDS.has(cmd)) {
    process.stderr.write(`unknown command: ${cmd}\n\n${HELP_TEXT}`);
    process.exitCode = 2;
    return;
  }

  let file, arg;
  if (cmd === 'add' || cmd === 'pair') {
    file = positional[0];
    if (!file) {
      process.stderr.write(`${cmd} requires a file argument\n\n${HELP_TEXT}`);
      process.exitCode = 2;
      return;
    }
  }
  if (cmd === 'show') {
    arg = positional[0];
    if (!arg) {
      process.stderr.write(`show requires a transaction id or search text\n\n${HELP_TEXT}`);
      process.exitCode = 2;
      return;
    }
  }
  if (cmd === 'relink' && (!opts.from || !opts.to)) {
    process.stderr.write(`relink requires both --from <old-root> and --to <new-root>\n\n${HELP_TEXT}`);
    process.exitCode = 2;
    return;
  }

  const conn = connectionFromEnv(process.env);
  await openBudget(conn, process.env);
  try {
    if (cmd === 'add') {
      const result = await cmdAdd(file, opts);
      printAddResult(result, opts);
      process.exitCode = ADD_OK_STATUSES.has(result.status) ? 0 : 1;
    } else if (cmd === 'pair') {
      const result = await cmdPair(file, opts);
      printPairResult(result, opts);
      process.exitCode = PAIR_OK_STATUSES.has(result.status) ? 0 : 1;
    } else if (cmd === 'show') {
      const result = await cmdShow(arg, opts);
      printShowResult(result, opts);
      process.exitCode = SHOW_OK_STATUSES.has(result.status) ? 0 : 1;
    } else if (cmd === 'verify') {
      const report = await cmdVerify(opts);
      printVerifyReport(report, opts);
      process.exitCode = report.exit_code;
    } else if (cmd === 'relink') {
      const result = await cmdRelink(opts);
      printRelinkResult(result, opts);
      process.exitCode = RELINK_OK_STATUSES.has(result.status) ? 0 : 1;
    } else if (cmd === 'list') {
      const result = await cmdList(opts);
      printListResult(result, opts);
      process.exitCode = 0;
    }
  } finally {
    await api.shutdown();
  }
}

export {
  connectionFromEnv,
  openBudget,
  resolveVaultRoot,
  sanitizeFilename,
  vaultPathFor,
  sha256File,
  readVaultIndex,
  appendVaultIndexLine,
  checkDoubleIngest,
  parseFilenameConvention,
  queryCandidates,
  queryTransactionById,
  formatCents,
  checkNoteIdempotency,
  extractPdfTotalAndDate,
  parseAmountFlag,
  cmdAdd,
  cmdPair,
  cmdShow,
  cmdVerify,
  cmdRelink,
  cmdList,
  buildVerifyReport,
  latestByTxnId,
  validateVaultPath,
  parseArgs,
  HELP_TEXT,
};

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    if (err?.userError) {
      process.stderr.write(`${err.message}\n`);
      process.exitCode = err.usageError ? 2 : 1;
      return;
    }
    process.stderr.write(`${err.stack || err}\n`);
    process.exitCode = 1;
  });
}
