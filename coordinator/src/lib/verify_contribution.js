// Phase-2 contribution verification. The submission is identified by its
// SharedBlob object id; we first resolve it through the durable blob policy
// and a size bound (both pre-download), then run the crypto:
//   1. position — the blob extends the current head by exactly one contribution
//      (v2paramsExtends; guards against building on an old head or a self-chain).
//   2. transcript — each entry is a plain contribution, and the last entry hash
//      is the on-chain contribution hash.
//   3. validity — reinject the frozen base sections (3-7) to reform a full zkey,
//      then run snarkjs's full-chain verifier against the ptau (verifyFromInit).
// Blobs are read via readBlob, which resolves the SharedBlob id, enforces the
// durable blob policy, caches the content blob on disk, and returns a local path.
//
// Explicit failures and all wrapped snarkjs exceptions reject under the policy
// in crypto/snarkjs.js. Failures outside that wrapper can still halt for review.

import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { log } from './config.js';
import { readContributionInfo } from '../crypto/snarkjs.js';
import { readBlob, resolveBlob } from '../crypto/walrus.js';

const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'verify_worker.js');

// Heap limit for the isolated verification. It must be above the need of a
// legitimate 2^21 run (low GBs) and below the host RAM. It is a limit, not a reservation.
// A blob that fills the heap stops the child, not the coordinator.
const maxOldSpaceMb = () => Number(process.env.VERIFY_MAX_OLD_SPACE_MB) || 8192;
// Time limit for the isolated verification. It stops a child that an input keeps busy.
export const verificationTimeoutMs = () => Number(process.env.VERIFY_TIMEOUT_MS) || 10 * 60 * 1000;

const STEP_LABELS = {
  resolve: 'resolve submitted SharedBlob',
  dlHead: 'load current head p2c',
  parseHead: 'parse current head p2c',
  dlSub: 'load submitted p2c',
};

// Cap submitted params blobs before download so a hostile blob can't trigger an
// arbitrarily large download. 256 MiB covers the current 2^21 circuit (~120 MB)
// with room for contributions. Larger circuits need a higher limit.
export const MAX_SUBMISSION_BYTES = 256 * 1024 * 1024;

// Check the submission size before downloading it.
// The size comes from the on-chain blob metadata.
export function checkSubmissionSize(declaredSize) {
  if (!Number.isFinite(declaredSize)) return { ok: false, reason: 'submitted blob has no readable on-chain size' };
  if (declaredSize > MAX_SUBMISSION_BYTES) {
    return { ok: false, reason: `submitted blob too large (${declaredSize} B > ${MAX_SUBMISSION_BYTES} B limit)` };
  }
  return { ok: true };
}

// Run verification in a bounded child process.
// - Child crash/OOM/timeout => reject the submission.
// - Any reported exception => rethrow for operator review.
// The child returns all step timings with its final response.
export function runVerifyStepsIsolated({ headPath, subPath, baseZkey, ptau, workdir, expectedHash }) {
  return new Promise((resolve, reject) => {
    const TIMEOUT_MS = verificationTimeoutMs();
    // Relay stdout, but buffer stderr to prevent hostile blobs from flooding logs.
    const child = fork(WORKER, [], { execArgv: [`--max-old-space-size=${maxOldSpaceMb()}`], silent: true });
    child.stdout?.on('data', (b) => process.stdout.write(b));

    // Keep the useful error line and only a short stderr tail.
    let stderrTail = '';
    let diagnosis = '';
    child.stderr?.on('data', (b) => {
      stderrTail += b;
      if (!diagnosis) {
        diagnosis = stderrTail.split('\n').find((l) => /FATAL ERROR|Check failed|Error:/.test(l))?.trim() || '';
      }
      stderrTail = stderrTail.slice(-2000);
    });

    let settled = false;
    let outcome = null;

    const finish = (fn) => { if (!settled) { settled = true; clearTimeout(timer); child.removeAllListeners(); try { child.kill('SIGKILL'); } catch { /* already gone */ } fn(); } };
    const timer = setTimeout(() => {
      outcome = { reason: `malformed submission (verify exceeded ${Math.round(TIMEOUT_MS / 1000)}s; killed)` };
      finish(() => resolve({ ok: false, ...outcome }));
    }, TIMEOUT_MS);

    child.once('message', (message) => { outcome = message; });

    child.on('error', (e) => finish(() => reject(e)));

    child.on('exit', (code, signal) => {
      finish(() => {
        if (code === 0 && outcome?.type === 'result') return resolve({ ...outcome.value, timings: outcome.timings });
        if (code === 0 && outcome?.type === 'error') {
          return reject(Object.assign(new Error(outcome.message), { code: 'EVERIFYCHILD', timings: outcome.timings }));
        }

        const how = signal ? `signal ${signal}` : `exit code ${code}`;
        // Log one useful line without dumping the child's stderr.
        const why = diagnosis || stderrTail.trim().split('\n').filter(Boolean).pop();
        if (why) log(`  verify child died (${how}): ${why.slice(0, 200)}`);
        resolve({ ok: false, reason: `malformed submission (verify process died: ${how})` });
      });
    });

    child.send({ headPath, subPath, baseZkey, ptau, workdir, expectedHash });
  });
}

export async function verifyContribution({ network, client, sharedBlobId, headSharedBlobId, baseZkey, ptau, workdir, expectedHash, onProgress = () => {} }) {
  if (typeof expectedHash !== 'string') throw new Error('expected contribution hash is required');
  const t0 = Date.now();
  const done = (extra) => ({ sec: (Date.now() - t0) / 1000, ...extra });

  // Per-step timings so the verify cost is legible (resolve/download/crypto).
  const timings = {};
  const step = async (k, fn) => {
    const label = STEP_LABELS[k] || k;
    const s = Date.now();
    onProgress(label, 120_000);
    log(`  ${label}…`);
    try {
      const r = await fn();
      timings[k] = +((Date.now() - s) / 1000).toFixed(1);
      const result = typeof r === 'boolean' ? ` (${r})` : '';
      log(`  ${label} OK in ${timings[k].toFixed(1)}s${result}`);
      return r;
    } catch (e) {
      timings[k] = +((Date.now() - s) / 1000).toFixed(1);
      log(`  ${label} failed in ${timings[k].toFixed(1)}s: ${e?.message || e}`);
      throw e;
    }
  };
  const finish = (extra) => { log(`  verify timings (s): ${Object.entries(timings).map(([k, v]) => `${k}=${v}`).join(' ')}`); return done({ timings, ...extra }); };

  // Return:
  //   ok=true  -> accept the contribution
  //   ok=false -> reject the contribution
  //   throw    -> verification could not finish; leave it Pending for review
  //
  // The snarkjs wrapper normalizes explicit failures and all exceptions into
  // ok=false. Failures outside the wrapper still throw and leave the slot Pending.

  // (0) durability: resolve the submission's SharedBlob and check it's shared + durable.
  const sub = await step('resolve', () => resolveBlob(network, client, sharedBlobId));
  if (!sub.ok) return finish({ ok: false, reason: sub.reason });

  const blobId = sub.contentBlobId;
  const cacheDir = path.join(workdir, 'blobs');
  const head = await step('dlHead', () => readBlob(network, client, headSharedBlobId, { label: 'current head', cacheDir }));

  // Make sure our current head is valid before checking the submission.
  // If the head is broken, stop rather than blaming the submission.
  await step('parseHead', () => readContributionInfo(head.file));

  // (1) size: bound the submission before downloading it, using its on-chain
  // declared size against a fixed limit.
  const size = checkSubmissionSize(sub.declaredSize);
  if (!size.ok) return finish({ ok: false, blobId, reason: size.reason });

  const submission = await step('dlSub', () => readBlob(network, client, sharedBlobId, { label: 'submitted blob', cacheDir }));
  const headPath = head.file;
  const subPath = submission.file;

  // position (extends head by one) + validity (reinject base, verify from genesis).
  log('  verifying contribution in child process…');
  onProgress('Checking contribution cryptography', verificationTimeoutMs() + 60_000);
  const result = await runVerifyStepsIsolated({ headPath, subPath, baseZkey, ptau, workdir, expectedHash });
  Object.assign(timings, result.timings);
  return finish({ blobId, ...result });
}
