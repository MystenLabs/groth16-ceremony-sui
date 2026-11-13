// Turn a contribution error into a short explanation and a next step.
// Why it exists: Raw errors name internal parts (attestor, allowlist, slot).
// A contributor needs to know what happened, if anything is lost, and what to do.
// Assumptions: The raw error always goes to the progress log as well.

const RETRY = 'Run the same command to try again. Your key and funds are kept.';

// Stop before a step if the turn has ended. The chain refuses a late submission.
export function assertTurnOpen(turnEndsAt, step, now = Date.now()) {
  if (Number.isFinite(turnEndsAt) && now >= turnEndsAt) throw new Error(`turn ended before the ${step}`);
}

const RULES = [
  {
    test: /turn ended before the/,
    explain: ({ message }) => ({
      title: 'Your turn ended before the contribution was complete.',
      lines: [`${capitalize(message)}. Nothing was submitted.`, RETRY],
    }),
  },
  {
    test: /not on the ceremony's allowlist/,
    explain: ({ address }) => ({
      title: 'You are not enrolled in this ceremony yet.',
      lines: ['Send your contribution address to the organizer:', '', `    ${address}`, '', 'When they confirm, run the same command again.'],
    }),
  },
  {
    test: /attestor unavailable|attestor health check|did not report a healthy loop/,
    explain: () => ({
      title: 'The ceremony checker is not available right now.',
      lines: ['Nothing is lost. Wait a few minutes.', RETRY],
    }),
  },
  {
    test: /different ceremony or network|no coordinator URL/,
    explain: () => ({
      title: 'The ceremony coordinator is not set up correctly.',
      lines: ['Send the log to the organizer.', 'Run the same command again when they tell you.'],
    }),
  },
  {
    test: /funding link is for a different ceremony/,
    explain: () => ({
      title: 'This funding link is for a different ceremony.',
      lines: ['Ask the organizer for the funding link for this ceremony.'],
    }),
  },
  {
    test: /ceremony is closed|ceremony is finalized|finalized\/closed/,
    explain: () => ({ title: 'This ceremony does not accept contributions anymore.', lines: [] }),
  },
  {
    test: /phase 2 has not started/,
    explain: () => ({
      title: 'This ceremony is not open for contributions yet.',
      lines: ['Run the same command again when the organizer opens it.'],
    }),
  },
  {
    test: /is not a ceremony|Object 0x[0-9a-fA-F]+ not found/,
    explain: ({ network }) => ({
      title: `No ceremony with this ID exists on ${network}.`,
      lines: ['Check the ceremony ID and the network.'],
    }),
  },
  {
    test: /funding|payout|top-up/,
    explain: ({ message }) => ({ title: 'Automatic funding did not work.', lines: [capitalize(message) + '.'] }),
  },
  {
    test: /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|aggregator|socket|timed out|HTTP 5\d\d/i,
    explain: () => ({
      title: 'A network request failed.',
      lines: ['Check your internet connection.', RETRY],
    }),
  },
];

function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1).replace(/\.$/, '');
}

export function errorMessage(err) {
  let msg = String(err?.message || err);
  for (let c = err?.cause; c; c = c.cause) msg += ` <- ${c.message || c}`;
  return msg;
}

// `stage` is the stage that failed. A failed transaction while we hold the turn
// usually means that the turn expired.
export function explainFailure(err, { address, network, stage } = {}) {
  const message = errorMessage(err);
  if (stage === 'verify' && /tx failed/.test(message)) {
    return {
      title: 'The contribution could not be submitted.',
      lines: ['Your turn probably ended before the upload finished.', RETRY],
    };
  }
  const rule = RULES.find((r) => r.test.test(message));
  if (rule) {
    return rule.explain({ address, network, message });
  }
  return { title: 'The contribution stopped because of an error.', lines: [message, '', RETRY] };
}
