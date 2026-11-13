const test = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes, scryptSync } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createRegistrationService, validateInput, hashPassword, tokenDigest } = require('../lib/server/registration');
const { createRegistrationHandler: handler } = require('../lib/server/registrationHttp');
const createRegistrationHandler = (action, options) => handler(action, { ...options,
    environment: { NODE_ENV: 'development', APP_BASE_URL: 'http://localhost', AUTH_ALLOW_LOCAL_HTTP: '1' } });
const { createTestOutbox } = require('./fixtures/registration-outbox.cjs');

const password = 'synthetic-password-314';
const valid = { email: '  User@Example.TEST ', password };
const sink = () => { const lines = []; return { lines, info: (v) => lines.push(v), warn: (v) => lines.push(v), error: (v) => lines.push(v) }; };
const request = (value, headers = {}) => new Request('http://localhost/api/auth/register', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost', ...headers }, body: JSON.stringify(value),
});

test('邮箱规范化不删除加号/点，密码不规范化', () => {
    assert.deepEqual(validateInput('register', valid), { email: 'user@example.test', password });
    assert.equal(validateInput('register', { email: ' A.B+tag@Example.TEST ', password }).email, 'a.b+tag@example.test');
    assert.equal(validateInput('register', { email: 'a@b.test', password: ' '.repeat(12) }).password, ' '.repeat(12));
});

test('拒绝非法邮箱、字段注入、弱长度/超长/控制字符密码', () => {
    for (const value of [null, [], {}, { ...valid, role: 'admin' }, { ...valid, verified: true }, { ...valid, emailVerifiedAt: 'now' },
        { ...valid, userId: 'x' }, { ...valid, email: 3 }, { ...valid, email: 'a@localhost' }, { ...valid, email: '.a@b.test' },
        { ...valid, email: 'a..b@b.test' }, { ...valid, email: 'a@-b.test' }, { ...valid, email: '用户@b.test' },
        { ...valid, email: `${'a'.repeat(65)}@b.test` }, { ...valid, email: `a@${'b'.repeat(64)}.test` },
        { ...valid, email: 'a\nb@b.test' }, { ...valid, password: 'short' }, { ...valid, password: 'a'.repeat(129) },
        { ...valid, password: '中'.repeat(44) }, { ...valid, password: `${password}\0` }]) {
        assert.throws(() => validateInput('register', value), (e) => e.code === 'INVALID_INPUT');
    }
});

test('验证只接受规范的256位token且拒绝额外字段', () => {
    const token = randomBytes(32).toString('base64url');
    assert.deepEqual(validateInput('verify-email', { token }), { token });
    for (const value of [{ token: 'x' }, { token: 'a'.repeat(43) }, { token, role: 'admin' }, { token: 1 }]) {
        assert.throws(() => validateInput('verify-email', value));
    }
});

test('scrypt参数、随机盐、可重算哈希且不含明文', async () => {
    const hashes = await Promise.all([hashPassword(password), hashPassword(password)]);
    assert.notEqual(hashes[0], hashes[1]);
    for (const value of hashes) {
        assert.match(value, /^scrypt:32768:8:3:[0-9a-f]{32}:[0-9a-f]{128}$/);
        const [, n, r, p, salt, hash] = value.split(':');
        assert.equal(scryptSync(password, salt, 64, { N: +n, r: +r, p: +p, maxmem: 64 * 1024 * 1024 }).toString('hex'), hash);
        assert.ok(!value.includes(password));
    }
    assert.equal(tokenDigest('test').length, 64);
});

test('无邮件通道安全失败，非法输入不访问数据库', async () => {
    let used = false;
    const database = { transaction() { used = true; }, execute() { used = true; } };
    const service = createRegistrationService({ database });
    await assert.rejects(service.register(valid), (e) => e.code === 'MAIL_UNAVAILABLE');
    await assert.rejects(service.register({ ...valid, role: 'admin' }), (e) => e.code === 'INVALID_INPUT');
    assert.equal(used, false);
});

test('测试 outbox显式注入且生产拒绝', () => {
    const before = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
        assert.throws(createTestOutbox);
        assert.throws(() => createRegistrationService({ database: { transaction() {} }, mailer: { kind: 'test-memory-outbox' } }));
    } finally {
        if (before === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = before;
    }
});

test('HTTP默认注册503，不假发送、不泄漏字段、不创建数据库连接', async () => {
    const log = sink();
    const handler = createRegistrationHandler('register', { database() { assert.fail('不应连接'); }, sink: log });
    const response = await handler(request(valid));
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, 'MAIL_UNAVAILABLE');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.doesNotMatch(log.lines.join(''), /synthetic-password|example.test|token/i);
});

test('HTTP拒绝过大流式body、伪造content-length与非法JSON/编码', async () => {
    const handler = createRegistrationHandler('register', { database() { assert.fail('不应连接'); }, sink: sink() });
    for (const [req, status] of [
        [request(valid, { 'content-type': 'text/plain' }), 400],
        [request(valid, { 'content-length': '4096' }), 413],
        [request({ email: 'x'.repeat(3000) }, { 'content-length': '1' }), 413],
        [new Request('http://localhost', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost' }, body: '{' }), 400],
        [new Request('http://localhost', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost' }, body: new Uint8Array([255]) }), 400],
    ]) assert.equal((await handler(req)).status, status);
});

test('HTTP数据库错误不回显密码、令牌、邮箱或连接字符串', async () => {
    const log = sink();
    const token = randomBytes(32).toString('base64url');
    const handler = createRegistrationHandler('verify-email', { sink: log, database() { throw new Error(`${password} ${token} user@example.test postgres://secret`); } });
    const response = await handler(request({ token }));
    assert.equal(response.status, 503);
    const output = await response.text() + log.lines.join('');
    for (const secret of [password, token, 'user@example.test', 'postgres://secret']) assert.ok(!output.includes(secret));
});

test('新增Route明确Node运行时且不引用测试fixture，未引入会话/role', () => {
    for (const action of ['register', 'verify-email']) {
        const file = path.join(__dirname, `../app/api/auth/${action}/route.js`);
        const source = fs.readFileSync(file, 'utf8');
        assert.match(source, /runtime = 'nodejs'/);
        assert.match(source, new RegExp(`createRegistrationHandler\\('${action}'(?:\\)|,)`));
        assert.doesNotMatch(source, /require\(.+fixtures|from.+fixtures|Set-Cookie/);
    }
});
