# zkLogin c67e80c one-contributor ceremony benchmark

Status: complete (`audit OK`)

## Run

- Started (UTC): 2026-08-10T16:04:20Z
- Runner: 2026-08-10T19:17:49Z to 2026-08-10T22:47:30Z
- Network: Sui testnet
- Mode: local coordinator, attestor, and scripted contributor
- Contributors: 1, followed by the final public beacon
- Git revision: `6690e38`
- Machine: Apple M1 Max, 10 cores, 64 GB RAM, Darwin arm64
- Node: `v22.17.1`
- Sui CLI: `1.74.0-d034d564f84b`
- Walrus CLI: `1.53.0-42bc13730da8`

## Inputs

| Artifact | Bytes | Details |
| --- | ---: | --- |
| R1CS | 4,158,327,312 | 1,656,177 constraints; 1,631,902 variables |
| Base zkey | 4,935,076,908 | Groth16; zero Phase-2 contributions; domain 2^21 |
| PTAU | 2,416,002,200 | Power 21; ceremony power 28 |
| Genesis p2c | 119,330,468 | SHA-256 `a75122d8a2620edeaccc7e83bdcbf29b4db8054ae086525856876266ebd2c01a` |

## Timings

All durations are wall-clock times.

| Stage | Duration | Result |
| --- | ---: | --- |
| Full base-zkey verification | 2h59m22.88s | `ZKey Ok!` |
| Extract base zkey to p2u | 1.30s | 238,660,132 bytes |
| Compress p2u to genesis p2c | 2.06s | 119,330,468 bytes |
| Publish Move package | 4s | success |
| Create ceremony and upload R1CS | 25m29s | success |
| Approve R1CS | 2s | 1/1 approvals |
| Verify staged genesis | skipped | full preflight verification recorded above |
| Start Phase 2 and upload genesis | 38s | success |
| Contributor request to accepted receipt | 7m53s | accepted |
| Contributor: download | 7.295s | success |
| Contributor: decompress | 37.930s | success |
| Contributor: contribute | 3m06.553s | success |
| Contributor: compress | 0.422s | success |
| Contributor: upload | 50.272s | success |
| Attestor contribution verification | 2m53.4s | accepted |
| Finalize Phase 2 | 2s | success |
| Seal and upload final artifacts | 37m00s | closed |
| Final audit | 2h18m18s | `audit OK` |
| Audit: R1CS download | 2m51.254s | 4,158,327,312 bytes |
| Audit: final zkey download | 3m08.803s | 4,935,077,759 bytes |
| Audit: full zkey verification | ~2h09m03s | `ZKey Ok!` |
| Complete runner | 3h29m40.91s | success |

## Outputs

- Run directory (now migrated): `ceremony-runs/local-zklogin-c67e80c-20260810T160420Z`
- Package ID: `0x4b5424a2b5f701964dd816757561327f5c90ecfe8a5b4377decbb73d64fb86fe`
- Ceremony ID: `0xe1871323d8cc552728ee8f630c74cdba2e98b6fd1a1337c49a1698d59f78108c`
- Contributor receipt: `contributors/receipt-19022be1.json`
- Final parameter blob: `0xee7fe43db84140ba44f4c55ae61d4d327ac9df3999249e219a87b3a69b76f63c`
- Final zkey blob: `0xc08ccb0146ecb4d9a7ff3850cfd09639a88ea87f0efa1bcda33575df2a43279a`
- Final verification-key blob: `0x865b40ea1e00f28dacef0ce988f6e7ba37070f8f135275531b70e36c19ce566a`
- Audit: `audit OK (2 accepted contributions)`

## Notes

- The cached zkey, R1CS, and PTAU passed full cryptographic verification before the run.
- This benchmark uses full-scale zkLogin artifacts; it is not the repository's small-circuit mock.
