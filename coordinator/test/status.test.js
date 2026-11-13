import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readContributorNames, slotLabel } from '../src/lib/status.js';

const address = '0x' + '1'.repeat(64);
const ceremonyId = '0x' + '2'.repeat(64);
const ceremony = (slot) => ({ phase: { '@variant': 'Phase2Contribute' }, chain: [], slot });

test('first-time claimed contributors get names from scoped heartbeat and telemetry records', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ceremony-status-'));
  try {
    assert.equal((await readContributorNames(dir, { ceremonyId, network: 'testnet' })).size, 0);
    fs.mkdirSync(path.join(dir, 'logs'));
    const row = { kind: 'heartbeat', ephemeralAddr: address, ceremonyId, name: 'mahdi' };
    fs.writeFileSync(path.join(dir, 'logs/telemetry.jsonl'), [
      JSON.stringify(row),
      JSON.stringify({ kind: 'telemetry', ephemeral_addr: address, ceremony_id: ceremonyId, name: 'mahdi-3' }),
      JSON.stringify({ ...row, ceremonyId: '0xother', name: 'wrong ceremony' }),
      JSON.stringify({ ...row, network: 'mainnet', name: 'wrong network' }),
      JSON.stringify({ ...row, name: '' }), 'null', '{incomplete',
    ].join('\n'));
    const names = await readContributorNames(dir, { ceremonyId, network: 'testnet' });
    assert.equal(names.get(address), 'mahdi-3');
    assert.equal(slotLabel(ceremony({ '@variant': 'Claimed', who: address, until_ms: 0 }), null, names),
      `Claimed by ${address} (mahdi-3) until 1970-01-01T00:00:00.000Z`);
    assert.equal(slotLabel(ceremony({ '@variant': 'Pending', who: address, name: 'submitted-name' }), null, names),
      `Pending by ${address} (submitted-name)`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('slot names retain existing chain/enrollment fallbacks, with address-only output if unknown', () => {
  const j = ceremony({ '@variant': 'Claimed', who: address });
  assert.equal(slotLabel(j), `Claimed by ${address}`);
  j.chain.push({ contributor: address, name: 'earlier' });
  assert.equal(slotLabel(j), `Claimed by ${address} (earlier)`);
  assert.equal(slotLabel(j, { rows: [{ address, name: 'enrolled' }] }), `Claimed by ${address} (enrolled)`);
});
