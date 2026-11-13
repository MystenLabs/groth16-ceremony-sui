import test from 'node:test';
import assert from 'node:assert/strict';
import { requestFunding, validateFundingUrl, requireFundingLinkForCeremony } from '../src/funding.js';
const secret = 'a'.repeat(64);
const url = `https://example.com/fund/${secret}`;
const digest = 'B'.repeat(44);
const body = { address: '0xa', ceremonyId: '0xb', network: 'testnet' };

test('funding retries the same address without leaking the URL, and forbids redirects', async () => {
  let calls = 0;
  const logs = [];
  const result = await requestFunding(url, body, {
    sleep: async () => {}, log: (line) => logs.push(line), attempts: 3,
    fetchFn: async (value, options) => {
      assert.equal(String(value), url);
      assert.equal(options.redirect, 'error');
      assert.deepEqual(JSON.parse(options.body), body);
      if (++calls === 1) throw new Error(`fetch failed: ${url}`);
      if (calls === 2) return new Response('{}', { status: 503 });
      return Response.json({ ok: true, status: 'funded', digest });
    },
  });
  assert.equal(result, digest);
  assert.equal(calls, 3);
  assert.equal(logs.join().includes(secret), false);
  assert.match(logs[0], /could not reach the funding endpoint/);
  assert.match(logs[1], /HTTP 503; the coordinator may be unavailable/);
});

test('disabled, invalid, mismatched, and closed funding stop immediately', async () => {
  for (const [status, message] of [[403, /disabled/], [404, /invalid or unavailable/], [400, /does not match/], [409, /not accepting/]]) {
    await assert.rejects(requestFunding(url, body, { fetchFn: async () => new Response(url, { status }), sleep: async () => assert.fail('must not retry') }), message);
  }
});

test('persistent transport failure is bounded and redacted', async () => {
  await assert.rejects(requestFunding(url, body, { attempts: 2, sleep: async () => {}, fetchFn: async () => { throw new Error(url); } }), (error) => {
    assert.match(error.message, /same workdir/);
    assert.equal(error.message.includes(secret), false);
    return true;
  });
});

test('private URL requires HTTPS except loopback and rejects credentials/query strings', () => {
  assert.equal(validateFundingUrl(url).href, url);
  assert.equal(validateFundingUrl(url.replace('https://example.com', 'http://127.0.0.1:8090')).protocol, 'http:');
  for (const bad of [url.replace('https:', 'http:'), url + '?secret=bad', url.replace('example.com', 'user:pass@example.com'), 'https://example.com']) {
    assert.throws(() => validateFundingUrl(bad));
  }
});

test('self-funded is the default; automatic funding is opt-in and modes are mutually exclusive', async () => {
  const { selectFundingMode, validatePublicCoordinatorUrl } = await import('../src/funding.js');
  assert.deepEqual(selectFundingMode({ 'self-funded': true }, {}), { mode: 'self-funded' });
  assert.deepEqual(selectFundingMode({ 'funding-url': url }, {}), { mode: 'automatic', url });
  assert.deepEqual(selectFundingMode({}, { CEREMONY_FUNDING_URL: url }), { mode: 'automatic', url });
  assert.deepEqual(selectFundingMode({}, {}), { mode: 'self-funded' });
  for (const empty of ['', '   ']) {
    assert.throws(() => selectFundingMode({ 'funding-url': empty }, {}), /--funding-url is empty; CEREMONY_FUNDING_URL may be unset/);
    assert.throws(() => selectFundingMode({ 'funding-url': empty }, { CEREMONY_FUNDING_URL: url }), /--funding-url is empty/);
  }
  assert.throws(() => selectFundingMode({ 'self-funded': true, 'funding-url': url }, {}), /choose either/);
  assert.throws(() => selectFundingMode({ 'self-funded': true }, { CEREMONY_FUNDING_URL: url }), /unset/);
  assert.throws(() => validatePublicCoordinatorUrl(url), /must be public/);
  for (const invalid of ['data:text/plain,hello', 'ftp://example.com', 'file:///tmp/coordinator']) {
    assert.throws(() => validatePublicCoordinatorUrl(invalid), /must be public/);
  }
  for (const valid of ['http://localhost:8090', 'https://example.com']) validatePublicCoordinatorUrl(valid);
});

const context = {
  address: '0x' + '1'.repeat(64), ceremonyId: '0x' + '2'.repeat(64),
  organizer: '0x' + '3'.repeat(64), network: 'testnet', walCoinType: '0x4::wal::WAL',
};
function fundingHarness({ enough = false, payoutEnough = true } = {}) {
  let funded = enough;
  const calls = { request: 0, saved: [], waited: 0 };
  const transaction = {
    digest, status: { success: true }, transaction: { sender: context.organizer },
    balanceChanges: [
      { address: context.address, coinType: '0x2::sui::SUI', amount: '60' },
      { address: context.address, coinType: context.walCoinType, amount: '250' },
    ],
  };
  const client = { core: {
    async getBalance() { return { balance: { balance: funded ? '1000' : '0' } }; },
    async waitForTransaction(options) {
      assert.deepEqual(options.include, { transaction: true, balanceChanges: true });
      return { Transaction: transaction };
    },
  } };
  const options = {
    fundingUrl: url, minSui: 40n, minWal: 100n,
    request: async () => { calls.request++; funded = payoutEnough; return digest; },
    saveReceipt: async (receipt) => { calls.saved.push(JSON.parse(JSON.stringify(receipt))); },
    waitForFunds: async () => { calls.waited++; funded = true; },
  };
  return { client, options, calls, transaction };
}

test('existing funds take priority over a URI, without creating refund provenance', async () => {
  const { ensureFunding } = await import('../src/funding.js');
  for (const permissionless of [true, false]) {
    const h = fundingHarness({ enough: true });
    assert.equal(await ensureFunding(h.client, { ...context, permissionless }, h.options), null);
    assert.deepEqual(h.calls, { request: 0, saved: [], waited: 0 });
  }
});

test('missing funds and URI ask for manual funding without recording organizer funding', async () => {
  const { ensureFunding } = await import('../src/funding.js');
  const h = fundingHarness();
  assert.equal(await ensureFunding(h.client, context, { ...h.options, fundingUrl: undefined }), null);
  assert.deepEqual(h.calls, { request: 0, saved: [], waited: 1 });
});

test('confirmed automatic funding persists across retries without URI and access-mode changes', async () => {
  const { ensureFunding } = await import('../src/funding.js');
  for (const permissionless of [true, false]) {
    const h = fundingHarness();
    const receipt = await ensureFunding(h.client, { ...context, permissionless }, h.options);
    assert.equal(receipt.organizer, context.organizer);
    assert.equal(receipt.digest, digest);
    assert.equal(h.calls.request, 1);
    assert.deepEqual(h.calls.saved, [receipt]);
    assert.equal(JSON.stringify(receipt).includes(secret), false);
    const resumed = await ensureFunding(h.client, { ...context, permissionless: !permissionless }, {
      ...h.options, fundingUrl: undefined, receipt: h.calls.saved[0],
    });
    assert.deepEqual(resumed, receipt);
    assert.equal(h.calls.request, 1);
  }
});

test('a spent payout is recorded before reporting insufficient funds', async () => {
  const { ensureFunding } = await import('../src/funding.js');
  const h = fundingHarness({ payoutEnough: false });
  await assert.rejects(ensureFunding(h.client, context, h.options), /already received its payout/);
  assert.equal(h.calls.saved[0].digest, digest);
});

test('a receipt from another network, ceremony, key or organizer never authorizes a refund', async () => {
  const { ensureFunding } = await import('../src/funding.js');
  const original = fundingHarness();
  const receipt = await ensureFunding(original.client, context, original.options);
  for (const key of ['network', 'ceremonyId', 'address', 'organizer']) {
    const h = fundingHarness({ enough: true });
    const wrong = { ...receipt, [key]: key === 'network' ? 'mainnet' : '0x' + '9'.repeat(64) };
    assert.equal(await ensureFunding(h.client, context, { ...h.options, receipt: wrong }), null);
  }
});

test('failed, unrelated, or non-paying transactions do not create refund provenance', async () => {
  const { ensureFunding } = await import('../src/funding.js');
  for (const modify of [
    (tx) => { tx.status.success = false; },
    (tx) => { tx.digest = 'C'.repeat(44); },
    (tx) => { tx.transaction.sender = '0x5'; },
    (tx) => { tx.balanceChanges = []; },
    (tx) => { for (const change of tx.balanceChanges) change.address = '0x6'; },
  ]) {
    const h = fundingHarness();
    modify(h.transaction);
    await assert.rejects(ensureFunding(h.client, context, h.options), /funding transaction/);
    assert.equal(h.calls.saved.length, 0);
  }
});

test('a refunded payout does not sweep new personal funds when a key is reused', async () => {
  const { ensureFunding } = await import('../src/funding.js');
  const original = fundingHarness();
  const receipt = { ...await ensureFunding(original.client, context, original.options), refundDigest: 'D'.repeat(44) };
  const next = fundingHarness({ enough: true });
  assert.equal(await ensureFunding(next.client, context, { ...next.options, receipt }), null);
  assert.equal(next.calls.request, 0);
  const empty = fundingHarness({ payoutEnough: false });
  await assert.rejects(ensureFunding(empty.client, context, { ...empty.options, receipt }), /already received and refunded/);
  assert.equal(empty.calls.saved.length, 0);
});

test('0.12 WAL triggers automatic funding under the 114 MiB budget', async () => {
  const { ensureFunding } = await import('../src/funding.js');
  const { fundingDefaults } = await import('../src/funding-policy.js');
  const h = fundingHarness();
  let wal = '120000000';
  h.client.core.getBalance = async ({ coinType }) => ({ balance: { balance: coinType === context.walCoinType ? wal : '60000000' } });
  h.options.request = async () => { h.calls.request++; wal = '250000000'; return digest; };
  const { minSui, minWal } = fundingDefaults('testnet');
  const receipt = await ensureFunding(h.client, context, { ...h.options, minSui, minWal });
  assert.equal(h.calls.request, 1);
  assert.equal(receipt.digest, digest);
});

test('a funding link must come from the ceremony coordinator host', () => {
  requireFundingLinkForCeremony(url, 'https://example.com');
  requireFundingLinkForCeremony(url, null);
  assert.throws(() => requireFundingLinkForCeremony('not a link', null), /invalid private funding URL/);
  assert.throws(() => requireFundingLinkForCeremony(url, 'https://other.example'), /different ceremony/);
  assert.throws(() => requireFundingLinkForCeremony('https://example.com/nope', 'https://example.com'), /invalid private funding URL/);
});
