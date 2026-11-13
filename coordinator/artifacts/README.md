# coordinator/artifacts

The coordinator's local base for verifying contributions. These are large
(~GB) and **not committed** (see `.gitignore`); the organizer puts them here.

| file | what | size |
|------|------|------|
| `circuit_0000.zkey` | genesis full zkey — the starting point. The coordinator reattaches its frozen sections 3–7 to each contribution (`zkas`) and verifies (`zkvi`). | ~1.2 GB |
| `pot_final.ptau` | phase-1 output (`prepare phase2`), the ptau `zkvi` checks against. | ~2.4 GB |

`attestor.js`, `admin.js seal`, and `audit.js` default or rebuild around these
artifacts; override with the env vars to point elsewhere where supported. Seal
needs both local artifacts because it reassembles and verifies the final full
zkey before closing, then writes and uploads `final.p2c`, `final.zkey`, and
`final.vkey.json`.

How they're produced: `pot_final.ptau` is the phase-1 file for zkLogin v2. Its
base is `challenge_0087` of the Perpetual Powers of Tau (86 contributions). It
is reduced from 2^28 to 2^21. The final beacon is drand round 6440000. Its
BLAKE2b-512 / `b2sum` is the on-chain `phase1_digest`. `create.js --ptau`
computes that digest from the file.

`circuit_0000.zkey` is `g16s(r1cs, pot_final.ptau)`.
The genesis blob uploaded to Walrus is the *compressed* `circuit_0000.v2params`
(the mutable sections only), derived from this zkey with `zkex`.
