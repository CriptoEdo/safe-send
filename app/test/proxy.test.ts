// Tests of the Mainnet RPC proxy (api/rpc.ts), with the local validator standing in for Helius.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { POST } from '../api/rpc.ts';

const SITE = 'https://www.safe-send.app';

before(() => {
  process.env.HELIUS_MAINNET_RPC_URL = process.env.TEST_RPC ?? 'http://127.0.0.1:8899';
});

const call = (body: unknown, origin: string | null = SITE) =>
  POST(new Request('https://www.safe-send.app/api/rpc', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }));

const rpc = (method: string, params: unknown[] = []) => ({ jsonrpc: '2.0', id: 1, method, params });

test('forwards the methods the app uses, from the site', async () => {
  const response = await call(rpc('getBalance', ['11111111111111111111111111111111']));
  assert.equal(response.status, 200);
  assert.equal(typeof (await response.json()).result.value, 'number');
  for (const origin of ['https://safe-send.app', 'https://safe-send-git-mainnet-edob.vercel.app', 'http://localhost:5173']) {
    assert.equal((await call(rpc('getLatestBlockhash'), origin)).status, 200, origin);
  }
});

test('refuses other sites and requests without an origin', async () => {
  assert.equal((await call(rpc('getBalance', ['11111111111111111111111111111111']), 'https://evil.example')).status, 403);
  assert.equal((await call(rpc('getBalance', ['11111111111111111111111111111111']), 'https://safe-send.app.evil.example')).status, 403);
  assert.equal((await call(rpc('getBalance', ['11111111111111111111111111111111']), null)).status, 403);
});

test('refuses methods the app does not use, and getProgramAccounts on other programs', async () => {
  for (const method of ['requestAirdrop', 'getSlot', 'getBlock', 'getSignaturesForAddress']) {
    const response = await call(rpc(method));
    assert.equal(response.status, 403, method);
    assert.match((await response.json()).error.message, /not allowed/);
  }
  const tokenProgram = await call(rpc('getProgramAccounts', ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA']));
  assert.equal(tokenProgram.status, 403);
  const safeSend = await call(rpc('getProgramAccounts', ['EGLwJZkWybKNMeQQcmJ6HZYnCfTqWn2b7RQVRsPsQ1Zg', { encoding: 'base64', dataSlice: { offset: 0, length: 0 } }]));
  assert.equal(safeSend.status, 200);
});

test('refuses malformed, oversized and oversized-batch requests', async () => {
  assert.equal((await call('not json')).status, 400);
  assert.equal((await call(rpc('getBalance', ['x'.repeat(70_000)]))).status, 413);
  assert.equal((await call(Array.from({ length: 11 }, () => rpc('getBlockHeight')))).status, 400);
  assert.equal((await call([rpc('getBlockHeight'), rpc('requestAirdrop')])).status, 403); // one bad item refuses the batch
  assert.equal((await call([rpc('getBlockHeight'), rpc('getLatestBlockhash')])).status, 200);
});

test('without the Helius URL configured, it says so', async () => {
  const saved = process.env.HELIUS_MAINNET_RPC_URL;
  delete process.env.HELIUS_MAINNET_RPC_URL;
  assert.equal((await call(rpc('getBlockHeight'))).status, 500);
  process.env.HELIUS_MAINNET_RPC_URL = saved;
});
