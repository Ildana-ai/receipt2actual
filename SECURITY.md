# Security

receipt2actual reads and writes your budget through Actual's own API library,
copies receipt files into a folder on your own disk, and writes one field —
the transaction note — back to the budget. It never touches amount, payee,
date, category, or cleared status. The only network connection is the one
Actual's API library opens to the sync server you configured, if you use
server mode; local (no-server) mode makes no network connection at all.
Nothing is uploaded anywhere else, and there is no telemetry.

The password, sync ID, and encryption password come from environment
variables and are never written to disk by this tool, never appear in the
command line, and never appear in `vault.jsonl`. Actual's API keeps a working
copy of the budget in `ACTUAL_DATA_DIR` (default `.actual-data` in the current
folder); treat that folder as you would the budget itself.

The vault directory (default `~/ActualReceipts`) holds a plain copy of every
receipt you pair, plus `vault.jsonl`, an index of what was paired to what.
Neither is encrypted by this tool — protect the vault the way you'd protect
the receipts themselves.

Because the transaction note stores an absolute file path, a receipt vault is
tied to the machine that wrote it. Moving the vault or the budget to a new
machine needs `relink`; see the README.

## Reporting a problem

Email **hello@ildana.ai**. A confirmed issue is fixed in a new release and
credited in the release notes if you want it to be.
