const test = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { authPolicy, checkOrigin } = require('../lib/server/authPolicy');
const { hashPassword, verifyPassword } = require('../lib/server/passwords');
const { canonicalToken, sessionCookie, cookieValue, COOKIE_NAME, createSessionService } = require('../lib/server/session');
const { createSessionHandler } = require('../lib/server/sessionHttp');
const { createRegistrationHandler } = require('../lib/server/registrationHttp');
const environment = { NODE_ENV: 'development', APP_BASE_URL: 'http://localhost:3212', AUTH_ALLOW_LOCAL_HTTP: '1' };
const origin = environment.APP_BASE_URL;
const quiet = { info() {}, warn() {}, error() {} };
const req = (headers = {}, method = 'POST', body = '{}') => new Request(`${origin}/api/auth/login`, {
    method, headers: { origin, 'content-type': 'application/json', ...headers }, ...(method !== 'GET' ? { body } : {}),
});
test('认证源必须配置，HTTPS生产强制Secure，本地HTTP仅显式development', () => {
    for (const source of [{}, { ...environment, AUTH_ALLOW_LOCAL_HTTP: '' }, { ...environment, NODE_ENV: 'production' },
        { ...environment, APP_BASE_URL: 'http://remote.test' }, { ...environment, APP_BASE_URL: `${origin}/path` },
        { ...environment, APP_BASE_URL: 'https://user:secret@site.test' }]) assert.throws(() => authPolicy(source));
    assert.deepEqual(authPolicy(environment), { origin, secure: false });
    const mailbox = { NODE_ENV: 'development', APP_BASE_URL: origin, PAINTTRACK_LOCAL_MAILBOX: '1',
        PAINTTRACK_LOCAL_MAILBOX_ORIGIN: origin, PAINTTRACK_LOCAL_MAILBOX_SECRET: 'a'.repeat(64) };
    assert.equal(authPolicy(mailbox).secure, false);
    assert.throws(() => authPolicy({ ...mailbox, PAINTTRACK_LOCAL_MAILBOX_ORIGIN: 'http://localhost:3211' }));
    assert.throws(() => authPolicy({ ...mailbox, NODE_ENV: 'production' }));
    assert.equal(authPolicy({ NODE_ENV: 'production', APP_BASE_URL: 'https://site.test' }).secure, true);
    assert.match(cookieValue('value', true, Date.now()), /; Secure;/);
});
test('Origin精确比较，拒绝缺失/null/跨源/同站不同源和转发头伪造', () => {
    const policy = authPolicy(environment);
    checkOrigin(req(), policy);
    for (const headers of [{ origin: 'null' }, { origin: 'http://evil.test' }, { origin: 'http://localhost:3213' },
        { origin: `${origin}/` }, { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' },
        { origin: 'http://evil.test', 'x-forwarded-host': 'localhost:3212', 'x-forwarded-proto': 'http' }]) {
        assert.throws(() => checkOrigin(req(headers), policy), (e) => e.code === 'ORIGIN_REJECTED');
    }
    const missing = new Request(origin, { method: 'POST' });
    assert.throws(() => checkOrigin(missing, policy));
    checkOrigin(new Request(origin), policy, false);
});
test('cookie只接受单个规范token，属性和清除作用域一致', () => {
    const token = randomBytes(32).toString('base64url');
    assert.equal(canonicalToken(token), token);
    for (const value of ['x', 'a'.repeat(43), 'x'.repeat(9000)]) assert.equal(canonicalToken(value), null);
    const request = (cookie) => new Request(origin, { headers: { cookie } });
    assert.equal(sessionCookie(request(`${COOKIE_NAME}=${token}`)), token);
    assert.equal(sessionCookie(request(`${COOKIE_NAME}=${token}; ${COOKIE_NAME}=${token}`)), null);
    assert.equal(sessionCookie(request(`${COOKIE_NAME}=%${token}`)), null);
    const cookie = cookieValue(token, true, Date.now() + 28800000);
    assert.match(cookie, /Path=\/; HttpOnly; SameSite=Strict; Secure; Max-Age=28800; Expires=/);
    assert.doesNotMatch(cookie, /Domain=/);
    assert.match(cookieValue(null, true), /Max-Age=0; Expires=Thu, 01 Jan 1970/);
});
// drizzle 的 raw execute 不做 timestamptz 反序列化，PostgreSQL 会把时间输出成
// "2026-11-10 16:54:51.954875+08" 这种文本。会话投影和 Cookie 都必须归一化为 Date，
// 否则 /api/auth/me 会外泄非 ISO 文本，Set-Cookie 的 Expires 会变成 Invalid Date。
test('PostgreSQL timestamptz 文本被归一化为 Date 且 Cookie Expires 有效', async () => {
    const pgText = '2026-11-10 16:54:51.954875+08';
    const expected = '2026-11-10T08:54:51.954Z';
    const database = { async execute() {
        return { rows: [{ id: 'user-id', email: 'verified@example.test', role: 'user', auth_level: 'password', mfa_verified_at: null, step_up_verified_at: null, email_verified_at: pgText, created_at: pgText }] };
    } };
    const service = createSessionService({ database, sink: quiet });
    const token = randomBytes(32).toString('base64url');
    const me = await service.me(token);
    assert.ok(me.user.createdAt instanceof Date);
    assert.equal(me.user.createdAt.toISOString(), expected);
    assert.equal(me.user.authLevel, 'password');
    assert.equal(me.user.mfaVerifiedAt, null);
    const cookie = cookieValue(token, true, pgText);
    assert.doesNotMatch(cookie, /Invalid Date/);
    assert.match(cookie, /Expires=Tue, 10 Nov 2026 08:54:51 GMT/);
    for (const value of ['2026-11-10 16:54:51.954+08', '2026-11-10 16:54:51+08', '2026-11-10 16:54:51.954875+0800']) {
        assert.equal(cookieValue(token, true, value).includes('Invalid Date'), false, value);
    }
    // 已归一化的 Date 与数字时间戳必须原样可用，避免二次转换引入偏移。
    const date = new Date(expected);
    assert.match(cookieValue(token, true, date), /Expires=Tue, 10 Nov 2026 08:54:51 GMT/);
    assert.match(cookieValue(token, true, date.getTime()), /Expires=Tue, 10 Nov 2026 08:54:51 GMT/);
});
test('现有scrypt格式可验证，错密码/未知/损坏hash做完整dummy KDF', async () => {
    const password = 'Synthetic-password-3212';
    const hash = await hashPassword(password);
    assert.equal(await verifyPassword(password, hash), true);
    assert.equal(await verifyPassword('Another-password-3212', hash), false);
    assert.equal(await verifyPassword(password, undefined), false);
    assert.equal(await verifyPassword(password, 'scrypt:999999999:8:3:invalid'), false);
});
test('共享KDF并发有界，队列超限拒绝并在完成后恢复', async () => {
    const results = await Promise.allSettled(Array.from({ length: 11 }, () => verifyPassword('Synthetic-password-3212', null)));
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 10);
    assert.equal(results.filter((r) => r.status === 'rejected' && r.reason.code === 'KDF_BUSY').length, 1);
    assert.equal(await verifyPassword('Synthetic-password-3212', null), false);
});
test('全部敏感HTTP操作在读取body/数据库前拒绝跨站', async () => {
    for (const action of ['login', 'logout', 'register', 'verify-email']) {
        const factory = ['login', 'logout'].includes(action) ? createSessionHandler : createRegistrationHandler;
        const handler = factory(action, { environment, sink: quiet, database() { assert.fail('禁止访问数据库'); } });
        const response = await handler(req({ origin: 'http://evil.test' }));
        assert.equal(response.status, 403);
        assert.equal(response.headers.get('cache-control'), 'no-store');
    }
});
test('HTTP内部异常不回显敏感错误、SQL和Cookie', async () => {
    const lines = [];
    const secret = 'private-password-cookie-email@example.test SELECT * FROM users';
    const sink = { info: (v) => lines.push(v), warn: (v) => lines.push(v), error: (v) => lines.push(v) };
    const handler = createSessionHandler('me', { environment, sink, database() { throw new Error(secret); } });
    const response = await handler(req({}, 'GET'));
    assert.equal(response.status, 503);
    assert.equal((await response.clone().json()).error.code, 'AUTH_UNAVAILABLE');
    assert.ok(!(await response.text() + lines.join('')).includes(secret));
});
test('非法登录输入/流式body限制拒绝且不会执行SQL', async () => {
    const database = { execute() { assert.fail('禁止执行SQL'); } };
    const handler = createSessionHandler('login', { environment, sink: quiet, database });
    for (const body of ['{}', '{', JSON.stringify({ email: 'a@b.test', password: 'x'.repeat(129) }),
        JSON.stringify({ email: 'x'.repeat(3000), password: 'x' }), JSON.stringify({ email: 'a@b.test', password: '123456789012', userId: 'x' })]) {
        assert.ok([400, 413].includes((await handler(req({}, 'POST', body))).status));
    }
});
