const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { Client } = require('pg');
const { tokenDigest } = require('../../lib/server/registration');
const root = path.resolve(__dirname, '../..');
const base = process.env.PAINTTRACK_HTTP_BASE || 'http://127.0.0.1:3212';
const report = { checks: [], status: 'running' };
const record = (name, details = {}) => report.checks.push({ name, status: 'passed', ...details });
async function run() {
    const serverLog = path.join(root, process.env.PAINTTRACK_HTTP_SERVER_LOG || '.workbuddy/phase32-server.log');
    const database = fs.readFileSync(serverLog, 'utf8').match(/Retained development database: (pt_local_auth_[a-f0-9]{12})/)[1];
    assert.notEqual(database, 'pt_local_auth_fd43c6e2186a');
    report.database = database;
    const db = new Client({ host: '127.0.0.1', port: 5433, user: 'postgres', database });
    const secrets = [];
    const password = `Synthetic-${randomBytes(12).toString('hex')}`;
    const email = `http-${randomBytes(6).toString('hex')}@example.test`;
    secrets.push(password, email);
    const post = (route, body, cookie, headers = {}) => fetch(base + route, { method: 'POST', headers: {
        origin: base, 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...headers,
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const me = (cookie) => fetch(base + '/api/auth/me', { headers: cookie ? { cookie } : {} });
    const cookieFrom = (response) => {
        const cookie = response.headers.get('set-cookie');
        assert.ok(cookie);
        assert.match(cookie, /Path=\/; HttpOnly; SameSite=Strict; Max-Age=28800; Expires=/);
        assert.doesNotMatch(cookie, /Secure|Domain=/);
        const pair = cookie.split(';')[0];
        const token = pair.split('=')[1];
        assert.match(token, /^[A-Za-z0-9_-]{43}$/);
        secrets.push(token, pair);
        return { pair, token };
    };
    await db.connect();
    try {
        const pg = (await db.query("SELECT current_setting('server_version_num')::int version")).rows[0];
        report.postgresVersion = pg.version;
        const role = (await db.query("SELECT rolsuper,rolcreatedb,rolcreaterole,rolbypassrls FROM pg_roles WHERE rolname=$1", [database.replace('pt_local_auth_', 'pt_local_runtime_')])).rows[0];
        assert.ok(Object.values(role).every((v) => !v));
        record('新随机库PG16与非管理员应用角色确认');
        for (const route of ['/login', '/register', '/verify-email', '/dev/mailbox']) {
            const response = await fetch(base + route);
            assert.equal(response.status, 200);
            assert.match(response.headers.get('cache-control'), /(?:^|,\s*)no-store(?:,|$)/);
            assert.ok((await response.text()).includes('PAINTTRACK') || route === '/dev/mailbox');
        }
        record('Next登录/注册/验证/收件器页面真实HTTP200，无缓存');
        assert.deepEqual(await (await me()).json(), { user: null });
        assert.equal((await post('/api/auth/register', { email, password })).status, 202);
        const unverified = await post('/api/auth/login', { email, password });
        assert.equal(unverified.status, 401);
        const failure = await unverified.json();
        const inbox = await (await fetch(base + '/api/dev/mailbox')).json();
        const token = inbox.messages.find((v) => v.email === email).verificationPath.split('#')[1];
        secrets.push(token);
        assert.equal((await post('/api/auth/verify-email', { token })).status, 202);
        const login = await post('/api/auth/login', { email, password });
        assert.equal(login.status, 200);
        const first = cookieFrom(login);
        const body = await login.json();
        assert.deepEqual(Object.keys(body), ['user']);
        assert.deepEqual(Object.keys(body.user), ['id', 'role']);
        assert.equal(body.user.role, 'user');
        const user = (await db.query('SELECT id,email,created_at,email_verified_at FROM users WHERE email=$1', [email])).rows[0];
        assert.ok(user.email_verified_at);
        assert.equal(body.user.id, user.id);
        const row = async (value) => (await db.query('SELECT * FROM auth_sessions WHERE token_hash=$1', [tokenDigest(value)])).rows[0];
        const initial = await row(first.token);
        assert.equal(initial.user_id, user.id);
        assert.ok(initial.expires_at - initial.created_at >= 28800000 && initial.expires_at - initial.created_at < 28801000);
        const current = await me(first.pair);
        assert.match(current.headers.get('cache-control'), /(?:^|,\s*)no-store(?:,|$)/);
        assert.equal(current.headers.get('set-cookie'), null);
        const currentBody = await current.json();
        assert.deepEqual(currentBody, { user: {
            id: user.id, email, role: 'user', emailVerified: true, createdAt: new Date(user.created_at).toISOString(),
        } });
        assert.deepEqual(await row(first.token), initial);
        record('HTTP注册→邮箱验证→登录→Cookie属性→me及PG固定8小时不续期');
        for (const input of [{ email, password: `${password}-wrong` }, { email: `unknown-${email}`, password }]) {
            const response = await post('/api/auth/login', input);
            assert.equal(response.status, 401);
            assert.equal(response.headers.get('set-cookie'), null);
            const rejected = await response.json();
            delete rejected.error.requestId;
            const expected = structuredClone(failure); delete expected.error.requestId;
            assert.deepEqual(rejected, expected);
            for (const secret of secrets) assert.ok(!JSON.stringify(rejected).includes(secret));
        }
        record('未验证/错密码/未知邮箱HTTP稳定401同错误正文且不签Cookie');
        const replacement = await post('/api/auth/login', { email, password }, first.pair);
        assert.equal(replacement.status, 200);
        const second = cookieFrom(replacement);
        assert.notEqual(second.token, first.token);
        assert.ok((await row(first.token)).revoked_at);
        assert.deepEqual(await (await me(first.pair)).json(), { user: null });
        const out = await post('/api/auth/logout', undefined, second.pair);
        assert.equal(out.status, 204);
        assert.match(out.headers.get('set-cookie'), /Path=\/; HttpOnly; SameSite=Strict; Max-Age=0; Expires=Thu, 01 Jan 1970/);
        assert.ok((await row(second.token)).revoked_at);
        assert.deepEqual(await (await me(second.pair)).json(), { user: null });
        assert.equal((await post('/api/auth/logout', undefined, second.pair)).status, 204);
        record('HTTP防固定新token/旧session撤销→登出清Cookie→旧Cookie重放无效/重复登出');
        const thirdResponse = await post('/api/auth/login', { email, password });
        const third = cookieFrom(thirdResponse);
        await db.query("UPDATE auth_sessions SET created_at=clock_timestamp()-interval '10 hours',expires_at=clock_timestamp()-interval '1 minute' WHERE token_hash=$1", [tokenDigest(third.token)]);
        assert.deepEqual(await (await me(third.pair)).json(), { user: null });
        const fourth = cookieFrom(await post('/api/auth/login', { email, password }));
        const concurrent = await Promise.all(Array.from({ length: 6 }, () => post('/api/auth/logout', undefined, fourth.pair)));
        assert.ok(concurrent.every((v) => v.status === 204));
        assert.deepEqual(await (await me(fourth.pair)).json(), { user: null });
        const fake = randomBytes(32).toString('base64url');
        assert.deepEqual(await (await me(`painttrack_session=${fake}`)).json(), { user: null });
        assert.deepEqual(await (await me('painttrack_session=invalid')).json(), { user: null });
        record('HTTP过期/伪造/格式错误/6并发撤销与重放拒绝');
        for (const input of [{ email, password, userId: user.id }, { email: 'x'.repeat(321), password }, { email, password: 'x'.repeat(129) }, { email, password: 'short' }]) {
            assert.equal((await post('/api/auth/login', input)).status, 400);
        }
        assert.equal((await post('/api/auth/login', { email: 'x'.repeat(3000), password })).status, 413);
        for (const route of ['login', 'logout', 'register', 'verify-email']) {
            assert.equal((await post(`/api/auth/${route}`, {}, first.pair, { origin: 'http://evil.test' })).status, 403);
            assert.equal((await post(`/api/auth/${route}`, {}, first.pair, { 'sec-fetch-site': 'cross-site' })).status, 403);
            assert.equal((await fetch(`${base}/api/auth/${route}`, { method: 'POST' })).status, route === 'register' ? 404 : 403);
        }
        assert.equal((await post('/api/auth/login', {}, undefined, { origin: 'http://evil.test', 'x-forwarded-host': '127.0.0.1:3212', 'x-forwarded-proto': 'http' })).status, 403);
        assert.equal((await fetch(`${base}/api/auth/me`, { headers: { origin: 'http://evil.test' } })).status, 403);
        record('HTTP输入限长/额外字段/所有敏感POST缺失Origin及跨站/转发头伪造拒绝');
        await db.query("UPDATE auth_rate_limits SET window_start=clock_timestamp()-interval '2 minutes' WHERE bucket='login'");
        const rates = await Promise.all(Array.from({ length: 35 }, () => post('/api/auth/login', { email: `unknown-${email}`, password })));
        const statuses = rates.reduce((all, response) => { all[response.status] = (all[response.status] || 0) + 1; return all; }, {});
        assert.equal(statuses[429], 5);
        assert.equal((statuses[401] || 0) + (statuses[503] || 0), 30);
        assert.ok(rates.every((v) => [401, 429, 503].includes(v.status)));
        assert.equal((await db.query("SELECT hits FROM auth_rate_limits WHERE bucket='login'")).rows[0].hits, 30);
        for (const response of rates) {
            const text = await response.text();
            for (const secret of secrets) assert.ok(!text.includes(secret));
        }
        record('HTTP35并发共享限流5次429，KDF有界超载拒绝', { statuses });
        await db.query("UPDATE auth_rate_limits SET window_start=clock_timestamp()-interval '2 minutes' WHERE bucket='login'");
        const persisted = JSON.stringify((await db.query('SELECT row_to_json(s) FROM auth_sessions s')).rows);
        const columns = (await db.query("SELECT column_name FROM information_schema.columns WHERE table_name='auth_sessions'")).rows.map((v) => v.column_name);
        assert.deepEqual(columns.sort(), ['id', 'user_id', 'token_hash', 'expires_at', 'revoked_at', 'created_at'].sort());
        const log = fs.readFileSync(serverLog, 'utf8');
        for (const secret of secrets) { assert.ok(!persisted.includes(secret)); assert.ok(!log.includes(secret)); }
        assert.doesNotMatch(log, /postgres(?:ql)?:\/\/|SELECT .*password_hash|INSERT INTO auth_sessions/);
        record('PG会话列仅hash无token/email/password，真实HTTP错误与服务日志不含秘密/SQL');
        const old = await fetch('http://127.0.0.1:3211/register');
        assert.equal(old.status, 200);
        record('已验收3211服务仍可只读访问，旧库未接入测试');
        report.status = 'passed';
    } finally { await db.end(); }
}
run().catch((error) => {
    report.status = 'failed';
    report.failure = { code: error.code === 'ERR_ASSERTION' ? 'ASSERTION_FAILED' : 'HTTP_CHECK_FAILED',
        line: error.stack?.match(/session-ui-http\.cjs:(\d+):/)?.[1] };
    process.exitCode = 1;
}).finally(() => {
    const log = path.join(root, process.env.PAINTTRACK_HTTP_REPORT || '.workbuddy/phase32-http-report.json');
    fs.writeFileSync(log, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ status: report.status, checks: report.checks.length, log }));
});
