# zklogin-v2-ceremony

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

Phase 1 (powers of tau) is **inherited, not run here**: the ceremony adopts a
phase-1 file (`pot_final.ptau`) and commits its hash on-chain as `phase1_digest`.
[`coordinator/artifacts/README.md`](coordinator/artifacts/README.md) describes that file.

## Contribute

To contribute, install Git and Node.js 22, 24, or 26. Then run:

```bash
git clone https://github.com/MystenLabs/zklogin-v2-ceremony.git
./zklogin-v2-ceremony/ceremony contribute
```

The command asks for the organizer's funding link, your public name, and some
random text. Then it does the rest. `ceremony.json` selects the ceremony.
See the [contributor instructions](cli/README.md) for details and options.

## How it works

1. **Setup.** The organizer creates a `Ceremony` object on Sui. It commits the phase-1 digest
   and the R1CS blob. Optional auditors approve the R1CS.
2. **Contributions.** One slot is open at a time. A contributor claims it, downloads the
   current parameters from Walrus, contributes, uploads the result, and submits it.
3. **Verification.** The coordinator verifies each submission off-chain. It then sends
   `accept`, which advances the head, or `reject`, which reopens the slot.
4. **Final beacon.** The organizer ends the contributions. The contract draws one random
   beacon from Sui, and the coordinator applies it and closes the ceremony.
5. **Audit.** Anyone can verify the full chain of contributions from the on-chain record
   and the Walrus blobs.

## Repository layout

| Directory | Content |
| --- | --- |
| `move/` | The Sui Move module `groth16_phase2`: the shared `Ceremony` object, its phases, and the slot rules. |
| `cli/` | The contributor CLI. See the [contributor instructions](cli/README.md). |
| `coordinator/` | The organizer tools: ceremony creation, the genesis builder, the attestor, admin commands, and the auditor. |
| `bench/` | Benchmarks of the contribution and verification steps. |
| `docs/` | Operator documents. |

The snarkjs pipeline is a pinned `MystenLabs/snarkjs` git dependency (see the
`package.json`s), not vendored here.

## Documentation

| Document | Reader |
| --- | --- |
| [Contributor instructions](cli/README.md) | Contributors |
| [Running a ceremony](docs/running-a-ceremony.md) | The organizer: each step from creation to audit, and the mock rehearsal |
| [Automatic contributor funding](docs/funding.md) | The organizer: payouts, the payout history, and recovery |
| [Status page and monitoring](docs/status-and-monitoring.md) | The organizer and integrators: the HTTP endpoints |
| [Cryptographic audit map](coordinator/src/crypto/README.md) | Reviewers of the cryptographic code |

## Status

`move/` tests pass (`cd move && sui move test`). The phase-2 lifecycle —
`create_ceremony` → `approve_r1cs` → `start_phase_2` → contribute → coordinator
head-extension check + `verifyFromInit` + `accept` → `finalize_phase2` → `seal`
→ audit — was validated end-to-end on live testnet on 2026-09-08 with a small
circuit. It closed with one participant plus the final beacon and ended with
`audit OK`. An earlier revision was also exercised against the real zkLogin
circuit (~1M constraints, `verifyFromInit` ~60 s). Phase 1 is the adopted
powers-of-tau file (`pot_final.ptau`, 2^21); the genesis is `g16s` of
that ptau + the `--O2` circuit r1cs.
