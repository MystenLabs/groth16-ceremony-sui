// Budgets for ~114.8 MiB compressed zkLogin contributions stored for 53 epochs.
// Testnet rehearsal: 0.120434316 WAL/upload and ~0.013 SUI/contribution.
// Mainnet quote (2026-09-17): 2.636464920 WAL/upload at 53 epochs;
// relay tip 0.023694320 SUI/upload. Gas allowance is estimated from testnet.
// TODO: validate and tune mainnet budgets after an end-to-end mainnet mock.
// Keep separate network entries so future tuning does not affect both networks.
const FUNDING_BY_NETWORK = Object.freeze({
  testnet: Object.freeze({ sui: 60_000_000n, wal: 300_000_000n, minSui: 40_000_000n, minWal: 150_000_000n }),
  mainnet: Object.freeze({ sui: 100_000_000n, wal: 6_000_000_000n, minSui: 50_000_000n, minWal: 3_000_000_000n }),
});

export function fundingDefaults(network) {
  if (!Object.hasOwn(FUNDING_BY_NETWORK, network)) throw new Error(`unknown funding network ${network}`);
  return FUNDING_BY_NETWORK[network];
}
