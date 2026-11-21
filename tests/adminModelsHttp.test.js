'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAdminModelsHandler } = require('../lib/server/adminModelsHttp');

const actor = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', role: 'admin', authLevel: 'mfa' };
const request = (url = 'http://localhost/api/admin/models') => new Request(url, { headers: { Origin: 'http://localhost' } });
function handler({ user = actor, result = { ok: true, data: { models: [], nextCursor: null }, error: null, meta: { source: 'api', mock: false, writesAvailable: false } }, error } = {}) {
  return createAdminModelsHandler({
    environment: { NODE_ENV: 'development', APP_BASE_URL: 'http://localhost/', AUTH_ALLOW_LOCAL_HTTP: '1' },
    database: {},
    session: () => ({ me: async () => ({ user }) }),
    projection: () => ({ read: async () => error ? Promise.reject(error) : result }),
    sink: { warn() {}, error() {} },
  });
}

test('模型 API 要求 admin+MFA，成功返回 API 来源和不可写能力', async () => {
  const response = await handler() (request());
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.meta.source, 'api');
  assert.equal(body.meta.writesAvailable, false);
  assert.ok(body.requestId);
  assert.equal(body.meta.requestId, body.requestId);
  assert.equal(response.headers.get('x-request-id'), body.requestId);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('vary'), 'Cookie');
});

test('匿名、非管理员和未完成 MFA 均拒绝且不触发投影读取', async () => {
  for (const user of [null, { id: actor.id, role: 'user', authLevel: 'mfa' }, { ...actor, authLevel: 'password' }]) {
    let reads = 0;
    const route = createAdminModelsHandler({ environment: { NODE_ENV: 'development', APP_BASE_URL: 'http://localhost/', AUTH_ALLOW_LOCAL_HTTP: '1' }, database: {}, session: () => ({ me: async () => ({ user }) }), projection: () => ({ read: async () => { reads++; } }), sink: { warn() {}, error() {} } });
    const response = await route(request());
    assert.ok([401, 403].includes(response.status));
    assert.equal(reads, 0);
  }
});

test('HTTP 成功信封可直接被真实 gateway 消费，不依赖旧 Mock adapter', async () => {
  const { createAdminModelsGateway } = require('../lib/adminModelsData');
  const { createAdminModelsProjectionRead } = require('../lib/server/adminModelsProjectionRead');
  const database = { transaction: async run => run({ execute: async () => ({ rows: [] }) }) };
  const projection = createAdminModelsProjectionRead({ database, clock: async () => '2026-11-20T02:00:00.000Z', readBindings: async () => [] });
  const response = await handler({ result: await projection.read() })(request());
  const gateway = createAdminModelsGateway({ transport: async () => response.json() });
  const result = await gateway.read();
  assert.equal(result.source, 'api');
  assert.equal(result.mock, false);
  assert.equal(result.writesAvailable, false);
  assert.deepEqual(result.models, []);
  assert.equal(result.nextCursor, null);
  assert.equal(result.meta.requestId, response.headers.get('x-request-id'));
  const valid = await handler({ result: await projection.read() })(request()).then(value => value.json());
  for (const change of [
    body => { body.meta.mock = true; },
    body => { body.meta.writesAvailable = true; },
    body => { body.meta.capabilities.pricingRead = true; },
    body => { body.meta.requestId = 'different'; },
    body => { body.meta.asOf = 'invalid'; },
    body => { body.meta.orderBy.reverse(); },
    body => { body.data.nextCursor = '!bad'; },
  ]) {
    const body = structuredClone(valid);
    change(body);
    await assert.rejects(createAdminModelsGateway({ transport: async () => body }).read(), /ADMIN_MODELS_DATA_INVALID/);
  }
});

test('数据库或投影失败返回脱敏 503，不回退 Mock', async () => {
  const response = await handler({ error: Object.assign(new Error('secret SQL'), { code: 'DB_FAIL' }) })(request());
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.error.code, 'ADMIN_MODELS_UNAVAILABLE');
  assert.doesNotMatch(JSON.stringify(body), /secret SQL|DB_FAIL/);
});

test('非法查询返回 400，方法和 Origin 受到保护', async () => {
  for (const query of ['limit=51', 'type=audio', 'enabled=yes', 'q=', 'q=a&q=b', 'secret=x', 'cursor=bad!']) {
    let reads = 0;
    const route = createAdminModelsHandler({ environment: { NODE_ENV: 'development', APP_BASE_URL: 'http://localhost/', AUTH_ALLOW_LOCAL_HTTP: '1' }, database: {}, session: () => ({ me: async () => ({ user: actor }) }), projection: () => ({ read: async () => { reads++; } }), sink: { warn() {}, error() {} } });
    const invalid = await route(request(`http://localhost/api/admin/models?${query}`));
    assert.equal(invalid.status, 400, query);
    assert.equal(reads, 0);
  }
  const post = await handler() (new Request('http://localhost/api/admin/models', { method: 'POST', headers: { Origin: 'http://localhost' } }));
  assert.equal(post.status, 405);
  const foreign = await handler() (new Request('http://localhost/api/admin/models', { headers: { Origin: 'http://evil.test' } }));
  assert.equal(foreign.status, 403);
});
