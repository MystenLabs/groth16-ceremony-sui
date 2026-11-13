// Draw a small picture of a contribution hash.
//
// Why it exists: A long hex hash is hard to recognize. A picture lets a
// contributor see at a glance that two copies of a hash are the same.
//
// How it works: This is the "drunken bishop" walk that OpenSSH uses for its
// key pictures ("randomart").
//   1. A bishop starts at the center of a `WIDTH` x `HEIGHT` grid.
//   2. Each byte of the hash gives four moves, two bits each, low bits first.
//      Bit 0 sets the horizontal direction. Bit 1 sets the vertical direction.
//   3. The bishop stays inside the grid. Each cell counts its visits.
//   4. The visit count selects a character from `SYMBOLS`.
//      `S` marks the start cell and `E` marks the end cell.
//
// Assumptions: The input is a hex string. The picture is not a security check.
// Always compare the full hash.

const WIDTH = 17;
const HEIGHT = 9;
const SYMBOLS = ' .o+=*BOX@%&#/^';

// Return `HEIGHT` strings of `WIDTH` characters each.
export function randomart(hashHex) {
  const bytes = Buffer.from(hashHex.replace(/^0x/, ''), 'hex');
  const counts = Array.from({ length: HEIGHT }, () => new Array(WIDTH).fill(0));
  const start = { x: Math.floor(WIDTH / 2), y: Math.floor(HEIGHT / 2) };
  let x = start.x;
  let y = start.y;
  for (const byte of bytes) {
    for (let shift = 0; shift < 8; shift += 2) {
      const bits = (byte >> shift) & 3;
      x = Math.min(WIDTH - 1, Math.max(0, x + (bits & 1 ? 1 : -1)));
      y = Math.min(HEIGHT - 1, Math.max(0, y + (bits & 2 ? 1 : -1)));
      counts[y][x] += 1;
    }
  }
  const rows = counts.map((row) => row.map((n) => SYMBOLS[Math.min(n, SYMBOLS.length - 1)]));
  rows[start.y][start.x] = 'S';
  rows[y][x] = 'E';
  return rows.map((row) => row.join(''));
}

// Put the picture in a rounded frame. `title` goes in the top border and
// `caption` in the bottom border. Both are cut to fit.
export function framedRandomart(hashHex, { title = '', caption = '' } = {}) {
  const inner = WIDTH + 2;
  const border = (left, label, right) => {
    const text = label ? ` ${label.slice(0, inner - 4)} ` : '';
    const before = Math.floor((inner - text.length) / 2);
    return left + '─'.repeat(before) + text + '─'.repeat(inner - text.length - before) + right;
  };
  return [
    border('╭', title, '╮'),
    ...randomart(hashHex).map((row) => `│ ${row} │`),
    border('╰', caption, '╯'),
  ];
}

export const FRAME_WIDTH = WIDTH + 4;
