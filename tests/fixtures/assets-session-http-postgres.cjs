'use strict';

const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const { once } = require('node:events');
const { createServer } = require('node:http');
const { Readable } = require('node:stream');
const { drizzle } = require('drizzle-orm/node-postgres');
const { hashPassword } = require('../../lib/server/registration');
const { COOKIE_NAME } = require('../../lib/server/session');
const { createSessionHandler } = require('../../lib/server/sessionHttp');
const { createAssetsHandler } = require('../../lib/server/assetsHttp');

async function withAssetsHttp(database, run, mount) {
    const environment = { NODE_ENV: 'development', AUTH_ALLOW_LOCAL_HTTP: '1' };
    const sink = { info() {}, warn() {}, error() {} };
    const login = createSessionHandler('login', { database, environment, sink });
    const list = createAssetsHandler({ database, environment, sink });
    let origin;
    let extra;
    const server = createServer(async (incoming, outgoing) => {
        try {
            const url = new URL(origin + incoming.url);
            const handler = url.pathname === '/api/auth/login' ? login : url.pathname === '/api/assets' ? list : extra;
            if (!handler) { outgoing.writeHead(404).end(); return; }
            const request = new Request(url, {
                method: incoming.method, headers: incoming.headers,
                ...(['GET', 'HEAD'].includes(incoming.method) ? {} : { body: Readable.toWeb(incoming), duplex: 'half' }),
            });
            const response = await handler(request);
            outgoing.writeHead(response.status, Object.fromEntries(response.headers));
            outgoing.end(Buffer.from(await response.arrayBuffer()));
        } catch {
            if (!outgoing.headersSent) outgoing.writeHead(500).end();
            else outgoing.destroy();
        }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    origin = `http://127.0.0.1:${server.address().port}`;
    environment.APP_BASE_URL = origin;
    try {
        if (mount) extra = await mount({ database, environment, sink });
        return await run((path, options) => fetch(origin + path, {
            ...options, headers: { origin, ...options?.headers }, redirect: 'error', signal: AbortSignal.timeout(10000),
        }));
    } finally {
        await new Promise((resolve, reject) => {
            server.close((error) => error ? reject(error) : resolve());
            server.closeAllConnections();
        });
    }
}

async function checkAssetsSessions(admin, webPool, { database, runtimeRole }, record) {
    assert.ok(/^pt_acceptance_[a-z0-9]+_[a-f0-9]{6}$/.test(database), 'fresh acceptance database required');
    assert.equal(runtimeRole, database.replace(/^pt_acceptance_/, 'pt_runtime_'));
    assert.equal((await admin.query('SELECT current_database() AS db')).rows[0].db, database);
    assert.deepEqual((await webPool.query('SELECT current_database() AS db, current_user AS role')).rows[0], { db: database, role: runtimeRole });
    const password = `Synthetic-${randomBytes(18).toString('hex')}`;
    const hash = await hashPassword(password);
    const [a, b] = ['a', 'b'].map((label) => ({ id: randomUUID(), email: `assets-http-${label}-${randomUUID()}@example.test` }));
    for (const account of [a, b]) {
        await admin.query("INSERT INTO users (id,email,password_hash,email_verified_at,role) VALUES ($1,$2,$3,clock_timestamp(),'user')", [account.id, account.email, hash]);
    }
    const [aNew, aOld, bNew, bOld] = Array.from({ length: 4 }, () => randomUUID());
    await admin.query(`INSERT INTO assets (id,owner_id,media_type,mime_type,size_bytes,storage_key,status,created_at)
        SELECT id, owner_id, 'image', 'image/png', 42, 'fixture-assets-http/' || id::text, 'ready',
               CURRENT_TIMESTAMP - age_seconds * interval '1 second'
        FROM (VALUES ($1::uuid,$5::uuid,1), ($2::uuid,$5::uuid,2), ($3::uuid,$6::uuid,0), ($4::uuid,$6::uuid,3))
             AS seed(id, owner_id, age_seconds)`, [aNew, aOld, bNew, bOld, a.id, b.id]);
    await withAssetsHttp(drizzle(webPool), async (request) => {
        const path = '/api/assets?media=all&limit=1';
        function assertPrivate(response) {
            assert.equal(response.headers.get('cache-control'), 'no-store');
            assert.ok(response.headers.get('vary')?.toLowerCase().split(/,\s*/).includes('cookie'), 'asset response must vary by Cookie');
        }
        const anonymous = await request(path);
        assert.equal(anonymous.status, 401, 'anonymous asset status');
        assertPrivate(anonymous);
        const denial = await anonymous.json();
        assert.ok(denial.error?.code === 'UNAUTHENTICATED' && !('items' in denial) && !('accountId' in denial), 'anonymous response must not project assets');
        record('资产 HTTP：匿名请求返回 401 且不返回资产', 'passed');
        async function signIn(account, label) {
            const response = await request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: account.email, password }) });
            assert.equal(response.status, 200, `account ${label} login status`);
            const body = await response.json();
            assert.ok(body.user?.id === account.id && body.user?.role === 'user', `account ${label} login identity`);
            const cookie = response.headers.get('set-cookie')?.split(';', 1)[0];
            assert.ok(cookie?.startsWith(`${COOKIE_NAME}=`) && /^[A-Za-z0-9_-]{43}$/.test(cookie.slice(COOKIE_NAME.length + 1)), `account ${label} session cookie missing or malformed`);
            return cookie;
        }
        const cookieA = await signIn(a, 'A');
        const cookieB = await signIn(b, 'B');
        assert.ok(cookieA !== cookieB, 'each login must issue a distinct session');
        async function page(cookie, account, expectedId, label, cursor) {
            const response = await request(cursor ? `${path}&cursor=${encodeURIComponent(cursor)}` : path, { headers: { cookie } });
            assert.equal(response.status, 200, `${label}: asset status`);
            assertPrivate(response);
            const body = await response.json();
            assert.ok(body.accountId === account.id, `${label}: wrong accountId`);
            assert.ok(Array.isArray(body.items) && body.items.length === 1 && body.items[0].id === expectedId, `${label}: wrong asset membership`);
            return body.nextCursor;
        }
        const cursorA = await page(cookieA, a, aNew, 'A first page');
        const cursorB = await page(cookieB, b, bNew, 'B first page');
        assert.ok(typeof cursorA === 'string' && cursorA && typeof cursorB === 'string' && cursorB, 'both accounts need a second page');
        assert.ok(await page(cookieA, a, aOld, 'A second page', cursorA) === null, 'A pagination must end');
        assert.ok(await page(cookieB, b, bOld, 'B second page', cursorB) === null, 'B pagination must end');
        record('资产 HTTP：两个真实登录会话仅返回本人资产及本人分页', 'passed');
        // A 的页边界之后同时存在 A 与 B 的资产，不带归属条件会先返回 A 的旧资产。
        assert.ok(await page(cookieB, b, bOld, 'B using A cursor', cursorA) === null, 'foreign cursor must not extend B pagination');
        record('资产 HTTP：B 使用 A 的游标仍仅返回 B 的资产', 'passed');
    });
}

module.exports = { checkAssetsSessions, withAssetsHttp };
