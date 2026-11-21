'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAccountCreditsHandler } = require('../lib/server/accountCreditsHttp');

const userId = '11111111-1111-4111-8111-111111111111';
const otherId = '22222222-2222-4222-8222-222222222222';
const environment = { APP_BASE_URL: 'http://127.0.0.1:3000', NODE_ENV: 'development', AUTH_ALLOW_LOCAL_HTTP: '1' };
function request(cookie = '') { return new Request('http://127.0.0.1:3000/api/account/credits', { headers: { cookie, origin: 'http://127.0.0.1:3000', 'x-request-id': 'req-account-credit-1' } }); }
function fakeSession(user) { return () => ({ me: async () => ({ user }) }); }
function fakeDatabase() { return { execute: async () => ({ rows: [] }) }; }

test('credits API rejects unauthenticated requests without querying credits', async () => {
    let queries = 0;
    const response = await createAccountCreditsHandler({ environment, database: () => ({ execute: async () => { queries += 1; return { rows: [] }; } }), session: fakeSession(null) })(request());
    assert.equal(response.status, 401);
    const body = await response.json();
    assert.equal(body.error.code, 'UNAUTHENTICATED');
    assert.match(body.error.requestId, /^[0-9a-f-]{36}$/);
    assert.equal(queries, 0);
});

test('credits API binds the query to the current session user', async () => {
    let queryCount = 0;
    const database = { execute: async () => { queryCount += 1; return { rows: [] }; } };
    const response = await createAccountCreditsHandler({ environment, database: () => database, session: fakeSession({ id: userId }) })(request('pt_session=opaque'));
    assert.equal(response.status, 200);
    assert.equal(queryCount, 2);
    assert.deepEqual((await response.json()).credits, { availableTenths: '0', reservedTenths: '0', totalTenths: '0', unitVersion: 'credit_tenths_v1', events: [], nextCursor: null });
});

test('credits API returns generic failure without leaking database details', async () => {
    const secret = 'postgres://admin:super-secret@127.0.0.1/hidden';
    const sink = { error(message) { assert.doesNotMatch(String(message), /super-secret|postgres:\/\//); }, warn() {} };
    const response = await createAccountCreditsHandler({ environment, database: () => ({ execute: async () => { throw new Error(secret); } }), session: fakeSession({ id: userId }), sink })(request('pt_session=opaque'));
    assert.equal(response.status, 503);
    assert.deepEqual((await response.json()).error.code, 'CREDIT_UNAVAILABLE');
});

test('credits API does not accept a client-selected user id', async () => {
    const response = await createAccountCreditsHandler({ environment, database: () => fakeDatabase(), session: fakeSession({ id: userId }) })(new Request(`http://127.0.0.1:3000/api/account/credits?userId=${otherId}`, { headers: { origin: environment.APP_BASE_URL } }));
    assert.equal(response.status, 200);
});

test('credits API rejects invalid pagination query before database access', async () => {
    let queries = 0;
    const response = await createAccountCreditsHandler({ environment, database: () => ({ execute: async () => { queries += 1; return { rows: [] }; } }), session: fakeSession({ id: userId }) })(new Request('http://127.0.0.1:3000/api/account/credits?limit=0', { headers: { origin: environment.APP_BASE_URL } }));
    assert.equal(response.status, 400);
    assert.equal(queries, 0);
    assert.equal((await response.json()).error.code, 'INVALID_CREDIT_QUERY');
});
