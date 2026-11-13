// Local contribution verification and bindings to ceremony commitments.
//
// snarkjs reports invalid contributions both by returning false and by throwing
// on malformed binary inputs. crypto/snarkjs.js privately normalizes those into
// the same rejection result; operational failures still throw from this worker.
import fs from 'node:fs';
import path from 'node:path';
import {
  runContributionStepOrReject,
  decompressParams,
  assembleZkey,
  readContributionInfo,
  verifyFromInit,
  extendsHead as checkExtendsHead,
  snarkLogger,
} from './snarkjs.js';

// Main cryptographic verification pipeline for an individual submission; start
// the contribution audit here and follow the calls into snarkjs.js. It checks:
// 1. The submission extends the accepted head by exactly one contribution.
// 2. Each transcript entry is a plain contribution, not a beacon entry.
// 3. Its final contribution hash matches the expected on-chain submission hash.
// 4. Its reassembled full zkey verifies against the supplied genesis and ptau.
// Production runs this function in verify_worker.js through runVerifyStepsIsolated.
// expectedHash is required for every caller, including benchmarks and tests.
export async function runVerifySteps({ headPath, subPath, baseZkey, ptau, workdir, expectedHash, step, log = () => {} }) {
  if (typeof expectedHash !== 'string' || !/^[0-9a-f]{128}$/.test(expectedHash)) {
    throw new Error('expectedHash must be a 64-byte lowercase hexadecimal contribution hash');
  }
  const run = step || ((_key, fn) => fn());
  const snarkStep = async (key, fn) => {
    log(`${key}...`);
    const result = await run(key, () => runContributionStepOrReject(key, fn));
    log(result.ok ? `${key} OK` : `${key} rejected: ${result.reason}`);
    return result;
  };
  const snarkLog = { ...snarkLogger(console.warn), info() {} };
  const fullPath = path.join(workdir, `full-${path.basename(subPath).slice(0, 12)}.zkey`);
  // Note: Exceptions thrown by snarkjs.js leave the slot Pending for operator attention.
  // TODO: Should we wire it up so that we receive a message on Slack when the below throws (assuming its easy to setup)?
  try {
    // Read the submission through the memory reader, as the contributor CLI does.
    // The disk reader returns zeros for a read past the end of a file.
    let result = await snarkStep('load', () => ({ type: 'mem', data: new Uint8Array(fs.readFileSync(subPath)) }));
    if (!result.ok) return result;
    const submission = result.value;

    result = await snarkStep('extends', () => checkExtendsHead(headPath, submission));
    if (!result.ok) return result;

    // Check the transcript before the slow steps.
    result = await snarkStep('transcript', () => readContributionInfo(submission));
    if (!result.ok) return result;
    const { contributions, hashes } = result.value;
    // Only the organizer adds a beacon entry. Each entry in a submission must be plain.
    const plain = (entry) => entry.type === 0 && entry.beaconHash === null && entry.numIterationsExp === null;
    if (!contributions.every(plain)) {
      return { ok: false, reason: 'submission contains an entry that is not a plain contribution' };
    }
    const contributionHash = hashes.at(-1);
    if (!contributionHash) return { ok: false, reason: 'submitted blob has no contribution hash' };
    if (contributionHash !== expectedHash) {
      return { ok: false, reason: `contribution hash mismatch: submitted ${expectedHash} verified ${contributionHash}` };
    }

    const p2u = { type: 'mem' };
    result = await snarkStep('decompress', () => decompressParams(submission, p2u, snarkLog));
    if (!result.ok) return result;
    result = await snarkStep('assemble', () => assembleZkey(baseZkey, p2u, fullPath, snarkLog));
    if (!result.ok) return result;
    result = await snarkStep('verifyFromInit', () => verifyFromInit(baseZkey, ptau, fullPath, snarkLog));
    if (!result.ok) return result;
    return { ok: true };
  } finally {
    fs.rmSync(fullPath, { force: true });
  }
}

export async function verifyBaseCircuit(baseZkey, headPath) {
  const base = await readContributionInfo(baseZkey);
  const head = await readContributionInfo(headPath);
  if (base.csHash !== head.csHash) throw new Error(`BASE_ZKEY ${baseZkey} csHash ${base.csHash} does not match the on-chain head's ${head.csHash}`);
}
