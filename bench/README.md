# Verify benchmark

Reproduce the coordinator's phase-2 verification on a given machine and report
per-step timings, to compare hardware before picking a coordinator host.

It **imports the real functions** from `coordinator/src/crypto` (`readBlob`,
`runVerifySteps`) — the same code the attestor runs — so the numbers can't
drift. It pulls a real **head + contribution** from a live ceremony on chain and
runs `download → v2paramsExtends → transcript checks (plain entries, contribution hash) → decompress → assemble → verifyFromInit`.
The attestor rejects a beacon entry. For a Closed ceremony, give `--head` and `--sub` of a contribution, not of the seal blob.
The expected hash comes from the selected on-chain contribution. With explicit
blob IDs, supply that contribution's recorded hash using `--expected-hash`.

Because it reuses the coordinator, run it from a repo clone (not as a standalone
copy):

```
cd coordinator && npm install && cd ..
```

The full verify (`assemble` + `verifyFromInit`) needs the two big artifacts —
the genesis full zkey and the phase-1 ptau. Drop them in `coordinator/artifacts/`
(the default lookup) or point at them with `--base` / `--ptau`.

## Run

```
# Default ceremony + coordinator/artifacts, latest accepted contribution:
node bench/verify-bench.mjs

# Explicit artifacts / ceremony:
node bench/verify-bench.mjs --ceremony 0x… --base path/to/circuit_0000.zkey --ptau path/to/pot_final.ptau

# Or two explicit SharedBlob object ids (head = predecessor, sub = contribution):
node bench/verify-bench.mjs --head 0x… --sub 0x… --expected-hash <128-hex-characters>
```

Output includes machine details, per-step timings, and `ok: true` only when
the complete acceptance verdict passes. Rejection prints the reason and exits
with a nonzero status.

Downloaded blobs are cached under `<workdir>/blobs`. Pass `--cached` to reuse
them; by default the benchmark downloads them again to measure transfer times.

# Walrus CLI I/O benchmark

`walrus-cli.mjs` measures the coordinator's Walrus CLI blob transfer
helpers against real files or generated random data.

```
node bench/walrus-cli.mjs upload <file>
node bench/walrus-cli.mjs upload --size 64MiB
node bench/walrus-cli.mjs download <sharedBlobId>
node bench/walrus-cli.mjs roundtrip --size 64MiB
```
