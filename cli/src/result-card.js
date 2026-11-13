// Build the card that a contributor sees after an accepted contribution.
//
// Why it exists: Contributors may share a screenshot of the result. The card
// holds only public facts, so that a screenshot is safe to share.
//
// How it works:
//   1. A rounded window holds a picture of the contribution hash and the main
//      facts. The top border names the ceremony. The bottom border names the
//      public status page, where anyone can find the contribution.
//   2. The caller prints local details below the card: funds, links, receipt.
//   3. If the terminal is narrower than `CARD_WIDTH`, the window is left out
//      and the facts are listed below the picture.
//
// Assumptions:
//   - `paint(format, text)` adds color, or returns the text as is.
//   - `displayWidth` knows the common wide characters (CJK, emoji). A rare
//     character can still move the right border by one column.

import { framedRandomart, FRAME_WIDTH } from './fingerprint.js';

// Room for the longest fact: "Hash" plus a short hash.
const FACT_WIDTH = 26;
// The characters between the left and the right border.
const INNER = 2 + FRAME_WIDTH + 3 + FACT_WIDTH + 2;
// The full line: a 2-space indent and the two borders.
export const CARD_WIDTH = 2 + INNER + 2;

// Wide characters take two columns. Combining marks and joiners take none.
const WIDE = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6\u{1f300}-\u{1faff}\u{20000}-\u{3fffd}]/u;
const ZERO = /[\u0300-\u036f\u200b-\u200f\ufe00-\ufe0f]/u;

function charWidth(ch) {
  if (ZERO.test(ch)) return 0;
  return WIDE.test(ch) ? 2 : 1;
}

export function displayWidth(text) {
  let total = 0;
  for (const ch of text.replace(/\u001b\[[0-9;]*m/g, '')) total += charWidth(ch);
  return total;
}

// Cut the text to `max` columns. Put `…` at the end if the text was cut.
function cut(text, max) {
  if (displayWidth(text) <= max) return text;
  let out = '';
  let used = 0;
  for (const ch of text) {
    if (used + charWidth(ch) > max - 1) break;
    out += ch;
    used += charWidth(ch);
  }
  return `${out}…`;
}

// The status page shows UTC times. Use the UTC date, so that the card matches it.
export function utcDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

export function renderResultCard({ hashHex, position, name, tsMs, network, title, statusUrl, width, paint = (_format, text) => text }) {
  const art = framedRandomart(hashHex).map((line, i, all) => (i === 0 || i === all.length - 1)
    ? paint('dim', line)
    : paint('dim', line.slice(0, 2)) + paint('cyan', line.slice(2, -2)) + paint('dim', line.slice(-2)));
  const label = (key, value) => `${paint('dim', key.padEnd(9))}${value}`;
  const who = paint('bold', cut(name || 'no name', FACT_WIDTH));
  const place = position ? `Contributor #${position}` : 'Contributor';
  const details = [
    label('Network', `Sui ${network}`),
    tsMs ? label('Date', utcDate(tsMs)) : null,
    label('Hash', `${hashHex.slice(0, 8)}…${hashHex.slice(-8)}`),
  ].filter(Boolean);
  // Keep the scheme. Without it, terminals open the text as a local file path.
  const status = statusUrl ? statusUrl.replace(/\/$/, '') : '';

  if (width < CARD_WIDTH) {
    const facts = [label('Ceremony', title), ...details, status ? label('Status', status) : null].filter(Boolean);
    return [...art.map((l) => `  ${l}`), '', `    ${who}`, `    ${place}`, '', ...facts.map((l) => `    ${l}`)];
  }

  // Put the facts beside the picture, centered on its height.
  const facts = [who, place, '', ...details];
  const start = Math.floor((art.length - facts.length) / 2);
  const body = art.map((line, i) => (facts[i - start] ? `${line}   ${facts[i - start]}` : line));
  const row = (text) => `  ${paint('dim', '│')}  ${text}${' '.repeat(Math.max(0, INNER - 2 - displayWidth(text)))}${paint('dim', '│')}`;
  const border = (left, text, format, right) => {
    const shown = text ? cut(text, INNER - 4) : '';
    const fill = '─'.repeat(Math.max(0, INNER - 1 - (shown ? displayWidth(shown) + 2 : 0)));
    return `  ${paint('dim', `${left}─`)}${shown ? ` ${paint(format, shown)} ` : ''}${paint('dim', `${fill}${right}`)}`;
  };
  return [
    border('╭', title, 'bold', '╮'),
    row(''),
    ...body.map(row),
    row(''),
    border('╰', status, 'reset', '╯'),
  ];
}
