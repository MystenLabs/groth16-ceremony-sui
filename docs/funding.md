# Automatic contributor funding

This document is for the organizer. It describes how the coordinator pays contributors,
which files record the payouts, and how to recover after an unclean shutdown.

## How it works

Creating a ceremony generates a random shared secret in the run's private
`funding-secret.json`, enabled by default. The on-chain `coordinator_url` contains
only the public base URL; it cannot authorize payouts. The coordinator's existing
HTTP server accepts `POST /fund/<secret>` with `{address, ceremonyId, network}`.
It uses the organizer wallet to send 0.06 SUI + 0.30 WAL on testnet; permissioned ceremonies
also allowlist the recipient in the same transaction. It accepts new automatic
payouts only during `Phase2Contribute`.

Funding amounts are configured per network in `cli/src/funding-policy.js`. Testnet
defaults to **0.06 SUI + 0.30 WAL** per new contributor; contributor balance
checks require **0.04 SUI + 0.15 WAL**. The WAL payout covers two uploads at the
measured cost, with enough left after the first to pass the retry balance check. These budgets target ~114.8 MiB compressed
zkLogin contributions stored for 53 epochs: the testnet rehearsal measured
0.120434316 WAL per upload. Mainnet starts at
**0.10 SUI + 6 WAL**, with **0.05 SUI + 3 WAL** minimum balances. A read-only
mainnet quote on 2026-09-17 returned 2.636464920 WAL for a 120,374,615-byte upload
at 53 epochs, plus a relay fee of 0.023694320 SUI. The SUI budget includes a
conservative allowance based on testnet gas measurements. The mainnet defaults
are not yet validated by an end-to-end mainnet run. Recheck `admin.js cost` for different artifact sizes or prices.

Override either automatic payout amount when starting the attestor:

```bash
node coordinator/src/attestor.js --run "$RUN" --network "$NETWORK" --port 8090 \
  --airdrop-sui 0.1 --airdrop-wal 0.4
```

Amounts are in SUI/WAL units (up to nine decimal places), must meet the contributor
minimums, and override only the selected network's defaults. The attestor logs the
effective amounts when starting its HTTP server. Restart it to change these flags.
Overrides apply only to **new payouts**: funded addresses keep their existing
receipts, and unresolved transactions retry their original amounts. To replenish
an existing wallet, use `admin.js fund <address> --sui <amount> --wal <amount>`;
manual top-ups keep independent overrides and can be below contributor minimums.

Admin commands (all accept `--run` and `--network`):

| Command | Effect |
| --- | --- |
| `funding-url` | Print the private URL; create the secret if missing on an older run |
| `disable-funding` | Stop new automatic enrollment/payouts |
| `enable-funding` | Resume with the existing secret and payout history |
| `rotate-funding-secret` | Replace the secret, preserving enabled/disabled status and payout history |
| `enroll-without-funding 0x…` | Only allowlist |
| `fund 0x…` | Explicit, repeatable manual top-up without changing enrollment |

The contributor CLI uses existing wallet funds first, requesting funding through
its private URL only if the balance is insufficient. Without enough funds or a
URL, it asks the contributor to fund the printed address or rerun with a URL.
Confirmed automatic payouts are recorded in the contributor workdir: only those
contributors automatically return leftover SUI/WAL after acceptance, regardless
of ceremony access mode. Other funds remain in the contribution wallet; use the
explicit `ceremony refund` command to return manually supplied funds if desired.

Funding configuration is read for each request, so no restart is required.
Access-mode changes do not change funding configuration. Disabling cannot cancel
a transaction already submitted. Rotation immediately invalidates the old URL
for new requests. `funding-url` does not enable disabled funding. The
`/enroll-request` endpoint only logs a request; approval stays manual.

## Payout history

`funding-payouts.jsonl` is an append-only, owner-readable text file: one JSON
record per payout transition, keyed by network/ceremony/normalized address. It
records signed transaction bytes **before submission**, then the confirmed
outcome. Unknown outcomes retain the same signed transaction for reconciliation
or resubmission; only confirmed failed transactions can be replaced. Automatic
funding uses this history. A previously funded address
gets its original receipt, with no new payment or automatic re-enrollment.
Manual `fund` is a separate top-up operation accepting exactly one address. Never delete payout history to
rotate a secret or disable funding.

## Wallet lock and recovery

Coordinator transactions, Walrus uploads, package publication, and manual funding share `funding.lock` to avoid
concurrent wallet use and history writes. Use one local run directory for all
operations on that ceremony; separate copies cannot coordinate payouts. After
an unclean shutdown, check the PID in `funding.lock`, establish that the owner
has stopped. If the lock contains `unresolved`, reconcile that operation before
removing the lock: a transaction entry contains its digest and signed bytes for
lookup or identical resubmission; an external-tool entry requires checking the
tool's transactions and ensuring none remain in flight. External-tool errors
conservatively retain the lock even if they happened before submission. After
reconciliation, remove only the lock file before restarting. Keep the payout
history: retries will recover its recorded transactions. A torn final log line
is discarded; corrupt complete records stop funding for operator inspection.
An unresolved payout blocks subsequent wallet transactions, even after a restart;
retry the original payout request to resolve it before proceeding.

## Secrets and backups

The secret, payout history, and lock are excluded from Git. Keep the entire run
directory private, and publish only explicitly selected manifests/artifacts—never
export the run directory wholesale. Both the secret and payout history belong in
private backups. Configure HTTPS at the reverse proxy and suppress/redact access
logs for `/fund/*`, including error logs. Normal application output does not print
the private URL; only `funding-url` prints it intentionally.

There is no spending cap or identity quota: anyone holding the shared secret can
request funding for fresh addresses. Per-address tracking prevents duplicate
payouts; it does not prevent that accepted use of the shared credential.
