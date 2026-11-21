const test = require('node:test');
const assert = require('node:assert/strict');
const {
    TaskApiError,
    parseIdempotencyKey,
    requestFingerprint,
    validateCreateTaskRequest,
} = require('../lib/server/tasks/taskSubmission');
const { createTaskSubmissionService } = require('../lib/server/tasks/taskService');

const imagePayload = { logicalModelId: 'test-image', prompt: 'a cat', aspectRatio: '1:1', size: '1024x1024', outputCount: 1 };

function scriptedPool(results) {
    const calls = [];
    return {
        calls,
        async connect() {
            return {
                async query(text, values) {
                    calls.push({ text, values });
                    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(text)) return { rowCount: 0, rows: [] };
                    const next = results.shift();
                    if (next instanceof Error) throw next;
                    return next || { rowCount: 0, rows: [] };
                },
                release() {},
            };
        },
    };
}

const baseTask = {
    id: '00000000-0000-4000-8000-000000000001',
    owner_id: '00000000-0000-4000-8000-000000000002',
    idempotency_key: 'request-key-0001',
    request_fingerprint: 'a'.repeat(64),
    task_type: 'image.generate',
    status: 'queued',
    created_at: new Date('2026-11-09T02:00:00Z'),
    updated_at: new Date('2026-11-09T02:00:00Z'),
};

test('idempotency keys are required and restricted to a canonical character set', () => {
    assert.equal(parseIdempotencyKey('request-key-0001'), 'request-key-0001');
    for (const value of [null, undefined, '', 'short', 'has space', 'x'.repeat(129), '中文键值']) {
        assert.throws(() => parseIdempotencyKey(value), (error) => error instanceof TaskApiError && error.status === 400);
    }
});

test('task request rejects unknown fields, unsupported types and unsafe payloads', () => {
    const valid = validateCreateTaskRequest({
        taskType: 'image.generate', payload: { ...imagePayload, width: 512 },
    });
    assert.equal(valid.taskType, 'image.generate');

    const rejected = [
        [{ taskType: 'image.generate', payload: { prompt: 'x' }, extra: true }, 'INVALID_TASK_REQUEST'],
        [{ taskType: 'image.generate', payload: { prompt: 'x' }, ownerId: '00000000-0000-4000-8000-000000000002' }, 'INVALID_TASK_REQUEST'],
        [{ taskType: 'image.generate' }, 'INVALID_TASK_REQUEST'],
        [{ taskType: 'image.unknown', payload: { prompt: 'x' } }, 'UNSUPPORTED_TASK_TYPE'],
        [{ taskType: 'image.generate', payload: {} }, 'INVALID_TASK_PAYLOAD'],
        [{ taskType: 'image.generate', payload: [] }, 'INVALID_TASK_PAYLOAD'],
        [{ taskType: 'image.generate', payload: { prompt: 'x'.repeat(5000) } }, 'INVALID_TASK_PAYLOAD'],
        [JSON.parse('{"taskType":"image.generate","payload":{"__proto__":{"admin":true}}}'), 'INVALID_TASK_PAYLOAD'],
    ];
    for (const [body, code] of rejected) {
        assert.throws(() => validateCreateTaskRequest(body), (error) => error instanceof TaskApiError && error.code === code);
    }
});

test('task request enforces depth and total payload size limits', () => {
    let deep = { value: 1 };
    for (let index = 0; index < 10; index += 1) deep = { nested: deep };
    assert.throws(() => validateCreateTaskRequest({ taskType: 'image.generate', payload: deep }),
        (error) => error.code === 'INVALID_TASK_PAYLOAD');

    const large = { logicalModelId: 'test-video', prompt: 'x'.repeat(2000), durationMs: 1000, fps: 1 };
    for (let index = 0; index < 20; index += 1) large[`part${index}`] = 'y'.repeat(2000);
    assert.throws(() => validateCreateTaskRequest({ taskType: 'video.generate', payload: large }),
        (error) => error.code === 'TASK_PAYLOAD_TOO_LARGE' && error.status === 413);
});

test('request fingerprint is stable across object key order and sensitive to payload changes', () => {
    const first = requestFingerprint({ taskType: 'image.generate', payload: { ...imagePayload, a: 1, b: { c: 2, d: 3 } } });
    const reordered = requestFingerprint({ taskType: 'image.generate', payload: { b: { d: 3, c: 2 }, a: 1, ...imagePayload } });
    const changed = requestFingerprint({ taskType: 'image.generate', payload: { ...imagePayload, a: 1, b: { c: 2, d: 4 } } });
    assert.match(first, /^[0-9a-f]{64}$/);
    assert.equal(first, reordered);
    assert.notEqual(first, changed);
});

test('service creates a task owned by the authenticated user', async () => {
    const pool = scriptedPool([{ rowCount: 1, rows: [baseTask] }]);
    const service = createTaskSubmissionService({ pool });
    const result = await service.submit({
        ownerId: baseTask.owner_id,
        idempotencyKey: baseTask.idempotency_key,
        taskType: 'image.generate',
        payload: { ...imagePayload },
    });
    assert.equal(result.replayed, false);
    assert.deepEqual(result.task, {
        id: baseTask.id,
        taskType: 'image.generate',
        status: 'queued',
        createdAt: baseTask.created_at,
        updatedAt: baseTask.updated_at,
        completedAt: null,
        cancelRequestedAt: null,
        result: null,
        errorCode: null,
    });
    assert.equal('owner_id' in result.task, false);
    assert.equal('request_fingerprint' in result.task, false);
    const insert = pool.calls.find((call) => /INSERT INTO generation_tasks/.test(call.text));
    assert.equal(insert.values[0], baseTask.owner_id);
    assert.equal(insert.values[1], baseTask.idempotency_key);
    assert.match(insert.text, /ON CONFLICT \(owner_id, idempotency_key\) DO NOTHING/);
});

test('same key with the same request replays the existing task', async () => {
    const pool = scriptedPool([
        { rowCount: 0, rows: [] },
        {
            rowCount: 1,
            rows: [{
                ...baseTask,
                request_fingerprint: requestFingerprint({
                    taskType: 'image.generate', payload: { ...imagePayload },
                }),
            }],
        },
    ]);
    const service = createTaskSubmissionService({ pool });
    const result = await service.submit({
        ownerId: baseTask.owner_id,
        idempotencyKey: baseTask.idempotency_key,
        taskType: 'image.generate',
        payload: { ...imagePayload },
    });
    assert.equal(result.replayed, true);
    assert.equal(result.task.id, baseTask.id);
});

test('same key with a different request is rejected instead of returning the old task', async () => {
    const pool = scriptedPool([
        { rowCount: 0, rows: [] },
        { rowCount: 1, rows: [{ ...baseTask, request_fingerprint: 'b'.repeat(64) }] },
    ]);
    const service = createTaskSubmissionService({ pool });
    await assert.rejects(service.submit({
        ownerId: baseTask.owner_id,
        idempotencyKey: baseTask.idempotency_key,
        taskType: 'image.generate',
        payload: { ...imagePayload, prompt: 'a different cat' },
    }), (error) => error instanceof TaskApiError && error.code === 'IDEMPOTENCY_KEY_REUSED' && error.status === 409);
});

test('新提交必须显式提供模型和正安全整数计价参数，图片仅支持单张', () => {
    const videoPayload = { logicalModelId: 'test-video', prompt: 'synthetic', durationMs: 1000, fps: 1 };
    const invalidIntegers = [undefined, null, 0, -1, 1.5, '1', true, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1];
    for (const [taskType, payload, keys] of [
        ['image.generate', imagePayload, ['outputCount']],
        ['video.generate', videoPayload, ['durationMs', 'fps']],
    ]) {
        assert.deepEqual(validateCreateTaskRequest({ taskType, payload }).payload, payload);
        const { logicalModelId, ...withoutModel } = payload;
        assert.throws(() => validateCreateTaskRequest({ taskType, payload: withoutModel }), { code: 'LOGICAL_MODEL_REQUIRED' });
        for (const key of keys) {
            const missing = { ...payload };
            delete missing[key];
            assert.throws(() => validateCreateTaskRequest({ taskType, payload: missing }), { code: 'INVALID_TASK_PAYLOAD' });
            for (const value of invalidIntegers) {
                assert.throws(() => validateCreateTaskRequest({ taskType, payload: { ...payload, [key]: value } }), { code: 'INVALID_TASK_PAYLOAD' });
            }
        }
    }
    for (const outputCount of [2, Number.MAX_SAFE_INTEGER]) {
        assert.throws(() => validateCreateTaskRequest({ taskType: 'image.generate', payload: { ...imagePayload, outputCount } }),
            { code: 'UNSUPPORTED_OUTPUT_COUNT', status: 409 });
    }
    assert.equal(validateCreateTaskRequest({ taskType: 'video.generate', payload: { ...videoPayload, durationMs: Number.MAX_SAFE_INTEGER, fps: Number.MAX_SAFE_INTEGER } }).payload.durationMs, Number.MAX_SAFE_INTEGER);
});

test('视频指纹覆盖精确毫秒与帧率，键顺序不影响指纹', () => {
    const payload = { logicalModelId: 'test-video', prompt: 'synthetic', durationMs: 1000, fps: 1 };
    const fingerprint = requestFingerprint({ taskType: 'video.generate', payload });
    assert.equal(fingerprint, requestFingerprint({ taskType: 'video.generate', payload: { fps: 1, durationMs: 1000, prompt: 'synthetic', logicalModelId: 'test-video' } }));
    for (const change of [{ durationMs: 1001 }, { fps: 2 }, { logicalModelId: 'other-video' }]) {
        assert.notEqual(fingerprint, requestFingerprint({ taskType: 'video.generate', payload: { ...payload, ...change } }));
    }
});

test('提交服务拒绝非法参数和无可信路由的视频，且不连接数据库', async () => {
    let connects = 0;
    const service = createTaskSubmissionService({ pool: { async connect() { connects++; assert.fail('不得访问数据库'); } } });
    for (const payload of [{ prompt: 'legacy mock' }, { ...imagePayload, outputCount: 0 }, { ...imagePayload, outputCount: 2 }]) {
        await assert.rejects(service.submit({ ownerId: baseTask.owner_id, idempotencyKey: baseTask.idempotency_key, taskType: 'image.generate', payload }), TaskApiError);
    }
    await assert.rejects(service.submit({ ownerId: baseTask.owner_id, idempotencyKey: baseTask.idempotency_key,
        taskType: 'video.generate', payload: { logicalModelId: 'test-video', prompt: 'synthetic', durationMs: 1000, fps: 1 } }),
    { code: 'MODEL_PARAMETERS_UNSUPPORTED', status: 409 });
    assert.equal(connects, 0);
});

test('service refuses to run without a PostgreSQL pool', () => {
    assert.throws(() => createTaskSubmissionService({}), /pool is required/);
    assert.throws(() => createTaskSubmissionService({ pool: { query() {} } }), /pool is required/);
});
