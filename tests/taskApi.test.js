const test = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const {
    createTaskCancelHandler,
    createTaskDetailHandler,
    createTaskHandler,
    createRoutedTaskHandler,
    createTasksHandler,
} = require('../lib/server/tasks/taskHttp');
const { TaskApiError } = require('../lib/server/tasks/taskSubmission');

const USER_ID = '00000000-0000-4000-8000-0000000000b1';
const ORIGIN = 'https://app.example';
const TOKEN = randomBytes(32).toString('base64url');

function createSink() {
    return {
        records: [],
        info(value) { this.records.push(value); },
        warn(value) { this.records.push(value); },
        error(value) { this.records.push(value); },
    };
}

function fakeDatabase({ role = 'user', authLevel = 'password' } = {}) {
    return {
        $client: {},
        async execute() {
            return { rows: [{
                id: USER_ID,
                role,
                auth_level: authLevel,
                mfa_verified_at: authLevel === 'mfa' ? new Date() : null,
                step_up_verified_at: null,
            }] };
        },
    };
}

function makeRequest({
    method = 'POST', origin = ORIGIN, cookie = `painttrack_session=${TOKEN}`,
    idempotencyKey = 'request-key-0001', contentType = 'application/json',
    body = JSON.stringify({ taskType: 'image.generate', payload: { prompt: 'a cat' } }),
} = {}) {
    const headers = {};
    if (origin !== null) headers.origin = origin;
    if (cookie) headers.cookie = cookie;
    if (idempotencyKey !== null) headers['idempotency-key'] = idempotencyKey;
    if (contentType !== null) headers['content-type'] = contentType;
    return new Request(`${ORIGIN}/api/tasks`, {
        method,
        headers,
        ...(method === 'POST' ? { body } : {}),
    });
}

function createHandler(service, sink = createSink(), database = fakeDatabase()) {
    return {
        sink,
        handler: createTaskHandler({
            database,
            environment: { APP_BASE_URL: ORIGIN, NODE_ENV: 'production' },
            sink,
            serviceFactory: () => service,
        }),
    };
}

const task = Object.freeze({
    id: '00000000-0000-4000-8000-0000000000c1',
    taskType: 'image.generate',
    status: 'queued',
    createdAt: '2026-11-09T02:00:00.000Z',
    updatedAt: '2026-11-09T02:00:00.000Z',
    completedAt: null,
    cancelRequestedAt: null,
    result: null,
    errorCode: null,
});

test('trusted routed HTTP factory rejects absent catalog and service overrides', () => {
    assert.throws(() => createRoutedTaskHandler(), TypeError);
    assert.throws(() => createRoutedTaskHandler({ catalog: { getLogicalModel() {} }, serviceFactory() {} }), TypeError);
});

test('routed HTTP with no route rolls back without INSERT or internal configuration queries', async () => {
    const sql = [];
    const db = fakeDatabase();
    db.$client = { async connect() { return { release() {}, async query(text) {
        sql.push(text); return { rowCount: 0, rows: [] };
    } }; } };
    let calls = 0;
    const sink = createSink();
    const handler = createRoutedTaskHandler({ database: db, sink,
        environment: { APP_BASE_URL: ORIGIN, NODE_ENV: 'production' },
        catalog: { async getLogicalModel(id) { calls++; assert.equal(id, 'image-alpha'); return null; } },
    });
    const response = await handler(makeRequest({ body: JSON.stringify({ taskType: 'image.generate',
        payload: { logicalModelId: 'image-alpha', prompt: 'test', aspectRatio: '1:1', size: '1024x1024' } }) }));
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, 'MODEL_UNAVAILABLE');
    assert.equal(calls, 1);
    assert.ok(sql.includes('ROLLBACK'));
    assert.ok(!sql.some(text => /INSERT|provider_instances|provider_models|route_bindings/i.test(text)));
});

test('routed catalog backend failure is redacted at HTTP boundary', async () => {
    const db = fakeDatabase();
    db.$client = { async connect() { return { release() {}, async query() { return { rowCount: 0, rows: [] }; } }; } };
    const sink = createSink();
    const handler = createRoutedTaskHandler({ database: db, sink,
        environment: { APP_BASE_URL: ORIGIN, NODE_ENV: 'production' },
        catalog: { async getLogicalModel() { throw new Error('synthetic-private-backend-error'); } },
    });
    const response = await handler(makeRequest({ body: JSON.stringify({ taskType: 'image.generate',
        payload: { logicalModelId: 'image-alpha', prompt: 'test', aspectRatio: '1:1', size: '1024x1024' } }) }));
    assert.equal(response.status, 503);
    assert.ok(!JSON.stringify([await response.json(), sink.records]).includes('synthetic-private-backend-error'));
});

test('password-level administrator cannot create tasks before MFA elevation', async () => {
    const { handler } = createHandler({ async submit() { throw new Error('must not run'); } }, createSink(), fakeDatabase({ role: 'admin', authLevel: 'password' }));
    const response = await handler(makeRequest());
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, 'MFA_REQUIRED');
});

test('MFA-level administrator can create tasks', async () => {
    const { handler } = createHandler({ async submit() { return { task, replayed: false }; } }, createSink(), fakeDatabase({ role: 'admin', authLevel: 'mfa' }));
    const response = await handler(makeRequest());
    assert.equal(response.status, 201);
});

test('task creation requires an authenticated session', async () => {
    const { handler } = createHandler({ async submit() { throw new Error('must not run'); } });
    const response = await handler(makeRequest({ cookie: null }));
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error.code, 'UNAUTHENTICATED');
});

test('task creation rejects cross-site mutations', async () => {
    const { handler } = createHandler({ async submit() { throw new Error('must not run'); } });
    const response = await handler(makeRequest({ origin: 'https://evil.example' }));
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, 'ORIGIN_REJECTED');
});

test('task creation accepts only POST', async () => {
    const { handler } = createHandler({ async submit() { throw new Error('must not run'); } });
    const response = await handler(makeRequest({ method: 'GET' }));
    assert.equal(response.status, 405);
    assert.equal((await response.json()).error.code, 'METHOD_NOT_ALLOWED');
});

test('task creation requires an idempotency key', async () => {
    const { handler } = createHandler({ async submit() { throw new Error('must not run'); } });
    const response = await handler(makeRequest({ idempotencyKey: null }));
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'IDEMPOTENCY_KEY_REQUIRED');
});

test('task creation rejects non-JSON and malformed bodies', async () => {
    const { handler } = createHandler({ async submit() { throw new Error('must not run'); } });
    const wrongType = await handler(makeRequest({ contentType: 'text/plain' }));
    assert.equal(wrongType.status, 415);
    assert.equal((await wrongType.json()).error.code, 'INVALID_CONTENT_TYPE');

    const malformed = await handler(makeRequest({ body: '{not json' }));
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).error.code, 'INVALID_TASK_REQUEST');
});

test('task creation returns 201 with only public task fields', async () => {
    const calls = [];
    const { handler, sink } = createHandler({
        async submit(input) { calls.push(input); return { task, replayed: false }; },
    });
    const response = await handler(makeRequest());
    assert.equal(response.status, 201);
    assert.equal(response.headers.get('idempotency-replayed'), 'false');
    assert.deepEqual(await response.json(), { task });
    assert.deepEqual(calls, [{
        ownerId: USER_ID,
        idempotencyKey: 'request-key-0001',
        taskType: 'image.generate',
        payload: { prompt: 'a cat' },
    }]);
    assert.ok(sink.records.some((record) => record.includes('"action":"task.create"')));
});

test('replaying the same idempotency key returns 200 and the same task', async () => {
    const { handler } = createHandler({ async submit() { return { task, replayed: true }; } });
    const response = await handler(makeRequest());
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('idempotency-replayed'), 'true');
    assert.equal((await response.json()).task.id, task.id);
});

test('idempotency key reuse with a different request maps to 409', async () => {
    const { handler } = createHandler({
        async submit() { throw new TaskApiError('IDEMPOTENCY_KEY_REUSED', 409); },
    });
    const response = await handler(makeRequest());
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, 'IDEMPOTENCY_KEY_REUSED');
});

test('unexpected storage failures do not leak internals', async () => {
    const { handler } = createHandler({
        async submit() { throw new Error('connect ECONNREFUSED 127.0.0.1:5432'); },
    });
    const response = await handler(makeRequest());
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.error.code, 'TASK_SUBMISSION_UNAVAILABLE');
    assert.equal(JSON.stringify(body).includes('ECONNREFUSED'), false);
});

function apiRequest({
    method = 'GET', path = '/api/tasks', origin = ORIGIN,
    cookie = `painttrack_session=${TOKEN}`, query = '', params,
} = {}) {
    const headers = {};
    if (origin !== null) headers.origin = origin;
    if (cookie) headers.cookie = cookie;
    return {
        request: new Request(`${ORIGIN}${path}${query}`, { method, headers }),
        context: { params },
    };
}

function detailTask(overrides = {}) {
    return { ...task, ...overrides };
}

test('任务列表只返回当前用户的公开字段，并透传分页游标', async () => {
    const calls = [];
    const handler = createTasksHandler({
        database: fakeDatabase(),
        environment: { APP_BASE_URL: ORIGIN, NODE_ENV: 'production' },
        sink: createSink(),
        queryFactory: () => ({
            async list(input) {
                calls.push(input);
                return { tasks: [task], nextCursor: 'cursor-1' };
            },
        }),
    });
    const { request } = apiRequest({ query: '?limit=5&cursor=abc' });
    const response = await handler(request);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { tasks: [task], nextCursor: 'cursor-1' });
    assert.deepEqual(calls, [{ ownerId: USER_ID, limit: '5', cursor: 'abc' }]);
});

test('任务列表要求认证，非法分页映射为 400', async () => {
    const handler = createTasksHandler({
        database: fakeDatabase(),
        environment: { APP_BASE_URL: ORIGIN, NODE_ENV: 'production' },
        sink: createSink(),
        queryFactory: () => ({ async list() { throw new TaskApiError('INVALID_PAGINATION', 400); } }),
    });
    const denied = await handler(apiRequest({ cookie: null }).request);
    assert.equal(denied.status, 401);
    assert.equal((await denied.json()).error.code, 'UNAUTHENTICATED');

    const invalid = await handler(apiRequest().request);
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error.code, 'INVALID_PAGINATION');
});

test('任务列表拒绝非 GET/POST 方法，且读请求不要求 Origin', async () => {
    const handler = createTasksHandler({
        database: fakeDatabase(),
        environment: { APP_BASE_URL: ORIGIN, NODE_ENV: 'production' },
        sink: createSink(),
        queryFactory: () => ({ async list() { return { tasks: [], nextCursor: null }; } }),
    });
    const put = await handler(apiRequest({ method: 'PUT' }).request);
    assert.equal(put.status, 405);

    const noOrigin = await handler(apiRequest({ origin: null }).request);
    assert.equal(noOrigin.status, 200);
});

test('任务详情按会话用户查询，他人任务统一 404', async () => {
    const seen = [];
    const handler = createTaskDetailHandler({
        database: fakeDatabase(),
        environment: { APP_BASE_URL: ORIGIN, NODE_ENV: 'production' },
        sink: createSink(),
        queryFactory: () => ({
            async get(input) {
                seen.push(input);
                return input.taskId === task.id ? detailTask() : null;
            },
        }),
    });
    const found = await handler(apiRequest({
        path: `/api/tasks/${task.id}`, params: { taskId: task.id },
    }).request, { params: { taskId: task.id } });
    assert.equal(found.status, 200);
    assert.equal((await found.json()).task.id, task.id);

    const other = '00000000-0000-4000-8000-0000000000d1';
    const missing = await handler(apiRequest({
        path: `/api/tasks/${other}`, params: { taskId: other },
    }).request, { params: Promise.resolve({ taskId: other }) });
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error.code, 'TASK_NOT_FOUND');
    assert.deepEqual(seen[0], { ownerId: USER_ID, taskId: task.id });
});

test('取消接口区分已取消与已登记，并对终态返回 409', async () => {
    const outcomes = [
        ['requested', 202, true],
        ['cancelled', 200, false],
        ['already_cancelled', 200, false],
    ];
    for (const [outcome, status, pending] of outcomes) {
        const sink = createSink();
        const handler = createTaskCancelHandler({
            database: fakeDatabase(),
            environment: { APP_BASE_URL: ORIGIN, NODE_ENV: 'production' },
            sink,
            serviceFactory: () => ({
                async cancel(input) {
                    assert.equal(input.ownerId, USER_ID);
                    return { task: detailTask({ cancelRequestedAt: '2026-11-09T03:00:00.000Z' }), outcome };
                },
            }),
        });
        const { request } = apiRequest({
            method: 'POST', path: `/api/tasks/${task.id}/cancel`, params: { taskId: task.id },
        });
        const response = await handler(request, { params: { taskId: task.id } });
        assert.equal(response.status, status);
        assert.equal((await response.json()).cancelRequested, pending);
        assert.ok(sink.records.some((record) => record.includes('"action":"task.cancel"')));
    }

    const conflicted = createTaskCancelHandler({
        database: fakeDatabase(),
        environment: { APP_BASE_URL: ORIGIN, NODE_ENV: 'production' },
        sink: createSink(),
        serviceFactory: () => ({
            async cancel() { throw new TaskApiError('TASK_NOT_CANCELLABLE', 409); },
        }),
    });
    const response = await conflicted(apiRequest({
        method: 'POST', path: `/api/tasks/${task.id}/cancel`, params: { taskId: task.id },
    }).request, { params: { taskId: task.id } });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, 'TASK_NOT_CANCELLABLE');
});

test('取消接口拒绝跨站请求、非 POST 方法，且不泄露内部错误', async () => {
    const handler = createTaskCancelHandler({
        database: fakeDatabase(),
        environment: { APP_BASE_URL: ORIGIN, NODE_ENV: 'production' },
        sink: createSink(),
        serviceFactory: () => ({ async cancel() { throw new Error('pool exhausted: 10.0.0.5'); } }),
    });
    const crossSite = await handler(apiRequest({
        method: 'POST', origin: 'https://evil.example', path: `/api/tasks/${task.id}/cancel`, params: { taskId: task.id },
    }).request, { params: { taskId: task.id } });
    assert.equal(crossSite.status, 403);
    assert.equal((await crossSite.json()).error.code, 'ORIGIN_REJECTED');

    const wrongMethod = await handler(apiRequest({
        path: `/api/tasks/${task.id}/cancel`, params: { taskId: task.id },
    }).request, { params: { taskId: task.id } });
    assert.equal(wrongMethod.status, 405);

    const failed = await handler(apiRequest({
        method: 'POST', path: `/api/tasks/${task.id}/cancel`, params: { taskId: task.id },
    }).request, { params: { taskId: task.id } });
    assert.equal(failed.status, 503);
    const body = await failed.json();
    assert.equal(body.error.code, 'TASK_CANCELLATION_UNAVAILABLE');
    assert.equal(JSON.stringify(body).includes('10.0.0.5'), false);
});
