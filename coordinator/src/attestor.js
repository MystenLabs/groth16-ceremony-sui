#!/usr/bin/env node
// The coordinator's attestor loop. Polls the Ceremony object; when the slot is
// Pending, verifies the contributor's blob and calls `accept` (valid) or
// `reject` (invalid) with the OrganizerCap. A two-phase commit, so a bad or
// missing contribution never corrupts the head. Optionally runs the coordinator
// HTTP server for telemetry, heartbeats, and enrollment requests.
//
// Config: package/ceremony/cap ids come from --run's manifest.json (or env).
//   BASE_ZKEY       genesis full zkey (frozen sections 3-7)   [default artifacts/circuit_0000.zkey]
//   BASE_PTAU       phase-1 ptau                              [default artifacts/pot_final.ptau]
//   NETWORK         testnet | mainnet (default testnet)
//   CEREMONY_RUN    ceremony run name
//   CEREMONY_MANIFEST explicit ceremony manifest path
//   DEPLOYMENTS     legacy alias for CEREMONY_MANIFEST
//   COORDINATOR_PORT if set, run the coordinator HTTP server on this port
//   WORKDIR          optional override for the selected run directory
//   POLL_MS         poll interval (default 5000)

import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { Transaction } from '@mysten/sui/transactions';
import { verifyPhase1Digest } from './crypto/commitments.js';
import { verifyBaseCircuit } from './crypto/verify_contribution.js';
import { CLOCK, log, loadIds, resolveBaseArtifacts, resolveCeremonyPaths } from './lib/config.js';
import { makeClient, loadKeypair, readCeremony, parseSlot, exec } from './lib/chain.js';
import { verifyContribution } from './lib/verify_contribution.js';
import { readBlob } from './crypto/walrus.js';
import { startCoordinatorHttpServer } from './coordinator_http.js';
import { createFundingService } from './lib/funding.js';
import { resolveAirdropAmounts, formatCoinAmount } from './lib/funding-policy.js';
import { AttestorStatus } from './lib/attestor_status.js';

const { values: o } = parseArgs({ options: {
  run: { type: 'string' },
  manifest: { type: 'string' },
  deployments: { type: 'string' },
  network: { type: 'string' },
  workdir: { type: 'string' },
  'base-zkey': { type: 'string' },
  'base-ptau': { type: 'string' },
  port: { type: 'string' },
  'poll-ms': { type: 'string' },
  'airdrop-sui': { type: 'string' },
  'airdrop-wal': { type: 'string' },
  help: { type: 'boolean' },
} });

if (o.help) {
  console.log(`Usage: node coordinator/src/attestor.js --run <name> [options]
  --network <testnet|mainnet>  network (default: NETWORK or testnet)
  --port <port>               serve funding, heartbeats and telemetry
  --airdrop-sui <SUI>         SUI per new automatic payout (testnet: 0.06; mainnet: 0.10)
  --airdrop-wal <WAL>         WAL per new automatic payout (testnet: 0.30; mainnet: 6)
  --base-zkey <file>          verified genesis zkey
  --base-ptau <file>          phase-1 ptau
  --poll-ms <milliseconds>    attestor polling interval (default: 5000)
  --manifest <file>           explicit manifest instead of --run
  --workdir <dir>             override the run's work directory
Amounts use whole-token units, with at most 9 decimal places.
Overrides apply to new payouts only; restart the attestor to change them.`);
  process.exit(0);
}

const NETWORK = o.network || process.env.NETWORK || 'testnet';
const PORT = o.port || process.env.COORDINATOR_PORT;
let AIRDROP;
try { AIRDROP = resolveAirdropAmounts(NETWORK, { sui: o['airdrop-sui'], wal: o['airdrop-wal'] }); }
catch (e) { console.error(e.message); process.exit(1); }
const POLL_MS = Number(o['poll-ms'] || process.env.POLL_MS || 5000);
if (!Number.isSafeInteger(POLL_MS) || POLL_MS < 1 || POLL_MS > 2_147_483_647) {
  console.error('--poll-ms must be a positive integer up to 2147483647');
  process.exit(1);
}
const manifest = o.manifest || process.env.CEREMONY_MANIFEST;
const deployments = o.deployments || process.env.DEPLOYMENTS;
if (deployments) console.error('warning: --deployments/DEPLOYMENTS is deprecated; use --manifest/--run');
const paths = resolveCeremonyPaths({
  run: o.run || process.env.CEREMONY_RUN,
  manifest,
  deployments,
  workdir: o.workdir || process.env.WORKDIR,
});
const WORKDIR = paths.workdir;
const ids = loadIds(NETWORK, paths.manifest, { required: ['packageId', 'ceremonyId', 'organizerCapId'] });
const artifactEnv = {
  ...process.env,
  BASE_ZKEY: o['base-zkey'] || process.env.BASE_ZKEY,
  BASE_PTAU: o['base-ptau'] || process.env.BASE_PTAU || ids.dep.phase1?.file,
};
const { baseZkey: BASE_ZKEY, basePtau: BASE_PTAU } = resolveBaseArtifacts(artifactEnv, { artifactsDir: paths.artifacts });

const { packageId: PKG, ceremonyId: CER, organizerCapId: CAP } =
  ids;

const client = makeClient(NETWORK);
const attestor = loadKeypair({ workdir: WORKDIR });
fs.mkdirSync(WORKDIR, { recursive: true });
const monitor = new AttestorStatus({ network: NETWORK, ceremonyId: CER, pollMs: POLL_MS });

const ZERO_ID = `0x${'0'.repeat(64)}`;

// Make sure the local base artifacts belong to this ceremony.
// If they don't match the onchain commitments, stop before verifying
// contributions, otherwise it always fails.
async function checkBaseArtifactsMatchChain(j) {
  log('hashing base ptau against the on-chain phase1_digest…');
  const onChain = Buffer.from(j.phase1_digest || '', 'base64').toString('hex');
  await verifyPhase1Digest(BASE_PTAU, onChain);
  log('  base ptau matches phase1_digest');

  // The base zkey must use the same circuit as the current head.
  const phase = j.phase?.['@variant'] || 'Setup';
  if (phase === 'Setup' || !j.head_blob_id || j.head_blob_id === ZERO_ID) return;
  const head = await readBlob(NETWORK, client, j.head_blob_id, { label: 'current head', cacheDir: paths.blobs });
  await verifyBaseCircuit(BASE_ZKEY, head.file);
  log('  base zkey circuit hash matches the on-chain head');
}

// accept advances the head (needs the Clock); reject just reopens the slot.
function callAttestor(fn, pending) {
  if (!/^[0-9a-fA-F]{128}$/.test(pending.contributionHash || '')) {
    throw new Error(`pending contribution hash is not 64-byte hex: ${pending.contributionHash || ''}`);
  }
  const contributionHash = Array.from(Buffer.from(pending.contributionHash || '', 'hex'));
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG}::groth16_phase2::${fn}`,
    arguments: fn === 'reject'
      ? [tx.object(CAP), tx.object(CER), tx.pure.id(pending.sharedBlobId), tx.pure.vector('u8', contributionHash), tx.pure.address(pending.who)]
      : [
        tx.object(CAP),
        tx.object(CER),
        tx.pure.id(pending.headSharedBlobId),
        tx.pure.id(pending.sharedBlobId),
        tx.pure.vector('u8', contributionHash),
        tx.pure.address(pending.who),
        tx.object(CLOCK),
      ],
  });
  return exec(client, attestor, tx);
}

async function main() {
  log(`coordinator up — network=${NETWORK} ceremony=${CER} attestor=${attestor.toSuiAddress()} walrusBlobIO=cli`);
  for (const f of [BASE_ZKEY, BASE_PTAU]) if (!fs.existsSync(f)) { console.error(`not found: ${f}`); process.exit(1); }
  try {
    const initial = await readCeremony(client, CER);
    await checkBaseArtifactsMatchChain(initial);
    monitor.observe(initial);
  } catch (e) {
    console.error(`base artifact check failed: ${e?.message || e}`);
    process.exit(1);
  }
  if (PORT) {
    log(`automatic funding per new contributor (${NETWORK}): ${formatCoinAmount(AIRDROP.sui)} SUI + ${formatCoinAmount(AIRDROP.wal)} WAL`);
    startCoordinatorHttpServer(Number(PORT), WORKDIR, {
      monitor,
      funding: createFundingService({ client, keypair: attestor, workdir: WORKDIR, network: NETWORK, packageId: PKG, ceremonyId: CER, capId: CAP, airdrop: AIRDROP }),
    });
  }

  for (;;) {
    try {
      monitor.activity('polling', 'Reading ceremony from Sui');
      const head = await readCeremony(client, CER);
      monitor.observe(head);
      const c = parseSlot(head);
      if (c.slot === 'Pending') {
        log(`pending: ${c.name || '?'} by ${c.who?.slice(0, 10)}… shared blob ${c.sharedBlobId?.slice(0, 12)}… hash ${c.contributionHash?.slice(0, 16) || '?'}…`);

        let v;
        try {
          v = await verifyContribution({
            network: NETWORK,
            client,
            sharedBlobId: c.sharedBlobId,
            expectedHash: c.contributionHash,
            headSharedBlobId: c.headSharedBlobId,
            baseZkey: BASE_ZKEY,
            ptau: BASE_PTAU,
            workdir: WORKDIR,
            onProgress: (step, graceMs) => monitor.activity('verifying', step, graceMs),
          });
        } catch (e) {
          const reason = e?.message || String(e);
          log(`  verify error after internal retries: ${reason}; leaving pending for admin`);
          monitor.fail('Verification stopped; organizer intervention required. Check the attestor log.', { stopped: true });
          process.exitCode = 1;
          return;
        }

        monitor.activity(v.ok ? 'accepting' : 'rejecting', 'Submitting the verification verdict to Sui', 120_000);
        if (v.ok) {
          const d = await callAttestor('accept', c);
          log(`  verified OK in ${v.sec.toFixed(1)}s -> accepted (${d}); chain now ${c.chainLen + 1}`);
        } else {
          const reason = v.reason || 'invalid contribution';
          const d = await callAttestor('reject', c);
          log(`  ${reason} in ${v.sec.toFixed(1)}s -> rejected (${d})`);
        }
        monitor.activity('polling', 'Refreshing ceremony after verification');
        monitor.observe(await readCeremony(client, CER));
      }
    } catch (e) {
      monitor.fail('Could not complete the latest ceremony poll or transaction; retrying. Check the attestor log.');
      log(`loop error: ${e?.message || e}`);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
