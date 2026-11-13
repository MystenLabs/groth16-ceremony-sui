# coordinator/artifacts

The coordinator's local base for verifying contributions. These are large
(~GB) and **not committed** (see `.gitignore`); the organizer puts them here.

| file | what | size |
|------|------|------|
| `circuit_0000.zkey` | genesis full zkey — the starting point. The coordinator reattaches its frozen sections 3–7 to each contribution (`zkas`) and verifies (`zkvi`). | ~1.2 GB |
| `pot_final.ptau` | phase-1 output (`prepare phase2`), the ptau `zkvi` checks against. | ~1.1 GB |

`attestor.js`, `admin.js seal`, and `audit.js` default or rebuild around these
artifacts; override with the env vars to point elsewhere where supported. Seal
needs both local artifacts because it reassembles and verifies the final full
zkey before closing, then writes and uploads `final.p2c`, `final.zkey`, and
`final.vkey.json`.

How they're produced: `pot_final.ptau` is the public phase-1 artifact from
[`sui-foundation/zklogin-ceremony-contributions/phase1`](https://github.com/sui-foundation/zklogin-ceremony-contributions/tree/main/phase1)
(PPOT `challenge_0081` reduced to 2^20, drand beacon contribution, imported as
`pot20.ptau`, then `prepare phase2`). Its BLAKE2b-512 / `b2sum` is the
on-chain `phase1_digest`:

```text
516fdf98bef4ab474bf01e336c801b275bdb4c5209ad06351b1f1ebc6f7060b77c11c9adaf861a776e77c2eff9f22cb4dae29fcab12f97489a9f049339904b3c
```

`circuit_0000.zkey` is `g16s(r1cs, pot_final.ptau)`.
The genesis blob uploaded to Walrus is the *compressed* `circuit_0000.v2params`
(the mutable sections only), derived from this zkey with `zkex`.
