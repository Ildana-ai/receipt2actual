<p align="center">
  <a href="https://ildana.ai">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset=".github/assets/ildana-lockup-white-512.png">
      <img src=".github/assets/ildana-lockup-black-512.png" alt="Ildana — Augmented Intelligence" width="260">
    </picture>
  </a>
</p>

# Receipt → Actual

Pair receipt files to [Actual Budget](https://actualbudget.org) transactions,
on your own machine. `receipt2actual` copies each receipt into a local vault
next to the transaction it belongs to, and writes a marker onto that
transaction's note so you can always find your way back to the file.

Nothing is uploaded anywhere. No OCR, no cloud service, no telemetry — a
receipt with no readable text is refused, not guessed at.

## Install

Needs [Node](https://nodejs.org) 22.13 or newer (the PDF reader it uses needs it).

```bash
git clone https://github.com/Ildana-ai/receipt2actual.git
cd receipt2actual
npm install
npm install -g .
```

The last line puts a `receipt2actual` command on your PATH. Skip it and run
`node receipt2actual.mjs` from the clone instead if you prefer; every example
below works either way.

## Point it at your budget

Everything comes from environment variables, so the password is never part of
the `receipt2actual` command line and never lands in a file in this
repository. If your shell keeps history, put a space before the `export` line
or set the variables in a file you `source`, so the password stays out of the
history too.

**If you run an Actual sync server** (most people):

```bash
export ACTUAL_URL=https://actual.example.com
export ACTUAL_PASSWORD='your server password'
export ACTUAL_SYNC_ID=your-budgets-sync-id
```

`ACTUAL_SYNC_ID` is the Sync ID Actual assigns your budget — the same value the
[official API](https://actualbudget.org/docs/api/) uses to download it. The
API keeps a local copy of the budget while it works; by default that goes in
`.actual-data` inside the folder you run from. Set `ACTUAL_DATA_DIR` to put it
somewhere deliberate. If the budget is end-to-end encrypted, add its
encryption password too:

```bash
export ACTUAL_ENCRYPTION_PASSWORD='your encryption password'
```

**If you have no server** and the budget already lives on this machine, name
it instead:

```bash
export ACTUAL_BUDGET_ID=my-budget-a1b2c3d
export ACTUAL_DATA_DIR=~/Library/Application\ Support/Actual
```

## The vault

Paired receipts live in a folder called the vault — `~/ActualReceipts` by
default:

| OS | Default vault |
|---|---|
| macOS / Linux | `~/ActualReceipts` |
| Windows | `C:\Users\<you>\ActualReceipts` |

Override it with `RECEIPT_VAULT` (sticky, put it next to your other exported
variables) or `--vault <path>` for one run. Either way, the path must be
absolute and must not contain any spaces — more on why below.

Inside the vault, each receipt lands at
`<vault>/YYYY/MM/<short-transaction-id>__<original-filename>`, filed under the
year and month of the transaction it settled, not the day you happened to
ingest it. Alongside it sits `vault.jsonl`, a plain-text log of every pairing
this tool has made — one JSON line per pairing, never rewritten, only ever
appended to.

## Pairing a receipt

`add` tries the fast, automatic routes first and falls back to asking you:

**1. Name the file `AMOUNT_YYYY-MM-DD_anything.ext`** and it pairs itself with
no reading of the file at all:

```bash
receipt2actual add 45.23_2026-09-01_costco.pdf
```

**2. Drop in a PDF receipt with a readable total and date** and it reads them
straight off the page:

```bash
receipt2actual add IMG_20260901_scan.pdf
```

A scanned image with no text layer, or a password-protected PDF, is refused
rather than guessed at — receipt2actual does not do OCR, on purpose.

**3. Anything else, or an ambiguous match** — more than one transaction fits
the same amount and date — hands you a numbered list to pick from:

```bash
receipt2actual pair receipt.jpg
```

```
Amount (e.g. 45.23, or -45.23 for a credit): 45.23
Date (YYYY-MM-DD): 2026-09-01
  1) 2026-09-01  -$45.23  Costco  (Checking)
  2) 2026-09-03  -$45.23  Costco Dup  (Checking)
Pick 1-2, or 0 for none of these: 1
paired -> a1b2c3d4-... (/home/you/ActualReceipts/2026/09/a1b2c3d4__receipt.jpg)
```

`pair --txn <id>` skips the search entirely when you already know the
transaction. Add `--dry-run` to any of these to see what would happen without
touching disk or the budget.

## What the note looks like

Once paired, the receipt's absolute path on disk is added to the transaction's
note in Actual, after anything you already wrote there — no wrapper text, one
space in between:

```
/home/you/ActualReceipts/2026/09/a1b2c3d4__costco-receipt.pdf
```

```
Split with Sam /home/you/ActualReceipts/2026/09/a1b2c3d4__costco-receipt.pdf
```

Your own note is never replaced. Pairing the same receipt again does nothing.

**In the desktop app**, clicking that note reveals the file in Finder or
Explorer. **In the browser or PWA**, clicking it copies the path to your
clipboard instead — Actual's web client can't open a file picker on your
disk, so paste it into your file manager or run `receipt2actual show`.

## `show` — open a receipt from the terminal

```bash
receipt2actual show a1b2c3d4-1234-5678-9abc-def012345678
receipt2actual show costco
```

Give it a transaction id, or search text that matches a payee or a note.
A search that matches more than one transaction refuses and lists the matches
rather than guessing which one you meant — pass the id instead. It opens the
paired file in your OS's default viewer (`open` on macOS, `xdg-open` on
Linux, `start` on Windows).

## `verify` — the headline feature

Every pairing this tool makes is a claim: this file is this transaction's
receipt. `verify` is the only command that checks whether that claim still
holds, in both directions — every pairing you'd trust is worth being able to
re-check.

```bash
receipt2actual verify
```

A healthy vault:

```json
{
  "checked_at": "2026-09-15T18:04:00.000Z",
  "vault_root": "/home/you/ActualReceipts",
  "pairings_checked": 12,
  "ok": 12,
  "orphan_files": [],
  "orphan_index_entries": [],
  "malformed_lines": [],
  "exit_code": 0
}
12/12 pairings ok, 0 orphan(s)
```

A vault with problems — a receipt file deleted by hand, a transaction removed
from the budget, a note hand-edited or cleared, a file whose bytes no longer
match what was paired, a stray file nobody indexed:

```json
{
  "checked_at": "2026-09-15T18:05:00.000Z",
  "vault_root": "/home/you/ActualReceipts",
  "pairings_checked": 12,
  "ok": 9,
  "orphan_files": ["/home/you/ActualReceipts/2026/08/stray-file.pdf"],
  "orphan_index_entries": [
    {"txn_id": "a1b2c3d4-...", "vault_path": "/home/you/ActualReceipts/2026/09/a1b2c3d4__costco.pdf", "reason": "file_missing"},
    {"txn_id": "b2c3d4e5-...", "vault_path": "/home/you/ActualReceipts/2026/09/b2c3d4e5__coffee.pdf", "reason": "note_marker_missing_or_changed"},
    {"txn_id": "c3d4e5f6-...", "vault_path": "/home/you/ActualReceipts/2026/09/c3d4e5f6__amazon.pdf", "reason": "hash_mismatch"}
  ],
  "malformed_lines": [],
  "exit_code": 1
}
9/12 pairings ok, 4 orphan(s)
```

`verify` exits non-zero the moment anything doesn't check out, so a script or
a cron job can gate on the exit code alone. `list --orphans` gives the same
walk as a shorter, human-readable list instead of the full JSON report.
`list` on its own prints every current pairing.

## Moving the vault, or the budget, to a new machine

The note marker is an absolute path, so it only resolves on the machine that
wrote it — **one machine per budget** is the rule in v1. If you move the
vault folder to a new location, or a new computer, `relink` rewrites every
marker and the index to match:

```bash
receipt2actual relink --from /old/ActualReceipts --to /new/ActualReceipts --dry-run
# move the folder yourself, e.g.:
mv /old/ActualReceipts /new/ActualReceipts
receipt2actual relink --from /old/ActualReceipts --to /new/ActualReceipts
```

`relink` doesn't move any files itself — it only updates the markers and the
index to match a move you've already made — and re-runs `verify` at the end
so you know right away if anything didn't line up.

## What it will not do

- No OCR. A scanned or image-only PDF is refused, not guessed at.
- It never touches anything on a transaction but the note field — amount,
  payee, date, category, and cleared status are always left exactly as
  Actual has them.
- It doesn't work across machines without `relink` — the note is an absolute
  path, and absolute paths from one machine don't resolve on another.

## Development

```bash
npm install
npm test
```

The tests build a throwaway local budget for every case — no server, no
fixtures checked into the repo.

## License

MIT. See [LICENSE](LICENSE); the brand carve-out is in [NOTICE](NOTICE).
Security issues: see [SECURITY.md](SECURITY.md).

Not affiliated with Actual Budget. Built by [Ildana](https://ildana.ai).
