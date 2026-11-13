# groth16-sui-ceremony

A Groth16 phase-2 trusted-setup ceremony, orchestrated on Sui and stored on
Walrus. Generic across circuits (zkLogin v2 is the first user); nothing here is
zkLogin-specific.

The organizer must explicitly choose **permissionless** contributions with
`--permissionless` or an organizer-managed allowlist with `--permissioned`.
In permissionless mode, anyone claims the single open slot,
downloads the current params, runs a phase-2 contribution, uploads the result
to Walrus, and submits it. A central **coordinator** (admin == attestor)
verifies each contribution off-chain and `accept`s it to advance the chain — a
two-phase commit, so a bad or missing contribution never corrupts the head.

Phase 1 (powers of tau) is **inherited, not run here**: the ceremony adopts the
public [sui-foundation phase-1 transparency](https://github.com/sui-foundation/zklogin-ceremony-contributions/tree/main/phase1)
output (`pot_final.ptau`) and commits its hash on-chain as `phase1_digest`.

## Packages

To contribute, install Git and Node.js 22, 24, or 26. Then run:

```bash
git clone https://github.com/MystenLabs/groth16-ceremony-sui.git
./groth16-ceremony-sui/ceremony contribute
```

The command asks for the organizer's funding link, your public name, and some
random text. Then it does the rest. `ceremony.json` selects the ceremony.
See the [contributor instructions](cli/README.md) for details and options.

| dir | what |
|-----|------|
| `move/` | Sui Move module `groth16_phase2` — the shared `Ceremony` object with a linear lifecycle `Phase`: `Setup` (`create_ceremony` commits `phase1_digest` + the r1cs blob; `approve_r1cs` collects k-of-n auditor attestations) → `Phase2Contribute` (contributions, governed by the `Slot` sub-machine `Open → Claimed → Pending → Open`) → `Phase2Beacon` (final beacon drawn, frozen) → `Closed`. The `OrganizerCap` (bound to its ceremony) gates `start_phase_2`/`accept`/`reject`/`finalize_phase2`/`submit_final` (the seal, which also closes), plus `set_access_mode`, which flips a live ceremony between permissioned and permissionless while retaining the allowlist. `finalize_phase2` draws the single on-chain random beacon (Sui RNG). |
| `cli/` | Unattended contributor. Point it at a `Ceremony` object id: it reads the head, pulls the predecessor blob from Walrus, claims, contributes, uploads, and submits — supports self-funding or private automatic enrollment/funding, then runs untouched. Crypto isolated in `cli/src/crypto.js`, contract calls in `cli/src/chain.js`. |
| `coordinator/` | Organizer's toolkit. Cryptographic workflows, Walrus operations, and artifact trust checks in [`src/crypto/`](coordinator/src/crypto/README.md), Sui/process adapters and general utilities in `src/lib/`; on top: the bootstrapper (`src/create.js`, including Move compile/verify/reuse/publish), the attestor loop (`src/attestor.js` — `check head extension → decompress → assemble → verifyFromInit → bind submitted hash`, then `accept`/`reject`), the coordinator HTTP server (`src/coordinator_http.js` — heartbeats, telemetry, append-only enrollment requests), the genesis builder (`src/genesis.js` — `g16s` + extract + compress on the adopted ptau), the read-only auditor (`src/audit.js`), and admin commands (`src/admin.js`: `status`/`set-url`/`approve-r1cs`/`start-phase2`/`reject-pending`/`finalize-phase2`/`seal`/`set-access-mode`). |

The snarkjs pipeline is a pinned `MystenLabs/snarkjs` git dependency (see the
`package.json`s), not vendored here.

The pinned fork currently leaves a phase-1 ptau `FileHandle` for garbage
collection after some verification paths. Node 24 reports this as a non-fatal
`DEP0137` warning even when verification succeeds; do not confuse the warning
with a failed ceremony command.

## Running a ceremony

The canonical Move package publication lives in committed
`move/Published.toml`. Every ceremony gets a name and an isolated
private/runtime directory:

```text
ceremony-runs/<run>/
├── manifest.json
├── state.json
├── artifacts/
├── blobs/
├── logs/
└── audit/
```

The manifest is the operator's run-local provenance record: package snapshot,
ceremony and cap ids, circuit and phase-1 commitments, Walrus blobs, transaction
digests, and final artifacts. The on-chain `Ceremony` object is authoritative
for current lifecycle state. Coordinator signing commands use that run's
`state.json`, initialized from the Sui CLI active address.
A fresh clone contains only `ceremony-runs/.gitignore`, which keeps the
operator workspace visible without tracking its contents. `key.js init --run
<name>` creates the nested run directory recursively, and later commands create
`artifacts/`, `blobs/`, `logs/`, and `audit/` as they need them.
Coordinator commands refuse to sign if `sui client active-address` no longer
matches that stored key, keeping Sui SDK transactions and Walrus CLI uploads on
the same operator wallet. Coordinator blob reads/writes use the `walrus` CLI, so
the selected network needs a configured/funded Walrus/Sui CLI wallet. From the
repo root, run `coordinator/scripts/install-walrus.sh` to install or update the
default `walrus@testnet` CLI through `suiup`.

```sh
# 0. Use the Node 24 LTS line and install the two workspaces after a fresh clone.
nvm install
nvm use
npm --prefix coordinator ci
npm --prefix cli ci

# Choose a stable run name. All coordinator lifecycle commands accept --run.
RUN=zklogin-mock-aug31
NETWORK=testnet

# 1. Initialize coordinator/admin signing from the active Sui CLI key.
node coordinator/src/key.js init --run "$RUN"

# Install/update the Walrus CLI used by coordinator blob I/O.
coordinator/scripts/install-walrus.sh

# 2. adopt phase 1: download the public pot_final.ptau into coordinator/artifacts/
curl -L -o coordinator/artifacts/pot_final.ptau \
  https://media.githubusercontent.com/media/sui-foundation/zklogin-ceremony-contributions/main/phase1/pot_final.ptau

# Optional read-only input identity checks, useful before or during a run.
walrus --context "$NETWORK" --json blob-id circuit.r1cs
sha256sum circuit.r1cs coordinator/artifacts/pot_final.ptau
b2sum circuit.r1cs coordinator/artifacts/pot_final.ptau

# 3. SETUP: create the ceremony, committing phase1_digest (= b2sum of pot_final.ptau)
#    + the r1cs blob. --coordinator-url is published on-chain for the coordinator HTTP server.
#    Before any ceremony transaction, create.js compiles move/, verifies it against
#    the selected network's package in move/Published.toml, and reuses it on a match.
#    If no matching publication exists, it asks before publishing a fresh package.
node coordinator/src/create.js --run "$RUN" --network "$NETWORK" \
  --r1cs circuit.r1cs --ptau coordinator/artifacts/pot_final.ptau \
  --auditors 0xAUD1,0xAUD2 --threshold 2 --coordinator-url https://coordinator.example \
  --permissionless
#    Optional: --slot-duration-secs 1200 gives each claimant 20 minutes; the default
#    is 900 seconds (15 minutes), with a maximum of 3600 seconds (one hour).
#    The organizer can change it for future claims.
#    Coordinator uploads use `walrus store --permanent --share --json` and verify
#    the resulting content blob id + SharedBlob.
#    If a blob was uploaded out-of-band, skip upload with --r1cs-shared-blob 0xSHARED.
#    Supplying --r1cs as well recomputes its Walrus blob id and requires it to
#    match that SharedBlob. Supplying both --ptau and --phase1-hash similarly
#    requires the local phase-1 file to match the declared digest.
#    Omitting --auditors (threshold 0) skips the approval gate: start-phase2 proceeds
#    directly with no attestation to the r1cs. Recommended for rehearsals only.
#    Choose --permissioned [--allowlist 0xA,0xB] instead for an allowlisted ceremony;
#    manage it later with admin.js enroll-without-funding / remove-contributors.
#    For non-interactive operation, --publish-package grants publish permission;
#    --no-publish-package fails instead of prompting.

# 4. build the genesis (g16s + extract + compress) from the adopted ptau + r1cs,
#    collect auditor approvals (skipped when none are listed), then seed + open phase 2.
node coordinator/src/genesis.js --run "$RUN" --r1cs circuit.r1cs \
  --ptau coordinator/artifacts/pot_final.ptau
node coordinator/src/genesis.js verify --run "$RUN" --r1cs circuit.r1cs \
  --ptau coordinator/artifacts/pot_final.ptau
node coordinator/src/admin.js approve-r1cs --run "$RUN" --network "$NETWORK"   # once per auditor; omit when we dont have any
node coordinator/src/admin.js start-phase2 --run "$RUN" --network "$NETWORK" \
  --genesis "ceremony-runs/$RUN/artifacts/circuit_0000.p2c"

# 5. run the coordinator (organizer): verify + accept/reject, serve funding and telemetry.
#    The base zkey defaults to the run's artifacts/; the ptau path comes from
#    manifest.json. Explicit --base-zkey/--base-ptau overrides are available.
node coordinator/src/attestor.js --run "$RUN" --network "$NETWORK" --port 8090

# 6. Get the private funding URL (organizer). Share its output privately.
node coordinator/src/admin.js funding-url --run "$RUN" --network "$NETWORK"
# Commit the ceremony ID and network to ceremony.json, so that contributors run
# only `./ceremony contribute`. The CLI asks them for the funding URL (hidden).
# Self-funded contributors press Enter there, then send the printed address to
# the organizer for enroll-without-funding. For a rehearsal without ceremony.json:
./ceremony contribute --ceremony <ceremony-object-id> --network "$NETWORK"

# Allowlist self-funded contributors or manually top up funds:
node coordinator/src/admin.js enroll-without-funding 0xA,0xB --run "$RUN" --network "$NETWORK"
node coordinator/src/admin.js fund 0xA --run "$RUN" --network "$NETWORK"
# Switch modes mid-ceremony (Setup or Phase2Contribute); opening up retains the allowlist for a later re-close.
node coordinator/src/admin.js set-access-mode permissionless --run "$RUN" --network "$NETWORK"
# Funding is independent of access mode; disable it separately when desired.
node coordinator/src/admin.js disable-funding --run "$RUN" --network "$NETWORK"

# 7. PHASE 2 conclude (organizer).
node coordinator/src/admin.js finalize-phase2 --run "$RUN" --network "$NETWORK"

#    Seal requires the same local BASE_ZKEY/BASE_PTAU artifacts as the attestor,
#    writes verified final.{p2c,zkey,vkey.json}, uploads all three to Walrus, and closes.
node coordinator/src/admin.js seal --run "$RUN" --network "$NETWORK"

# 8. Audit after close. Recomputes input blob ids and hashes, byte-compares the
#    downloaded R1CS with the manifest's local input when available, verifies
#    final zkey against r1cs+ptau, walks on-chain blobs for contribution
#    order/inclusion, then byte-checks final params/vkey.
#    Walrus blobs are cached under the run's blobs/ directory.
node coordinator/src/audit.js --run "$RUN" --network "$NETWORK"
```

`--manifest <file>` and `--workdir <dir>` support custom layouts. The old
`--deployments` and create-time `--out` flags remain temporary aliases and emit
warnings.

## Mock Ceremony Rehearsal

For a cheap one-contributor testnet rehearsal, run the mock runner on the remote
ceremony host from the repo root:

```sh
cd coordinator
npm run mock:ceremony
```

Use `CONTRIBUTOR_COUNT=3 FUNDING_MODE=automatic npm run mock:ceremony` to
exercise private automatic enrollment with three contributors. The default
`FUNDING_MODE=self-funded` exercises manual enrollment and balance polling.
Use `CONTRIBUTOR_COUNT=4 FUNDING_MODE=mixed npm run mock:ceremony` to alternate
self-funded and automatic contributors, two of each, in the same ceremony.
Contributors run sequentially; their funding modes are recorded in the run summary.

By default it builds a tiny square circuit inside a fresh run directory, so the
Walrus uploads are small. Each run is isolated under
`ceremony-runs/mock-<timestamp>/` using the same layout as a real
ceremony:

- `artifacts/` — generated `square.r1cs`, `pot_final.ptau`, genesis zkey/p2c
- `manifest.json` — run-specific on-chain and Walrus record
- `state.json` — protected organizer key exported from the active Sui address
- `blobs/` — Walrus read cache
- `logs/` — create/admin/attestor/contributor/seal/audit logs
- `contributors/` — contributor key state and receipt JSON
- `audit/` — final audit scratch data

The runner compiles and verifies the package in `move/Published.toml`, reusing
it when it matches. If it does not match, `PUBLISH_PACKAGE=auto` asks before a
fresh publish, `PUBLISH_PACKAGE=1` pre-authorizes publishing, and
`PUBLISH_PACKAGE=0` refuses to publish.

Set `ARTIFACT_MODE=existing` with `R1CS=... PTAU=... BASE_ZKEY=... GENESIS=...`
to rehearse against prebuilt artifacts instead.

## Status

Slot duration is stored on each ceremony as `slot_duration_ms`; Move has no default.
`create.js --slot-duration-secs` accepts positive whole seconds up to 3600 (one hour) and records the
duration in the run manifest. A claim uses the configured duration from its claim
time, including after an expired slot is reopened. Submission is allowed at the
exact deadline; anyone may reopen the slot only after it. The organizer can update
it during setup or contributions:

```sh
node coordinator/src/admin.js set-slot-duration --run "$RUN" --network "$NETWORK" \
  --slot-duration-secs 1200
```

Updates require the ceremony's `OrganizerCap` and affect only future claims.
Move enforces the one-hour maximum at creation and on updates; both CLI commands
reject larger values before submitting a transaction.
An active claim keeps its original deadline, and a pending contribution remains
pending until accepted or rejected. Changes are rejected after the final beacon.
The admin command records the updated duration and transaction in the manifest.

This object-layout and `create_ceremony` signature change requires a **fresh Move
package publication and a new ceremony**; it is not a compatible in-place upgrade.
Existing ceremonies keep their original duration. Contributor transactions do not
change: they already read the on-chain claim deadline.

`move/` tests pass (`cd move && sui move test`). The phase-2 lifecycle —
`create_ceremony` → `approve_r1cs` → `start_phase_2` → contribute → coordinator
head-extension check + `verifyFromInit` + `accept` → `finalize_phase2` → `seal`
→ audit — was validated end-to-end on live testnet on 2026-09-08 with a small
circuit. It closed with one participant plus the final beacon and ended with
`audit OK`. An earlier revision was also exercised against the real zkLogin
circuit (~1M constraints, `verifyFromInit` ~60 s). Phase 1 is the adopted public
sui-foundation powers-of-tau (`pot_final.ptau`, 2^21); the genesis is `g16s` of
that ptau + the `--O2` circuit r1cs.


### Approximate contribution activity

The coordinator serves `GET /queue?ceremonyId=<Sui object ID>`:

```json
{"waitingCount":5,"asOf":"2026-09-11T15:00:00.000Z"}
```

`waitingCount` counts distinct contributor addresses reporting `waiting_for_slot`
through `POST /heartbeat`, scoped to the ceremony. The CLI reports this state only
when funded and eligible to claim, while another contributor holds the slot or
awaits verification. Funding/approval waits and the active contributor are excluded.
Heartbeats run every 30 seconds; entries expire after 90 seconds without a refresh.
State changes are reported immediately, best effort. The endpoint requires a valid
ceremony ID (otherwise HTTP 400), returns `Cache-Control: no-store`, and exposes
no contributor identities.

This is self-reported activity, not an ordered queue or a guaranteed wait time.
Clients without reporting are invisible; disconnected clients can remain counted
until expiry. Counts reset on coordinator restart and describe this server's
clients only. An empty count does not establish that the on-chain slot is open.

Consumers can estimate activity as `waitingCount` times the ceremony's on-chain claim
window, `slot_duration_ms` (15 minutes by default), which bounds how long each waiting
contributor can hold the slot. Up to 60 minutes, display e.g. “About 5 contributors waiting · roughly 50
minutes of contribution activity.” Above 60 minutes: “The ceremony is busy. Try
checking back in a few hours.” Include “Estimates are approximate; availability
may change.” The CLI shows activity once when it begins waiting and tells users
they can leave it running; it continues trying to claim regardless of this endpoint.
The shared CLI formatter in `cli/src/queue-activity.js` supports both messages.

## Automatic contributor funding

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
conservative allowance based on testnet gas measurements. **TODO: validate and
tune mainnet defaults after an end-to-end mainnet mock.** Recheck `admin.js cost` for different artifact sizes or prices.

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
| `enroll-without-funding 0x…` | Only allowlist; replaces the old command name outright |
| `fund 0x…` | Explicit, repeatable manual top-up without changing enrollment |

The contributor CLI uses existing wallet funds first, requesting funding through
its private URL only if the balance is insufficient. Without enough funds or a
URL, it asks the contributor to fund the printed address or rerun with a URL.
Confirmed automatic payouts are recorded in the contributor workdir: only those
contributors automatically return leftover SUI/WAL after acceptance, regardless
of ceremony access mode. Other funds remain in the contribution wallet; use the
explicit `ceremony refund` command to return manually supplied funds if desired.
The combined manual `enroll` and `enroll-pending` commands have been removed.

Contributors have the ceremony's claim window, `slot_duration_ms` (15 minutes by default, at most one hour), from claim to submission.
Attestor verification runs after submission and is outside that window. Retries
reuse an existing unexpired claim and display its remaining time using Sui's
clock. Expired claims return to the usual expire-and-claim flow; retrying does
not reset a live deadline.

Slot availability and manual-funding balances are checked every 30 seconds by
default; contributors can tune this with `--poll-interval 60`, for example.

Funding configuration is read for each request, so no restart is required.
Access-mode changes do not change funding configuration. Disabling cannot cancel
a transaction already submitted. Rotation immediately invalidates the old URL
for new requests. `funding-url` does not enable disabled funding. Public enrollment
requests/manual approval remain a TODO for the new contributor flow; the older
logging endpoint and read-only pending-request viewer remain available.

### Ceremony status page

With the attestor's HTTP server enabled (`--port 8090`), `/status` shows the
ceremony phase, accepted contribution count, slot and claim deadline, approximate
waiting count, latest 20 accepted contributions, and attestor activity. It
refreshes every 30 seconds. Names come from on-chain submissions; a first-time
claimant's name is not yet available. The accepted count includes the final beacon
contribution once the ceremony is closed.

`GET /status.json` returns HTTP 200 for fresh, healthy attestor activity or HTTP
503 during startup, after a loop failure, or when activity becomes stale. It uses
the existing loop's observations, without additional Sui requests per viewer.
Polling gets at least 30 seconds of grace (or three polling intervals);
downloads and verdict transactions get two minutes; isolated verification gets
its configured timeout plus one minute. These are activity deadlines, not proof
that every operation is making progress. Long synchronous downloads can also
temporarily prevent the HTTP server from responding. Connection failures leave
the page's previous data visible with an explicit outdated-data warning.

Serve the static assets with Caddy so the page remains reachable when the attestor
is down. An example configuration is in `coordinator/Caddyfile.example`:

```bash
sudo install -d -m 755 /var/www/zkceremony-status
sudo install -m 644 coordinator/src/status_page.html coordinator/src/status_page.js /var/www/zkceremony-status/
# Merge the example's /status and /status.js routes into your Caddyfile.
# Keep /status.json proxied to the attestor, along with the existing API routes.
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl reload caddy
```

Only these two public files belong in the static directory. The status API
exposes public ceremony data and operational timestamps, not private funding
URLs, wallet state, raw errors, or telemetry logs. `/healthz` remains the Caddy
connectivity check. For an attestor health check from a script, use
`curl --fail --show-error --max-time 10 https://zkceremony.sui.io/status.json`.
Restart the attestor after installing the backend changes to activate monitoring.
The contributor CLI checks this endpoint immediately before claiming or resuming
a slot, including when a slot becomes available after waiting. It requires a
healthy response for the same ceremony/network and stops with same-workdir retry
guidance on failure, before any claim transaction or contribution computation.
Chain contributions therefore require a configured public coordinator URL and
an attestor exposing `/status.json`; older servers without this endpoint must be
updated. Automatic funding, if needed, happens before this readiness check.

`funding-payouts.jsonl` is an append-only, owner-readable text file: one JSON
record per payout transition, keyed by network/ceremony/normalized address. It
records signed transaction bytes **before submission**, then the confirmed
outcome. Unknown outcomes retain the same signed transaction for reconciliation
or resubmission; only confirmed failed transactions can be replaced. Automatic
funding uses this history. A previously funded address
gets its original receipt, with no new payment or automatic re-enrollment.
Manual `fund` is a separate top-up operation accepting exactly one address. Never delete payout history to
rotate a secret or disable funding.

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

The secret, payout history, and lock are excluded from Git. Keep the entire run
directory private, and publish only explicitly selected manifests/artifacts—never
export the run directory wholesale. Both the secret and payout history belong in
private backups. Configure HTTPS at the reverse proxy and suppress/redact access
logs for `/fund/*`, including error logs. Normal application output does not print
the private URL; only `funding-url` prints it intentionally.

There is no spending cap or identity quota: anyone holding the shared secret can
request funding for fresh addresses. Per-address tracking prevents duplicate
payouts; it does not prevent that accepted use of the shared credential.
