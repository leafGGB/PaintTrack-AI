const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { createAuthorizationHandler } = require('../lib/server/authorizationHttp');
const { requireRole, requireAdminMfa, requireAdminStepUp, requireOwnedAsset, requireOwnedAssetContent, softDeleteOwnedAsset } = require('../lib/server/authorization');
const environment = { NODE_ENV: 'development', APP_BASE_URL: 'http://127.0.0.1:3213', AUTH_ALLOW_LOCAL_HTTP: '1' };
const quiet = { info() {}, warn() {}, error() {} };
const token = randomBytes(32).toString('base64url');
const request = (headers = {}, method = 'GET') => new Request(environment.APP_BASE_URL, { method, headers: {
    cookie: `painttrack_session=${token}`, ...headers,
} });

test('权限策略deny-by-default，不默认允许管理员跨资源所有者', async () => {
    for (const user of [null, { role: 'user' }, { role: 'superadmin' }]) assert.throws(() => requireRole(user, 'admin'), (e) => e.code === 'FORBIDDEN');
    assert.throws(() => requireRole({ role: 'admin' }, 'unknown'));
    await assert.rejects(requireOwnedAsset({ execute() { assert.fail(); } }, null, 'invalid'));
    await assert.rejects(requireOwnedAsset({ execute() { assert.fail(); } }, { role: 'admin' }, 'invalid'), (e) => e.code === 'NOT_FOUND');
});

test('资产内容读取仅返回ready且归属当前用户的私有存储定位信息', async () => {
    const id = '00000000-0000-4000-8000-000000000055';
    const owner = { id: '00000000-0000-4000-8000-000000000001', role: 'user' };
    const database = { async execute() { return { rows: [{ id, status: 'ready', storage_key: 'users/private/key' }] }; } };
    const asset = await requireOwnedAssetContent(database, owner, id);
    assert.equal(asset.storage_key, 'users/private/key');
    await assert.rejects(requireOwnedAssetContent({ async execute() { return { rows: [] }; } }, { ...owner, id: '00000000-0000-4000-8000-000000000002' }, id), (error) => error.code === 'NOT_FOUND');
    await assert.rejects(requireOwnedAssetContent({ async execute() { return { rows: [{ id, status: 'pending', storage_key: null }] }; } }, owner, id), (error) => error.code === 'NOT_FOUND');
});

test('资产软删除只对本人ready资产生效，重复删除幂等且他人资产不泄露', async () => {
    const id = '00000000-0000-4000-8000-000000000066';
    const owner = { id: '00000000-0000-4000-8000-000000000001', role: 'user' };
    const deletedAt = new Date('2026-11-13T05:00:00Z');
    const scripted = (...results) => {
        const calls = [];
        return {
            calls,
            async execute(query) {
                calls.push(query);
                const next = results[calls.length - 1];
                if (next === undefined) throw new Error('unexpected query');
                return next;
            },
        };
    };

    // ready -> deleted：单条条件更新命中即可，不再探测。
    const hit = scripted({ rows: [{ id, status: 'deleted', deleted_at: deletedAt }] });
    assert.deepEqual(await softDeleteOwnedAsset(hit, owner, id),
        { id, status: 'deleted', deletedAt, alreadyDeleted: false });
    assert.equal(hit.calls.length, 1);

    // 重复删除：条件更新 0 行，探测到已删除后返回幂等成功。
    const repeat = scripted({ rows: [] }, { rows: [{ id, status: 'deleted', deleted_at: deletedAt }] });
    assert.deepEqual(await softDeleteOwnedAsset(repeat, owner, id),
        { id, status: 'deleted', deletedAt, alreadyDeleted: true });
    assert.equal(repeat.calls.length, 2);

    // 他人资产与不存在的资产共用同一个 404，不区分原因。
    await assert.rejects(
        softDeleteOwnedAsset(scripted({ rows: [] }, { rows: [] }), { ...owner, id: '00000000-0000-4000-8000-000000000002' }, id),
        (error) => error.code === 'NOT_FOUND' && error.status === 404,
    );

    // 尚无交付对象的中间态不可删除。
    for (const status of ['pending', 'uploading', 'failed']) {
        await assert.rejects(
            softDeleteOwnedAsset(scripted({ rows: [] }, { rows: [{ id, status, deleted_at: null }] }), owner, id),
            (error) => error.code === 'ASSET_NOT_DELETABLE' && error.status === 409,
        );
    }

    // 非规范 ID 与非法角色在触库之前拒绝。
    const untouched = scripted();
    for (const candidate of ['../etc/passwd', '', undefined, `${id}x`]) {
        await assert.rejects(softDeleteOwnedAsset(untouched, owner, candidate), (error) => error.code === 'NOT_FOUND');
    }
    for (const user of [null, { role: 'superadmin' }, { id: owner.id }]) {
        await assert.rejects(softDeleteOwnedAsset(untouched, user, id), (error) => error.code === 'FORBIDDEN');
    }
    assert.equal(untouched.calls.length, 0);

    // 数据库故障必须冒泡，不能被折叠成 404 或 409。
    const failure = new Error('database unavailable');
    await assert.rejects(softDeleteOwnedAsset({ async execute() { throw failure; } }, owner, id), (error) => error === failure);
});

test('资产删除接口只接受DELETE、要求同源Origin，且GET不能触发删除', async () => {
    const id = '00000000-0000-4000-8000-000000000066';
    const session = { id: '00000000-0000-4000-8000-000000000001', role: 'user' };
    const deletedAt = new Date('2026-11-13T05:00:00Z');
    const results = [
        { rows: [session] },
        { rows: [{ id, status: 'deleted', deleted_at: deletedAt }] },
        { rows: [session] },
        { rows: [] },
        { rows: [{ id, status: 'deleted', deleted_at: deletedAt }] },
    ];
    let index = 0;
    const database = { async execute() { return results[index++] ?? { rows: [] }; } };
    const handler = createAuthorizationHandler('asset.delete', { environment, database, sink: quiet });
    const del = (headers = {}, target = id) => handler(
        new Request(environment.APP_BASE_URL, { method: 'DELETE', headers: { cookie: `painttrack_session=${token}`, ...headers } }),
        { params: Promise.resolve({ id: target }) },
    );

    // 缺失或跨站 Origin 一律拒绝，且在触库之前完成。
    assert.equal((await del()).status, 403);
    assert.equal((await del({ origin: 'http://evil.test' })).status, 403);
    assert.equal((await del({ origin: 'null' })).status, 403);
    assert.equal(index, 0);

    const first = await del({ origin: environment.APP_BASE_URL });
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('cache-control'), 'no-store');
    assert.deepEqual((await first.json()).asset,
        { id, status: 'deleted', deletedAt: deletedAt.toISOString(), alreadyDeleted: false });

    const again = await del({ origin: environment.APP_BASE_URL });
    assert.equal(again.status, 200);
    assert.equal((await again.json()).asset.alreadyDeleted, true);

    // 同一路由的读取动作不接受 DELETE，删除动作也不接受 GET。
    // 方法校验发生在认证之后，因此这里需要一个只返回会话行的独立数据库。
    const sessionOnly = { async execute() { return { rows: [session] }; } };
    const readHandler = createAuthorizationHandler('asset.read', { environment, database: sessionOnly, sink: quiet });
    const deleteOnRead = await readHandler(
        new Request(environment.APP_BASE_URL, { method: 'DELETE', headers: { cookie: `painttrack_session=${token}`, origin: environment.APP_BASE_URL } }),
        { params: Promise.resolve({ id }) },
    );
    assert.equal(deleteOnRead.status, 405);
    const deleteHandler = createAuthorizationHandler('asset.delete', { environment, database: sessionOnly, sink: quiet });
    const getOnDelete = await deleteHandler(request(), { params: Promise.resolve({ id }) });
    assert.equal(getOnDelete.status, 405);
});

test('管理员 MFA 和 step-up 门禁拒绝普通会话及过期认证', () => {
    assert.throws(() => requireAdminMfa({ role: 'admin', authLevel: 'password' }), (e) => e.code === 'MFA_REQUIRED');
    assert.throws(() => requireAdminStepUp({ role: 'admin', authLevel: 'mfa', stepUpVerifiedAt: new Date(Date.now() - 301000) }), (e) => e.code === 'STEP_UP_REQUIRED');
    assert.doesNotThrow(() => requireAdminStepUp({ role: 'admin', authLevel: 'mfa', stepUpVerifiedAt: new Date() }));
});

test('管理员汇总要求 MFA 会话，普通用户仍按角色拒绝', async () => {
    let current = { id: '00000000-0000-4000-8000-000000000001', role: 'admin', auth_level: 'password' };
    const database = { async execute() {
        if (current?.auth_level === 'mfa') return { rows: [{ ...current, mfa_verified_at: new Date(), step_up_verified_at: null }] };
        return { rows: current ? [current] : [] };
    } };
    const handler = createAuthorizationHandler('admin.summary', { environment, database, sink: quiet });
    assert.equal((await handler(request())).status, 403);
    current.auth_level = 'mfa';
    assert.equal((await handler(request())).status, 200);
});

test('匿名/伪造role不授予身份，合法会话实时检查角色', async () => {
    let current = { id: '00000000-0000-4000-8000-000000000001', role: 'user' };
    const database = { async execute() { return { rows: current ? [current] : [] }; } };
    const handler = createAuthorizationHandler('admin.summary', { environment, database, sink: quiet });
    assert.equal((await handler(new Request(environment.APP_BASE_URL, { headers: { 'x-role': 'admin', role: 'admin' } }))).status, 401);
    assert.equal((await handler(request({ 'x-role': 'admin' }))).status, 403);
    current = { ...current, role: 'admin', auth_level: 'password' };
    assert.equal((await handler(request())).status, 403);
    current.auth_level = 'mfa';
    assert.equal((await handler(request())).status, 200);
    current.role = 'user';
    assert.equal((await handler(request())).status, 403);
    current = null;
    assert.equal((await handler(request())).status, 401);
});

test('数据库失败closed并脱敏，Origin在数据库和body之前拒绝', async () => {
    const lines = [];
    const secret = 'private-cookie-password-email@example.test SELECT secret';
    const sink = { info: (v) => lines.push(v), warn: (v) => lines.push(v), error: (v) => lines.push(v) };
    let calls = 0;
    const database = () => { calls++; throw new Error(secret); };
    const handler = createAuthorizationHandler('cloud.blocked', { environment, database, sink });
    for (const headers of [{}, { origin: 'null' }, { origin: 'http://evil.test' }, { origin: environment.APP_BASE_URL, 'sec-fetch-site': 'cross-site' }]) {
        assert.equal((await handler(request(headers, 'POST'))).status, 403);
    }
    assert.equal(calls, 0);
    const response = await handler(request());
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await response.clone().json()).error.code, 'AUTH_UNAVAILABLE');
    assert.ok(!(await response.text() + lines.join('')).includes(secret));
});

test('已认证用户和管理员均不能调用未实现云端能力，不读取body或fetch', async () => {
    for (const role of ['user', 'admin']) {
        const database = { async execute() { return { rows: [{ id: 'synthetic', role }] }; } };
        const handler = createAuthorizationHandler('cloud.blocked', { environment, database, sink: quiet });
        const response = await handler(request({ origin: environment.APP_BASE_URL }, 'POST'));
        assert.equal(response.status, 503);
        assert.equal((await response.json()).error.code, 'NOT_IMPLEMENTED');
    }
});

test('全部旧代理/上传/workflow入口只接统一门禁且middleware无外部rewrite', () => {
    const root = path.resolve(__dirname, '..');
    const routes = ['agents/[[...path]]', 'api/v1/[[...path]]', 'app/[[...path]]', 'workflow/[[...path]]',
        'upload-binary', 'v1/[[...path]]', 'v1/creative-agent/[[...path]]', 'v1/get_upload_url', 'v1/upload-binary'];
    for (const route of routes) {
        const source = fs.readFileSync(path.join(root, 'app/api', route, 'route.js'), 'utf8');
        assert.match(source, /createAuthorizationHandler\('cloud.blocked'\)/);
        assert.doesNotMatch(source, /fetch\(|https?:|arrayBuffer\(|formData\(/);
        for (const verb of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) assert.ok(source.includes(`blocked as ${verb}`));
    }
    const middleware = fs.readFileSync(path.join(root, 'middleware.js'), 'utf8');
    assert.doesNotMatch(middleware, /NextResponse\.rewrite|https:\/\/api\.muapi\.ai/);
    assert.match(middleware, /connect-src 'self';/);
    for (const page of ['[agent_id]', '[agent_id]/[conversation_id]', 'create', 'edit/[id]']) {
        const source = fs.readFileSync(path.join(root, 'app/agents', page, 'page.js'), 'utf8');
        assert.match(source, /CloudUnavailable/);
        assert.doesNotMatch(source, /fetch\(|muapi_key|https:/);
    }
});
