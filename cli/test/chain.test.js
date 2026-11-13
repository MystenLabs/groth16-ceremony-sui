import test from 'node:test';
import assert from 'node:assert/strict';
import { awaitVerdict, claimWhenOpen, readHead } from '../src/chain.js';

const CEREMONY_TYPE = '0x123::groth16_phase2::Ceremony';

function ceremonyJson({ headBlobId = '0xold', slot = { '@variant': 'Open' }, chain = [] } = {}) {
  return {
    permissioned: false,
    phase: { '@variant': 'Phase2' },
    head_blob_id: headBlobId,
    slot,
    chain,
  };
}

function fakeClient(states, { now = () => Date.now() } = {}) {
  const waited = [];
  return {
    waited,
    core: {
      async waitForTransaction({ digest }) {
        waited.push(digest);
      },
      async getObject({ objectId }) {
        if (objectId === '0x6') return { object: { json: { timestamp_ms: String(now()) } } };
        const json = states.length ? states.shift() : ceremonyJson();
        return { object: { type: CEREMONY_TYPE, json } };
      },
    },
  };
}

test('awaitVerdict reports rejected when submit pending was missed by polling', async () => {
  const client = fakeClient([
    ceremonyJson({ slot: { '@variant': 'Open' } }),
  ]);

  const verdict = await awaitVerdict(client, '0xceremony', '0xmine', {
    submitDigest: '9nQeWvG816bUx9EP',
    timeoutMs: 1000,
    pollMs: 1,
  });

  assert.equal(verdict, 'rejected');
  assert.deepEqual(client.waited, ['9nQeWvG816bUx9EP']);
});

test('awaitVerdict does not infer rejection without submit evidence', async () => {
  const client = fakeClient([
    ceremonyJson({ slot: { '@variant': 'Open' } }),
  ]);

  const verdict = await awaitVerdict(client, '0xceremony', '0xmine', {
    timeoutMs: 0,
    pollMs: 1,
  });

  assert.equal(verdict, 'timeout');
});

// A live set_access_mode flip to permissioned must not send unlisted CLIs into
// the claim/abort retry loop (each aborted claim costs gas).
test('claimWhenOpen refuses to claim when permissioned and unlisted', async () => {
  const client = fakeClient([{ ...ceremonyJson(), permissioned: true, allowlist: { contents: ['0xalice'] } }]);
  let claims = 0;
  client.core.executeTransaction = async () => { claims++; return {}; };

  await assert.rejects(
    claimWhenOpen(client, null, '0x123', '0xceremony', '0xbob', { pollMs: 1 }),
    /0xbob is not on the ceremony's allowlist/,
  );
  assert.equal(claims, 0);
});


test('claimWhenOpen reports only eligible slot waiters, including access-mode changes', async () => {
  const busy = { '@variant': 'Claimed', who: '0xother', until_ms: Date.now() + 60_000 };
  const client = fakeClient([
    { ...ceremonyJson({ slot: busy }), permissioned: true, allowlist: { contents: [] } },
    { ...ceremonyJson({ slot: busy }), permissioned: true, allowlist: { contents: ['0xme'] } },
    { ...ceremonyJson({ slot: busy }), permissioned: true, allowlist: { contents: [] } },
    ceremonyJson({ slot: { '@variant': 'Claimed', who: '0xme', until_ms: Date.now() + 900_000 } }),
  ]);
  const waiting = [];
  await claimWhenOpen(client, null, '0x123', '0xceremony', '0xme', {
    pollMs: 1, onWaiting: (value) => waiting.push(value),
  });
  assert.deepEqual(waiting, [false, true, false]);
});

test('slot polling defaults to 30 seconds and accepts a CLI override', async (t) => {
  const { parsePollInterval } = await import('../src/chain.js');
  assert.equal(parsePollInterval(), 30_000);
  assert.equal(parsePollInterval('60'), 60_000);
  for (const bad of ['0', '-1', 'abc', 'NaN', 'Infinity', '0.5', '2147484', '']) {
    assert.throws(() => parsePollInterval(bad), /--poll-interval/);
  }
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const seconds of [30, 60]) {
    const busy = ceremonyJson({ slot: { '@variant': 'Pending', who: '0xother' } });
    const mine = ceremonyJson({ slot: { '@variant': 'Claimed', who: '0xme', until_ms: Date.now() + 900_000 } });
    const client = fakeClient([busy, mine]);
    const logs = [];
    let finished = false;
    const promise = claimWhenOpen(client, null, '0x123', '0xceremony', '0xme', {
      ...(seconds === 60 ? { pollMs: parsePollInterval('60') } : {}),
      log: (line) => logs.push(line),
    }).then(() => { finished = true; });
    await new Promise(setImmediate);
    assert.match(logs[0], /previous contribution/);
    assert.ok(logs.some((l) => new RegExp(`again in ${seconds}s`).test(l)));
    t.mock.timers.tick(seconds * 1000 - 1);
    await new Promise(setImmediate);
    assert.equal(finished, false);
    t.mock.timers.tick(1);
    await promise;
    assert.equal(finished, true);
  }
});

async function mockClaimTransactions(t, client) {
  const { Transaction } = await import('@mysten/sui/transactions');
  const commands = [];
  t.mock.method(Transaction.prototype, 'build', async function () {
    commands.push(this.getData().commands.map((c) => c.MoveCall.function));
    return new Uint8Array([1]);
  });
  client.core.executeTransaction = async () => ({ Transaction: { digest: 'claim-digest', status: { success: true } } });
  const keypair = { toSuiAddress: () => '0xa', signTransaction: async () => ({ signature: 'test-signature' }) };
  return { keypair, commands };
}

test('health failure prevents open, expired and resumed claims without transaction retries', async (t) => {
  const now = 1_000_000;
  for (const slot of [
    { '@variant': 'Open' },
    { '@variant': 'Claimed', who: '0xc', until_ms: now - 10_001 },
    { '@variant': 'Claimed', who: '0xa', until_ms: now - 10_001 },
    { '@variant': 'Claimed', who: '0xa', until_ms: now + 900_000 },
  ]) {
    const client = fakeClient([ceremonyJson({ slot })], { now: () => now });
    const { keypair, commands } = await mockClaimTransactions(t, client);
    let checks = 0;
    await assert.rejects(claimWhenOpen(client, keypair, '0x123', '0xb', '0xa', {
      checkHealth: async () => { checks++; throw new Error('attestor unavailable'); },
    }), /attestor unavailable/);
    assert.equal(checks, 1);
    assert.deepEqual(commands, []);
  }
});

test('health is checked when a busy slot becomes available and uses its current coordinator URL', async (t) => {
  const now = 1_000_000;
  const client = fakeClient([
    ceremonyJson({ slot: { '@variant': 'Pending', who: '0xc' } }),
    { ...ceremonyJson(), coordinator_url: 'https://new-coordinator.example' },
  ], { now: () => now });
  const { keypair, commands } = await mockClaimTransactions(t, client);
  let checks = 0;
  await assert.rejects(claimWhenOpen(client, keypair, '0x123', '0xb', '0xa', {
    pollMs: 1,
    checkHealth: async (head) => {
      checks++;
      assert.equal(head.coordinatorUrl, 'https://new-coordinator.example');
      throw new Error('attestor unavailable');
    },
  }), /attestor unavailable/);
  assert.equal(checks, 1);
  assert.deepEqual(commands, []);
});

test('expired own claim is expired and reclaimed, then its fresh deadline is confirmed', async (t) => {
  const now = 1_000_000;
  const old = ceremonyJson({ slot: { '@variant': 'Claimed', who: '0xa', until_ms: now - 10_001 } });
  const fresh = ceremonyJson({ slot: { '@variant': 'Claimed', who: '0xa', until_ms: now + 900_000 } });
  const client = fakeClient([old, fresh], { now: () => now });
  const { keypair, commands } = await mockClaimTransactions(t, client);
  const head = await claimWhenOpen(client, keypair, '0x123', '0xb', '0xa');
  assert.deepEqual(commands, [['expire', 'claim']]);
  assert.deepEqual(client.waited, ['claim-digest']);
  assert.equal(head.slotUntil, now + 900_000);
});

test('a claim that expires during its health check is not resumed as live', async (t) => {
  let now = 1_000_000;
  const client = fakeClient([
    ceremonyJson({ slot: { '@variant': 'Claimed', who: '0xa', until_ms: now + 5000 } }),
    ceremonyJson({ slot: { '@variant': 'Claimed', who: '0xa', until_ms: now + 900_000 } }),
  ], { now: () => now });
  const { keypair, commands } = await mockClaimTransactions(t, client);
  await claimWhenOpen(client, keypair, '0x123', '0xb', '0xa', {
    checkHealth: async () => { now += 20_000; },
  });
  assert.deepEqual(commands, [['expire', 'claim']]);
});

test('a still-valid short lease resumes without predicting work duration', async () => {
  const now = 1_000_000;
  const client = fakeClient([ceremonyJson({ slot: { '@variant': 'Claimed', who: '0xa', until_ms: now + 60_000 } })], { now: () => now });
  const head = await claimWhenOpen(client, null, '0x123', '0xb', '0xa');
  assert.equal(head.slotUntil, now + 60_000);
  assert.deepEqual(client.waited, []);
});

test('resume uses Sui clock despite a fast local clock and reports the remaining lease', async () => {
  const now = 1_000_000; // Far behind the host clock on purpose.
  const client = fakeClient([ceremonyJson({ slot: { '@variant': 'Claimed', who: '0xa', until_ms: now + 360_000 } })], { now: () => now });
  const logs = [];
  const head = await claimWhenOpen(client, null, '0x123', '0xb', '0xa', { log: (s) => logs.push(s) });
  assert.equal(head.slotUntil, now + 360_000);
  assert.match(logs[0], /6m 0s remaining \(Sui clock\)/);
  assert.deepEqual(client.waited, []);
});

test('another contributor can win the expired slot; losing CLI keeps waiting', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const now = 1_000_000;
  const client = fakeClient([
    ceremonyJson({ slot: { '@variant': 'Claimed', who: '0xa', until_ms: now - 10_001 } }),
    ceremonyJson({ slot: { '@variant': 'Claimed', who: '0xc', until_ms: now + 900_000 } }),
    ceremonyJson(),
    ceremonyJson({ slot: { '@variant': 'Claimed', who: '0xa', until_ms: now + 900_000 } }),
  ], { now: () => now });
  const { keypair, commands } = await mockClaimTransactions(t, client);
  let attempts = 0;
  client.core.executeTransaction = async () => {
    if (++attempts === 1) throw new Error('slot lost to another contributor');
    return { Transaction: { digest: 'new-claim', status: { success: true } } };
  };
  let finished = false;
  const pending = claimWhenOpen(client, keypair, '0x123', '0xb', '0xa', { pollMs: 1000 }).then(() => { finished = true; });
  await new Promise(setImmediate);
  t.mock.timers.tick(1000);
  await new Promise(setImmediate);
  assert.equal(finished, false);
  t.mock.timers.tick(1000);
  await pending;
  assert.deepEqual(commands, [['expire', 'claim'], ['claim']]);
});

test('readHead lists accepted contributors with normalized addresses', async () => {
  const client = fakeClient([ceremonyJson({ chain: [{ contributor: '0xA', name: 'Deepak' }, { name: 'old entry' }] })]);
  const head = await readHead(client, '0xceremony');
  assert.equal(head.chainLen, 2);
  assert.deepEqual(head.contributors, ['0x' + '0'.repeat(63) + 'a', null]);
  assert.deepEqual(head.chain.map((e) => e.name), ['Deepak', 'old entry']);
});

test('readHead returns the hash and the time of each accepted contribution', async () => {
  const hash = Buffer.alloc(64, 0xab);
  const client = fakeClient([ceremonyJson({ chain: [{ contributor: '0xA', name: 'D', contribution_hash: hash.toString('base64'), ts_ms: '1700000000000', blob_id: '0xb10b' }] })]);
  const [entry] = (await readHead(client, '0xceremony')).chain;
  assert.equal(entry.contributionHash, 'ab'.repeat(64));
  assert.equal(entry.tsMs, 1700000000000);
  assert.equal(entry.sharedBlobId, '0xb10b');
});

test('readHead removes control characters from contributor names', async () => {
  const client = fakeClient([ceremonyJson({ chain: [{ contributor: '0xA', name: 'Eve\u001b[2Jx' }] })]);
  assert.equal((await readHead(client, '0xceremony')).chain[0].name, 'Eve[2Jx');
});
