const test = require('node:test');
const assert = require('node:assert/strict');
const { createAssetsHandler } = require('../lib/server/assetsHttp');
const { RegistrationError } = require('../lib/server/registration');
const sink = { log() {}, warn() {}, error() {}, info() {} };
const environment = { APP_BASE_URL: 'https://example.test' };
test('asset collection rejects unsupported method before database access and never caches', async () => {
  let reads = 0;
  const handler = createAssetsHandler({ environment, database: () => { reads++; throw new Error('must not load'); }, sink });
  const result = await handler(new Request('http://localhost/api/assets?media=image', { method: 'POST' }));
  assert.equal(result.status, 405); assert.equal(reads, 0);
  assert.equal(result.headers.get('Cache-Control'), 'no-store'); assert.equal(result.headers.get('Vary'), 'Cookie');
});
test('asset collection sanitizes unexpected database failure', async () => {
  const handler = createAssetsHandler({ environment, database: () => { throw new Error('private database detail'); }, sink });
  const result = await handler(new Request('http://localhost/api/assets?media=image'));
  assert.equal(result.status, 503);
  const body = await result.text();
  assert.match(body, /ASSETS_QUERY_UNAVAILABLE/); assert.doesNotMatch(body, /private database detail/);
});
test('asset collection preserves known auth failure without querying collection', async () => {
  let queries = 0;
  const handler = createAssetsHandler({ environment, database: () => { throw new RegistrationError('UNAUTHENTICATED', 401); }, queryFactory: () => { queries++; }, sink });
  const result = await handler(new Request('http://localhost/api/assets?media=video'));
  assert.equal(result.status, 401); assert.equal(queries, 0);
});
