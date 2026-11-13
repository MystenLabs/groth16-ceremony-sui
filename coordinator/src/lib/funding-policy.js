import { fundingDefaults } from '../../../cli/src/funding-policy.js';

export { fundingDefaults };

const UNIT = 1_000_000_000n;
const U64_MAX = (1n << 64n) - 1n;

export function parseCoinAmount(value, label = 'coin amount') {
  if (typeof value !== 'string' || !/^\d+(?:\.\d{1,9})?$/.test(value)) {
    throw new Error(`${label} must be a nonnegative decimal with at most 9 decimal places`);
  }
  const [whole, fraction = ''] = value.split('.');
  const amount = BigInt(whole) * UNIT + BigInt(fraction.padEnd(9, '0'));
  if (amount > U64_MAX) throw new Error(`${label} exceeds u64`);
  return amount;
}

export function formatCoinAmount(amount) {
  const fraction = String(amount % UNIT).padStart(9, '0').replace(/0+$/, '');
  return String(amount / UNIT) + (fraction ? `.${fraction}` : '');
}

export function resolveAirdropAmounts(network, overrides = {}) {
  const defaults = fundingDefaults(network);
  const amounts = {};
  for (const [coin, minimum] of [['sui', defaults.minSui], ['wal', defaults.minWal]]) {
    const label = `--airdrop-${coin}`;
    const amount = overrides[coin] == null ? defaults[coin] : parseCoinAmount(overrides[coin], label);
    if (amount < minimum) throw new Error(`${label} must be at least ${formatCoinAmount(minimum)} ${coin.toUpperCase()} to meet the contributor balance check`);
    amounts[coin] = amount;
  }
  return amounts;
}
