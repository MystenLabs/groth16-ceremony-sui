// Complete cryptographic audit of locally downloaded ceremony artifacts.
// The command supplies one chain snapshot and files; this module owns every
// artifact/transcript/beacon comparison needed before reporting audit success.
import fs from 'node:fs';
import path from 'node:path';
import { sameFileBytes } from '../lib/files.js';
import { canonicalJsonBytes } from '../lib/json.js';
import { b2sumFile, sha256File, verifyPhase1Digest } from './commitments.js';
import { verifyBlobId } from './walrus.js';
import { readContributionInfo, extractParams, exportVerificationKey, verifyZkeyFromR1cs, snarkLogger } from './snarkjs.js';

const b64Hex = (v) => Buffer.from(v || '', 'base64').toString('hex');
function assertOk(condition, message) {
  if (!condition) throw new Error(`audit failed: ${message}`);
}

function assertHashArrayEq(actual, expected, label) {
  assertOk(actual.length === expected.length, `${label} contribution count ${actual.length} != expected ${expected.length}`);
  for (let i = 0; i < expected.length; i++) {
    assertOk(actual[i] === expected[i], `${label} contribution hash #${i + 1} mismatch`);
  }
}

async function verifyExtractedFinalParams({ finalZkey, finalParams, runDir, log }) {
  const tmp = fs.mkdtempSync(path.join(runDir, 'final-'));
  try {
    const p2u = path.join(tmp, 'final.p2u');
    const p2c = path.join(tmp, 'final.p2c');
    log('extracting final zkey params for byte comparison');
    await extractParams({ fullZkey: finalZkey, p2u, p2c, logger: snarkLogger(log) });
    assertOk(sameFileBytes(p2c, finalParams), 'uploaded final zkey does not derive the final params blob');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function verifyFinalVkey({ finalZkey, finalVkey, log }) {
  log('verifying uploaded final vkey');
  const expected = canonicalJsonBytes(await exportVerificationKey(finalZkey, snarkLogger(log)));
  const actual = fs.readFileSync(finalVkey);
  assertOk(Buffer.compare(expected, actual) === 0, 'uploaded final vkey does not match final zkey export');
}

export function checkFinalCeremony(ceremony) {
  const phase = ceremony.phase?.['@variant'] || 'Setup';
  assertOk(phase === 'Closed', `ceremony phase is ${phase}; final audit only runs after Closed`);
  const chain = Array.isArray(ceremony.chain) ? ceremony.chain : [];
  assertOk(chain.length > 0, 'closed ceremony has no accepted final contribution');
  assertOk(ceremony.head_blob_id === chain.at(-1).blob_id, 'head_blob_id does not match final chain entry');
  const finalBeaconHex = b64Hex(ceremony.final_beacon);
  assertOk(finalBeaconHex.length === 64, 'final beacon is not 32 bytes');
  const phase1Digest = b64Hex(ceremony.phase1_digest);
  assertOk(/^[0-9a-f]{128}$/.test(phase1Digest), 'ceremony phase1_digest is not 64 bytes');
  return { chain, finalBeaconHex, phase1Digest };
}

export async function verifyFinalArtifacts({
  ceremony, r1cs, expectedR1csBlobId, actualR1csBlobId, localR1cs,
  ptau, finalZkey, finalVkey, contributions, workdir, log = () => {},
}) {
  const { chain, finalBeaconHex, phase1Digest } = checkFinalCeremony(ceremony);
  verifyBlobId(actualR1csBlobId, expectedR1csBlobId);
  log(`r1cs Walrus blob id ok ${actualR1csBlobId}`);
  log(`r1cs sha256 ${await sha256File(r1cs)}`);
  log(`r1cs b2sum ${await b2sumFile(r1cs)}`);
  if (localR1cs) {
    assertOk(sameFileBytes(localR1cs, r1cs), `downloaded r1cs does not match local input ${localR1cs}`);
    log(`downloaded r1cs matches local input ${path.resolve(localR1cs)}`);
  }
  await verifyPhase1Digest(ptau, phase1Digest);
  log(`phase-1 digest ok ${phase1Digest.slice(0, 24)}...`);
  log(`phase-1 sha256 ${await sha256File(ptau)}`);
  log(`phase-1 b2sum ${phase1Digest}`);

  log('verifying final zkey with snarkjs zkey verify r1cs');
  verifyZkeyFromR1cs({ r1cs, ptau, zkey: finalZkey });
  const finalZkeyInfo = await readContributionInfo(finalZkey);
  assertOk(finalZkeyInfo.hashes.length === chain.length, `final zkey has ${finalZkeyInfo.hashes.length} contributions, ceremony chain has ${chain.length}`);
  const lastContribution = finalZkeyInfo.contributions.at(-1);
  assertOk(lastContribution, 'final zkey has no contributions');
  assertOk(lastContribution.type === 1, 'final zkey last contribution is not a beacon contribution');
  assertOk(lastContribution.beaconHash === finalBeaconHex, 'final zkey beacon does not match on-chain final beacon');
  // Contribution types live in the artifact transcript, not on-chain entries.
  assertOk(finalZkeyInfo.contributions.some((entry) => entry.type === 0),
    'closed ceremony has no accepted non-beacon contribution');

  assertOk(contributions.length === chain.length, 'downloaded contribution count does not match ceremony chain');
  const chainHashes = [];
  for (let i = 0; i < chain.length; i++) {
    const c = chain[i];
    const label = `chain #${i + 1} ${c.name || '(unnamed)'}`;
    assertOk(contributions[i].sharedBlobId === c.blob_id, `${label} downloaded blob does not match chain entry`);
    const onchainHash = b64Hex(c.contribution_hash);
    assertOk(/^[0-9a-f]{128}$/.test(onchainHash), `${label} on-chain contribution_hash is not 64 bytes`);
    const info = await readContributionInfo(contributions[i].file);
    assertOk(info.hashes.length === i + 1, `${label} has ${info.hashes.length} contributions, expected ${i + 1}`);
    assertHashArrayEq(info.hashes.slice(0, i), chainHashes, `${label} prefix`);
    assertOk(info.hashes[i] === onchainHash, `${label} blob contribution hash does not match on-chain contribution_hash`);
    assertOk(onchainHash === finalZkeyInfo.hashes[i], `${label} on-chain contribution_hash does not match final zkey`);
    chainHashes.push(onchainHash);
    log(`${label}: contribution hash and prefix verified`);
  }
  assertHashArrayEq(chainHashes, finalZkeyInfo.hashes, 'on-chain chain');
  const finalParams = contributions.at(-1).file;
  await verifyExtractedFinalParams({ finalZkey, finalParams, runDir: workdir, log });
  await verifyFinalVkey({ finalZkey, finalVkey, log });
  log(`final params b2sum ${await b2sumFile(finalParams)}`);
  log(`final zkey b2sum ${await b2sumFile(finalZkey)}`);
  log(`final vkey b2sum ${await b2sumFile(finalVkey)}`);
  return { contributionCount: chain.length };
}
