import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { askHidden } from '../src/prompt.js';

function fakeTerminal() {
  const input = new EventEmitter();
  Object.assign(input, { isRaw: false, setRawMode(v) { this.isRaw = v; }, setEncoding() {}, resume() {}, pause() {} });
  const written = [];
  return { input, output: { write: (s) => written.push(s) }, written };
}

test('hidden input shows dots, supports backspace, and never echoes the value', async () => {
  const t = fakeTerminal();
  const answer = askHidden('Link: ', t);
  t.input.emit('data', 'secrex');
  t.input.emit('data', '\u007f');
  t.input.emit('data', 't\r');
  assert.equal(await answer, 'secret');
  const shown = t.written.join('');
  assert.doesNotMatch(shown, /secre/);
  assert.equal(shown, "Link: ••••••\b \b•\n");
  assert.equal(t.input.isRaw, false);
  assert.equal(t.input.listenerCount('data'), 0);
});

test('hidden input ignores special keys and handles Ctrl-C', async () => {
  const t = fakeTerminal();
  let interrupted = false;
  const answer = askHidden('Q: ', { ...t, onInterrupt: () => { interrupted = true; } });
  t.input.emit('data', 'a\u001b[A');
  t.input.emit('data', '\u0003');
  assert.equal(interrupted, true);
  assert.equal(t.input.isRaw, false);
  t.input.emit('data', '\r');
  void answer;
});

test('Ctrl-D ends hidden input', async () => {
  const t = fakeTerminal();
  const answer = askHidden('Q: ', t);
  t.input.emit('data', 'abc\u0004');
  assert.equal(await answer, 'abc');
});
