# Running a ceremony

This document is for the organizer. It shows each step from a fresh clone to the audit of a closed ceremony.
Contributors need only the [contributor instructions](../cli/README.md).

Related documents:

- [Automatic contributor funding](funding.md)
- [Status page and monitoring](status-and-monitoring.md)
- [Cryptographic audit map](../coordinator/src/crypto/README.md)

## Run directory

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

`--manifest <file>` and `--workdir <dir>` support custom layouts. The old
`--deployments` and create-time `--out` flags remain temporary aliases and emit
warnings.

## Before you start

Check these items on the machine that runs the coordinator:

- The `walrus` binary and its configuration are for the network of the ceremony.
  `coordinator/scripts/install-walrus.sh` installs the testnet release by default.
- A supervisor (for example a systemd unit) restarts the attestor after a crash.
  A terminal multiplexer session does not do that.
- The Sui CLI active address is the organizer wallet, and it has SUI and WAL.

The pinned snarkjs fork currently leaves a phase-1 ptau `FileHandle` for garbage
collection after some verification paths. Node 24 reports this as a non-fatal
`DEP0137` warning even when verification succeeds; do not confuse the warning
with a failed ceremony command.

## Steps

### 0. Install

```sh
# Use the Node 24 LTS line and install the two workspaces after a fresh clone.
nvm install
nvm use
npm --prefix coordinator ci
npm --prefix cli ci

# Choose a stable run name. All coordinator lifecycle commands accept --run.
RUN=zklogin-mock-aug31
NETWORK=testnet
```

### 1. Initialize the organizer key and the Walrus CLI

```sh
# Initialize coordinator/admin signing from the active Sui CLI key.
node coordinator/src/key.js init --run "$RUN"

# Install/update the Walrus CLI used by coordinator blob I/O.
coordinator/scripts/install-walrus.sh
```

### 2. Adopt phase 1

Copy the phase-1 file into `coordinator/artifacts/`.
[`coordinator/artifacts/README.md`](../coordinator/artifacts/README.md) describes the file.

```sh
cp <phase-1 file> coordinator/artifacts/pot_final.ptau

# Optional read-only input identity checks, useful before or during a run.
walrus --context "$NETWORK" --json blob-id circuit.r1cs
sha256sum circuit.r1cs coordinator/artifacts/pot_final.ptau
b2sum circuit.r1cs coordinator/artifacts/pot_final.ptau
```

### 3. Create the ceremony

`create.js` commits `phase1_digest` (the `b2sum` of `pot_final.ptau`) and the R1CS blob.
`--coordinator-url` is published on-chain for the coordinator HTTP server.

```sh
node coordinator/src/create.js --run "$RUN" --network "$NETWORK" \
  --r1cs circuit.r1cs --ptau coordinator/artifacts/pot_final.ptau \
  --auditors 0xAUD1,0xAUD2 --threshold 2 --coordinator-url https://coordinator.example \
  --permissionless
```

Notes:

- **Package.** Before any ceremony transaction, `create.js` compiles `move/`, verifies it against
  the selected network's package in `move/Published.toml`, and reuses it on a match.
  If no matching publication exists, it asks before publishing a fresh package.
  For non-interactive operation, `--publish-package` grants publish permission;
  `--no-publish-package` fails instead of prompting.
- **Access mode.** Choose `--permissioned [--allowlist 0xA,0xB]` instead for an allowlisted ceremony;
  manage it later with `admin.js enroll-without-funding` / `remove-contributors`.
- **Auditors.** Omitting `--auditors` (threshold 0) skips the approval gate: `start-phase2` proceeds
  directly with no attestation to the r1cs. Recommended for rehearsals only.
- **Slot duration.** `--slot-duration-secs 1200` gives each claimant 20 minutes; the default
  is 900 seconds (15 minutes), with a maximum of 3600 seconds (one hour). See [Slot duration](#slot-duration).
- **Uploads.** Coordinator uploads use `walrus store --permanent --share --json` and verify
  the resulting content blob id + SharedBlob.
  If a blob was uploaded out-of-band, skip upload with `--r1cs-shared-blob 0xSHARED`.
  Supplying `--r1cs` as well recomputes its Walrus blob id and requires it to
  match that SharedBlob. Supplying both `--ptau` and `--phase1-hash` similarly
  requires the local phase-1 file to match the declared digest.

### 4. Build and verify the genesis, then open phase 2

Build the genesis (`g16s` + extract + compress) from the adopted ptau + r1cs.

```sh
node coordinator/src/genesis.js --run "$RUN" --r1cs circuit.r1cs \
  --ptau coordinator/artifacts/pot_final.ptau
node coordinator/src/genesis.js verify --run "$RUN" --r1cs circuit.r1cs \
  --ptau coordinator/artifacts/pot_final.ptau
```

> **`genesis.js verify` is mandatory.** `start-phase2` does not check the genesis file,
> and `start_phase_2` on chain is permanent. A wrong genesis makes each contribution
> useless, and only the audit after the close shows it. Use the same `circuit.r1cs`
> file that `create.js` committed.

Collect auditor approvals (skipped when none are listed), then seed + open phase 2.

```sh
node coordinator/src/admin.js approve-r1cs --run "$RUN" --network "$NETWORK"   # once per auditor
node coordinator/src/admin.js start-phase2 --run "$RUN" --network "$NETWORK" \
  --genesis "ceremony-runs/$RUN/artifacts/circuit_0000.p2c"
```

### 5. Run the attestor

The attestor verifies each submission, sends `accept` or `reject`, and serves funding and telemetry.
The base zkey defaults to the run's `artifacts/`; the ptau path comes from
`manifest.json`. Explicit `--base-zkey`/`--base-ptau` overrides are available.

```sh
node coordinator/src/attestor.js --run "$RUN" --network "$NETWORK" --port 8090
```

### 6. Admit contributors

```sh
# Get the private funding URL. Share its output privately.
node coordinator/src/admin.js funding-url --run "$RUN" --network "$NETWORK"
```

Commit the ceremony ID and network to `ceremony.json`, so that contributors run
only `./ceremony contribute`. The CLI asks them for the funding URL (hidden).
Self-funded contributors press Enter there, then send the printed address to
the organizer for `enroll-without-funding`. For a rehearsal without `ceremony.json`:

```sh
./ceremony contribute --ceremony <ceremony-object-id> --network "$NETWORK"
```

```sh
# Allowlist self-funded contributors or manually top up funds:
node coordinator/src/admin.js enroll-without-funding 0xA,0xB --run "$RUN" --network "$NETWORK"
node coordinator/src/admin.js fund 0xA --run "$RUN" --network "$NETWORK"
# Switch modes mid-ceremony (Setup or Phase2Contribute); opening up retains the allowlist for a later re-close.
node coordinator/src/admin.js set-access-mode permissionless --run "$RUN" --network "$NETWORK"
# Funding is independent of access mode; disable it separately when desired.
node coordinator/src/admin.js disable-funding --run "$RUN" --network "$NETWORK"
```

See [Automatic contributor funding](funding.md) for the funding commands and the recovery steps.

### 7. Conclude phase 2

`finalize-phase2` draws the final beacon and is permanent.
Seal requires the same local `BASE_ZKEY`/`BASE_PTAU` artifacts as the attestor,
writes verified `final.{p2c,zkey,vkey.json}`, uploads all three to Walrus, and closes.

```sh
node coordinator/src/admin.js finalize-phase2 --run "$RUN" --network "$NETWORK"
node coordinator/src/admin.js seal --run "$RUN" --network "$NETWORK"
```

### 8. Audit after close

The audit recomputes input blob ids and hashes, byte-compares the
downloaded R1CS with the manifest's local input when available, verifies
final zkey against r1cs+ptau, walks on-chain blobs for contribution
order/inclusion, then byte-checks final params/vkey.
Walrus blobs are cached under the run's `blobs/` directory.

```sh
node coordinator/src/audit.js --run "$RUN" --network "$NETWORK"
```

### 9. After the audit: consider an immutable package

The organizer key holds the `UpgradeCap` of the Move package. An upgrade can add
a function that changes the record of a closed ceremony. An immutable package
removes that possibility.

- Do this only after the ceremony is closed and the audit passes. Before that,
  an immutable package blocks the correction of a contract bug.
- The step is permanent.
- The id is in `manifest.json` as `package_upgrade_capability`.
- All ceremonies on the same package lose the upgrade path together.

```sh
sui client call --package 0x2 --module package --function make_immutable \
  --args <UpgradeCap id>
```

## Slot duration

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

Contributors have the ceremony's claim window, `slot_duration_ms` (15 minutes by default, at most one hour), from claim to submission.
Attestor verification runs after submission and is outside that window. Retries
reuse an existing unexpired claim and display its remaining time using Sui's
clock. Expired claims return to the usual expire-and-claim flow; retrying does
not reset a live deadline.

Slot availability and manual-funding balances are checked every 30 seconds by
default; contributors can tune this with `--poll-interval 60`, for example.

## Mock ceremony rehearsal

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
