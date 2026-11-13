const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { Client } = require('pg');
const { tokenDigest } = require('../../lib/server/registration');

const root = path.resolve(__dirname, '../..');
const base = process.env.PAINTTRACK_HTTP_BASE || 'http://127.0.0.1:3211';
const serverLog = path.join(root, process.env.PAINTTRACK_HTTP_SERVER_LOG || '.workbuddy/phase34-local-ui-server.log');
const report = { checks: [], status: 'running' };
const record = (name, details = {}) => report.checks.push({ name, status: 'passed', ...details });

async function run() {
    const database = fs.readFileSync(serverLog, 'utf8').match(/Retained development database: (pt_local_auth_[a-f0-9]{12})/)[1];
    const db = new Client({ host: '127.0.0.1', port: 5433, user: 'postgres', database });
    const password = `Synthetic-${randomBytes(12).toString('hex')}`;
    const nextPassword = `Reset-${randomBytes(12).toString('hex')}`;
    const email = `reset-ui-${randomBytes(6).toString('hex')}@example.test`;
    const secrets = [password, nextPassword, email];
    const post = (route, body, cookie, headers = {}) => fetch(base + route, { method: 'POST', headers: {
        origin: base, 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...headers,
    }, body: JSON.stringify(body) });
    const cookieFrom = (response) => {
        const value = response.headers.get('set-cookie');
        assert.ok(value);
        return { pair: value.split(';')[0], token: value.split('=')[1] };
    };
    await db.connect();
    try {
        for (const route of ['/reset-password', '/login', '/dev/mailbox']) {
            const response = await fetch(base + route);
            assert.equal(response.status, 200);
            assert.match(response.headers.get('cache-control'), /(?:^|,\s*)no-store(?:,|$)/);
            const html = await response.text();
            assert.ok(html.includes('重置密码') || route !== '/reset-password');
        }
        const loginHtml = await (await fetch(base + '/login')).text();
        assert.match(loginHtml, /reset-password/);
        record('重置密码页面和登录入口真实HTTP200且无缓存');

        assert.equal((await post('/api/auth/register', { email, password })).status, 202);
        const inboxAfterRegister = await (await fetch(base + '/api/dev/mailbox')).json();
        const verificationMessage = inboxAfterRegister.messages.find((message) => message.email === email && message.type === 'verification');
        assert.ok(verificationMessage);
        const verificationToken = verificationMessage.verificationPath.split('#')[1];
        secrets.push(verificationToken);
        assert.equal((await post('/api/auth/verify-email', { token: verificationToken })).status, 202);
        const login = await post('/api/auth/login', { email, password });
        assert.equal(login.status, 200);
        const session = cookieFrom(login);
        const user = (await db.query('SELECT id FROM users WHERE email=$1', [email])).rows[0];
        assert.ok(user);
        record('真实HTTP注册/验证/登录建立旧session');

        const unknown = await post('/api/auth/password-reset', { email: `unknown-${email}` });
        const known = await post('/api/auth/password-reset', { email: email.toUpperCase() });
        assert.equal(unknown.status, 202);
        assert.equal(known.status, 202);
        assert.deepEqual(await unknown.json(), await known.json());
        const inbox = await (await fetch(base + '/api/dev/mailbox')).json();
        const resetMessage = inbox.messages.find((message) => message.email === email && message.type === 'password-reset');
        assert.ok(resetMessage);
        const resetToken = resetMessage.path.split('#')[1];
        secrets.push(resetToken);
        assert.equal(resetMessage.path, `/reset-password#${resetToken}`);
        assert.equal((await db.query('SELECT token_hash FROM password_reset_tokens WHERE user_id=$1', [user.id])).rows[0].token_hash,
            tokenDigest(resetToken));
        record('真实HTTP未知/已知邮箱统一202并从测试收件器取得重置fragment');

        const resetPage = await fetch(base + resetMessage.path);
        assert.equal(resetPage.status, 200);
        assert.match(await resetPage.text(), /重置密码/);
        assert.equal((await post('/api/auth/password-reset/consume', { token: resetToken, password: nextPassword })).status, 202);
        const oldSession = await fetch(base + '/api/auth/me', { headers: { cookie: session.pair } });
        assert.equal(oldSession.status, 200);
        assert.deepEqual(await oldSession.json(), { user: null });
        const sessionState = await db.query(`SELECT count(*)::int AS total,
            count(*) FILTER (WHERE revoked_at IS NULL)::int AS active
            FROM auth_sessions WHERE user_id=$1`, [user.id]);
        assert.equal(sessionState.rows[0].total >= 1, true);
        assert.equal(sessionState.rows[0].active, 0);
        assert.equal((await post('/api/auth/login', { email, password })).status, 401);
        assert.equal((await post('/api/auth/login', { email, password: nextPassword })).status, 200);
        record('真实HTTP消费重置token后密码更新且旧session失效');

        for (const headers of [{ origin: 'http://evil.test' }, { 'sec-fetch-site': 'cross-site' }]) {
            assert.equal((await post('/api/auth/password-reset', { email }, undefined, headers)).status, 403);
        }
        assert.equal((await post('/api/auth/password-reset', { email: 'x'.repeat(4000) })).status, 413);
        record('重置HTTP跨Origin/跨站及超限body拒绝');

        const log = fs.readFileSync(serverLog, 'utf8');
        for (const secret of secrets) assert.equal(log.includes(secret), false);
        assert.doesNotMatch(log, /postgres(?:ql)?:\/\/|password_hash|token_hash/);
        const pageSource = fs.readFileSync(path.join(root, 'app/reset-password/page.js'), 'utf8');
        assert.match(pageSource, /window\.location\.hash/);
        assert.match(pageSource, /history\.replaceState/);
        record('服务日志不含密码/token，页面源码读取并清理fragment');
        report.status = 'passed';
    } finally { await db.end(); }
}

run().catch((error) => {
    report.status = 'failed';
    report.failure = { code: error.code === 'ERR_ASSERTION' ? 'ASSERTION_FAILED' : 'HTTP_CHECK_FAILED',
        line: error.stack?.match(/password-reset-ui-http\.cjs:(\d+):/)?.[1] };
    process.exitCode = 1;
}).finally(() => {
    const output = path.resolve(root, process.env.PAINTTRACK_HTTP_REPORT || '.workbuddy/phase34-local-ui-http.json');
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ status: report.status, checks: report.checks.length, log: output }));
});
