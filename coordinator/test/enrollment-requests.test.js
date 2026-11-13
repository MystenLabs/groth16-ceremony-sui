import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  appendEnrollmentRequest,
  readEnrollmentRequests,
  summarizeEnrollmentRequests,
} from '../src/lib/enrollment_requests.js';

const addr = (ch) => `0x${ch.repeat(64)}`;

test('enrollment request helpers normalize, filter, dedupe, and summarize rows', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ceremony-enrollment-'));
  try {
    appendEnrollmentRequest(dir, {
      cli: true,
      ceremonyId: addr('b'),
      network: 'testnet',
      address: `0x${'A'.repeat(64)}`,
      name: ' Alice ',
      discord: ' alice ',
    });
    appendEnrollmentRequest(dir, {
      ceremonyId: addr('b'),
      network: 'testnet',
      address: addr('a'),
      name: 'Alice Updated',
    });
    appendEnrollmentRequest(dir, {
      ceremonyId: addr('c'),
      network: 'testnet',
      address: addr('d'),
    });
    appendEnrollmentRequest(dir, {
      ceremonyId: addr('b'),
      network: 'mainnet',
      address: addr('e'),
    });

    const { rows } = readEnrollmentRequests(dir, { ceremonyId: addr('b'), network: 'testnet' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].address, addr('a'));
    assert.equal(rows[0].name, 'Alice Updated');
    assert.equal(rows[0].requests, 2);

    const summary = summarizeEnrollmentRequests(rows, {
      permissioned: true,
      allowlist: [addr('f')],
    });
    assert.deepEqual(summary.pending.map((r) => r.address), [addr('a')]);

    const enrolled = summarizeEnrollmentRequests(rows, {
      permissioned: true,
      allowlist: [addr('a')],
    });
    assert.deepEqual(enrolled.pending, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
