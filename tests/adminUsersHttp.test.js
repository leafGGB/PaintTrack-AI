'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAdminUsersHandlers, parseListQuery } = require('../lib/server/adminUsersHttp');

const environment = { APP_BASE_URL: 'http://127.0.0.1:3000', NODE_ENV: 'development', AUTH_ALLOW_LOCAL_HTTP: '1' };
const adminId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const userId = '11111111-1111-4111-8111-111111111111';
const requestId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function request(path, cookie = 'painttrack_session=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa') {
    return new Request(`http://127.0.0.1:3000${path}`, { headers: { cookie, origin: environment.APP_BASE_URL, 'x-request-id': requestId } });
}
function fakeSession(user) { return () => ({ me: async () => ({ user }) }); }
function body(response) { return response.json(); }
function adminDatabase(rows, ledgerRows = []) {
    let call = 0;
    return { execute: async () => {
        call += 1;
        if (call === 1) return { rows };
        if (call === 2) return { rows: [{ count: 2 }] };
        if (call === 3) return { rows: [{ user_id: userId, available_tenths: '14', reserved_tenths: '7', unit_version: 'credit_tenths_v1' }] };
        return { rows: ledgerRows };
    } };
}
const userRow = { id: userId, email: 'person@example.com', role: 'user', email_verified_at: null, created_at: '2026-11-18 10:00:00+08' };

test('admin user list requires administrator MFA before querying users', async () => {
    let queries = 0;
    const handlers = createAdminUsersHandlers({ environment, session: fakeSession({ id: adminId, role: 'admin', authLevel: 'password' }), database: () => ({ execute: async () => { queries += 1; return { rows: [] }; } }) });
    const response = await handlers.list(request('/api/admin/users'));
    assert.equal(response.status, 403);
    assert.equal((await body(response)).error.code, 'MFA_REQUIRED');
    assert.equal(queries, 0);
});

test('admin user list supports exact email and bounded cursor pagination without sensitive fields', async () => {
    const rows = [
        { ...userRow, cursor_time: '2026-11-18T02:00:00.123456Z' },
        { ...userRow, id: '22222222-2222-4222-8222-222222222222', email: 'other@example.com', cursor_time: '2026-11-18T02:00:00.123455Z' },
    ];
    const database = { execute: async () => ({ rows }) };
    const handlers = createAdminUsersHandlers({ environment, session: fakeSession({ id: adminId, role: 'admin', authLevel: 'mfa' }), database: () => database });
    const response = await handlers.list(request('/api/admin/users?email=person%40example.com&limit=1'));
    const result = await body(response);
    assert.equal(response.status, 200);
    assert.deepEqual(result.data.users, [{ id: userId, email: 'person@example.com', role: 'user', emailVerified: false, createdAt: '2026-11-18T02:00:00.000Z' }]);
    assert.equal(JSON.parse(Buffer.from(result.data.nextCursor, 'hex').toString()).createdAt, rows[0].cursor_time);
    assert.doesNotMatch(JSON.stringify(result), /password|token|secret|ip/i);
    assert.equal(parseListQuery(new URL('http://localhost/api/admin/users?email=PERSON%40EXAMPLE.COM')).email, 'person@example.com');
    assert.throws(() => parseListQuery(new URL('http://localhost/api/admin/users?limit=51')), error => error.code === 'INVALID_ADMIN_USER_QUERY');
    assert.throws(() => parseListQuery(new URL('http://localhost/api/admin/users?extra=x')), error => error.code === 'INVALID_ADMIN_USER_QUERY');
});

test('admin user detail returns identity, active sessions, balance and recent ledger only', async () => {
    const ledger = [{ id: '33333333-3333-4333-8333-333333333333', user_id: userId, task_id: null, kind: 'grant', credit_tenths: '14', source_type: 'manual', created_at: '2026-11-18 10:00:00+08' }];
    const handlers = createAdminUsersHandlers({ environment, session: fakeSession({ id: adminId, role: 'admin', authLevel: 'mfa' }), database: () => adminDatabase([userRow], ledger) });
    const response = await handlers.detail(request(`/api/admin/users/${userId}`), userId);
    const result = await body(response);
    assert.equal(response.status, 200);
    assert.deepEqual(result.data.user, { id: userId, email: 'person@example.com', role: 'user', emailVerified: false, createdAt: '2026-11-18T02:00:00.000Z' });
    assert.equal(result.data.activeSessionCount, 2);
    assert.deepEqual(result.data.credits, { availableTenths: '14', frozenTenths: '7', unitVersion: 'credit_tenths_v1' });
    assert.equal(result.data.recentLedger[0].kind, 'grant');
    assert.doesNotMatch(JSON.stringify(result), /password_hash|token_hash|secret_ciphertext|ip_address|storage_key/i);
});

test('admin user detail uses not found for invalid or unknown ids', async () => {
    let queries = 0;
    const handlers = createAdminUsersHandlers({ environment, session: fakeSession({ id: adminId, role: 'admin', authLevel: 'mfa' }), database: () => ({ execute: async () => { queries += 1; return { rows: [] }; } }) });
    const invalid = await handlers.detail(request('/api/admin/users/not-an-id'), 'not-an-id');
    assert.equal(invalid.status, 404);
    assert.equal((await body(invalid)).error.code, 'NOT_FOUND');
    assert.equal(queries, 0);
});

test('both admin user endpoints reject anonymous and ordinary users before data queries', async () => {
    for (const actor of [null, { id: userId, role: 'user', authLevel: 'mfa' }]) {
        for (const action of ['list', 'detail']) {
            let queries = 0;
            const handlers = createAdminUsersHandlers({ environment, session: fakeSession(actor),
                database: { execute: async () => { queries += 1; return { rows: [] }; } },
                sink: { warn() {}, error() {} } });
            const response = await handlers[action](request('/api/admin/users'), userId);
            assert.equal(response.status, actor ? 403 : 401);
            assert.equal((await body(response)).error.code, actor ? 'FORBIDDEN' : 'UNAUTHENTICATED');
            assert.equal(queries, 0);
        }
    }
});

test('user list cursor is filter-bound and applied as a parameterized keyset', async () => {
    const { PgDialect } = require('drizzle-orm/pg-core');
    const queries = [];
    const handlers = createAdminUsersHandlers({ environment,
        session: fakeSession({ id: adminId, role: 'admin', authLevel: 'mfa' }),
        database: { execute: async (query) => { queries.push(new PgDialect().sqlToQuery(query)); return { rows: [] }; } },
        sink: { warn() {}, error() {} } });
    const cursor = Buffer.from(JSON.stringify({ v: 1, email: null, createdAt: '2026-11-18T02:00:00.123456Z', id: userId })).toString('hex');
    assert.equal((await handlers.list(request(`/api/admin/users?cursor=${cursor}`))).status, 200);
    assert.match(queries[0].sql, /\(created_at,id\) < /);
    assert.ok(queries[0].params.includes('2026-11-18T02:00:00.123456Z'));
    assert.ok(queries[0].params.includes(userId));
    for (const query of [`email=person%40example.com&cursor=${cursor}`, 'limit=0', 'limit=1&limit=2', 'cursor=bad']) {
        const response = await handlers.list(request(`/api/admin/users?${query}`));
        assert.equal(response.status, 400);
    }
    assert.equal(queries.length, 1);
});

test('admin user detail rejects password-level admin and unknown user', async () => {
    for (const authLevel of ['password', 'mfa']) {
        let queries = 0;
        const handlers = createAdminUsersHandlers({ environment,
            session: fakeSession({ id: adminId, role: 'admin', authLevel }),
            database: { execute: async () => { queries += 1; return { rows: [] }; } },
            sink: { warn() {}, error() {} } });
        const response = await handlers.detail(request(`/api/admin/users/${userId}`), userId);
        assert.equal(response.status, authLevel === 'password' ? 403 : 404);
        assert.equal(queries, authLevel === 'password' ? 0 : 1);
    }
});

test('admin user APIs hide database errors', async () => {
    const secret = 'postgres://admin:super-secret@127.0.0.1/hidden';
    const records = [];
    const sink = { error(message) { records.push(String(message)); }, warn(message) { records.push(String(message)); } };
    const handlers = createAdminUsersHandlers({ environment, session: fakeSession({ id: adminId, role: 'admin', authLevel: 'mfa' }), database: () => ({ execute: async () => { throw new Error(secret); } }), sink });
    const response = await handlers.list(request('/api/admin/users'));
    assert.equal(response.status, 503);
    assert.equal((await body(response)).error.code, 'ADMIN_USERS_UNAVAILABLE');
    assert.doesNotMatch(records.join('\n'), /super-secret|postgres:\/\//);
});
