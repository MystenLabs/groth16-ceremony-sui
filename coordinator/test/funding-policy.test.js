import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fundingDefaults, resolveAirdropAmounts, parseCoinAmount, formatCoinAmount } from '../src/lib/funding-policy.js';

test('network budgets cover the measured 114.8 MiB upload with a buffer', () => {
  for (const network of ['testnet']) {
    const policy = fundingDefaults(network);
    assert.equal(policy.sui, 60_000_000n);
    assert.equal(policy.wal, 300_000_000n);
    assert.equal(policy.minWal, 150_000_000n);
    assert.ok(policy.minWal > 120_434_316n);
    assert.ok(policy.wal >= policy.minWal);
    assert.ok(policy.sui >= policy.minSui);
    assert.deepEqual(resolveAirdropAmounts(network), { sui: policy.sui, wal: policy.wal });
  }
  const mainnet = fundingDefaults('mainnet');
  assert.deepEqual(mainnet, { sui: 100_000_000n, wal: 6_000_000_000n, minSui: 50_000_000n, minWal: 3_000_000_000n });
  assert.ok(mainnet.wal - 2_636_464_920n >= mainnet.minWal);
  assert.ok(mainnet.sui - (23_694_320n + 13_000_000n) >= mainnet.minSui);
  assert.ok(fundingDefaults('testnet').wal - 120_434_316n >= fundingDefaults('testnet').minWal);
  assert.throws(() => fundingDefaults('devnet'), /unknown funding network/);
  assert.throws(() => fundingDefaults('toString'), /unknown funding network/);
});

test('airdrop overrides are exact decimal amounts and do not mutate network defaults', () => {
  assert.deepEqual(resolveAirdropAmounts('testnet', { sui: '0.100000001', wal: '0.3' }), { sui: 100_000_001n, wal: 300_000_000n });
  assert.deepEqual(resolveAirdropAmounts('testnet', { wal: '0.4' }), { sui: 60_000_000n, wal: 400_000_000n });
  assert.equal(fundingDefaults('testnet').wal, 300_000_000n);
  assert.deepEqual(resolveAirdropAmounts('mainnet'), { sui: 100_000_000n, wal: 6_000_000_000n });
  assert.deepEqual(resolveAirdropAmounts('mainnet', { wal: '7' }), { sui: 100_000_000n, wal: 7_000_000_000n });
  assert.throws(() => resolveAirdropAmounts('mainnet', { wal: '0.3' }), /at least 3 WAL/);
  for (const value of ['', '-1', 'NaN', 'Infinity', '1e-1', '0.0000000001', '18446744073.709551616']) {
    assert.throws(() => resolveAirdropAmounts('testnet', { wal: value }), /--airdrop-wal/);
  }
  for (const [coin, value] of [['sui', '0'], ['sui', '0.039'], ['wal', '0.12']]) {
    assert.throws(() => resolveAirdropAmounts('testnet', { [coin]: value }), /must be at least/);
  }
  assert.equal(parseCoinAmount('0'), 0n); // Manual top-ups may fund just one coin.
  assert.equal(parseCoinAmount('18446744073.709551615'), (1n << 64n) - 1n);
  assert.equal(formatCoinAmount(100_000_001n), '0.100000001');
});

test('attestor exposes payout flags and rejects bad amounts before loading a run', () => {
  const script = new URL('../src/attestor.js', import.meta.url);
  const help = spawnSync(process.execPath, [script.pathname, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--airdrop-sui/);
  assert.match(help.stdout, /--airdrop-wal/);
  const invalid = spawnSync(process.execPath, [script.pathname, '--airdrop-wal', '0.12'], { encoding: 'utf8' });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /--airdrop-wal must be at least 0.15 WAL/);
  assert.doesNotMatch(invalid.stderr, /missing.*run|pass.*run/);
});
