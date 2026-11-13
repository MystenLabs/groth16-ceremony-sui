import test from 'node:test';
import assert from 'node:assert/strict';
import { renderResultCard, CARD_WIDTH, displayWidth, utcDate } from '../src/result-card.js';

const HASH = '2a47ad16' + 'ab'.repeat(56) + '12a3bccd';
const BASE = {
  hashHex: HASH, position: 3, name: 'Deepak', tsMs: Date.UTC(2026, 10, 12, 23, 30),
  network: 'testnet', title: 'zkLogin v2 trusted-setup ceremony', statusUrl: 'https://zkceremony.sui.io/status',
};

test('the card fits 60 columns and every line has the same width', () => {
  const lines = renderResultCard({ ...BASE, width: 59 });
  assert.ok(CARD_WIDTH <= 59);
  for (const line of lines) assert.equal([...line].length, CARD_WIDTH, line);
  assert.match(lines[0], /^  ╭─ zkLogin v2 trusted-setup ceremony ─+╮$/);
  assert.match(lines.at(-1), /^  ╰─ https:\/\/zkceremony\.sui\.io\/status ─+╯$/);
});

test('the card shows public facts only, with a short hash', () => {
  const text = renderResultCard({ ...BASE, width: 79 }).join('\n');
  for (const part of ['Deepak', 'Contributor #3', 'Sui testnet', '2026-11-12', '2a47ad16…12a3bccd']) {
    assert.ok(text.includes(part), part);
  }
  assert.ok(!text.includes(HASH));
});

test('the card uses the UTC date', () => {
  assert.equal(utcDate(Date.UTC(2026, 10, 12, 23, 30)), '2026-11-12');
});

test('a long name is cut and the card keeps its width', () => {
  const lines = renderResultCard({ ...BASE, name: 'N'.repeat(64), width: 79 });
  for (const line of lines) assert.equal([...line].length, CARD_WIDTH);
  assert.match(lines.join('\n'), /N+…/);
});

test('a narrow terminal gets a list without the window', () => {
  const text = renderResultCard({ ...BASE, width: CARD_WIDTH - 1 }).join('\n');
  assert.ok(!text.includes('╭─ zkLogin'));
  assert.match(text, /Ceremony zkLogin v2 trusted-setup ceremony/);
  assert.match(text, /Status {3}https:\/\/zkceremony\.sui\.io\/status/);
});

test('the card works without a position, a date, or a status page', () => {
  const lines = renderResultCard({ ...BASE, position: null, tsMs: null, statusUrl: null, width: 79 });
  for (const line of lines) assert.equal([...line].length, CARD_WIDTH);
  assert.ok(lines.join('\n').includes('Contributor '));
  assert.match(lines.at(-1), /^  ╰─+╯$/);
});

test('emoji and CJK names do not break the card', () => {
  for (const name of ['😀'.repeat(16), '漢'.repeat(21), 'é'.repeat(10), 'Ana 👩🏽‍💻']) {
    const lines = renderResultCard({ ...BASE, name, width: 79 });
    for (const line of lines) assert.equal(displayWidth(line), CARD_WIDTH, `${name}: ${line}`);
  }
});

test('an emoji title does not crash the card', () => {
  const lines = renderResultCard({ ...BASE, title: '🎉'.repeat(40), width: 79 });
  assert.equal(displayWidth(lines[0]), CARD_WIDTH);
});
