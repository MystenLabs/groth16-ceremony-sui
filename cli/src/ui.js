// Show the contributor's progress as a fixed list of stages.
//
// Why it exists: A contribution takes minutes or hours. The user must see what
// happens now, what comes next, and if they must do something.
//
// How it works:
// 1. The CLI reports events: a stage starts, its status or progress changes,
//    or it ends. A stage can have inner steps, which show below it. The CLI
//    can also add a note (a message that stays on screen).
// 2. "Live" mode (an interactive terminal) draws the stage list again in place
//    several times each second.
// 3. "Plain" mode (a pipe, a file, or `TERM=dumb`) writes one timestamped line
//    for each event.
// 4. Every event also goes to `record` (the saved progress log) as plain text.
//    Details go only to `record`, unless the user sets `--verbose`.
//
// Assumptions:
// - Nothing else writes to the terminal while live mode draws.
// - Live mode cuts each line to the terminal width, so it can count lines.
// - Other writers to stdout or stderr (for example dependency warnings) can
//   leave a stale copy of the list on screen. The next redraw is still correct.
// - Colors follow `NO_COLOR` and `TERM=dumb`. Color only marks state.

import { styleText } from 'node:util';

export const STAGES = Object.freeze([
  { id: 'prepare', label: 'Prepare' },
  { id: 'turn', label: 'Wait for your turn' },
  { id: 'download', label: 'Download' },
  { id: 'compute', label: 'Compute' },
  { id: 'upload', label: 'Upload' },
  { id: 'verify', label: 'Submit and verify' },
]);

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const LABEL_WIDTH = 20;
const BAR_WIDTH = 20;
const REDRAW_MS = 150;
// Terminals that support synchronized output show a frame only when it is complete.
const SYNC_ON = '\u001b[?2026h';
const SYNC_OFF = '\u001b[?2026l';
const DEADLINE_WARNING_MS = 3 * 60_000;
const TONES = { info: null, action: 'yellow', success: 'green', error: 'red', dim: 'dim' };

// `precise` shows tenths below 10 seconds, for times that do not tick.
export function formatDuration(ms, { precise = false } = {}) {
  if (precise && ms < 10_000) return `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

export function colorEnabled(stream, env) {
  return !!stream.isTTY && !Object.hasOwn(env, 'NO_COLOR') && env.TERM !== 'dumb';
}

// Break a line at spaces so that each part fits in `width` characters. Keep the
// leading spaces on each part. A word longer than `width` stays whole.
export function wrap(line, width) {
  const lead = /^ */.exec(line)[0];
  const words = line.slice(lead.length).split(' ');
  const out = [];
  let cur = '';
  for (const word of words) {
    if (cur && lead.length + cur.length + 1 + word.length > width) { out.push(lead + cur); cur = word; }
    else cur = cur ? `${cur} ${word}` : word;
  }
  out.push(cur ? lead + cur : '');
  return out;
}

// Cut text to `width` characters. Show the cut with an ellipsis.
function fit(text, width) {
  if (width <= 0) return '';
  return text.length <= width ? text : text.slice(0, Math.max(0, width - 1)) + '…';
}

const LINK = /\u001b\]8;;([^\u001b]*)\u001b\\(.*?)\u001b\]8;;\u001b\\/g;

// Remove color codes, so that the log holds plain text. A link becomes its URL.
export function stripEscapes(text) {
  return text.replace(/\u001b\[[0-9;]*m/g, '').replace(LINK, '$1');
}

// Return the text as the terminal shows it: no color codes, and a link shows its text.
export function visibleText(text) {
  return text.replace(/\u001b\[[0-9;]*m/g, '').replace(LINK, '$2');
}

// True if the terminal is known to support OSC 8 links. Other terminals can
// hide the URL, so they get the URL as text. tmux needs extra setup, so it gets text too.
export function linksSupported(env) {
  if (env.TMUX) return false;
  return ['iTerm.app', 'vscode', 'WezTerm', 'ghostty'].includes(env.TERM_PROGRAM)
    || !!env.WT_SESSION || !!env.KITTY_WINDOW_ID || Number(env.VTE_VERSION) >= 5000;
}

export function createUi({
  stream = process.stdout, env = process.env, verbose = false,
  record = () => {}, now = Date.now, live,
} = {}) {
  const isLive = live ?? (!!stream.isTTY && env.TERM !== 'dumb');
  const links = isLive && linksSupported(env);
  const color = colorEnabled(stream, env);
  const paint = (format, text) => (color && format ? styleText(format, text, { validateStream: false }) : text);
  const stages = STAGES.map((s) => ({ ...s, state: 'pending', status: '', summary: '', progress: null, startedAt: 0 }));
  let current = null;
  let deadlineAt = null;
  let logPath = null;
  let drawn = 0;
  let lastFrame = '';
  let frame = 0;
  let timer = null;
  let closed = false;
  let plainQuarter = -1;

  const write = (text) => stream.write(text);
  const stamp = () => new Date(now()).toTimeString().slice(0, 8);
  const plain = (text) => write(`[${stamp()}] ${text}\n`);
  // Leave the last column empty. Some terminals wrap a line that fills it.
  const width = () => Math.max(1, (stream.columns || 80) - 1);

  // A line is a list of [format, text] parts. Cut the parts to the terminal
  // width before painting, so a drawn line never wraps.
  function render(parts) {
    let room = width();
    let out = '';
    for (const [format, text] of parts) {
      if (room <= 0) break;
      const piece = fit(text, room);
      room -= piece.length;
      out += paint(format, piece);
    }
    return out;
  }

  // One row of the list: a stage, or an inner step of a stage.
  function rowParts(row, indent, labelWidth) {
    const pad = ' '.repeat(indent);
    const label = row.label.padEnd(labelWidth) + ' ';
    if (row.state === 'done') return [[null, pad], ['green', '✓ '], [null, label], ['dim', row.summary]];
    if (row.state === 'failed') return [[null, pad], ['red', '✗ '], [null, label], ['red', row.summary]];
    if (row.state === 'pending') return [[null, pad], ['dim', '· ' + row.label]];
    const elapsed = formatDuration(now() - row.startedAt);
    const head = [[null, pad], ['cyan', SPINNER[frame % SPINNER.length] + ' '], [null, label]];
    const used = indent + 2 + label.length;
    if (row.progress != null) {
      const pct = `${Math.floor(row.progress * 100)}%`.padStart(4);
      // Show the bar only when the full line fits.
      if (width() < used + BAR_WIDTH + 1 + pct.length + 2 + elapsed.length) {
        return [...head, [null, pct], ['dim', `  ${elapsed}`]];
      }
      const filled = Math.round(row.progress * BAR_WIDTH);
      return [...head, ['cyan', '█'.repeat(filled)], ['dim', '░'.repeat(BAR_WIDTH - filled)], [null, ` ${pct}`], ['dim', `  ${elapsed}`]];
    }
    // Keep the elapsed time visible: cut the status, not the time.
    const status = fit(row.status, Math.max(0, width() - used - elapsed.length - 3));
    return [...head, [null, status], ['dim', `${status ? ' · ' : ''}${elapsed}`]];
  }

  // A stage with inner steps shows one row for each step while it runs.
  // When it is done, one dim line lists the time of each step.
  function stageLines(s) {
    const lines = [rowParts(s, 2, LABEL_WIDTH)];
    if (!s.steps || s.state === 'pending') return lines;
    if (s.state === 'done') {
      const times = s.steps.filter((x) => x.state === 'done').map((x) => `${x.label} ${x.summary}`);
      if (times.length) lines.push([[null, '      '], ['dim', times.join(' · ')]]);
      return lines;
    }
    for (const step of s.steps) lines.push(rowParts(step, 6, LABEL_WIDTH - 4));
    return lines;
  }

  function footerLines() {
    const lines = [];
    if (deadlineAt != null) {
      const left = deadlineAt - now();
      const text = left > 0
        ? `Your turn ends in ${formatDuration(left)}. Keep this terminal open.`
        : 'Your turn time is over. The ceremony can give the turn to someone else.';
      lines.push(render([[null, '  '], [left > DEADLINE_WARNING_MS ? null : 'yellow', text]]));
    }
    if (logPath) lines.push(render([[null, '  '], ['dim', `Log: ${logPath}`]]));
    return lines.length ? ['', ...lines] : [];
  }

  // Draw the stage list again in one write. Overwrite each line in place and
  // clear only the end of it, so the screen never shows an empty state.
  // `above` is text that goes above the list (a note or a result).
  function paintFrame(above = '') {
    if (!isLive || closed) return;
    const visible = stages.some((s) => s.state !== 'pending');
    // A blank first line keeps the list apart from the notes above it.
    const lines = visible ? ['', ...stages.flatMap(stageLines).map(render), ...footerLines()] : [];
    const text = lines.join('\n');
    if (!above && text === lastFrame) return;
    let out = SYNC_ON;
    if (drawn) out += `\u001b[${drawn}A\r`;
    if (above) out += '\u001b[0J' + above;
    out += lines.map((line) => line + '\u001b[K\n').join('');
    if (!above && lines.length < drawn) out += '\u001b[0J';
    write(out + SYNC_OFF);
    drawn = lines.length;
    lastFrame = text;
  }

  function redraw() { paintFrame(); }

  function startTimer() {
    if (!isLive || timer) return;
    write('\u001b[?25l');
    timer = setInterval(() => { frame++; redraw(); }, REDRAW_MS);
    timer.unref?.();
  }

  function stopTimer() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
    write('\u001b[?25h');
  }

  // Write text above the stage list. Live mode keeps the list below it.
  function writeAbove(text, tone) {
    const lines = String(text).split('\n');
    if (isLive && !closed) {
      const wrapped = lines.flatMap((line) => wrap(line, width() - 2)).map((line) => (line ? '  ' + line : ''));
      paintFrame(wrapped.map((line) => paint(TONES[tone], line) + '\n').join(''));
    } else {
      for (const line of lines) {
        if (line.trim()) plain(line);
        else write('\n');
      }
    }
  }

  const ui = {
    get live() { return isLive; },

    note(text, tone = 'info') {
      record(String(text));
      writeAbove(text, tone);
    },

    detail(text) {
      record(String(text));
      if (verbose) writeAbove(text, 'dim');
    },

    start(id, status = '') {
      const s = stages.find((x) => x.id === id);
      if (!s) throw new Error(`unknown stage ${id}`);
      Object.assign(s, { state: 'active', status, progress: null, startedAt: now() });
      current = s;
      plainQuarter = -1;
      record(`${s.label}…${status ? ` ${status}` : ''}`);
      if (isLive) { startTimer(); redraw(); } else plain(`${s.label}…`);
      if (!isLive && status) plain(`  ${status}`);
    },

    // Declare the inner steps of the active stage, in order.
    steps(labels) {
      if (!current) return;
      current.steps = labels.map((label) => ({ label, state: 'pending', status: '', summary: '', progress: null, startedAt: 0 }));
      redraw();
    },

    // End the active inner step and start the step with this label.
    step(label) {
      if (!current?.steps) return;
      endStep('done');
      const next = current.steps.find((x) => x.label === label);
      if (!next) throw new Error(`unknown step ${label}`);
      Object.assign(next, { state: 'active', startedAt: now(), progress: null });
      plainQuarter = -1;
      record(`  ${label}…`);
      if (isLive) redraw(); else plain(`  ${label}…`);
    },

    status(text) {
      if (!current || current.status === text) return;
      current.status = text;
      record(`  ${text}`);
      if (isLive) redraw(); else plain(`  ${text}`);
    },

    // Progress belongs to the active inner step when the stage has steps.
    progress(fraction) {
      if (!current) return;
      const row = activeStep() || current;
      const indent = row === current ? '  ' : '    ';
      row.progress = fraction == null ? null : Math.min(1, Math.max(0, fraction));
      if (row.progress == null) return redraw();
      const quarter = Math.floor(row.progress * 4);
      if (quarter > plainQuarter && quarter > 0) {
        plainQuarter = quarter;
        record(`${indent}${quarter * 25}%`);
        if (!isLive) plain(`${indent}${quarter * 25}%`);
      }
      redraw();
    },

    done(summary = '') { finish('done', '✓', summary); },
    fail(summary = '') { finish('failed', '✗', summary); },

    get stage() { return current?.id || null; },
    get width() { return width(); },

    deadline(at) { deadlineAt = at; redraw(); },
    setLog(file) { logPath = file; redraw(); },

    // A boxed summary with aligned rows, for example before the run starts.
    card(title, rows, footer = []) {
      const keyWidth = Math.max(...rows.map(([k]) => k.length));
      const lines = [`  ╭─ ${paint('bold', title)}`];
      for (const [k, v] of rows) {
        const [first, ...rest] = String(v).split('\n');
        lines.push(`  │  ${paint('dim', k.padEnd(keyWidth))}   ${first}`);
        for (const more of rest) lines.push(`  │  ${''.padEnd(keyWidth)}   ${more}`);
      }
      if (footer.length) lines.push('  │', ...footer.map((f) => `  │  ${f}`));
      lines.push('  ╰─');
      ui.print(lines.join('\n'));
    },

    // Write text as is, without a timestamp. Use it for headings and results.
    print(text = '') {
      record(stripEscapes(String(text)));
      if (isLive && !closed) paintFrame(text + '\n'); else write(text + '\n');
    },

    paint,

    // Show `text` as a link to `url` (OSC 8), if the terminal supports links.
    // Otherwise return the URL itself.
    link(url, text) {
      return links ? `\u001b]8;;${url}\u001b\\${text}\u001b]8;;\u001b\\` : url;
    },

    close() {
      if (closed) return;
      stopTimer();
      redraw();
      closed = true;
    },
  };

  function activeStep() {
    return current?.steps?.find((x) => x.state === 'active') || null;
  }

  function endStep(state) {
    const step = activeStep();
    if (!step) return;
    Object.assign(step, { state, progress: null, summary: formatDuration(now() - step.startedAt, { precise: true }) });
    const line = `  ${state === 'done' ? '✓' : '✗'} ${step.label} — ${step.summary}`;
    record(line);
    if (!isLive) plain(line);
  }

  function finish(state, mark, summary) {
    if (!current) return;
    endStep(state);
    Object.assign(current, { state, summary, progress: null });
    record(`${mark} ${current.label}${summary ? ` — ${summary}` : ''}`);
    if (isLive) redraw(); else plain(`${mark} ${current.label}${summary ? ` — ${summary}` : ''}`);
    current = null;
  }

  return ui;
}
