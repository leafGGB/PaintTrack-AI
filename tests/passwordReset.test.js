const test = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { createPasswordResetService, validateEmail, validateRequest, validateConsume } = require('../lib/server/passwordReset');
const { createPasswordResetHandler } = require('../lib/server/passwordResetHttp');
const { createTestOutbox } = require('./fixtures/registration-outbox.cjs');

const sink = () => ({ info() {}, warn() {}, error() {} });
const token = () => randomBytes(32).toString('base64url');
const request = (body, headers = {}) => new Request('http://localhost/api/auth/password-reset', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost', ...headers }, body: JSON.stringify(body),
});
const environment = { NODE_ENV: 'development', APP_BASE_URL: 'http://localhost', AUTH_ALLOW_LOCAL_HTTP: '1' };

test('密码重置输入复用邮箱规范化和严格 token/密码规则', () => {
    assert.equal(validateEmail(' User@Example.TEST '), 'user@example.test');
    assert.deepEqual(validateRequest({ email: ' User@Example.TEST ' }), { email: 'user@example.test' });
    const validToken = token();
    assert.deepEqual(validateConsume({ token: validToken, password: 'long-enough-password' }), { token: validToken, password: 'long-enough-password' });
    for (const value of [null, [], { email: 'x' }, { email: 'a@b.test', extra: true }, { email: 'a@localhost' }]) {
        assert.throws(() => validateRequest(value), (error) => error.code === 'INVALID_INPUT');
    }
    for (const value of [{ token: validToken, password: 'short' }, { token: validToken, password: 'a'.repeat(129) },
        { token: validToken, password: `${'a'.repeat(11)}\0` }, { token: `${validToken}=`, password: 'long-enough-password' },
        { token: validToken, password: 'long-enough-password', extra: 1 }]) {
        assert.throws(() => validateConsume(value), (error) => error.code === 'INVALID_INPUT');
    }
});

test('申请对不存在和已验证用户都返回同一受理结果，仅已验证账户发出随机 token', async () => {
    let userExists = false;
    let n = 0;
    const sent = [];
    const database = {
        async execute() { return { rows: [{ hits: 1 }] }; },
        async transaction(callback) { return callback({ async execute() {
            n += 1;
            if (n === 1) return { rows: userExists ? [{ id: 'user-1' }] : [] };
            return { rows: [] };
        } }); },
    };
    const outbox = createTestOutbox();
    const mailer = { ...outbox, async sendPasswordReset(message) { sent.push(message); } };
    const service = createPasswordResetService({ database, mailer, sink: sink() });
    const unknown = await service.request({ email: 'nobody@example.test' });
    userExists = true;
    n = 0;
    const known = await service.request({ email: 'user@example.test' });
    assert.deepEqual(unknown, known);
    assert.deepEqual(known, { status: 'accepted' });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].email, 'user@example.test');
    assert.match(sent[0].token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(sent[0].token.length, 43);
});

test('成功消费重置 token 后更新密码并撤销全部活跃会话', async () => {
    const statements = [];
    const database = { async transaction(callback) { return callback({ async execute(query) {
        statements.push(query.queryChunks.map((chunk) => typeof chunk === 'string' ? chunk : '').join(''));
        if (statements.length === 1) return { rows: [{ user_id: 'user-1' }] };
        return { rows: [] };
    } }); } };
    const service = createPasswordResetService({ database, sink: sink() });
    assert.deepEqual(await service.consume({ token: token(), password: 'long-enough-password' }), { status: 'accepted' });
    assert.equal(statements.length, 3);
});

test('token 无效或已消费会回滚，并不会修改用户或会话', async () => {
    let calls = 0;
    const database = { async transaction(callback) { return callback({ async execute() { calls += 1; return { rows: [] }; } }); } };
    const service = createPasswordResetService({ database, sink: sink() });
    await assert.rejects(service.consume({ token: token(), password: 'long-enough-password' }), (error) => error.code === 'INVALID_RESET_TOKEN');
    assert.equal(calls, 1);
});

test('HTTP 重置申请对有效邮箱统一 202，且拒绝错误 Origin、错误方法及超限请求体', async () => {
    const database = {
        async execute() { return { rows: [{ hits: 1 }] }; },
        async transaction(callback) { return callback({ async execute() { return { rows: [] }; } }); },
    };
    const handler = createPasswordResetHandler('request', { database, mailer: createTestOutbox(), sink: sink(), environment });
    const response = await handler(request({ email: 'unknown@example.test' }));
    assert.equal(response.status, 202);
    assert.equal(await response.text(), '{"status":"accepted"}');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await handler(request({ email: 'unknown@example.test' }, { origin: 'http://evil.test' }))).status, 403);
    assert.equal((await handler(new Request('http://localhost', { method: 'GET', headers: { origin: 'http://localhost' } }))).status, 405);
    assert.equal((await handler(request({ email: 'x'.repeat(4000) }, { 'content-length': '1' }))).status, 413);
});

test('真实开发 mailbox 接受密码重置邮件且返回 fragment 链接和类型', async () => {
    const keys = ['NODE_ENV', 'PAINTTRACK_LOCAL_MAILBOX', 'PAINTTRACK_LOCAL_MAILBOX_SECRET', 'PAINTTRACK_LOCAL_MAILBOX_ORIGIN'];
    const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    const origin = 'http://127.0.0.1:3211';
    const req = () => new Request(`${origin}/api/dev/mailbox`, { headers: { host: '127.0.0.1:3211', origin, 'x-painttrack-local-capability': 'b'.repeat(64) } });
    try {
        Object.assign(process.env, { NODE_ENV: 'development', PAINTTRACK_LOCAL_MAILBOX: '1', PAINTTRACK_LOCAL_MAILBOX_SECRET: 'b'.repeat(64), PAINTTRACK_LOCAL_MAILBOX_ORIGIN: origin });
        const { getDevelopmentMailer, mailboxResponse, clearMailbox } = require('../lib/server/developmentMailbox');
        await clearMailbox(req());
        const value = token();
        await getDevelopmentMailer().sendPasswordReset({ email: 'user@example.test', token: value });
        const message = (await mailboxResponse(req()).json()).messages[0];
        assert.equal(message.type, 'password-reset');
        assert.equal(message.path, `/reset-password#${value}`);
        assert.ok(message.expiresAt > Date.now());
        await clearMailbox(req());
    } finally {
        for (const key of keys) { if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key]; }
    }
});
