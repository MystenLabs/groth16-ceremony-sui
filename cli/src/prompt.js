// Ask the contributor questions on an interactive terminal.
// Why it exists: The funding link and the extra randomness must not show on
// screen, in shell history, or in the progress log.
// Assumptions: Callers use these functions only when stdin is a TTY.
import { createInterface } from 'node:readline/promises';

const MAX_DOTS = 40;

function interrupt() {
  process.kill(process.pid, 'SIGINT');
}

export async function askLine(question, { input = process.stdin, output = process.stdout } = {}) {
  const rl = createInterface({ input, output });
  // Without this listener, Ctrl-C only pauses readline and the CLI hangs.
  rl.on('SIGINT', () => { rl.close(); interrupt(); });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

export async function askYesNo(question, { input, output } = {}) {
  const answer = (await askLine(`${question} [Y/n] `, { input, output })).toLowerCase();
  return answer === '' || answer === 'y' || answer === 'yes';
}

// Read one line without echo. Show one dot for each character, up to `MAX_DOTS`.
export function askHidden(question, { input = process.stdin, output = process.stdout, onInterrupt = interrupt } = {}) {
  return new Promise((resolve) => {
    output.write(question);
    let value = '';
    const wasRaw = input.isRaw;
    input.setRawMode(true);
    input.setEncoding('utf8');
    input.resume();
    const finish = () => {
      input.removeListener('data', onData);
      input.setRawMode(wasRaw);
      input.pause();
      output.write('\n');
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        // Enter or Ctrl-D (end of input) ends the answer. Later characters in
        // the same chunk are dropped, because the question is over.
        if (ch === '\r' || ch === '\n' || ch === '\u0004') { finish(); resolve(value.trim()); return; }
        if (ch === '\u0003') { finish(); onInterrupt(); return; }
        // An escape sequence comes from a special key. Ignore the rest of it.
        if (ch === '\u001b') return;
        if (ch === '\u007f' || ch === '\b') {
          if (value && value.length <= MAX_DOTS) output.write('\b \b');
          value = value.slice(0, -1);
          continue;
        }
        if (ch < ' ') continue;
        value += ch;
        if (value.length <= MAX_DOTS) output.write('•');
      }
    };
    input.on('data', onData);
  });
}
