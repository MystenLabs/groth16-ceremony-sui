# ceremony-cli

Contribute to a Groth16 phase-2 trusted-setup ceremony on Sui and Walrus
(zkLogin is the first user). You run one command and answer three questions.
Then the CLI waits for your turn, computes your contribution, uploads it to
Walrus, and submits it on-chain.

## Contribute

You need Git and Node.js 22, 24, or 26. With nvm: `nvm install 24 && nvm use 24`.

```bash
git clone https://github.com/MystenLabs/zklogin-v2-ceremony.git
./zklogin-v2-ceremony/ceremony contribute
```

The CLI asks for:

1. **The funding link** from the organizer. The input is hidden. Press Enter if
   you fund the contribution address yourself.
2. **Your name.** It goes on-chain and into the final ceremony transcript.
3. **Some random text.** The input is hidden. The CLI always mixes in randomness
   from your operating system too.

Then it shows a summary and asks you to confirm. After that you can walk away.
Keep the terminal open and the laptop lid up. The run looks like this:

```text
  ✓ Prepare              received 0.06 SUI, 0.30 WAL from the organizer
  ✓ Wait for your turn   waited 12m 04s
  ✓ Download             113.8 MB in 7s
  ⠸ Compute              ██████████░░░░░░░░░░  52%  1m 38s
  · Upload
  · Submit and verify

  Your turn ends in 11m 20s. Keep this terminal open.
  Log: ceremony-work/testnet/0xbdd9…/logs/contributor.log
```

At the end, the CLI shows your contribution hash and the path to your receipt.
Publish the hash so that others can check your contribution.

On the first run, the launcher installs the CLI dependencies. It installs them
again when the dependency files or the Node.js version change. Git dependency
downloads use HTTPS.

### When something goes wrong

- Run the same command again. The CLI uses the same key, funds, and name.
  A rerun always downloads and computes again. If you held the turn, a rerun
  before the turn's deadline keeps it.
- If the CLI tells you to contact the organizer, send them
  `logs/contributor.log` from the work directory. The log never contains the
  funding link or your random text.
- Ctrl-C stops the run. While you hold your turn, the CLI asks you to press
  Ctrl-C a second time, because the next run must download and compute again.
- A run that submits a contribution exits with 0 only when the ceremony accepts it.
- One key contributes once. If the chain already lists the key, the CLI stops
  and says so. To contribute again, use a new `--workdir`.
- If you stop during verification, check the ceremony status page before you
  run the command again. The contribution can still be accepted.

### Files

The repository root has `ceremony.json`. It names the ceremony, its network,
and its title. The work directory for that ceremony is:

```text
ceremony-work/<network>/<ceremony-object-id>/
  state.json                 your contribution key (keep it private)
  receipt-<hash>.json        one receipt for each submitted contribution
  logs/contributor.log       the progress log
```

The work directory does not depend on your current directory. Use
`--workdir <dir>` to make a second contribution with a new key.

## Options

```text
ceremony contribute [options]   contribute to the ceremony in ceremony.json
ceremony refund [options]       send the key's leftover funds back

--name <s>          contribution name, public on-chain (asked if omitted)
--yes               start without the confirmation question
--verbose           show technical details on screen (the log always has them)
--help              show the help text
```

Advanced options, for scripts and rehearsals:

```text
--ceremony <id>     contribute to this ceremony instead of the one in ceremony.json
--network <n>       testnet | mainnet (default: ceremony.json, else testnet)
--funding-url <url> private funding link (or CEREMONY_FUNDING_URL)
--self-funded       fund the contribution address yourself; skip the funding question
--entropy <s>       random text for scripts (OS randomness is always mixed in)
--workdir <dir>     key and state directory
--coordinator-url <url>
                    override the coordinator URL from the ceremony (local rehearsals)
--poll-interval <s> seconds between slot and balance checks (default: 30)
--to <addr>         refund: send funds here instead of to the organizer
```

The CLI asks questions only on an interactive terminal. In a script, use
`--name`, `--entropy`, and `--funding-url` or `--self-funded`. Piped output,
`NO_COLOR=1`, and `TERM=dumb` give plain text without colors. The direct Node
entry point is `node cli/bin/ceremony.js`.

## Funding

The CLI checks the balance of the contribution address first:

- Enough SUI and WAL: it uses the existing funds, even with a funding link.
- Not enough funds, with a funding link: it asks the organizer's coordinator to
  enroll and fund the address.
- Not enough funds, without a funding link: it shows the address and waits for
  you to fund it.

Self-funded contributors in an invite-only (permissioned) ceremony must ask the
organizer to run `enroll-without-funding` for their address.

Balance checks use network-scoped budgets shared with the coordinator. The
testnet minimum is 0.04 SUI + 0.15 WAL, sized for roughly
114.8 MiB contributions. These are fixed budgets, not live storage-price quotes.
The organizer can raise automatic payouts through attestor CLI options. Mainnet
starts at a 0.10 SUI + 6 WAL payout and a 0.05 SUI + 3 WAL minimum balance.
TODO: validate and tune these estimates after a mainnet mock.

The funding link comes from the organizer's `funding-url` command. It is a
shared credential. Do not publish it. The CLI never stores or prints it, removes
it from the log, and does not follow redirects when it requests funding. The
organizer builds the link from the coordinator URL on-chain, so the CLI refuses
a link for a different host. It requires HTTPS, except on loopback for local
rehearsals.

Automatic funding is once per address per ceremony and network. Retries and
reruns with the same work directory recover the original payout. Spending or
refunding it never grants a second payout; ask the organizer to use `fund` for
a manual top-up. Disabled funding, an invalid link, or a closed ceremony stops
the CLI with an error. Temporary failures retry, then tell you to run the same
command again.

After acceptance, the CLI returns leftover funds to the organizer only when the
organizer funded the address. Self-funded and manually funded addresses keep
their leftovers; `refund` sends them back on request.

## How a run goes

1. **Start.** The CLI reads the ceremony from Sui and stops early if it is
   closed or not open yet. It asks the three questions and the confirmation.
2. **Prepare.** It checks the balance and gets funding, as described above.
3. **Wait for your turn.** The ceremony has one contribution slot. The CLI
   claims it when it is free. Just before the claim, it checks the coordinator's
   `/status.json` for a healthy attestor (the ceremony checker). If the check
   fails, the CLI stops before it claims or computes. You have the ceremony's
   claim window (15 minutes by default) from the claim to the submission. A
   rerun reuses an unexpired claim and checks it against Sui's clock.
4. **Download.** It gets the current parameters from Walrus and checks them
   against the content ID on-chain.
5. **Compute.** It decompresses the parameters, adds your contribution, and
   compresses the result. The progress bar follows the snarkjs computation.
6. **Upload.** It stores the result on Walrus for 53 epochs and wraps it in a
   `SharedBlob`.
7. **Submit and verify.** It submits the contribution on-chain and waits up to
   10 minutes for the attestor's verdict. It then writes the receipt.

A failed upload or submission means a new run from step 3.
TODO: resume from the computed contribution when the claim is still valid.

Sleep is inhibited when possible (`caffeinate` on macOS, `systemd-inhibit` on
Linux). Laptops still need the lid open.

## Review notes

Cryptographic calls — key generation/restore/export, transaction signing,
fallback entropy, and snarkjs contribute/compress/decompress — are in
`src/crypto.js`. Walrus SDK calls, SharedBlob resolution, aggregator downloads,
and upload/storage policy are grouped in `src/walrus.js`. Aggregator downloads
are verified against the on-chain content ID using the Walrus SDK before use.
Callers still own secret-key storage, user entropy input,
transaction contents, downloads, polling, and checkpoint recovery. These remain
part of a full security review. See the [coordinator audit map](../coordinator/src/crypto/README.md).
