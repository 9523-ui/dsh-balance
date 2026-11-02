import assert from 'node:assert/strict';
import { apply } from '../index.js';

function harness({ account, key, fetchImpl } = {}) {
  let route;
  let accountCalls = 0;
  const ctx = {
    logger: { warn: () => {} },
    effect(fn) {
      return fn();
    },
    get(name) {
      if (name === 'deepseekAccount' && account !== false) {
        return {
          async getBalance() {
            accountCalls += 1;
            return account;
          },
        };
      }
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'deepseek-account' }) };
      if (name === 'credentials' && key !== undefined) {
        return { resolve: async () => ({ value: key }) };
      }
      return undefined;
    },
    webServer: {
      register(options) {
        route = options;
        return () => {};
      },
    },
  };
  apply(ctx);
  assert.equal(route.kind, 'prefix');
  assert.equal(route.path, '/dsh-balance');

  const call = (method, url) =>
    new Promise((resolve, reject) => {
      const res = {
        destroyed: false,
        writableEnded: false,
        writeHead(status, headers) {
          this.status = status;
          this.headers = headers;
        },
        end(body) {
          this.writableEnded = true;
          resolve({ status: this.status, headers: this.headers, body: body === undefined ? '' : JSON.parse(body) });
        },
      };
      Promise.resolve(route.handler({ method, url }, res)).catch(reject);
    });

  return { call, accountCalls: () => accountCalls };
}

const snapshot = {
  status: 'ready',
  value: [{ currency: 'CNY', balance: '10.0000000000000000' }],
  bonusWallets: [{ currency: 'CNY', balance: '2.34' }],
};

{
  const server = harness({ account: snapshot });
  const first = await server.call('GET', '/dsh-balance/summary');
  assert.equal(first.status, 200);
  assert.equal(first.body.ok, true);
  assert.equal(first.body.source, 'deepseek-account');
  assert.equal(first.body.symbol, '¥');
  assert.equal(first.body.total, '12.34');
  assert.equal(first.body.granted, '2.34');
  assert.equal(first.body.toppedUp, '10.00');
  assert.equal(server.accountCalls(), 1);

  const cached = await server.call('GET', '/dsh-balance/summary');
  assert.equal(cached.body.total, '12.34');
  assert.equal(server.accountCalls(), 1, 'second summary read should hit the 30s cache');

  const refreshed = await server.call('POST', '/dsh-balance/refresh');
  assert.equal(refreshed.body.ok, true);
  assert.equal(server.accountCalls(), 2, 'refresh must bypass the cache');
}

{
  const server = harness({ account: false, key: 'sk-test' });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.match(String(url), /api\.deepseek\.com\/user\/balance$/);
    assert.equal(init.headers.authorization, 'Bearer sk-test');
    return new Response(
      JSON.stringify({
        balance_infos: [
          { currency: 'CNY', total_balance: '8.79', granted_balance: '0.00', topped_up_balance: '8.79' },
          { currency: 'USD', total_balance: '1.50', granted_balance: '0.50', topped_up_balance: '1.00' },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  try {
    const result = await server.call('GET', '/dsh-balance/summary');
    assert.equal(result.body.ok, true);
    assert.equal(result.body.source, 'deepseek-api-key');
    assert.equal(result.body.currency, 'CNY');
    assert.equal(result.body.total, '8.79');
    assert.equal(result.body.wallets.length, 2);
    assert.equal(result.body.wallets[1].currency, 'USD');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

{
  const server = harness({ account: false });
  const result = await server.call('GET', '/dsh-balance/summary');
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, false);
  assert.equal(result.body.reason, 'no-account');
}

{
  const server = harness({ account: { status: 'failed' } });
  const result = await server.call('GET', '/dsh-balance/summary');
  assert.equal(result.body.ok, false);
  assert.equal(result.body.reason, 'account-failed');
}

{
  const server = harness({ account: snapshot });
  const missing = await server.call('GET', '/dsh-balance/nope');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.reason, 'not-found');
  const wrongMethod = await server.call('PUT', '/dsh-balance/summary');
  assert.equal(wrongMethod.status, 405);
}

console.log('all balance host tests passed');
