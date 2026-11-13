import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseSlotDurationMs } from '../src/lib/slot-duration.js';

test('slot duration defaults to fifteen minutes and supports shorter and longer ceremonies', () => {
  assert.equal(parseSlotDurationMs(), 900000n);
  assert.equal(parseSlotDurationMs('1'), 1000n);
  assert.equal(parseSlotDurationMs('1200'), 1200000n);
});

test('slot duration rejects zero, negative, fractional, and malformed seconds', () => {
  for (const value of ['0', '00', '-1', '0.5', '1.0', '1e3', '+1', '', ' ', ' 10', '10s', null]) {
    assert.throws(() => parseSlotDurationMs(value), /positive whole number/);
  }
});

test('slot duration accepts one hour and rejects larger values', () => {
  assert.equal(parseSlotDurationMs('3600'), 3600000n);
  for (const value of ['3601', '18446744073709551', '18446744073709552']) {
    assert.throws(() => parseSlotDurationMs(value), /at most 3600 seconds/);
  }
});

test('create CLI rejects invalid duration before reading artifacts or publishing', () => {
  const create = fileURLToPath(new URL('../src/create.js', import.meta.url));
  for (const value of ['0', '3601', '18446744073709552']) {
    const result = spawnSync(process.execPath, [create, '--permissionless', '--slot-duration-secs', value], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--slot-duration-secs/);
    assert.doesNotMatch(result.stderr, /missing --r1cs/);
  }
});

test('admin requires an explicit valid duration before loading a ceremony or signing', () => {
  const admin = fileURLToPath(new URL('../src/admin.js', import.meta.url));
  for (const args of [[], ['--slot-duration-secs', '0'], ['--slot-duration-secs', '1.5'], ['--slot-duration-secs', '3601'], ['--slot-duration-secs', '18446744073709552']]) {
    const result = spawnSync(process.execPath, [admin, 'set-slot-duration', ...args], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--slot-duration-secs/);
    assert.doesNotMatch(result.stderr, /manifest|keypair/);
  }
});
