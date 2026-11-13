import test from 'node:test';
import assert from 'node:assert/strict';
import { randomart, framedRandomart, FRAME_WIDTH } from '../src/fingerprint.js';

const HASH = 'a3'.repeat(32) + '5c'.repeat(32);

test('randomart is a 17 x 9 grid with a start and an end mark', () => {
  const rows = randomart(HASH);
  assert.equal(rows.length, 9);
  for (const row of rows) assert.equal(row.length, 17);
  assert.equal(rows[4][8], 'S');
  assert.match(rows.join(''), /E/);
});

test('randomart is the same for the same hash and differs for another hash', () => {
  assert.deepEqual(randomart(HASH), randomart(`0x${HASH}`));
  assert.notDeepEqual(randomart(HASH), randomart('00'.repeat(64)));
});

test('randomart matches the OpenSSH walk for a known input', () => {
  // The bits 00 move up and left. From the center, four moves reach (4, 0).
  const rows = randomart('00');
  assert.equal(rows[0][4], 'E');
  assert.equal(rows[3][7], '.');
  assert.equal(rows[2][6], '.');
  assert.equal(rows[1][5], '.');
});

test('the frame has the same width on each line and shows the labels', () => {
  const lines = framedRandomart(HASH, { title: '#3', caption: 'a3a3…5c5c' });
  assert.equal(lines.length, 11);
  for (const line of lines) assert.equal([...line].length, FRAME_WIDTH);
  assert.match(lines[0], /^╭─+ #3 ─+╮$/);
  assert.match(lines[10], /^╰─+ a3a3…5c5c ─+╯$/);
});
