// Run phase-2 verification in isolation so malformed submissions cannot crash
// the coordinator. The parent handles child crashes, OOMs, and timeouts as rejects.
//
// One final IPC response: a result or error, including locally measured timings.
//
// Every caught exception is rethrown by the parent for operator review.

import { runVerifySteps } from '../crypto/verify_contribution.js';
import { log } from './config.js';

process.once('message', async (job) => {
  const timings = {};
  let response;
  try {
    const value = await runVerifySteps({
      ...job,
      log,
      step: async (key, fn) => {
        const t0 = Date.now();
        try {
          return await fn();
        } finally {
          timings[key] = +((Date.now() - t0) / 1000).toFixed(1);
        }
      },
    });

    response = { type: 'result', value, timings };
  } catch (e) {
    response = {
      type: 'error',
      message: e?.message || String(e),
      timings,
    };
  }
  // Flush the response before exiting; process.exit() alone can truncate IPC.
  process.send(response, (error) => process.exit(error ? 1 : 0));
});
