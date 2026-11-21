'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAdminSummaryHandler } = require('../lib/server/adminSummaryHttp');

const environment = {
    APP_BASE_URL: 'http://127.0.0.1:3000',
    NODE_ENV: 'development',
    AUTH_ALLOW_LOCAL_HTTP: '1',
};
const adminId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function request(cookie = '') {
    return new Request('http://127.0.0.1:3000/api/admin/summary', {
        headers: {
            cookie,
            origin: environment.APP_BASE_URL,
            'x-request-id': 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        },
    });
}

function fakeSession(user) {
    return () => ({ me: async () => ({ user }) });
}

function fakeSink() {
    const records = [];
    return {
        records,
        error(message) { records.push(String(message)); },
        warn(message) { records.push(String(message)); },
    };
}

function databaseWithCounts(counts) {
    let index = 0;
    return {
        execute: async () => ({ rows: [{ count: counts[index++] }] }),
    };
}

async function bodyOf(response) {
    return response.json();
}

test('admin summary rejects unauthenticated requests before querying summary data', async () => {
    let queries = 0;
    const sink = fakeSink();
    const response = await createAdminSummaryHandler({
        environment,
        session: fakeSession(null),
        database: () => ({ execute: async () => { queries += 1; return { rows: [] }; } }),
        sink,
    })(request());

    assert.equal(response.status, 401);
    assert.equal((await bodyOf(response)).error.code, 'UNAUTHENTICATED');
    assert.equal(queries, 0);
    assert.match(response.headers.get('cache-control'), /no-store/);
    assert.equal(response.headers.get('vary'), 'Cookie');
});

test('admin summary rejects a normal user', async () => {
    let queries = 0;
    const response = await createAdminSummaryHandler({
        environment,
        session: fakeSession({ id: adminId, role: 'user', authLevel: 'mfa' }),
        database: () => ({ execute: async () => { queries += 1; return { rows: [] }; } }),
    })(request('pt_session=opaque'));

    assert.equal(response.status, 403);
    assert.equal((await bodyOf(response)).error.code, 'FORBIDDEN');
    assert.equal(queries, 0);
});

test('admin summary requires MFA for an administrator', async () => {
    let queries = 0;
    const response = await createAdminSummaryHandler({
        environment,
        session: fakeSession({ id: adminId, role: 'admin', authLevel: 'password' }),
        database: () => ({ execute: async () => { queries += 1; return { rows: [] }; } }),
    })(request('pt_session=opaque'));

    assert.equal(response.status, 403);
    assert.equal((await bodyOf(response)).error.code, 'MFA_REQUIRED');
    assert.equal(queries, 0);
});

test('MFA-authenticated administrator receives only the read-only summary', async () => {
    let queries = 0;
    const database = {
        execute: async () => {
            queries += 1;
            return [{ users: 7, activeTasks: 2, activeAssets: 11 }][0]
                ? { rows: [{ count: [7, 2, 11][queries - 1] }] }
                : { rows: [] };
        },
    };
    const response = await createAdminSummaryHandler({
        environment,
        session: fakeSession({ id: adminId, role: 'admin', authLevel: 'mfa' }),
        database: () => database,
    })(request('pt_session=opaque'));

    assert.equal(response.status, 200);
    assert.deepEqual(await bodyOf(response), {
        data: {
            actor: { id: adminId, role: 'admin' },
            counts: { users: 7, activeTasks: 2, activeAssets: 11 },
        },
        requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    });
    assert.equal(queries, 3);
});

test('admin summary hides database errors and does not expose internal details', async () => {
    const secret = 'postgres://admin:super-secret@127.0.0.1/hidden';
    const sink = fakeSink();
    const response = await createAdminSummaryHandler({
        environment,
        session: fakeSession({ id: adminId, role: 'admin', authLevel: 'mfa' }),
        database: () => ({ execute: async () => { throw new Error(secret); } }),
        sink,
    })(request('pt_session=opaque'));

    assert.equal(response.status, 503);
    const body = await bodyOf(response);
    assert.equal(body.error.code, 'ADMIN_SUMMARY_UNAVAILABLE');
    assert.doesNotMatch(JSON.stringify(body), /super-secret|postgres:\/\//);
    assert.doesNotMatch(sink.records.join('\n'), /super-secret|postgres:\/\//);
});
