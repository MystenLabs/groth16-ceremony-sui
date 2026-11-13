import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { fundingSecretMatches } from '../src/crypto/funding_secret.js';
import { updateFundingConfig, readFundingConfig, privateFundingUrl, requirePublicCoordinatorUrl } from '../src/lib/funding-config.js';
import { withRunLock, withWalletOperation, trackedPayout, normalizeFundingAddress } from '../src/lib/funding-store.js';
import { buildFundingTransaction, createFundingService } from '../src/lib/funding.js';
import { startCoordinatorHttpServer } from '../src/coordinator_http.js';

const address = normalizeFundingAddress('0xa');
const ceremonyId = normalizeFundingAddress('0xb');
const scope = `testnet:${ceremonyId}`;
const payoutDigest = 'B'.repeat(44);
const signedBytes = Buffer.from('signed transaction').toString('base64');
const signature = Buffer.from('signature').toString('base64');
const prepared = { status: 'prepared', digest: payoutDigest, bytes: signedBytes, signature };
function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ceremony-funding-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function operations(overrides = {}) {
  return { prepare: async () => ({ ...prepared }), lookup: async () => null, send: async () => 'funded', ...overrides };
}

test('secret persists, rotates without enabling, and never belongs in a public URL', (t) => {
  const dir = directory(t);
  const first = updateFundingConfig(dir, 'testnet', ceremonyId);
  assert.equal(first.enabled, true);
  assert.equal(updateFundingConfig(dir, 'testnet', ceremonyId).secret, first.secret);
  updateFundingConfig(dir, 'testnet', ceremonyId, 'disable');
  const rotated = updateFundingConfig(dir, 'testnet', ceremonyId, 'rotate');
  assert.equal(rotated.enabled, false);
  assert.equal(fundingSecretMatches(first.secret, rotated.secret), false);
  assert.equal(fundingSecretMatches(rotated.secret, rotated.secret), true);
  assert.equal(readFundingConfig(dir, 'mainnet', ceremonyId), null);
  assert.equal(fs.statSync(path.join(dir, 'funding-secret.json')).mode & 0o777, 0o600);
  const url = privateFundingUrl('https://example.com', rotated.secret);
  assert.equal(url, `https://example.com/fund/${rotated.secret}`);
  assert.throws(() => requirePublicCoordinatorUrl(url), /never publish/);
  assert.throws(() => requirePublicCoordinatorUrl('https://example.com/%66und/secret'), /never publish/);
  assert.throws(() => privateFundingUrl('http://example.com', rotated.secret), /HTTPS/);
  assert.equal(updateFundingConfig(dir, 'testnet', ceremonyId, 'enable').secret, rotated.secret);
});

test('duplicate and concurrent requests fund once, including after reopening history', async (t) => {
  const dir = directory(t);
  let sends = 0, prepares = 0;
  const ops = operations({ prepare: async () => { prepares++; return { ...prepared }; }, send: async () => { sends++; return 'funded'; } });
  const pay = () => withRunLock(dir, (store) => trackedPayout(store, scope, address, ops));
  await Promise.all([pay(), pay(), pay()]);
  await pay();
  assert.equal(sends, 1);
  assert.equal(prepares, 1);
  const lines = fs.readFileSync(path.join(dir, 'funding-payouts.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(lines.map((r) => r.record.status), ['prepared', 'funded']);
});

test('ambiguous submission persists signed bytes and reuses them across retries', async (t) => {
  const dir = directory(t);
  let prepares = 0, sends = 0;
  const ops = operations({
    prepare: async () => { prepares++; return { ...prepared }; },
    lookup: async () => { throw new Error('RPC unavailable'); },
    send: async (record) => {
      assert.equal(record.bytes, signedBytes);
      const persisted = fs.readFileSync(path.join(dir, 'funding-payouts.jsonl'), 'utf8');
      assert.equal(persisted.includes(signedBytes), true);
      if (++sends === 1) throw new Error('timeout after submission');
      return 'funded';
    },
  });
  await assert.rejects(withRunLock(dir, (s) => trackedPayout(s, scope, address, ops)), /confirmation pending/);
  await withRunLock(dir, (s) => trackedPayout(s, scope, address, ops), { resume: { scope, address } });
  assert.equal(prepares, 1);
  assert.equal(sends, 2);
});

test('confirmed transaction is reconciled without resubmission; failed transaction can be replaced', async (t) => {
  const dir = directory(t);
  await withRunLock(dir, async (store) => {
    store.put(scope, address, { ...prepared });
    const result = await trackedPayout(store, scope, address, operations({ lookup: async () => 'funded', send: async () => assert.fail('must not resend') }));
    assert.equal(result.digest, payoutDigest);
    store.put(scope, address, { ...prepared });
    const replacement = await trackedPayout(store, scope, address, operations({ lookup: async () => 'failed' }));
    assert.equal(replacement.digest, payoutDigest);
  });
});

test('crash recovery keeps prepared transaction, ignores torn final line, and rejects complete corruption', async (t) => {
  const dir = directory(t);
  await withRunLock(dir, async (store) => store.put(scope, address, { ...prepared }));
  const history = path.join(dir, 'funding-payouts.jsonl');
  fs.appendFileSync(history, '{"partial":');
  await withRunLock(dir, async (store) => {
    assert.equal(store.get(scope, address).digest, payoutDigest);
    await trackedPayout(store, scope, address, operations({ lookup: async () => 'funded', prepare: async () => assert.fail('must not rebuild') }));
  }, { resume: { scope, address } });
  fs.appendFileSync(history, 'invalid JSON\n');
  await assert.rejects(withRunLock(dir, async () => assert.fail('must fail closed')));
});

test('unresolved payouts block other addresses and wallet operations until the original retry resolves', async (t) => {
  const dir = directory(t);
  await assert.rejects(withRunLock(dir, (s) => trackedPayout(s, scope, address,
    operations({ send: async () => { throw new Error('timeout'); } }))), /confirmation pending/);
  await assert.rejects(withRunLock(dir, () => assert.fail('must not use wallet')), /resolve the pending payout/);
  const other = normalizeFundingAddress('0xe');
  await assert.rejects(withRunLock(dir, (s) => trackedPayout(s, scope, other, operations()),
    { resume: { scope, address: other } }), /resolve the pending payout/);
  await withRunLock(dir, (s) => trackedPayout(s, scope, address, operations({ lookup: async () => 'funded' })),
    { resume: { scope, address } });
  await withRunLock(dir, (s) => trackedPayout(s, scope, other, operations()));
});

test('authorization failure before first submission does not leave a pending payout', async (t) => {
  const dir = directory(t);
  await assert.rejects(withRunLock(dir, (s) => trackedPayout(s, scope, address, operations({
    beforeSend: async () => { throw new Error('disabled'); },
    send: async () => assert.fail('must not submit'),
  }))), /disabled/);
  await withRunLock(dir, (s) => assert.equal(s.get(scope, address).status, 'failed'));
});

test('uncertain ordinary wallet operations retain the lock and recovery details', async (t) => {
  const dir = directory(t);
  await assert.rejects(withRunLock(dir, async (_store, guard) => {
    guard.block({ kind: 'transaction', digest: 'd', bytes: 'signed', signature: 's' });
    throw new Error('RPC timeout');
  }), /RPC timeout/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'funding.lock'))).unresolved.bytes, 'signed');
  await assert.rejects(withRunLock(dir, () => assert.fail('must not proceed')), /wallet is busy/);
});

test('external wallet operations serialize with payouts and retain the lock on failure', async (t) => {
  const dir = directory(t);
  let release, entered;
  const ready = new Promise((resolve) => { entered = resolve; });
  const upload = withWalletOperation(dir, { kind: 'walrus-store' }, async () => {
    entered();
    await new Promise((resolve) => { release = resolve; });
  });
  await ready;
  let paid = false;
  const payout = withRunLock(dir, () => { paid = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(paid, false);
  release();
  await Promise.all([upload, payout]);
  assert.equal(paid, true);
  await assert.rejects(withWalletOperation(dir, { kind: 'walrus-store' }, async () => { throw new Error('CLI failed'); }), /CLI failed/);
  await assert.rejects(withRunLock(dir, () => assert.fail('must not proceed')), /wallet is busy/);
});

test('confirmed transaction failure releases the wallet lock', async (t) => {
  const dir = directory(t);
  await assert.rejects(withRunLock(dir, async (_store, guard) => {
    guard.block({ kind: 'transaction' });
    guard.resolve();
    throw new Error('confirmed Move abort');
  }), /confirmed Move abort/);
  await withRunLock(dir, () => {});
});

test('manual fund rejects multiple addresses before loading the ceremony', () => {
  for (const args of [['0xa,0xb'], ['0xa', '0xb'], []]) {
    const result = spawnSync(process.execPath, [new URL('../src/admin.js', import.meta.url).pathname, 'fund', ...args], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /exactly one address/);
  }
});

test('a second process cannot acquire the wallet lock', async (t) => {
  const dir = directory(t);
  await withRunLock(dir, async () => {
    const moduleUrl = new URL('../src/lib/funding-store.js', import.meta.url).href;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `import { withRunLock } from ${JSON.stringify(moduleUrl)}; await withRunLock(${JSON.stringify(dir)}, async () => {});`], { encoding: 'utf8' });
    assert.notEqual(child.status, 0);
    assert.match(child.stderr, /wallet is busy/);
  });
  assert.equal(fs.existsSync(path.join(dir, 'funding.lock')), false);
});

test('complete payout records missing recovery or receipt fields fail closed', async (t) => {
  for (const record of [
    { status: 'funded' }, { status: 'funded', digest: 'invalid' },
    { ...prepared, bytes: undefined }, { ...prepared, signature: undefined },
    { ...prepared, bytes: 'not base64!' }, { ...prepared, signature: '' },
  ]) {
    const dir = directory(t);
    fs.writeFileSync(path.join(dir, 'funding-payouts.jsonl'), JSON.stringify({ scope, address, record }) + '\n');
    await assert.rejects(withRunLock(dir, () => assert.fail('must not use corrupt history')), /invalid funding payout history/);
  }
});

test('manual enrollment rejects new permissionless payouts but recovers existing payouts', async (t) => {
  const dir = directory(t);
  const client = { core: {
    getObject: async () => ({ object: { json: { permissioned: false, phase: { '@variant': 'Phase2Contribute' } } } }),
    getTransaction: async () => ({ Transaction: { digest: payoutDigest, status: { success: true } } }),
    executeTransaction: async () => assert.fail('must not send a new payout'),
  } };
  const service = createFundingService({ client, workdir: dir, network: 'testnet', ceremonyId });
  await assert.rejects(service.fund(address), /use fund for permissionless ceremonies/);
  await withRunLock(dir, (store) => store.put(scope, address, prepared));
  assert.equal((await service.fund(address)).digest, payoutDigest);
  assert.equal((await service.fund(address)).digest, payoutDigest);
});

test('funding transaction includes enrollment and both transfers, handling WAL pagination', async () => {
  const calls = [];
  const client = { core: { listCoins: async ({ cursor }) => {
    calls.push(cursor);
    return cursor ? { objects: [{ objectId: normalizeFundingAddress('0x2'), balance: '280000000' }], hasNextPage: false } : { objects: [{ objectId: normalizeFundingAddress('0x1'), balance: '20000000' }], hasNextPage: true, cursor: 'next' };
  } } };
  const opts = { client, owner: address, network: 'testnet', packageId: '0xc', ceremonyId, capId: '0xd', address };
  const tx = await buildFundingTransaction({ ...opts, enroll: true });
  const commands = tx.getData().commands;
  assert.equal(commands[0].MoveCall.function, 'add_contributors');
  assert.equal(commands.filter((c) => c.TransferObjects).length, 2);
  assert.equal(commands.filter((c) => c.MergeCoins).length, 1);
  assert.deepEqual(calls, [null, 'next']);
  const openTx = await buildFundingTransaction({ ...opts, enroll: false });
  assert.equal(openTx.getData().commands.some((c) => c.MoveCall), false);
});

test('HTTP authenticates funding independently of the public URL and reloads disabled/rotated configuration', async (t) => {
  const dir = directory(t);
  const config = updateFundingConfig(dir, 'testnet', ceremonyId);
  const funding = createFundingService({ workdir: dir, network: 'testnet', ceremonyId });
  const server = startCoordinatorHttpServer(0, dir, { funding });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (pathname, body = { address, ceremonyId, network: 'testnet' }) => fetch(`${base}${pathname}`, { method: 'POST', body: JSON.stringify(body) });
  assert.equal((await post('/fund')).status, 404);
  assert.equal((await post(`/fund/${'0'.repeat(64)}`)).status, 404);
  assert.equal((await post(`/fund/${config.secret}`, { address, ceremonyId, network: 'mainnet' })).status, 400);
  updateFundingConfig(dir, 'testnet', ceremonyId, 'disable');
  assert.equal((await post(`/fund/${config.secret}`)).status, 403);
  const rotated = updateFundingConfig(dir, 'testnet', ceremonyId, 'rotate');
  assert.equal((await post(`/fund/${config.secret}`)).status, 404);
  assert.equal((await post(`/fund/${rotated.secret}`)).status, 403);
  const telemetry = fs.readFileSync(path.join(dir, 'logs', 'telemetry.jsonl'), { encoding: 'utf8', flag: 'a+' });
  assert.equal(telemetry.includes(config.secret), false);
});

test('funding rejects invalid addresses and normalizes alternate encodings', () => {
  assert.equal(normalizeFundingAddress('0xA'), address);
  for (const bad of [null, '0x0', '0xZZ', '../a', '0x' + 'a'.repeat(65)]) assert.throws(() => normalizeFundingAddress(bad));
});

test('previously funded addresses return the receipt without paying or restoring a removed allowlist entry', async (t) => {
  const dir = directory(t);
  const config = updateFundingConfig(dir, 'testnet', ceremonyId);
  await withRunLock(dir, async (store) => store.put(scope, address, { status: 'funded', digest: payoutDigest }));
  const client = { core: {
    getObject: async () => ({ object: { json: { phase: { '@variant': 'Phase2Contribute' }, permissioned: true, allowlist: { contents: [] } } } }),
    executeTransaction: async () => assert.fail('must not fund or reinstate the address'),
  } };
  const service = createFundingService({ client, workdir: dir, network: 'testnet', ceremonyId });
  const result = await service.request(config.secret, { address: '0xA', network: 'testnet', ceremonyId });
  assert.equal(result.digest, payoutDigest);
  assert.equal(fs.readFileSync(path.join(dir, 'funding-payouts.jsonl'), 'utf8').trim().split('\n').length, 1);
});

test('automatic payout overrides reach transaction amounts and survive restarts without paying twice', async (t) => {
  const { Transaction } = await import('@mysten/sui/transactions');
  const { resolveAirdropAmounts } = await import('../src/lib/funding-policy.js');
  // Supply offline transaction bytes at the SDK build boundary; inspect the
  // actual funding commands before serialization, with no RPC or signing key.
  const offline = new Transaction();
  offline.setSender(address);
  offline.setGasBudget(1000000);
  offline.setGasPrice(1);
  offline.setGasPayment([{ objectId: normalizeFundingAddress('0x1'), version: '1', digest: '11111111111111111111111111111111' }]);
  const bytes = await offline.build();
  const digest = await offline.getDigest();
  const builtAmounts = [];
  t.mock.method(Transaction.prototype, 'build', async function () {
    const data = this.getData();
    builtAmounts.push(data.commands.filter((command) => command.SplitCoins).flatMap((command) =>
      command.SplitCoins.amounts.map((amount) => Buffer.from(data.inputs[amount.Input].Pure.bytes, 'base64').readBigUInt64LE())));
    return bytes;
  });
  let sends = 0;
  const client = { core: {
    getObject: async () => ({ object: { json: { permissioned: true, phase: { '@variant': 'Phase2Contribute' } } } }),
    listCoins: async () => ({ objects: [{ objectId: normalizeFundingAddress('0x2'), balance: '1000000000' }], hasNextPage: false }),
    executeTransaction: async () => { sends++; return { Transaction: { digest, status: { success: true } } }; },
    waitForTransaction: async () => {},
    getTransaction: async () => { throw new Error('pending transaction not found yet'); },
  } };
  const dir = directory(t);
  const config = updateFundingConfig(dir, 'testnet', ceremonyId);
  const options = {
    client, workdir: dir, network: 'testnet', ceremonyId, packageId: '0xc', capId: '0xd',
    keypair: { toSuiAddress: () => address, signTransaction: async () => ({ signature }) },
  };
  const first = createFundingService({ ...options, airdrop: resolveAirdropAmounts('testnet', { sui: '0.1', wal: '0.3' }) });
  const body = { address, ceremonyId, network: 'testnet' };
  assert.equal((await first.request(config.secret, body)).digest, digest);
  assert.deepEqual(builtAmounts, [[100_000_000n, 300_000_000n]]);
  const records = fs.readFileSync(path.join(dir, 'funding-payouts.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(records.at(-1).record.sui, '100000000');
  assert.equal(records.at(-1).record.wal, '300000000');
  const restarted = createFundingService({ ...options, airdrop: resolveAirdropAmounts('testnet', { sui: '0.2', wal: '0.5' }) });
  assert.equal((await restarted.request(config.secret, body)).digest, digest);
  assert.equal(sends, 1);
  assert.equal(builtAmounts.length, 1);

  // An unresolved payout also retries its original bytes and amounts.
  const pendingDir = directory(t);
  const pendingConfig = updateFundingConfig(pendingDir, 'testnet', ceremonyId);
  await withRunLock(pendingDir, (store) => store.put(scope, address, records[0].record));
  const pending = createFundingService({ ...options, workdir: pendingDir, airdrop: resolveAirdropAmounts('testnet', { sui: '0.2', wal: '0.5' }) });
  assert.equal((await pending.request(pendingConfig.secret, body)).digest, digest);
  assert.equal(sends, 2);
  assert.equal(builtAmounts.length, 1);
  const saved = fs.readFileSync(path.join(pendingDir, 'funding-payouts.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).at(-1).record;
  assert.equal(saved.sui, '100000000');
  assert.equal(saved.wal, '300000000');
});
