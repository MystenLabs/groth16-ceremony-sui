#!/usr/bin/env node
// Contribute to a Groth16 phase-2 trusted-setup ceremony on Sui and Walrus.
//
// Why it exists: A contributor runs one command, answers three questions, and
// walks away. The CLI does the rest and explains each step in plain words.
//
// How it works:
// 1. Read the ceremony from Sui. The ceremony ID comes from the command line or
//    from `ceremony.json` at the repository root.
// 2. Ask for the funding link, the public name, and extra randomness. Then ask
//    the user to confirm. Flags answer these questions for scripts.
// 3. Prepare: make sure that the contribution key has enough SUI and WAL.
// 4. Wait for your turn: claim the single on-chain contribution slot.
// 5. Download the current parameters from Walrus.
// 6. Compute the contribution: decompress, contribute, and compress.
// 7. Upload the result to Walrus.
// 8. Submit it on-chain and wait for the attestor's verdict.
//
// Terms:
// - Contribution key: an Ed25519 key that the CLI makes and keeps in the work
//   directory. It pays for transactions and storage.
// - Work directory: the folder with `state.json`, receipts, and logs. A rerun
//   with the same directory continues with the same key.
// - Attestor: the coordinator service that checks each contribution.
//   User-facing text calls it "the ceremony checker".
//
// Assumptions:
// - Cryptographic calls stay in ../src/crypto.js and Walrus calls stay in
//   ../src/walrus.js. This file only orchestrates.
// - ../src/ui.js owns all terminal output during a run.

import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { isValidSuiAddress, normalizeSuiAddress } from '@mysten/sui/utils';
import { randomEntropy, exportSecretKey, generateKey, restoreKey, contribute, compress, decompress } from '../src/crypto.js';
import { fetchBlob, uploadToWalrus, resolveSharedBlobContent } from '../src/walrus.js';
import { reportQueueActivity } from '../src/queue-activity.js';
import { ensureFunding, selectFundingMode, validatePublicCoordinatorUrl, requireFundingLinkForCeremony } from '../src/funding.js';
import { readHead, submitContribution, awaitVerdict, sweepFunds, claimWhenOpen, parsePollInterval } from '../src/chain.js';
import { fundingDefaults } from '../src/funding-policy.js';
import { requireAttestorHealthy } from '../src/health.js';
import { CEREMONY_ID, readCeremonyConfig, resolveWorkdir, startRunLog, recordRunLog, redact } from '../src/run-context.js';
import { createUi, formatDuration, visibleText } from '../src/ui.js';
import { askLine, askHidden, askYesNo } from '../src/prompt.js';
import { explainFailure, errorMessage, assertTurnOpen } from '../src/failures.js';
import { renderResultCard } from '../src/result-card.js';

// gRPC is the supported transport; JSON-RPC is deprecated (deactivation July 2026).
// All node access goes through the transport-agnostic `.core` API.
function makeSuiClient(net, network) {
  return new SuiGrpcClient({ network, baseUrl: process.env.SUI_URL || net.fullnode });
}

const NETWORKS = {
  testnet: {
    funding: fundingDefaults('testnet'),
    fullnode: 'https://fullnode.testnet.sui.io:443',
    relay: 'https://upload-relay.testnet.walrus.space',
    aggregator: 'https://aggregator.walrus-testnet.walrus.space',
    walCoinType: '0x8270feb7375eee355e64fdb69c50abb6b5f9393a722883c1cf45f8e26048810a::wal::WAL',
    faucets: 'https://faucet.sui.io/?network=testnet · https://stake-wal.wal.app/?network=testnet',
  },
  mainnet: {
    funding: fundingDefaults('mainnet'),
    fullnode: 'https://fullnode.mainnet.sui.io:443',
    relay: 'https://upload-relay.mainnet.walrus.space',
    aggregator: 'https://aggregator.walrus-mainnet.walrus.space',
    walCoinType: '0x356a26eb9e012a68958082340d4c4116e7f55615cf27affcff209cf0ae544f59::wal::WAL',
    faucets: '',
  },
};
const VERSION = '0.1.0';
const MAX_NAME_BYTES = 64;
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DEFAULT_TITLE = 'Trusted-setup ceremony';

const HELP = `ceremony v${VERSION} — contribute to a trusted-setup ceremony

Usage:
  ceremony contribute [options]   contribute to the ceremony in ceremony.json
  ceremony refund [options]       send the key's leftover funds back

The CLI reads the ceremony from Sui, waits for your turn, computes your
contribution, uploads it to Walrus, and submits it on-chain. It asks for the
funding link, your public name, and some random text. If a run stops, run the
same command again: it uses the same key and starts again from the download.

Options:
  --name <s>          contribution name, public on-chain (asked if omitted)
  --yes               start without the confirmation question
  --verbose           show technical details on screen (the log always has them)
  --help              show this text

Advanced options (scripts and rehearsals):
  --ceremony <id>     contribute to this ceremony instead of the one in ceremony.json
  --network <n>       testnet | mainnet (default: ceremony.json, else testnet)
  --funding-url <url> private funding link (or CEREMONY_FUNDING_URL); prefer the prompt,
                      because a link on the command line stays in shell history
  --self-funded       fund the contribution address yourself; skip the funding question
  --entropy <s>       random text for scripts (OS randomness is always mixed in)
  --workdir <dir>     key and state directory; use a new one for a second contribution
                      (default: <repository>/ceremony-work/<network>/<ceremony-id>)
  --coordinator-url <url>
                      override the coordinator URL from the ceremony (local rehearsals)
  --poll-interval <s> seconds between slot and balance checks (default: 30)
  --to <addr>         refund: send funds here instead of to the organizer
`;

// Values that the Ctrl-C handler needs while a run is active.
const session = { ui: null, holdingTurn: false, turnEndsAt: null, submitted: false, statusUrl: null, lastInterrupt: 0 };

// Show a path from the current directory when that is shorter.
function shortPath(file) {
  const rel = path.relative(process.cwd(), file);
  return !rel.startsWith('..') && rel.length < file.length ? rel : file;
}
function fmtCoin(mist) { return (Number(mist) / 1e9).toFixed(2); }
function fmtMB(n) { return n < 1048576 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1048576).toFixed(1)} MB`; }
function nameBytes(name) { return Buffer.byteLength(name, 'utf8'); }
function clockTime(ms) { return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
function plural(n, word) { return `${n} ${word}${n === 1 ? '' : 's'}`; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function timed(fn) {
  const t0 = performance.now();
  const out = await fn();
  return { out, sec: Math.round(performance.now() - t0) / 1000 };
}

// snarkjs logs objects and multi-line hash blocks. Keep one clean line.
function fmtLogMessage(msg) {
  let text;
  if (typeof msg === 'string') text = msg;
  else if (msg == null) text = '';
  else if (typeof msg.message === 'string') text = msg.message;
  else if (typeof msg.msg === 'string') text = msg.msg;
  else { try { text = JSON.stringify(msg); } catch { text = String(msg); } }
  return text.replace(/: \[object Object\]$/, '').replace(/\s+/g, ' ').trim();
}

// snarkjs reports "Applying key: L Section: i/n" while it computes, first for
// the L section and then for the H section. Each section is half of the work.
function makeSnarkLogger(ui) {
  return {
    debug(msg) {
      const m = /^Applying key:? (L|H) Section: (\d+)\/(\d+)/.exec(fmtLogMessage(msg));
      if (m) ui.progress((m[1] === 'H' ? 0.5 : 0) + Number(m[2]) / Number(m[3]) / 2);
    },
    info: (msg) => ui.detail(fmtLogMessage(msg)),
    warn: (msg) => ui.detail(fmtLogMessage(msg)),
    error: (msg) => ui.note(fmtLogMessage(msg), 'error'),
  };
}

// Library modules call `log(message, level)`. Waiting messages become the
// status of the active stage. Other messages go to the log only.
function stageLog(ui) {
  return (msg, level) => {
    if (level === 'waiting') ui.status(msg);
    else if (level === 'error') ui.note(msg, 'error');
    else ui.detail(msg);
  };
}

const WALRUS_STATUS = {
  encoded: 'reserving storage on Sui',
  registered: 'sending data to storage nodes',
  uploaded: 'collecting storage confirmations',
  certified: 'recording the upload on Sui',
};

function walrusLog(ui) {
  return (msg) => {
    ui.detail(msg);
    const step = /walrus: (\w+)/.exec(msg)?.[1];
    if (WALRUS_STATUS[step]) ui.status(WALRUS_STATUS[step]);
  };
}

// --- work directory state: the key, the name, and funding records ---

function statePath(workdir) { return path.join(workdir, 'state.json'); }
function loadState(workdir) {
  try { return JSON.parse(fs.readFileSync(statePath(workdir), 'utf8')); }
  catch { return null; }
}
function saveState(workdir, st) {
  fs.mkdirSync(workdir, { recursive: true });
  // The file holds the contribution key. Only the owner can read it.
  fs.writeFileSync(statePath(workdir), JSON.stringify(st, null, 2), { mode: 0o600 });
  fs.chmodSync(statePath(workdir), 0o600);
}

// Best-effort: stop the machine from idle-sleeping for the life of this
// process. Lid-close sleep can't be prevented from userspace.
function inhibitSleep() {
  try {
    if (process.platform === 'darwin') {
      spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore', detached: true }).unref();
      return 'caffeinate';
    }
    if (process.platform === 'linux') {
      const child = spawn('systemd-inhibit',
        ['--what=sleep:idle', '--why=ceremony contribution', 'sleep', 'infinity'], { stdio: 'ignore' });
      // A missing helper gives an 'error' event. Without a handler, that event stops the CLI.
      child.on('error', () => {});
      // Do not let the helper keep the CLI alive after the work is complete.
      child.unref();
      process.on('exit', () => child.kill());
      return 'systemd-inhibit';
    }
  } catch { /* helper missing */ }
  return null;
}

// --- best-effort coordinator reporting ---

function startHeartbeat(baseUrl, ctx) {
  if (!baseUrl) return { stop() {}, send: async () => {} };
  let pending = Promise.resolve();
  const send = () => pending = pending.then(() => fetch(new URL('/heartbeat', baseUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cli: true, ...ctx() }),
    signal: AbortSignal.timeout(5000),
  })).catch(() => {});
  send();
  const id = setInterval(send, 30_000);
  id.unref();
  return { stop: () => clearInterval(id), send };
}

async function postTelemetry(baseUrl, body) {
  if (!baseUrl) return;
  await fetch(new URL('/telemetry', baseUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => {});
}

// --- funding ---

async function readBalances(suiClient, addr, net) {
  const [s, w] = await Promise.all([
    suiClient.core.getBalance({ owner: addr, coinType: '0x2::sui::SUI' }),
    suiClient.core.getBalance({ owner: addr, coinType: net.walCoinType }),
  ]);
  return { sui: BigInt(s.balance.balance), wal: BigInt(w.balance.balance) };
}

function hasEnough(bal, net) {
  return bal.sui >= net.funding.minSui && bal.wal >= net.funding.minWal;
}

async function waitForFunding(ui, suiClient, addr, net, pollMs, { inviteOnly }) {
  const { minSui, minWal } = net.funding;
  ui.note(`Send at least ${fmtCoin(minSui)} SUI and ${fmtCoin(minWal)} WAL to the address above.`, 'action');
  if (inviteOnly) ui.note('This ceremony is invite-only. Also send the address to the organizer, so that they can enroll you.', 'action');
  if (net.faucets) ui.note(['Testnet faucets:', ...net.faucets.split(' · ').map((url) => `  • ${url}`)].join('\n'));
  ui.note('You fund this address once. Later runs use the same address.', 'dim');
  for (;;) {
    try {
      const bal = await readBalances(suiClient, addr, net);
      ui.status(`waiting for funds · ${fmtCoin(bal.sui)} SUI, ${fmtCoin(bal.wal)} WAL`);
      if (hasEnough(bal, net)) return;
    } catch { /* A failed balance read is temporary; try again. */ }
    await sleep(pollMs);
  }
}

// --- questions before the run ---

async function askFundingLink(ui, head) {
  ui.note('Paste the funding link from the organizer.\nPress Enter if you fund the contribution yourself.');
  for (let attempt = 0; attempt < 3; attempt++) {
    const link = await askHidden('  Funding link: ');
    if (!link) return null;
    try {
      requireFundingLinkForCeremony(link, head.coordinatorUrl);
      redact(link);
      // This is a local check only. The server checks the token when Prepare asks for funds.
      ui.note('✓ The link is for this ceremony. The server checks it in the Prepare step.', 'success');
      return link;
    } catch (e) {
      ui.note(/different ceremony/.test(e.message)
        ? 'This link is for a different ceremony. Ask the organizer for the link to this one.'
        : 'This is not a valid funding link. Paste the full link from the organizer.', 'error');
    }
  }
  throw new Error('no valid funding link; ask the organizer for the link to this ceremony');
}

async function askName(ui) {
  ui.print('');
  ui.note('Your name goes on-chain and into the final ceremony transcript.');
  for (;;) {
    const name = await askLine('  Name: ');
    if (nameBytes(name) <= MAX_NAME_BYTES) return name;
    ui.note(`The name is too long. Use at most ${MAX_NAME_BYTES} bytes.`, 'error');
  }
}

async function askEntropy(ui) {
  ui.print('');
  ui.note('Type some random text, then press Enter.\nYour computer adds its own randomness too.');
  return askHidden('  Random text: ');
}

// --- contribute ---

async function cmdContribute(ceremonyId, opts) {
  const network = opts.network;
  const net = NETWORKS[network];
  const workdir = opts.workdir;
  const suiClient = makeSuiClient(net, network);
  const interactive = !!process.stdin.isTTY && !!process.stdout.isTTY;
  const ui = createUi({ verbose: opts.verbose, record: recordRunLog });
  session.ui = ui;

  const logFile = startRunLog(workdir, [opts.fundingMode.url]);
  ui.detail(`ceremony-cli ${VERSION} · node ${process.versions.node} · ${process.platform}/${process.arch}`);
  ui.detail(`source revision: ${process.env.CEREMONY_SOURCE_REVISION || 'unknown'}`);
  ui.detail(`network: ${network} · ceremony: ${ceremonyId} · work directory: ${path.resolve(workdir)}`);

  let st = loadState(workdir) || {};
  const keypair = st.secretKey ? restoreKey(st.secretKey) : generateKey();
  const addr = keypair.toSuiAddress();
  let stage = null;
  let coordinatorBase = opts['coordinator-url'] || null;
  let heartbeat = { stop() {}, send: async () => {} };
  let name = opts.name || st.name || null;
  let phase = 'funding';
  const timings = {};

  try {
    // 1. Read the ceremony. Stop early if it cannot take a contribution.
    const head = await readHead(suiClient, ceremonyId);
    if (head.closed) throw new Error('ceremony is closed');
    if (head.finalized) throw new Error('ceremony is finalized; no further contributions');
    if (!head.started) throw new Error('phase 2 has not started yet (organizer must finish phase 1 + start)');
    coordinatorBase = opts['coordinator-url'] || head.coordinatorUrl;
    validatePublicCoordinatorUrl(coordinatorBase);

    ui.print('');
    ui.print(`  ${ui.paint('bold', opts.title || DEFAULT_TITLE)}`);
    ui.print(`  ${ui.paint('dim', `${network} · ${plural(head.chainLen, 'contribution')} so far · ${head.permissionless ? 'open to everyone' : 'invite-only'}`)}`);
    ui.print('');
    session.statusUrl = coordinatorBase ? new URL('/status', coordinatorBase).href : null;
    // The chain is the record of accepted work. Do not contribute twice with one key.
    const mineIndex = st.secretKey ? head.contributors.indexOf(normalizeSuiAddress(addr)) : -1;
    if (mineIndex >= 0) {
      const entry = head.chain[mineIndex];
      const headline = `This key already contributed as #${mineIndex + 1}. Thank you, ${entry.name || 'contributor'}!`;
      if (!entry.contributionHash) {
        ui.print(`  ${ui.paint(['green', 'bold'], `✓ ${headline}`)}`);
      } else {
        const receipt = findReceipt(workdir, entry.contributionHash);
        // The chain holds the SharedBlob object id. Look up the Walrus blob id if the receipt has none.
        const walrusId = receipt?.contentBlobId
          || (entry.sharedBlobId ? await resolveSharedBlobContent(suiClient, entry.sharedBlobId).catch(() => null) : null);
        printResult(ui, {
          headline,
          card: {
            hashHex: entry.contributionHash, position: mineIndex + 1, name: entry.name, tsMs: entry.tsMs,
            network, title: opts.title || DEFAULT_TITLE, statusUrl: session.statusUrl,
          },
          network, submitDigest: receipt?.submitDigest, walrusId, receiptPath: receipt?.path,
        });
      }
      ui.print('');
      ui.print('  To contribute again, run the command with a new --workdir <dir>.');
      ui.print('');
      return;
    }
    if (st.secretKey && head.slot === 'Pending' && head.slotWho === addr) {
      ui.print('  The ceremony checker is verifying your contribution now.');
      ui.print(`    Wait a few minutes.${session.statusUrl ? ` Then look for your name at ${session.statusUrl}.` : ''}`);
      ui.print('');
      return;
    }
    if (st.secretKey && st.name) ui.note(`Continuing as ${st.name}, with the key saved in this work directory.`);

    // 2. Questions. Flags and saved state answer them in scripts and reruns.
    let asked = false;
    let fundingUrl = opts.fundingMode.url || null;
    if (fundingUrl) {
      requireFundingLinkForCeremony(fundingUrl, head.coordinatorUrl);
      ui.note(`Using the funding link from ${opts['funding-url'] ? '--funding-url' : 'CEREMONY_FUNDING_URL'}.`);
    }
    const unspentFunding = st.funding && !st.funding.refundDigest;
    const mayAskFunding = interactive && !fundingUrl && !opts['self-funded'] && !unspentFunding;
    if (mayAskFunding && !(st.secretKey && hasEnough(await readBalances(suiClient, addr, net), net))) {
      fundingUrl = await askFundingLink(ui, head);
      asked = true;
    }
    if (!name && interactive) { name = await askName(ui); asked = true; }
    if (!name) {
      name = 'anon-' + Math.random().toString(36).slice(2, 6);
      ui.note(`No name given. Your contribution will appear as ${name}.`);
    }
    if (nameBytes(name) > MAX_NAME_BYTES) {
      throw new Error(`contribution name is ${nameBytes(name)} bytes; the ceremony contract accepts at most ${MAX_NAME_BYTES}`);
    }
    let entropy = opts.entropy;
    if (!entropy && interactive) { entropy = await askEntropy(ui); asked = true; }
    if (!entropy) entropy = randomEntropy();
    redact(entropy);

    if (asked && !opts.yes) {
      ui.print('');
      ui.card('Ready to contribute', [
        ['Name', `${name} (public)`],
        ['Funding', fundingUrl ? 'the organizer pays' : unspentFunding ? 'the organizer paid earlier' : 'you fund the contribution address'],
        ['Time', 'about 5–10 minutes of work when your turn starts,\nthen about 3 minutes of checks'],
      ], ['Keep this terminal open and your laptop lid up.']);
      if (!await askYesNo('  Start?')) {
        ui.print('  Stopped. Nothing was sent.');
        return;
      }
    }
    ui.print('');

    st = { ...st, secretKey: exportSecretKey(keypair), name, ceremonyId, network };
    saveState(workdir, st);
    ui.note(`Address: ${addr}`, 'dim');
    ui.setLog(shortPath(logFile));
    const inhibitor = inhibitSleep();
    if (inhibitor) ui.detail(`sleep inhibited via ${inhibitor}`);
    else ui.note('This computer can go to sleep during the run. Turn off sleep until the run ends.', 'action');

    phase = 'funding';
    heartbeat = startHeartbeat(coordinatorBase, () => ({ phase, currentStep: stageIndex(stage), name, ephemeralAddr: addr, ceremonyId }));
    ui.detail(`package ${head.packageId} · coordinator ${coordinatorBase}`);
    const log = stageLog(ui);

    // 3. Prepare: funds and enrollment.
    stage = 'prepare';
    ui.start('prepare', 'checking your balance');
    let toldToEnroll = false;
    const fundingContext = { network, ceremonyId, address: addr, organizer: head.organizer, walCoinType: net.walCoinType };
    const funding = await ensureFunding(suiClient, fundingContext, {
      fundingUrl, receipt: st.funding,
      minSui: net.funding.minSui, minWal: net.funding.minWal, log,
      saveReceipt(record) {
        st = { ...st, funding: record };
        saveState(workdir, st);
      },
      waitForFunds: () => {
        toldToEnroll = !head.permissionless;
        return waitForFunding(ui, suiClient, addr, net, opts.pollMs, { inviteOnly: !head.permissionless });
      },
    });
    const bal = await readBalances(suiClient, addr, net);
    ui.done(prepareSummary(funding, bal));
    if (!funding && !toldToEnroll && !head.permissionless && !head.allowlist.includes(addr)) {
      ui.note(`This ceremony is invite-only. If the organizer has not enrolled you, send them your address:\n\n    ${addr}\n`, 'action');
    }

    // 4. Wait for your turn. The head can move while we wait, so read it again after.
    stage = 'turn';
    phase = 'running';
    ui.start('turn', 'checking the contribution slot');
    const turnStart = Date.now();
    let reportedActivity = false;
    const mine = await claimWhenOpen(suiClient, keypair, head.packageId, ceremonyId, addr, {
      log, pollMs: opts.pollMs,
      async checkHealth(currentHead) {
        ui.status('checking that the ceremony checker is online');
        await requireAttestorHealthy(opts['coordinator-url'] || currentHead.coordinatorUrl, ceremonyId, network);
        ui.detail('attestor health check OK');
      },
      onWaiting(waiting) {
        const next = waiting ? 'waiting_for_slot' : 'running';
        if (phase !== next) {
          phase = next;
          void heartbeat.send();
        }
        if (waiting && !reportedActivity) {
          reportedActivity = true;
          showWaitingChecklist(ui, { awake: !!inhibitor });
          void reportQueueActivity(coordinatorBase, ceremonyId, (m) => ui.note(m, 'dim'), { slotDurationMs: head.slotDurationMs });
        }
      },
    });
    session.holdingTurn = true;
    phase = 'running';
    void heartbeat.send();
    if (Number.isFinite(mine.remainingMs)) {
      session.turnEndsAt = Date.now() + mine.remainingMs;
      ui.deadline(session.turnEndsAt);
    }
    const waited = Date.now() - turnStart;
    ui.done(waited < 60_000 ? 'your turn started' : `waited ${formatDuration(waited)}`);

    const cur = await readHead(suiClient, ceremonyId);
    const predBlob = await resolveSharedBlobContent(suiClient, cur.headSharedBlobId);
    ui.detail(`contributing on head ${predBlob} (chain length ${cur.chainLen})`);

    // 5. Download.
    stage = 'download';
    ui.start('download', 'fetching the latest parameters from Walrus');
    const dl = await timed(() => fetchBlob(suiClient, network, net, predBlob));
    timings.downloadsec = dl.sec;
    let bytes = dl.out;
    ui.done(`${fmtMB(bytes.length)} in ${formatDuration(dl.sec * 1000)}`);

    // 6. Compute.
    stage = 'compute';
    const snLog = makeSnarkLogger(ui);
    const computeStart = Date.now();
    ui.start('compute');
    const magic = String.fromCharCode(...bytes.slice(0, 3));
    ui.detail(`params: ${fmtMB(bytes.length)}, magic "${magic}"`);
    ui.steps(magic === 'p2c' ? ['Unpack', 'Contribute', 'Pack'] : ['Contribute', 'Pack']);
    if (magic === 'p2c') {
      ui.step('Unpack');
      const dec = await timed(() => decompress(bytes, snLog));
      bytes = dec.out;
      timings.decompresssec = dec.sec;
    }
    ui.step('Contribute');
    const c = await timed(() => contribute(bytes, name, entropy, snLog));
    const hashHex = c.out.hashHex;
    timings.contributesec = c.sec;
    ui.detail(`contribution hash: ${hashHex}`);
    ui.step('Pack');
    const cp = await timed(() => compress(c.out.bytes, snLog));
    const p2c = cp.out;
    timings.compresssec = cp.sec;
    ui.done(`done in ${formatDuration(Date.now() - computeStart)}`);

    // 7. Upload.
    stage = 'upload';
    assertTurnOpen(session.turnEndsAt, 'upload');
    ui.start('upload', `encoding ${fmtMB(p2c.length)}`);
    const up = await timed(() => uploadToWalrus(suiClient, keypair, network, net, p2c, walrusLog(ui)));
    timings.uploadsec = up.sec;
    const { sharedBlobId: blobId, contentBlobId } = up.out;
    ui.done(`${fmtMB(p2c.length)} in ${formatDuration(up.sec * 1000)}`);

    // 8. Submit and verify.
    stage = 'verify';
    assertTurnOpen(session.turnEndsAt, 'submission');
    ui.start('verify', 'submitting on-chain');
    const sd = await submitContribution(suiClient, keypair, head.packageId, ceremonyId, blobId, hashHex, name);
    session.holdingTurn = false;
    session.submitted = true;
    ui.deadline(null);
    ui.detail(`submitted on-chain (${sd})`);
    ui.status('checking your contribution (about 3 minutes)');
    const verdict = await awaitVerdict(suiClient, ceremonyId, blobId, { submitDigest: sd });
    let refund = null;
    session.submitted = false;
    if (verdict === 'accepted') {
      refund = await returnLeftovers(ui, suiClient, keypair, net, funding, addr);
      ui.done('accepted');
      if (refund.digest) {
        st = { ...st, funding: { ...funding, refundDigest: refund.digest } };
        saveState(workdir, st);
      }
    } else {
      ui.fail(verdict === 'rejected' ? 'rejected' : 'no verdict yet');
    }

    const receiptPath = path.join(workdir, `receipt-${hashHex.slice(0, 8)}.json`);
    fs.writeFileSync(receiptPath, JSON.stringify({ name, ceremonyId, contributionHash: hashHex, blobId, contentBlobId, address: addr, submitDigest: sd, verdict, funding: funding || null, refundDigest: refund?.digest || null, timings, finishedAt: new Date().toISOString() }, null, 2));
    ui.detail(`receipt saved: ${receiptPath}`);
    await postTelemetry(coordinatorBase, {
      cli: true, status: verdict, name, ceremony_id: ceremonyId, storage: 'walrus',
      cores: os.cpus().length, useragent: `ceremony-cli/${VERSION} node/${process.versions.node} ${process.platform}`,
      bytesize: p2c.length, hash: hashHex, blob_id: contentBlobId, ephemeral_addr: addr, ...timings,
    });

    ui.close();
    const statusUrl = session.statusUrl;
    if (verdict === 'accepted') {
      ui.print('');
      // Read the position and the time from the chain, so that the card matches the public record.
      const after = await readHead(suiClient, ceremonyId).catch(() => null);
      const index = after ? after.contributors.lastIndexOf(normalizeSuiAddress(addr)) : -1;
      printResult(ui, {
        headline: `Contribution accepted. Thank you, ${name}!`,
        card: {
          hashHex, name, network, title: opts.title || DEFAULT_TITLE, statusUrl,
          position: index >= 0 ? index + 1 : after?.chainLen,
          tsMs: index >= 0 && after.chain[index].tsMs ? after.chain[index].tsMs : Date.now(),
        },
        funds: fundsMessage(refund, addr),
        network, submitDigest: sd, walrusId: contentBlobId, receiptPath,
      });
      ui.print('');
    } else {
      printNotAccepted(ui, { verdict, receiptPath, logFile, statusUrl });
      process.exitCode = 1;
    }
  } catch (err) {
    const message = errorMessage(err);
    if (ui.stage) ui.fail('stopped');
    ui.close();
    recordRunLog(`failed during ${stage || 'setup'}: ${message}`);
    if (err?.stack) recordRunLog(err.stack);
    await postTelemetry(coordinatorBase, { cli: true, status: 'error', name, step: stageIndex(stage), error: message.slice(0, 500), ephemeral_addr: addr, ...timings });
    const { title, lines } = explainFailure(err, { address: addr, network, stage });
    printFailure(ui, title, [...lines, '', `Log: ${shortPath(logFile)}`]);
    process.exitCode = 1;
  } finally {
    session.holdingTurn = false;
    phase = 'stopped';
    heartbeat.stop();
    await heartbeat.send();
  }
}

// Organizer funding shows the amounts that its transaction credited. Other
// funds show only the balance, because the CLI does not know the sender.
function prepareSummary(funding, bal) {
  const balance = `${fmtCoin(bal.sui)} SUI, ${fmtCoin(bal.wal)} WAL`;
  if (!funding) return `balance ${balance}`;
  const received = `${fmtCoin(funding.sui)} SUI, ${fmtCoin(funding.wal)} WAL`;
  return `received ${received} from the organizer${received === balance ? '' : ` · balance ${balance}`}`;
}

// The wait can take hours without the user. Tell them what keeps the run alive.
function showWaitingChecklist(ui, { awake }) {
  ui.note([
    'Someone else has the turn. Leave this running: the CLI starts when your turn comes.',
    '  • Plug in the power cable.',
    '  • Keep the laptop lid open. Closing it stops the run.',
    '  • Keep this terminal window open.',
    awake ? 'The CLI keeps the computer awake while it runs.' : null,
  ].filter(Boolean).join('\n'));
}

function stageIndex(stage) {
  return ['prepare', 'turn', 'download', 'compute', 'upload', 'verify'].indexOf(stage) + 1;
}

// Return organizer funding after acceptance. Other funds stay with the key.
// The result has a `kind` that `fundsMessage` explains.
async function returnLeftovers(ui, suiClient, keypair, net, funding, addr) {
  if (!funding) return { kind: 'self-funded' };
  ui.status('accepted · returning leftover funds to the organizer');
  try {
    const sw = await sweepFunds(suiClient, keypair, net.walCoinType, funding.organizer);
    if (sw.digest) {
      ui.detail(`refunded leftover SUI + WAL to organizer ${funding.organizer} (${sw.digest})`);
      return { kind: 'returned', digest: sw.digest, wal: sw.wal };
    }
    ui.detail(`refund skipped: ${sw.skipped}`);
    return { kind: sw.wal ? 'wal-left' : 'nothing-left' };
  } catch (e) {
    ui.detail(`refund failed: ${errorMessage(e)}`);
    return { kind: 'failed' };
  }
}

// Explain the funds outcome in one short block: a mark, a color, and lines.
function fundsMessage(refund, addr) {
  switch (refund.kind) {
    case 'returned':
      return { mark: '✓', color: 'green', lines: [`Leftover ${refund.wal ? 'SUI and WAL' : 'SUI'} went back to the organizer.`] };
    case 'nothing-left':
      return { mark: '·', color: 'dim', lines: ['No leftover funds to return.'] };
    case 'wal-left':
      return { mark: '!', color: 'yellow', lines: ['Some WAL stays at your contribution address.', 'No SUI is left to pay the fee to send it back.'] };
    case 'failed':
      return {
        mark: '!', color: 'yellow',
        lines: ['Leftover funds did not go back to the organizer.', 'To try again, run the same command, but with refund instead of contribute.'],
      };
    default:
      return {
        mark: '·', color: 'dim',
        lines: [
          'Your leftover funds stay at your contribution address:', addr,
          'To move them, run the same command, but with', 'refund --to <address> instead of contribute.',
        ],
      };
  }
}

const EXPLORER_NETWORKS = new Set(['mainnet', 'testnet', 'devnet']);
const WALRUSCAN_NETWORKS = new Set(['mainnet', 'testnet']);

// Find the local receipt of an accepted contribution. Return null if there is none.
function findReceipt(workdir, hashHex) {
  const file = path.join(workdir, `receipt-${hashHex.slice(0, 8)}.json`);
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data.contributionHash === hashHex
      ? { path: file, submitDigest: data.submitDigest, contentBlobId: data.contentBlobId }
      : null;
  } catch {
    return null;
  }
}

// Show an accepted contribution: the headline, the shareable card, and then
// the local details. Each id is a link to its explorer page.
function printResult(ui, { headline, card, funds, network, submitDigest, walrusId, receiptPath }) {
  const p = ui.paint;
  ui.print(`  ${p(['green', 'bold'], `✓ ${headline}`)}`);
  ui.print('');
  for (const line of renderResultCard({ ...card, width: ui.width, paint: p })) ui.print(line);
  ui.print('');
  ui.print('  Share this on your socials!');

  if (funds) {
    ui.print('');
    const [first, ...rest] = funds.lines;
    ui.print(`  ${p(funds.color, funds.mark)} ${first}`);
    for (const line of rest) ui.print(`    ${line}`);
  }

  const ids = [
    submitDigest ? ['Submitted on Sui', submitDigest, EXPLORER_NETWORKS.has(network) && `https://devxplorer.io/?search=${submitDigest}&network=${network}`] : null,
    walrusId ? ['Stored on Walrus', walrusId, WALRUSCAN_NETWORKS.has(network) && `https://walruscan.com/${network}/blob/${walrusId}`] : null,
  ].filter(Boolean);
  if (ids.length) ui.print('');
  for (const [key, id, url] of ids) {
    const value = url ? ui.link(url, id) : id;
    // Put a long id below its label, so that the id does not wrap.
    if (2 + 18 + visibleText(value).length <= ui.width) ui.print(`  ${p('dim', key.padEnd(17))} ${value}`);
    else ui.print(`  ${p('dim', key)}\n    ${value}`);
  }

  if (receiptPath) {
    ui.print('');
    ui.print(`  ${p('dim', 'Receipt (has the full hash):')} ${shortPath(receiptPath)}`);
  }
}

function printNotAccepted(ui, { verdict, receiptPath, logFile, statusUrl }) {
  if (verdict === 'rejected') {
    printFailure(ui, 'The ceremony checker rejected your contribution.', [
      'Your funds stay at your contribution address.',
      'Send the log to the organizer. Then run the same command to try again.',
      '', `Log:     ${shortPath(logFile)}`, `Receipt: ${shortPath(receiptPath)}`,
    ]);
    return;
  }
  printFailure(ui, 'The ceremony checker has not answered in 10 minutes.', [
    'Your contribution can still be accepted.',
    statusUrl ? `Look for your name at ${statusUrl}.` : 'Ask the organizer for the result.',
    'If your name is not there, run the same command again.',
    '', `Log:     ${logFile}`, `Receipt: ${receiptPath}`,
  ], 'yellow', '!');
}

function printFailure(ui, title, lines, color = 'red', mark = '✗') {
  ui.print('');
  ui.print(`  ${ui.paint([color, 'bold'], `${mark} ${title}`)}`);
  ui.print('');
  for (const line of lines) ui.print(line ? `    ${line}` : '');
  ui.print('');
}

// The key's saved ceremony and network win over ceremony.json. Explicit
// --ceremony and --network flags win over both.
async function cmdRefund(ceremonyId, opts) {
  const ui = createUi({ verbose: true, live: false });
  const st = loadState(opts.workdir);
  if (!st?.secretKey) throw new Error(`no contribution key found in ${statePath(opts.workdir)}`);
  const network = (opts.explicit.network && opts.network) || st.network || opts.network;
  const net = NETWORKS[network];
  if (!net) throw new Error(`unknown network "${network}"`);
  const keypair = restoreKey(st.secretKey);
  const addr = keypair.toSuiAddress();
  const suiClient = makeSuiClient(net, network);
  const target = (opts.explicit.ceremony && ceremonyId) || st.ceremonyId || ceremonyId || null;
  ui.detail(`refund on ${network} for ceremony ${target || 'none'}`);
  let refundAddr = opts.to || null;
  // normalizeSuiAddress adds zeros to a short address. Refuse a short address instead.
  if (refundAddr && !isValidSuiAddress(refundAddr)) throw new Error('--to must be a full Sui address: 0x and 64 hex digits');
  if (!refundAddr) {
    if (!target) throw new Error('missing refund target: pass --to <addr> or provide a ceremony id');
    const head = await readHead(suiClient, target);
    if (!head.organizer) throw new Error(`ceremony ${target} has no organizer refund address`);
    refundAddr = head.organizer;
  }
  refundAddr = normalizeSuiAddress(refundAddr);
  ui.note(`Sending leftover funds from ${addr} to ${refundAddr}…`);
  const sw = await sweepFunds(suiClient, keypair, net.walCoinType, refundAddr);
  if (sw.digest && st.funding) saveState(opts.workdir, { ...st, funding: { ...st.funding, refundDigest: sw.digest } });
  if (sw.digest) ui.note(`✓ Leftover funds sent (${sw.digest}).`, 'success');
  else ui.note(`Nothing sent: ${sw.skipped}.`);
}

// --- entry ---

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      name: { type: 'string' },
      entropy: { type: 'string' },
      ceremony: { type: 'string' },
      'coordinator-url': { type: 'string' },
      'funding-url': { type: 'string' },
      'self-funded': { type: 'boolean' },
      yes: { type: 'boolean', default: false },
      verbose: { type: 'boolean', default: false },
      'poll-interval': { type: 'string' },
      to: { type: 'string' },
      network: { type: 'string' },
      workdir: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
  });
} catch (e) {
  fail(`${e.message}\n\n${HELP}`);
}
const { values: opts, positionals } = parsed;
const [command, ...extra] = positionals;
if (opts.help || !command) {
  console.log(HELP);
  process.exit(opts.help ? 0 : 1);
}
if (!['contribute', 'refund'].includes(command)) fail(`unknown command "${command}"\n\n${HELP}`);
if (extra.length) fail(`unexpected argument "${extra[0]}"; use --ceremony <id> to choose a ceremony`);

opts.explicit = { ceremony: !!opts.ceremony, network: !!opts.network };
let config = null;
try { config = readCeremonyConfig(REPO_ROOT); } catch (e) {
  if (!opts.ceremony && command === 'contribute') fail(e.message);
}
const ceremonyId = (opts.ceremony || config?.ceremonyId || '').toLowerCase() || null;
if (ceremonyId && !CEREMONY_ID.test(ceremonyId)) fail('The ceremony ID must be 0x followed by 64 hexadecimal characters.');
const fromConfig = !!config && ceremonyId === config.ceremonyId;
opts.network ||= fromConfig ? config.network : 'testnet';
if (!NETWORKS[opts.network]) fail(`unknown network "${opts.network}" (testnet | mainnet)`);
opts.title = fromConfig ? config.title : null;
opts.workdir = resolveWorkdir(opts, ceremonyId, REPO_ROOT);

process.on('SIGINT', () => {
  const now = Date.now();
  if (session.holdingTurn && now - session.lastInterrupt > 5000) {
    session.lastInterrupt = now;
    const ends = session.turnEndsAt ? ` Your turn ends at ${clockTime(session.turnEndsAt)}.` : '';
    session.ui?.note(`If you stop now, the download and the computation start again on the next run.${ends} Press Ctrl-C again within 5 seconds to stop.`, 'action');
    return;
  }
  if (session.ui?.stage) session.ui.fail('stopped');
  session.ui?.close();
  if (session.submitted) {
    const where = session.statusUrl ? ` Look for your name at ${session.statusUrl}` : ' Ask the organizer for the result';
    console.log(`\n  Stopped. Your contribution is submitted and can still be accepted.${where} before you run the command again.`);
  } else {
    console.log(session.holdingTurn && session.turnEndsAt
      ? `\n  Stopped. Your turn stays reserved until ${clockTime(session.turnEndsAt)}. Run the same command before then to keep it.\n  The download and the computation start again.`
      : '\n  Stopped. Your key and funds are kept. Run the same command to start again.');
  }
  process.exit(130);
});

let run;
if (command === 'refund') {
  run = cmdRefund(ceremonyId, opts);
} else {
  if (!ceremonyId) fail('No ceremony selected. Add ceremony.json to the repository root, or pass --ceremony <id>.');
  try {
    opts.fundingMode = selectFundingMode(opts);
    opts.pollMs = parsePollInterval(opts['poll-interval']);
  } catch (e) { fail(e.message); }
  run = cmdContribute(ceremonyId, opts);
}
run.catch((err) => {
  session.ui?.close();
  recordRunLog(err?.stack || String(err));
  console.error(`✗ ${errorMessage(err)}`);
  process.exit(1);
});
