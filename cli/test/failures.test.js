import test from 'node:test';
import assert from 'node:assert/strict';
import { explainFailure, errorMessage } from '../src/failures.js';

const ctx = { address: '0xabc', network: 'testnet' };

test('known failures get a plain title and a next step', () => {
  const cases = [
    ["0xabc is not on the ceremony's allowlist (it is permissioned); ask the organizer", /not enrolled/, /0xabc/],
    ['attestor unavailable (connection failed or timed out); rerun', /checker is not available/, /Nothing is lost/],
    ['ceremony is closed', /does not accept/, null],
    ['phase 2 has not started yet (organizer must finish phase 1 + start)', /not open for contributions yet/, null],
    ['Object 0x' + 'a'.repeat(64) + ' not found', /No ceremony with this ID exists on testnet/, null],
    ['private funding URL is invalid or unavailable; obtain the current URL from the organizer', /Automatic funding/, /Private funding URL is invalid/],
    ['fetch failed', /network request failed/, /internet connection/],
    ['this funding link is for a different ceremony; ask the organizer', /different ceremony/, null],
  ];
  for (const [message, title, line] of cases) {
    const out = explainFailure(new Error(message), ctx);
    assert.match(out.title, title, message);
    if (line) assert.match(out.lines.join('\n'), line, message);
  }
});

test('a failed transaction while submitting points to an expired turn', () => {
  assert.match(explainFailure(new Error('tx failed: {"abort":1}'), { ...ctx, stage: 'verify' }).lines[0], /turn probably ended/);
});

test('unknown failures keep the raw message and the cause chain', () => {
  const err = new Error('outer', { cause: new Error('inner') });
  assert.equal(errorMessage(err), 'outer <- inner');
  const out = explainFailure(err, ctx);
  assert.match(out.title, /stopped because of an error/);
  assert.equal(out.lines[0], 'outer <- inner');
});
