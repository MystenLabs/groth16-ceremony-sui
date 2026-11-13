import test from 'node:test';
import assert from 'node:assert/strict';
import { stripVTControlCharacters } from 'node:util';
import { createUi, formatDuration, stripEscapes, visibleText, wrap } from '../src/ui.js';

function fakeStream({ isTTY = false, columns = 80 } = {}) {
  const chunks = [];
  return { isTTY, columns, write: (s) => chunks.push(s), text: () => chunks.join('') };
}

function clock(start = Date.UTC(2026, 0, 1, 12, 0, 0)) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

test('durations read as seconds, minutes, or hours', () => {
  assert.equal(formatDuration(4_400), '4s');
  assert.equal(formatDuration(98_000), '1m 38s');
  assert.equal(formatDuration(3_725_000), '1h 02m');
});

test('plain mode writes one timestamped line per event and records details only in the log', () => {
  const stream = fakeStream();
  const records = [];
  const c = clock();
  const ui = createUi({ stream, env: {}, record: (m) => records.push(m), now: c.now });
  ui.start('download', 'fetching');
  ui.detail('magic "p2c"');
  ui.status('fetching');
  c.advance(7_000);
  ui.done('63.0 MB in 7s');
  ui.start('compute');
  for (const f of [0.1, 0.3, 0.31, 0.6, 1]) ui.progress(f);
  ui.fail('stopped');
  const out = stream.text();
  assert.doesNotMatch(out, /\u001b/);
  assert.doesNotMatch(out, /magic/);
  assert.match(out, /\] Download…\n.*\]   fetching\n.*\] ✓ Download — 63\.0 MB in 7s\n/);
  assert.equal(out.match(/\] {3}fetching/g).length, 1, 'repeated status is printed once');
  assert.deepEqual(out.match(/\d+%/g), ['25%', '50%', '100%']);
  assert.match(out, /✗ Compute — stopped/);
  assert.ok(records.includes('magic "p2c"'));
});

test('verbose plain mode shows details on screen', () => {
  const stream = fakeStream();
  const ui = createUi({ stream, env: {}, verbose: true });
  ui.detail('package 0x1');
  assert.match(stream.text(), /package 0x1/);
});

test('live mode draws the stage list in place, fits the width, and shows the turn deadline', () => {
  const stream = fakeStream({ isTTY: true, columns: 60 });
  const c = clock();
  const ui = createUi({ stream, env: { TERM: 'xterm' }, now: c.now });
  ui.setLog('/tmp/log');
  ui.start('prepare');
  ui.done('0.06 SUI, 0.30 WAL from the organizer');
  ui.start('compute', 'x'.repeat(200));
  ui.deadline(c.now() + 11 * 60_000);
  ui.progress(0.52);
  ui.note('Stopping now gives up your turn.', 'action');
  ui.close();
  const raw = stream.text();
  assert.match(raw, /\u001b\[\d+A\r/, 'redraw moves the cursor up');
  assert.doesNotMatch(raw, /\u001b\[\d+A\r\u001b\[0J\u001b\[\?2026l/, 'a frame is never only an erase');
  assert.match(raw, /\u001b\[33m/, 'action notes are yellow');
  const last = stripVTControlCharacters(raw.slice(raw.lastIndexOf('Stopping now')));
  assert.match(last, /✓ Prepare +0\.06 SUI/);
  assert.match(last, /Compute +█{10}░{10}  52%/);
  assert.match(last, /· Upload/);
  assert.match(last, /Your turn ends in 11m 00s\./);
  assert.match(last, /Log: \/tmp\/log/);
  for (const line of last.split('\n')) assert.ok(line.length < 60, `line fits: ${line}`);
});

test('NO_COLOR keeps live layout but removes color', () => {
  const stream = fakeStream({ isTTY: true });
  const ui = createUi({ stream, env: { NO_COLOR: '' } });
  ui.start('turn', 'someone else is contributing');
  ui.note('hello', 'action');
  ui.close();
  assert.doesNotMatch(stream.text().replace(/\u001b\[(\d+A|0J|K|\?25[lh]|\?2026[hl])/g, ''), /\u001b/);
});

test('a card shows aligned rows, including continued lines', () => {
  const stream = fakeStream();
  const ui = createUi({ stream, env: {} });
  ui.card('Ready', [['Name', 'alice (public)'], ['Time', 'line one\nline two']], ['Keep this open.']);
  assert.equal(stream.text(), [
    '  ╭─ Ready',
    '  │  Name   alice (public)',
    '  │  Time   line one',
    '  │         line two',
    '  │',
    '  │  Keep this open.',
    '  ╰─',
    '',
  ].join('\n'));
});

test('live lines never wrap, even on a narrow terminal', () => {
  for (const columns of [20, 45, 60]) {
    const stream = fakeStream({ isTTY: true, columns });
    const c = clock();
    const ui = createUi({ stream, env: { TERM: 'xterm' }, now: c.now });
    ui.setLog('/a/very/long/path/to/the/work/directory/logs/contributor.log');
    ui.start('prepare');
    ui.done('0.06 SUI, 0.30 WAL from the organizer');
    ui.start('compute');
    ui.deadline(c.now() + 60_000);
    ui.progress(0.52);
    ui.close();
    const raw = stream.text();
    const last = stripVTControlCharacters(raw.slice(raw.lastIndexOf('\u001b[?2026h'))).replace(/\r/g, '');
    for (const line of last.split('\n')) assert.ok(line.length < columns, `${columns} columns: "${line}"`);
    if (columns >= 45) assert.match(last, /52%/);
  }
});

test('live mode writes each frame once and skips frames that did not change', () => {
  const stream = fakeStream({ isTTY: true });
  const writes = [];
  stream.write = (chunk) => writes.push(chunk);
  const c = clock();
  const ui = createUi({ stream, env: { TERM: 'xterm' }, now: c.now });
  ui.start('download', 'fetching');
  const before = writes.length;
  ui.status('fetching');
  ui.deadline(null);
  assert.equal(writes.length, before, 'an unchanged frame is not written');
  ui.status('still fetching');
  assert.equal(writes.length, before + 1, 'one write per frame');
  assert.ok(writes.at(-1).startsWith('\u001b[?2026h') && writes.at(-1).endsWith('\u001b[?2026l'));
  ui.close();
});

test('inner steps show below their stage, carry the progress, and leave a time summary', () => {
  const stream = fakeStream({ isTTY: true, columns: 80 });
  const c = clock();
  const ui = createUi({ stream, env: { TERM: 'xterm' }, now: c.now });
  ui.start('compute');
  ui.steps(['Unpack', 'Contribute', 'Pack']);
  ui.step('Unpack');
  c.advance(42_000);
  ui.step('Contribute');
  c.advance(88_000);
  ui.progress(0.52);
  let raw = stream.text();
  let frame = stripVTControlCharacters(raw.slice(raw.lastIndexOf('\u001b[?2026h'))).replace(/\r/g, '');
  assert.match(frame, /\n {6}✓ Unpack {11}42s\n/);
  assert.match(frame, /\n {6}. Contribute {7}█{10}░{10}  52%  1m 28s\n/);
  assert.match(frame, /\n {6}· Pack\n/);
  c.advance(400);
  ui.step('Pack');
  c.advance(400);
  ui.done('done in 2m 11s');
  ui.close();
  raw = stream.text();
  frame = stripVTControlCharacters(raw.slice(raw.lastIndexOf('\u001b[?2026h'))).replace(/\r/g, '');
  assert.match(frame, /✓ Compute +done in 2m 11s\n {6}Unpack 42s · Contribute 1m 28s · Pack 0\.4s\n/);
  assert.doesNotMatch(frame, /✓ Unpack/);
});

test('plain mode logs each inner step and its time', () => {
  const stream = fakeStream();
  const c = clock();
  const ui = createUi({ stream, env: {}, now: c.now });
  ui.start('compute');
  ui.steps(['Contribute', 'Pack']);
  ui.step('Contribute');
  ui.progress(0.5);
  c.advance(3_000);
  ui.step('Pack');
  c.advance(250);
  ui.fail('stopped');
  const out = stream.text();
  assert.match(out, /\]   Contribute…\n.*\]     50%\n.*\]   ✓ Contribute — 3\.0s\n.*\]   Pack…\n.*\]   ✗ Pack — 0\.3s\n.*\] ✗ Compute — stopped/);
});

test('notes wrap at spaces, keep their indent, and keep long words whole', () => {
  assert.deepEqual(wrap('one two three four', 9), ['one two', 'three', 'four']);
  assert.deepEqual(wrap('  • Plug in the power cable.', 16), ['  • Plug in the', '  power cable.']);
  assert.deepEqual(wrap('0x' + 'a'.repeat(20), 10), ['0x' + 'a'.repeat(20)]);
  assert.deepEqual(wrap('', 10), ['']);
});

test('a link is a terminal hyperlink only in a terminal known to support it', () => {
  const env = { TERM: 'xterm', TERM_PROGRAM: 'iTerm.app' };
  const live = createUi({ stream: fakeStream({ isTTY: true }), env });
  const link = live.link('https://example.com/x', 'x');
  assert.equal(link, '\u001b]8;;https://example.com/x\u001b\\x\u001b]8;;\u001b\\');
  assert.equal(visibleText(link), 'x');
  assert.equal(stripEscapes(link), 'https://example.com/x');
  live.close();
  for (const other of [{ TERM: 'xterm' }, { ...env, TMUX: '/tmp/tmux' }, {}]) {
    const ui = createUi({ stream: fakeStream({ isTTY: !!other.TERM }), env: other });
    assert.equal(ui.link('https://example.com/x', 'x'), 'https://example.com/x');
    ui.close();
  }
});

test('the log gets printed text without color codes, and a link as its URL', () => {
  const records = [];
  const ui = createUi({ stream: fakeStream({ isTTY: true }), env: { TERM: 'xterm', TERM_PROGRAM: 'iTerm.app' }, record: (m) => records.push(m) });
  ui.print(`id ${ui.link('https://example.com/x', 'x')} ${ui.paint('bold', 'b')}`);
  ui.close();
  assert.ok(records.includes('id https://example.com/x b'));
});
