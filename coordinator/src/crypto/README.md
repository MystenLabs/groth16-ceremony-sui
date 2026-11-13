# Ceremony audit boundary

These eight JavaScript files collect the coordinator's cryptographic operations,
artifact trust checks, and ceremony verification workflows. Read
`verify_contribution.js`, `seal.js`, and `audit.js` for the protocol decisions,
then follow their calls into the dependency adapters and commitment helpers.
The contributor keeps its cryptographic primitives in `cli/src/crypto.js` and
its Walrus operations and storage policy in `cli/src/walrus.js`.

| File | Responsibility |
| --- | --- |
| `snarkjs.js` | snarkjs adapter: genesis construction, compressed-params ↔ full-zkey transformations, head-extension and full verification, beacon application, verification-key export, and contribution/circuit/beacon metadata parsing |
| `walrus.js` | Walrus SDK/CLI calls, local content identities, SharedBlob resolution, certification and retention checks, storage parameters, upload/download and cache handling |
| `commitments.js` | SHA-256/BLAKE2b file hashes and phase-1 commitment validation |
| `verify_contribution.js` | Contribution verification sequence, submitted-hash binding, accept/reject verdict, and base-circuit binding |
| `seal.js` | Beacon input validation, final artifact construction, and verification before releasing the outputs |
| `audit.js` | Closed-ceremony checks, artifact commitments, contribution history, final beacon, final params byte equality, and verification-key equality |
| `identity.js` | Coordinator secret-key import/persistence, active-address checks, and transaction signing |
| `funding_secret.js` | Funding-secret generation and constant-time comparison |

`snarkjs.js` is the only production coordinator file that imports snarkjs,
including its internal parsers and CLI entrypoint. Other modules use its
functions without depending on snarkjs internals.
`walrus.js` similarly owns all production coordinator Walrus SDK imports and
CLI calls. Its content-id computation, object identity checks, and storage
policy stay together with the operations that supply their inputs.

The shared conversion pipelines in `snarkjs.js` keep genesis, sealing, and audit
from maintaining independent extract/compress or decompress/assemble sequences.
The R1CS verifier command is shared by genesis verification and final audit.
File hashing uses Node read streams and native SHA-256/BLAKE2b-512; transcript
hashing uses the same native BLAKE2b-512 with snarkjs public-key serialization.
Hash and phase-1 commitment helpers are asynchronous and must be awaited.
The contributor passes its SDK keypair directly to Walrus for signing.
The general `lib/files.js` helper uses the standard macOS/Linux `cmp -s`
utility for exact file comparisons. The crypto audit owns the assertions about
which files must match. Exit 1 means different bytes; command and file-access
failures propagate as errors.
The generic `lib/json.js` helper sorts object keys and formats reproducible
JSON files. `seal.js` chooses to use those bytes for the published verification
key; `audit.js` derives the expected key and requires the published bytes to
match. The formatting helper remains an explicit dependency of those checks.
The local snarkjs workflows take file paths, scratch directories, and optional
logging/timing. The Walrus adapter owns its network and CLI operations;
command/chain adapters own ceremony polling and Sui transaction submission.

`lib/verify_contribution.js` obtains blobs through the Walrus adapter, enforces
the submission size limit, and supervises the bounded child in
`lib/verify_worker.js`. The child runs `crypto/verify_contribution.js`, including
transcript parsing and comparison against the pending on-chain contribution
hash. Inside `snarkjs.js`, explicit failed crypto checks and all exceptions
from wrapped contribution operations become the same rejection result, including
operational errors. This can reject valid contributions during infrastructure
failures. Errors outside the wrapper can still leave the slot pending and halt
the attestor loop. Callers do not inspect snarkjs error types, codes, or message text.
The expected contribution hash is mandatory in the cryptographic workflow,
including for benchmark and test callers; no mode skips the comparison.
Worker crashes and timeouts also reject. The attestor only submits the resulting
verdict, bound to the head, contributor, blob, and hash it read.
The worker measures its steps locally and sends one final result/error with
timings. A crash or timeout has no worker timings; the parent still reports
the failure and retains timings for its own completed steps.

The review also follows these dependencies outside this directory:

- `move/sources/groth16_phase2.move` for authorization, lifecycle transitions,
  on-chain randomness, and binding acceptance to the expected slot/head.
- `src/lib/verify_contribution.js` and `src/lib/verify_worker.js` for resource
  limits, worker supervision, and forwarding the complete verification verdict.
- Command/chain adapters for selecting the correct inputs, transaction contents,
  and acting on verification results; contributor state handling for secret-key
  storage, entropy input, and checkpoint recovery.
- The pinned MystenLabs snarkjs dependency, its internal artifact parsers, Sui
  signing SDK, and Walrus SDK/CLI. These modules invoke those implementations;
  they do not reimplement the cryptographic primitives.

`test/crypto-boundary.test.js` guards direct crypto imports and key/RNG calls
outside these locations, enforces the snarkjs and Walrus dependency boundaries,
and restricts imports from `lib/` to the documented utilities.
It is a source-level architectural guard, not a proof of complete isolation.
Test fixtures and benchmark code are outside this production boundary.

`test/seal.integration.test.js` exercises the real contributor module through
isolated verification, beacon sealing, and final audit. It also changes
commitments, hashes, beacon metadata, final params, and the verification key to
check that the audit rejects them. `test/verify-reject.test.js` covers malformed
inputs, child OOM, and infrastructure-error classification. Live rehearsals use
`scripts/mock-ceremony.sh`, which collects transport and on-chain evidence too.
