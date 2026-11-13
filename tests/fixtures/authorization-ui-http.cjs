const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, randomUUID } = require('node:crypto');
const { Client } = require('pg');
const { tokenDigest } = require('../../lib/server/registration');
const root = path.resolve(__dirname, '../..');
const base = process.env.PAINTTRACK_HTTP_BASE || 'http://127.0.0.1:3213';
const report = { status: 'running', checks: [] };
const record = (name, extra = {}) => report.checks.push({ name, status: 'passed', ...extra });
async function run() {
    const serverLog = path.join(root, process.env.PAINTTRACK_HTTP_SERVER_LOG || '.workbuddy/phase33-server.log');
    const log = fs.readFileSync(serverLog, 'utf8');
    const database = log.match(/Retained development database: (pt_local_auth_[a-f0-9]{12})/)[1];
    const adminEmail = log.match(/DEVELOPMENT_ONLY_ADMIN_FIXTURE (admin-[a-f0-9]{12}@example.test)/)[1];
    assert.ok(!['pt_local_auth_5fabde425ae3', 'pt_local_auth_e3bf266e5168', 'pt_local_auth_fd43c6e2186a'].includes(database));
    const runtime = database.replace('pt_local_auth_', 'pt_local_runtime_');
    report.database = database;
    const db = new Client({ host: '127.0.0.1', port: 5433, user: 'postgres', database });
    const secrets = [];
    const http = (route, cookie, method = 'GET', body, extra = {}) => fetch(base + route, { method, headers: {
        ...(cookie ? { cookie } : {}), ...(method !== 'GET' ? { origin: base, 'content-type': 'application/json' } : {}), ...extra,
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const expect = async (response, status, code) => {
        assert.equal(response.status, status);
        assert.match(response.headers.get('cache-control'), /no-store/);
        const body = await response.json();
        if (code) { assert.equal(body.error.code, code); assert.equal(body.error.message, 'Request failed'); }
        return body;
    };
    await db.connect();
    let denied = false;
    try {
        for (const route of ['/dev/authorization', '/login', '/register', '/verify-email', '/dev/mailbox']) assert.equal((await http(route)).status, 200);
        const page = await (await http('/dev/authorization')).text();
        assert.ok(page.includes(adminEmail));
        assert.match((await http('/login')).headers.get('content-security-policy'), /connect-src 'self';/);
        for (const route of ['/agents/create', '/agents/edit/synthetic', '/agents/synthetic', '/agents/synthetic/conversation']) {
            const response = await http(route, 'muapi_key=synthetic-not-a-real-key');
            assert.equal(response.status, 200);
            assert.ok((await response.text()).includes('UNAUTHENTICATED'));
        }
        record('本机验收页明确合成邮箱，Web CSP仅同源，4个Agent SSR入口无会话关闭');
        const users = [];
        for (let i = 0; i < 3; i++) {
            const email = i === 2 ? adminEmail : `role-http-${randomBytes(6).toString('hex')}@example.test`;
            const password = `Synthetic-${randomBytes(12).toString('hex')}`;
            secrets.push(password);
            assert.equal((await http('/api/auth/register', null, 'POST', { email, password })).status, 202);
            assert.equal((await http('/api/auth/login', null, 'POST', { email, password })).status, 401);
            const inbox = await (await http('/api/dev/mailbox')).json();
            const token = inbox.messages.find((m) => m.email === email).verificationPath.split('#')[1];
            secrets.push(token);
            assert.equal((await http('/api/auth/verify-email', null, 'POST', { token })).status, 202);
            const login = await http('/api/auth/login', null, 'POST', { email, password });
            assert.equal(login.status, 200);
            const cookie = login.headers.get('set-cookie').split(';')[0];
            secrets.push(cookie, cookie.split('=')[1]);
            const user = (await login.json()).user;
            users.push({ email, password, cookie, id: user.id });
        }
        // 等待launcher的独立后端准备；不从客户端提交角色，也不在fixture中替代此准备路径。
        const deadline = Date.now() + 10000;
        while ((await db.query('SELECT role FROM users WHERE id=$1', [users[2].id])).rows[0].role !== 'admin') {
            if (Date.now() > deadline) throw new Error('开发fixture准备未完成');
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        assert.equal((await expect(await http('/api/auth/me', users[0].cookie), 200)).user.role, 'user');
        assert.equal((await expect(await http('/api/auth/me', users[2].cookie), 200)).user.role, 'admin');
        record('三个用户均真实注册/未验证拒绝/邮件验证/登录，launcher仅指定合成账户admin');
        await expect(await http('/api/admin/summary'), 401, 'UNAUTHENTICATED');
        await expect(await http('/api/admin/summary', users[0].cookie, 'GET', undefined, { 'x-role': 'admin', role: 'admin', 'x-user-id': users[2].id }), 403, 'FORBIDDEN');
        await expect(await http('/api/admin/summary', users[2].cookie), 200);
        for (const route of ['/api/auth/register', '/api/auth/login']) {
            assert.equal((await http(route, null, 'POST', { email: users[0].email, password: users[0].password, role: 'admin' })).status, 400);
        }
        record('真实HTTP匿名401/伪造role header无效/role body400/普通403/admin200');
        const asset = (await db.query("INSERT INTO assets(owner_id,media_type,metadata) VALUES($1,'image',$2) RETURNING id", [users[0].id, { private: 'must-not-return' }])).rows[0].id;
        const resource = `/api/assets/${asset}`;
        await expect(await http(resource), 401, 'UNAUTHENTICATED');
        const own = (await expect(await http(resource, users[0].cookie), 200)).asset;
        assert.equal(own.id, asset);
        assert.deepEqual(Object.keys(own), ['id', 'media_type', 'mime_type', 'size_bytes', 'status', 'created_at']);
        await expect(await http(resource, users[1].cookie), 404, 'NOT_FOUND');
        await expect(await http(resource, users[2].cookie), 404, 'NOT_FOUND');
        await expect(await http(`/api/assets/${randomUUID()}`, users[0].cookie), 404, 'NOT_FOUND');
        await expect(await http('/api/assets/invalid', users[0].cookie), 404, 'NOT_FOUND');
        record('真实资产owner200/第二用户与管理员404/不存在及非法ID404/安全字段白名单');
        await db.query("UPDATE users SET role='admin' WHERE id=$1", [users[0].id]);
        await expect(await http('/api/admin/summary', users[0].cookie), 200);
        await db.query("UPDATE users SET role='user' WHERE id=$1", [users[0].id]);
        await expect(await http('/api/admin/summary', users[0].cookie), 403, 'FORBIDDEN');
        await db.query("UPDATE users SET role='user' WHERE id=$1", [users[2].id]);
        await expect(await http('/api/admin/summary', users[2].cookie), 403, 'FORBIDDEN');
        await db.query("UPDATE users SET role='admin' WHERE id=$1", [users[2].id]);
        record('同一Cookie角色升降即时生效，launcher完成后不持续重授admin');
        const blockedRoutes = ['/api/agents', '/api/agents/by-slug/synthetic', '/api/api/v1/synthetic', '/api/app/get_upload_file',
            '/api/workflow', '/api/workflow/synthetic', '/api/upload-binary', '/api/v1', '/api/v1/synthetic',
            '/api/v1/creative-agent/synthetic', '/api/v1/get_upload_url', '/api/v1/upload-binary'];
        for (const route of blockedRoutes) {
            await expect(await http(route), 401, 'UNAUTHENTICATED');
            for (const user of [users[0], users[2]]) {
                for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
                    await expect(await http(route, user.cookie, method, method === 'GET' ? undefined : { role: 'admin', url: 'http://127.0.0.1:9' }, { 'x-api-key': 'synthetic-not-a-key' }), 503, 'NOT_IMPLEMENTED');
                }
            }
        }
        record('12个代理路径含裸根/子路径，2角色×6方法全部503，匿名401，无Provider入口开放', { authenticatedRequests: blockedRoutes.length * 12 });
        for (const route of ['/api/agents', '/api/upload-binary', '/api/v1/synthetic']) {
            assert.equal((await fetch(base + route, { method: 'POST', headers: { cookie: users[0].cookie } })).status, 403);
            assert.equal((await http(route, users[0].cookie, 'POST', {}, { origin: 'http://evil.test' })).status, 403);
            assert.equal((await http(route, users[0].cookie, 'POST', {}, { 'sec-fetch-site': 'cross-site' })).status, 403);
        }
        record('代理敏感操作缺失Origin/跨源/跨站拒绝');
        await db.query('UPDATE users SET email_verified_at=NULL WHERE id=$1', [users[1].id]);
        await expect(await http(resource, users[1].cookie), 401, 'UNAUTHENTICATED');
        assert.equal((await http('/api/auth/logout', users[0].cookie, 'POST')).status, 204);
        await expect(await http(resource, users[0].cookie), 401, 'UNAUTHENTICATED');
        await db.query("UPDATE auth_sessions SET created_at=clock_timestamp()-interval '10 hours',expires_at=clock_timestamp()-interval '1 minute' WHERE token_hash=$1", [tokenDigest(users[2].cookie.split('=')[1])]);
        await expect(await http('/api/admin/summary', users[2].cookie), 401, 'UNAUTHENTICATED');
        await expect(await http(resource, `painttrack_session=${randomBytes(32).toString('base64url')}; role=admin`), 401, 'UNAUTHENTICATED');
        record('未验证已有会话/撤销/过期/伪造Cookie均401');
        await db.query('UPDATE users SET email_verified_at=clock_timestamp() WHERE id=$1', [users[1].id]);
        // 真实PG拒绝运行身份SELECT模拟DB查询失败，始终在finally恢复本次新库权限。
        await db.query(`REVOKE SELECT ON users FROM "${runtime}"`); denied = true;
        for (const route of ['/api/auth/me', '/api/admin/summary', resource, '/api/v1/synthetic']) {
            await expect(await http(route, users[1].cookie), 503, 'AUTH_UNAVAILABLE');
        }
        await db.query(`GRANT SELECT ON users TO "${runtime}"`); denied = false;
        await expect(await http(resource, users[1].cookie), 404, 'NOT_FOUND');
        record('真实PG权限故障使me/admin/owner/代理均503，恢复后仍按归属拒绝');
        const runtimeDb = new Client({ host: '127.0.0.1', port: 5433, user: runtime, database });
        await runtimeDb.connect();
        try {
            for (const text of ["UPDATE users SET role='admin'", "INSERT INTO users(email,password_hash,role) VALUES('injected@example.test','bad','admin')",
                "INSERT INTO users(email,password_hash,role) VALUES('injected@example.test','bad','user')"]) await assert.rejects(runtimeDb.query(text), (e) => e.code === '42501');
        } finally { await runtimeDb.end(); }
        record('实际应用身份直接SQL更新role/插入admin或显式user role均42501');
        const actualLog = fs.readFileSync(serverLog, 'utf8');
        for (const secret of secrets) assert.ok(!actualLog.includes(secret));
        assert.doesNotMatch(actualLog, /postgres(?:ql)?:\/\/|SELECT .*password_hash|INSERT INTO auth_sessions/);
        record('真实服务日志不包含密码Cookie会话验证token或SQL连接');
        assert.equal((await fetch('http://127.0.0.1:3212/register')).status, 200);
        report.status = 'passed';
    } finally {
        if (denied) await db.query(`GRANT SELECT ON users TO "${runtime}"`);
        await db.end();
    }
}
run().catch((error) => {
    report.status = 'failed';
    report.failure = { code: error.code === 'ERR_ASSERTION' ? 'ASSERTION_FAILED' : 'HTTP_CHECK_FAILED',
        line: error.stack?.match(/authorization-ui-http\.cjs:(\d+):/)?.[1],
        ...(error.code === 'ERR_ASSERTION' && typeof error.actual === 'number' ? { actual: error.actual, expected: error.expected } : {}) };
    process.exitCode = 1;
}).finally(() => {
    const log = path.join(root, process.env.PAINTTRACK_HTTP_REPORT || '.workbuddy/phase33-http-report.json');
    fs.writeFileSync(log, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ status: report.status, checks: report.checks.length, log }));
});
