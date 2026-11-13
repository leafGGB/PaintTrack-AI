const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { Client } = require('pg');
const base = 'http://127.0.0.1:3211';
const report = { checks: [], status: 'running' };
const check = (name) => report.checks.push({ name, status: 'passed' });
async function run() {
    for (const route of ['/register', '/verify-email', '/dev/mailbox']) {
        const response = await fetch(base + route);
        assert.equal(response.status, 200);
        assert.ok((await response.text()).includes('PAINTTRACK') || route === '/dev/mailbox');
    }
    check('Next注册/验证/开发收件页面真实HTTP200');
    const email = `ui-${randomBytes(6).toString('hex')}@example.test`;
    const post = (route, body) => fetch(base + route, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await post('/api/auth/register', { email, password: 'Synthetic-Only-Password-123' })).status, 202);
    const inbox = await fetch(base + '/api/dev/mailbox');
    assert.equal(inbox.status, 200);
    assert.equal(inbox.headers.get('cache-control'), 'no-store');
    const message = (await inbox.json()).messages.find((item) => item.email === email);
    assert.ok(message);
    const token = message.verificationPath.split('#')[1];
    assert.equal((await post('/api/auth/verify-email', { token })).status, 202);
    check('真实HTTP注册→内存测试邮件→主动POST验证');
    const log = fs.readFileSync(path.resolve(__dirname, '../../.workbuddy/phase31-local-ui-server.log'), 'utf8');
    const database = log.match(/Retained development database: (pt_local_auth_[a-f0-9]{12})/)[1];
    const db = new Client({ host: '127.0.0.1', port: 5433, user: 'postgres', database });
    try {
        await db.connect();
        const result = await db.query('SELECT email_verified_at,password_hash FROM users WHERE email=$1', [email]);
        assert.ok(result.rows[0].email_verified_at);
        assert.ok(result.rows[0].password_hash.startsWith('scrypt:'));
        const consumed = await db.query('SELECT consumed_at FROM email_verification_tokens WHERE user_id=(SELECT id FROM users WHERE email=$1)', [email]);
        assert.ok(consumed.rows[0].consumed_at);
        assert.equal(log.includes(token), false);
    } finally { await db.end(); }
    check('真实PG验证状态/一次性消费持久化及服务日志无token');
    assert.equal((await post('/api/auth/register', { email, password: 'Synthetic-Only-Password-123', role: 'admin' })).status, 400);
    assert.equal((await fetch(base + '/api/dev/mailbox', { headers: { Origin: 'http://evil.example' } })).status, 403);
    const wrongHost = await new Promise((resolve, reject) => {
        require('node:http').get(base + '/api/dev/mailbox', { headers: { Host: 'evil.example' } }, (response) => {
            response.resume(); resolve(response.statusCode);
        }).on('error', reject);
    });
    assert.equal(wrongHost, 403);
    assert.equal((await fetch(base + '/api/dev/mailbox', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    check('非法字段及跨Origin/Host/Fetch-Site拒绝');
    report.status = 'passed';
}
run().catch(() => { report.status = 'failed'; process.exitCode = 1; }).finally(() => {
    const output = path.resolve(__dirname, '../../.workbuddy/phase31-local-ui-http.json');
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report));
});
