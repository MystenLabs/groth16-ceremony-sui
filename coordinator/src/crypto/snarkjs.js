// The coordinator's only snarkjs dependency boundary.
// Artifact transformations, verification, and transcript parsing live here.
//
// snarkjs can return false or throw for invalid artifacts. Callers choose how
// to handle these failures:
// - Abort-on-error: call operations directly and let exceptions abort the
//   workflow. Callers must also check explicit false results. Used for genesis,
//   sealing, auditing, and reading the previously accepted head.
// - Reject-on-error: use runContributionStepOrReject when verifying pending
//   submissions from external contributors. Explicit false results and all
//   exceptions become contribution rejections, regardless of error code.
//
// Reject-on-error can reject valid contributions during operational or
// integration failures, but cannot make invalid contributions pass. Rejections
// retain the operation and original error message so failures remain diagnosable.
//
// Local files only. Callers own temporary directories and cleanup.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import * as snarkjs from 'snarkjs';

const SNARKJS = fileURLToPath(new URL('../../node_modules/snarkjs/cli.js', import.meta.url));
const directStep = (_label, fn) => fn();

// Normalize wrapped snarkjs operations into a result, including all exceptions.
// During contribution verification:
// - ok: true => continue; accept the contribution once all checks succeed.
// - ok: false => reject the contribution and continue the attestor loop.
// Failures outside this wrapper can still throw. The contribution then stays
// Pending, and the attestor loop tries the verification again.
export async function runContributionStepOrReject(operation, fn) {
  try {
    const value = await fn();
    return value === false
      ? {
          ok: false,
          reason: operation === 'extends'
            ? 'does not extend head (v2paramsExtends)'
            : operation === 'verifyFromInit'
              ? 'invalid chain (verifyFromInit)'
              : `snarkjs ${operation} returned false`,
        }
      : { ok: true, value };
  } catch (error) {
    return {
      ok: false,
      reason: `verification failed (${operation}: ${error?.message || String(error)})`,
    };
  }
}

export function snarkLogger(log = () => {}) {
  return { info: (m) => log(`  ${m}`), debug() {}, warn: (m) => log(`w ${m}`), error: (m) => log(`e ${m}`) };
}

export const decompressParams = (params, p2u, logger) =>
  snarkjs.zKey.decompressV2Params(params, p2u, logger);

export const assembleZkey = (baseZkey, p2u, fullZkey, logger) =>
  snarkjs.zKey.assemble(baseZkey, p2u, fullZkey, logger);

export async function assembleParams({ baseZkey, params, fullZkey, p2u = { type: 'mem' }, step = directStep, logger }) {
  await step('decompress', () => decompressParams(params, p2u, logger));
  await step('assemble', () => assembleZkey(baseZkey, p2u, fullZkey, logger));
}

export async function extractParams({ fullZkey, p2u, p2c, step = directStep, logger, nodeOptions }) {
  // Genesis keeps conversions in high-heap child processes, as before. Seal
  // and audit use the in-process API and their caller-owned scratch files.
  await step('extract', () => nodeOptions
    ? snarkCommand(['zkey', 'extract', fullZkey, p2u], nodeOptions)
    : snarkjs.zKey.extract(fullZkey, p2u, logger));
  await step('compress', () => nodeOptions
    ? snarkCommand(['zkey', 'compress', 'v2params', p2u, p2c], nodeOptions)
    : snarkjs.zKey.compressV2Params(p2u, p2c, logger));
}

export const verifyFromInit = (baseZkey, ptau, fullZkey, logger) =>
  snarkjs.zKey.verifyFromInit(baseZkey, ptau, fullZkey, logger);
export const extendsHead = (head, submission) => snarkjs.zKey.v2paramsExtends(head, submission);
export const exportVerificationKey = (zkey, logger) => snarkjs.zKey.exportVerificationKey(zkey, logger);
export const applyBeacon = (input, output, name, beacon, exp, logger) =>
  snarkjs.zKey.beacon(input, output, name, beacon, exp, logger);

// Use a separate process for the memory-heavy R1CS setup/verification. Keep the
// CLI argument spelling shared by genesis and final audit (the longer
// `zkey verify r1cs` alias is ambiguous in this pinned snarkjs CLI).
function snarkCommand(args, nodeOptions) {
  execFileSync(process.execPath, [SNARKJS, ...args], {
    stdio: 'inherit',
    env: { ...process.env, NODE_OPTIONS: nodeOptions },
  });
}

export function verifyZkeyFromR1cs({ r1cs, ptau, zkey, nodeOptions }) {
  const options = nodeOptions ?? (process.env.NODE_OPTIONS?.includes('--max-old-space-size')
    ? process.env.NODE_OPTIONS
    : [process.env.NODE_OPTIONS, '--max-old-space-size=16384'].filter(Boolean).join(' '));
  snarkCommand(['zkey', 'verify', r1cs, ptau, zkey], options);
}

export async function buildGenesis({ r1cs, ptau, outDir, step = directStep, logger, nodeOptions = process.env.GENESIS_NODE_OPTIONS || '--max-old-space-size=16384' }) {
  const fullZkey = path.join(outDir, 'circuit_0000.zkey');
  const p2u = path.join(outDir, 'circuit_0000.p2u');
  const p2c = path.join(outDir, 'circuit_0000.p2c');
  await step('g16s', () => snarkCommand(['g16s', r1cs, ptau, fullZkey], nodeOptions));
  await extractParams({ fullZkey, p2u, p2c, step, logger, nodeOptions });
  return { fullZkey, p2u, p2c };
}

const hex = (bytes) => Buffer.from(bytes).toString('hex');

export async function readContributionInfo(file) {
  const { mpcParams, hashes } = await snarkjs.zKey.readMPCParamsFile(file);
  return {
    // Circuit hash from §10 — the same for every artifact of one ceremony, so
    // it binds a params file to the circuit it belongs to.
    csHash: hex(mpcParams.csHash),
    hashes: hashes.map(hex),
    contributions: mpcParams.contributions.map((c) => ({
      type: c.type || 0,
      name: c.name || '',
      beaconHash: c.beaconHash ? hex(c.beaconHash) : null,
      numIterationsExp: c.numIterationsExp ?? null,
    })),
  };
}
