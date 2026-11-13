const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { createErrorResponse, emitAuditEvent, getRequestId, writeLog } = require('../lib/server/observability');

const projectRequire = createRequire(path.join(__dirname, '../package.json'));
const swc = projectRequire('next/dist/build/swc');
// 使用项目已有转译器运行真实源码；仅门禁用例显式注入数据库边界，不替换授权、会话或日志实现。
function loadServerModule(relativePath, globals = {}, database) {
    const cache = new Map();
    function load(filename) {
        if (database && filename === projectRequire.resolve('./lib/server/db')) return { getDatabase: () => database };
        if (cache.has(filename)) return cache.get(filename).exports;
        const localRequire = createRequire(filename);
        const loadedModule = { exports: {} };
        cache.set(filename, loadedModule);
        const { code } = swc.transformSync(fs.readFileSync(filename, 'utf8'), {
            filename,
            jsc: { parser: { syntax: 'ecmascript' }, target: 'es2022' },
            module: { type: 'commonjs' },
        });
        vm.runInNewContext(code, {
            module: loadedModule, exports: loadedModule.exports,
            require(specifier) {
                if (!specifier.startsWith('.')) return localRequire(specifier);
                const resolved = localRequire.resolve(specifier);
                return resolved.endsWith('.json') ? localRequire(specifier) : load(resolved);
            },
            process, Buffer, URL, Headers, Response, FormData,
            crypto: globalThis.crypto, console, ...globals,
        }, { filename });
        return loadedModule.exports;
    }
    return load(path.resolve(__dirname, '..', relativePath));
}

const validId = '123e4567-e89b-12d3-a456-426614174000';

test('request IDs accept UUIDs and replace invalid values', () => {
    assert.equal(getRequestId(validId), validId);
    const generated = getRequestId('bad-id');
    assert.match(generated, /^[0-9a-f-]{36}$/i);
    assert.notEqual(generated, 'bad-id');
    const generatedForLongValue = getRequestId(`${validId}extra`);
    assert.match(generatedForLongValue, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.notEqual(generatedForLongValue, `${validId}extra`);
});

test('middleware sends the same normalized request ID downstream and in the response', () => {
    const { middleware } = loadServerModule('middleware.js');
    for (const suppliedId of [validId, 'not-a-uuid', `${validId}extra`, undefined]) {
        const requestHeaders = new Headers({ authorization: 'Bearer private-token' });
        if (suppliedId !== undefined) requestHeaders.set('x-request-id', suppliedId);
        const request = {
            headers: requestHeaders,
            nextUrl: new URL('https://painttrack.test/api/workflow/run'),
        };
        const response = middleware(request);
        const downstreamRequestId = response.headers.get('x-middleware-request-x-request-id');

        assert.match(downstreamRequestId, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
        assert.ok(response.headers.get('x-middleware-override-headers').split(',').includes('x-request-id'));
        assert.equal(response.headers.get('x-request-id'), downstreamRequestId);
        assert.equal(requestHeaders.get('x-request-id'), suppliedId ?? null);
    }
});

test('旧rewrite路径仅向Node门禁传递request ID，不再转发供应商', () => {
    const { middleware } = loadServerModule('middleware.js');
    const response = middleware({
        headers: new Headers({ 'x-request-id': 'invalid' }),
        nextUrl: new URL('https://painttrack.test/api/v1/predictions'),
    });
    const downstreamRequestId = response.headers.get('x-middleware-request-x-request-id');

    assert.equal(response.headers.get('x-middleware-rewrite'), null);
    assert.ok(response.headers.get('x-middleware-override-headers').split(',').includes('x-request-id'));
    assert.equal(response.headers.get('x-request-id'), downstreamRequestId);
});

async function checkBlockedRoute(relativePath, { role = 'user', databaseFailure = false, anonymous = false, suppliedId = validId } = {}) {
    const lines = [];
    let fetchCalls = 0;
    let bodyReads = 0;
    let queries = 0;
    const user = { id: '00000000-0000-4000-8000-000000000001', role };
    const sessionToken = Buffer.alloc(32, 7).toString('base64url');
    const database = { async execute() {
        queries++;
        if (databaseFailure) throw new Error('private-db-credential SELECT private-sql');
        return { rows: [user] };
    } };
    const route = loadServerModule(relativePath, {
        process: { ...process, env: { ...process.env, NODE_ENV: 'production', APP_BASE_URL: 'https://painttrack.test' } },
        console: Object.fromEntries(['log', 'info', 'warn', 'error'].map((level) => [
            level, (...args) => lines.push(args.join(' ')),
        ])),
        fetch: async () => { fetchCalls++; throw new Error('private-upstream-credential'); },
    }, database);
    const code = anonymous ? 'UNAUTHENTICATED' : databaseFailure ? 'AUTH_UNAVAILABLE' : 'NOT_IMPLEMENTED';
    const methods = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
    for (const method of methods) {
        const request = new Request('https://painttrack.test/api/synthetic?name=private-query', {
            method,
            headers: { origin: 'https://painttrack.test', 'x-request-id': suppliedId,
                'x-api-key': 'private-api-key', authorization: 'Bearer private-authorization',
                cookie: anonymous ? 'role=admin; muapi_key=private-cookie' : `painttrack_session=${sessionToken}; private-cookie=value` },
            ...(!['GET', 'HEAD'].includes(method) ? { body: 'private-body-upload-policy' } : {}),
        });
        for (const reader of ['text', 'json', 'formData', 'arrayBuffer', 'blob']) {
            request[reader] = async () => { bodyReads++; throw new Error('private-body-read'); };
        }
        Object.defineProperty(request, 'body', { get() { bodyReads++; throw new Error('private-body-stream'); } });
        const response = await route[method](request, { params: Promise.resolve({ path: ['private-path'] }) });
        assert.equal(response.status, anonymous ? 401 : 503);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.equal(response.headers.get('vary'), 'Cookie');
        assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
        const requestId = response.headers.get('x-request-id');
        assert.equal(getRequestId(requestId), requestId);
        if (suppliedId === validId) assert.equal(requestId, suppliedId);
        else assert.notEqual(requestId, suppliedId);
        const text = await response.text();
        assert.deepEqual(JSON.parse(text), { error: { code, message: 'Request failed', requestId } });
        const records = lines.slice(-2).map((line) => JSON.parse(line));
        assert.equal(records.length, 2);
        assert.equal(records[0].event, 'audit');
        assert.equal(records[0].action, 'cloud.blocked');
        assert.equal(records[0].outcome, 'rejected');
        assert.equal(records[0].actorId, anonymous || databaseFailure ? undefined : user.id);
        assert.equal(records[1].service, 'authorization');
        assert.equal(records[1].event, 'request.rejected');
        assert.equal(records[1].errorCode, code);
        assert.ok(records.every((record) => record.requestId === requestId));
        assert.doesNotMatch(text + lines.join('\n'), /private-|SELECT|Bearer/);
        assert.ok(!(text + lines.join('\n')).includes(sessionToken));
    }
    assert.equal(lines.length, methods.length * 2);
    assert.equal(queries, anonymous ? 0 : methods.length);
    assert.equal(bodyReads, 0);
    assert.equal(fetchCalls, 0);
}

test('workflow全部方法对user/admin均failclosed且无网络，保留审计/脱敏/请求ID', async () => {
    for (const role of ['user', 'admin']) await checkBlockedRoute('app/api/workflow/[[...path]]/route.js', { role });
});

test('workflow数据库异常脱敏为AUTH_UNAVAILABLE，全部方法不读body或调用上游', async () => {
    await checkBlockedRoute('app/api/workflow/[[...path]]/route.js', { databaseFailure: true });
});

test('上传门禁不解析表单或透传S3，user/admin均关闭且规范化关联ID', async () => {
    for (const role of ['user', 'admin']) await checkBlockedRoute('app/api/upload-binary/route.js', { role, suppliedId: 'private-invalid-id' });
});

test('v1上传匿名/数据库故障/两角色均关闭且日志无凭据或原始异常', async () => {
    for (const options of [{ anonymous: true }, { databaseFailure: true }, { role: 'user' }, { role: 'admin' }]) {
        await checkBlockedRoute('app/api/v1/upload-binary/route.js', options);
    }
});

test('structured logs include only allowlisted fields', () => {
    const lines = [];
    const record = writeLog('info', {
        service: 'api', requestId: validId, status: 503,
        prompt: 'private prompt', authorization: 'secret', error: 'raw details',
        event: 'audit', action: 'asset.delete', actorId: 'user-1',
        resourceType: 'asset', resourceId: 'asset-2', outcome: 'denied',
    }, { info: (line) => lines.push(line) });

    assert.deepEqual(Object.keys(record).sort(), ['environment', 'event', 'requestId', 'service', 'status', 'timestamp']);
    assert.deepEqual(JSON.parse(lines[0]), record);
    assert.doesNotMatch(lines[0], /private prompt|secret|raw details|asset.delete|user-1|asset-2|denied/);
});

test('error response is stable and excludes underlying exception detail', () => {
    const result = createErrorResponse({ code: 'INTERNAL_ERROR', requestId: validId });
    assert.deepEqual(result.body, {
        error: { code: 'INTERNAL_ERROR', message: 'Request failed', requestId: validId },
    });
    assert.equal(result.headers['x-request-id'], validId);
    assert.equal(result.headers['Cache-Control'], 'no-store');
    assert.throws(() => createErrorResponse({ code: 'INTERNAL ERROR', requestId: validId }), /stable error code/);
});

test('audit events serialize approved audit metadata and exclude sensitive payloads', () => {
    const lines = [];
    const event = emitAuditEvent({
        action: 'asset.delete', actorId: 'user-1', resourceType: 'asset',
        resourceId: 'asset-2', outcome: 'denied', requestId: validId,
        payload: { prompt: 'private payload' }, authorization: 'top-secret-token',
        event: 'forged-event', timestamp: 'forged-time', environment: 'forged-environment',
        service: 'unapproved-service',
    }, { info: (line) => lines.push(line) });
    const serialized = JSON.parse(lines[0]);

    assert.equal(event.requestId, validId);
    assert.deepEqual({
        event: serialized.event,
        action: serialized.action,
        actorId: serialized.actorId,
        resourceType: serialized.resourceType,
        resourceId: serialized.resourceId,
        outcome: serialized.outcome,
        requestId: serialized.requestId,
    }, {
        event: 'audit',
        action: 'asset.delete',
        actorId: 'user-1',
        resourceType: 'asset',
        resourceId: 'asset-2',
        outcome: 'denied',
        requestId: validId,
    });
    assert.equal(lines.length, 1);
    assert.deepEqual(Object.keys(serialized).sort(), [
        'action', 'actorId', 'environment', 'event', 'outcome',
        'requestId', 'resourceId', 'resourceType', 'timestamp',
    ]);
    assert.ok(Number.isFinite(Date.parse(serialized.timestamp)));
    assert.equal(serialized.environment, process.env.NODE_ENV || 'development');
    assert.doesNotMatch(lines[0], /private payload|top-secret-token|forged-|unapproved-service/);
    assert.throws(() => emitAuditEvent({ action: 'asset.delete' }), /require action and outcome/);
});

test('audit events serialize normalized request IDs and reject invalid required metadata', () => {
    const lines = [];
    const sink = { info: (line) => lines.push(line) };
    const event = emitAuditEvent({ action: 'asset.delete', outcome: 'denied', requestId: 'bad-id' }, sink);
    const serialized = JSON.parse(lines[0]);

    assert.equal(serialized.requestId, event.requestId);
    assert.equal(getRequestId(serialized.requestId), serialized.requestId);
    assert.notEqual(serialized.requestId, 'bad-id');
    for (const invalid of [
        { outcome: 'denied' },
        { action: 'asset.delete', outcome: 1 },
        { action: 'x'.repeat(201), outcome: 'denied' },
    ]) {
        assert.throws(() => emitAuditEvent(invalid, sink), /require action and outcome/);
    }
    assert.equal(lines.length, 1);
});
