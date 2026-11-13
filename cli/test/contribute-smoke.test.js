// Run the real snarkjs contribution pipeline on a tiny square circuit.
// Why it exists: CI runs this file on each supported Node.js version. A version
// passes only if snarkjs and its WebAssembly workers run on it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { contribute, compress, decompress } from '../src/crypto.js';

const genesis = new Uint8Array(fs.readFileSync(new URL('./fixtures/square-genesis.p2c', import.meta.url)));
const magic = (bytes) => String.fromCharCode(...bytes.slice(0, 3));

test('decompress, contribute, and compress a small circuit', async () => {
  const progress = [];
  const logger = { info() {}, warn() {}, error() {}, debug: (m) => progress.push(m) };
  const p2u = await decompress(genesis, logger);
  assert.equal(magic(p2u), 'p2u');
  const first = await contribute(p2u, 'smoke', 'entropy one', logger);
  const second = await contribute(p2u, 'smoke', 'entropy two', logger);
  assert.match(first.hashHex, /^[0-9a-f]{128}$/);
  assert.notEqual(first.hashHex, second.hashHex, 'fresh randomness gives a fresh contribution');
  assert.ok(progress.some((m) => /^Applying key: L Section: \d+\/\d+/.test(m)), 'the progress bar depends on this message');
  const p2c = await compress(first.bytes, logger);
  assert.equal(magic(p2c), 'p2c');
  assert.equal(magic(await decompress(p2c, logger)), 'p2u');
});
