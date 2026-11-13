// Security-critical final seal artifact builder.
//
// This file owns the public-beacon contribution pipeline. It deliberately does
// not sign transactions or mutate chain state; callers get back verified p2c
// bytes plus the persisted final artifact paths, and decide how to upload/submit.

import fs from 'node:fs';
import path from 'node:path';
import { assembleParams, extractParams, applyBeacon, exportVerificationKey, extendsHead as checkExtendsHead, verifyFromInit, snarkLogger } from './snarkjs.js';
import { canonicalJsonBytes } from '../lib/json.js';

const DEFAULT_BEACON_EXP = 10;

function defaultSealOutputs(workdir) {
  return {
    outputP2c: path.join(workdir, 'final.p2c'),
    outputZkey: path.join(workdir, 'final.zkey'),
    outputVkey: path.join(workdir, 'final.vkey.json'),
  };
}

function assertFile(p) {
  if (!fs.existsSync(p)) throw new Error(`not found: ${p}`);
}

function assertBeaconHex(beaconHex) {
  if (typeof beaconHex !== 'string' || !/^[0-9a-fA-F]{64}$/.test(beaconHex)) {
    throw new Error('final beacon must be a 32-byte hex string');
  }
}

export function parseBeaconExp(value) {
  const n = Number(value ?? DEFAULT_BEACON_EXP);
  if (!Number.isInteger(n) || n < 10 || n > 63) throw new Error('--beacon-exp must be an integer between 10 and 63');
  return n;
}

function ensureParent(p) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
}

// Local, security-critical final seal pipeline. This intentionally has no
// Walrus or Sui dependency, so tests and manual workflows can exercise the same
// artifact transformation as production:
//   head p2c -> p2u -> full zkey -> zKey.beacon(type=1)
//             -> p2u -> p2c -> v2paramsExtends + verifyFromInit
export async function buildFinalBeaconP2c({
  headP2c,
  beaconHex,
  name,
  baseZkey,
  ptau,
  workdir,
  beaconExp,
  log = () => {},
}) {
  assertFile(headP2c);
  assertFile(baseZkey);
  assertFile(ptau);
  assertBeaconHex(beaconHex);
  const exp = parseBeaconExp(beaconExp);
  const snarkLog = snarkLogger(log);

  fs.mkdirSync(workdir, { recursive: true });
  const outputs = defaultSealOutputs(workdir);
  const finalP2c = outputs.outputP2c;
  const finalZkey = outputs.outputZkey;
  const finalVkey = outputs.outputVkey;
  ensureParent(finalP2c);
  ensureParent(finalZkey);
  ensureParent(finalVkey);

  const sealDir = fs.mkdtempSync(path.join(workdir, 'seal-'));
  try {
    const headP2u = path.join(sealDir, 'head.p2u');
    const fullHead = path.join(sealDir, 'head.zkey');
    const fullSealed = path.join(sealDir, 'final.zkey');
    const sealedP2u = path.join(sealDir, 'sealed.p2u');
    const sealedP2c = path.join(sealDir, 'final.p2c');
    const sealedVkey = path.join(sealDir, 'final.vkey.json');

    log('decompressing and assembling current head full zkey...');
    await assembleParams({ baseZkey, params: headP2c, fullZkey: fullHead, p2u: headP2u, logger: snarkLog });

    log(`applying public beacon contribution (exp ${exp})...`);
    const hash = await applyBeacon(fullHead, fullSealed, name, beaconHex, exp, snarkLog);
    if (!hash) throw new Error('snarkjs beacon failed');
    const hashHex = Buffer.from(hash).toString('hex');

    log('extracting sealed zkey -> p2u and compressing -> p2c...');
    await extractParams({ fullZkey: fullSealed, p2u: sealedP2u, p2c: sealedP2c, logger: snarkLog });
    const vkey = await exportVerificationKey(fullSealed, snarkLog);
    const vkeyBytes = canonicalJsonBytes(vkey);
    fs.writeFileSync(sealedVkey, vkeyBytes);

    log('verifying sealed output extends head and verifies from init...');
    const extendsHead = await checkExtendsHead(headP2c, sealedP2c);
    if (!extendsHead) throw new Error('sealed beacon output does not extend current head');
    const valid = await verifyFromInit(baseZkey, ptau, fullSealed, snarkLog);
    if (!valid) throw new Error('sealed beacon output failed verifyFromInit');
    const sealedBytes = new Uint8Array(fs.readFileSync(sealedP2c));

    fs.renameSync(fullSealed, finalZkey);
    fs.renameSync(sealedP2c, finalP2c);
    fs.renameSync(sealedVkey, finalVkey);

    const result = {
      hashHex,
      beaconExp: exp,
      sealedBytes,
      vkeyBytes,
      sealedP2c: finalP2c,
      fullSealedZkey: finalZkey,
      verificationKey: finalVkey,
    };
    return result;
  } finally {
    fs.rmSync(sealDir, { recursive: true, force: true });
  }
}
