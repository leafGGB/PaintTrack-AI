const test = require('node:test');
const assert = require('node:assert/strict');
const {
    TaskApiError,
    parseIdempotencyKey,
    requestFingerprint,
    validateCreateTaskRequest,
} = require('../lib/server/tasks/taskSubmission');
const { createTaskSubmissionService } = require('../lib/server/tasks/taskService');

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
        taskType: 'image.generate', payload: { prompt: 'a cat', width: 512 },
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

    const large = { prompt: 'x'.repeat(2000) };
    for (let index = 0; index < 20; index += 1) large[`part${index}`] = 'y'.repeat(2000);
    assert.throws(() => validateCreateTaskRequest({ taskType: 'video.generate', payload: large }),
        (error) => error.code === 'TASK_PAYLOAD_TOO_LARGE' && error.status === 413);
});

test('request fingerprint is stable across object key order and sensitive to payload changes', () => {
    const first = requestFingerprint({ taskType: 'image.generate', payload: { a: 1, b: { c: 2, d: 3 } } });
    const reordered = requestFingerprint({ taskType: 'image.generate', payload: { b: { d: 3, c: 2 }, a: 1 } });
    const changed = requestFingerprint({ taskType: 'image.generate', payload: { a: 1, b: { c: 2, d: 4 } } });
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
        payload: { prompt: 'a cat' },
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
                    taskType: 'image.generate', payload: { prompt: 'a cat' },
                }),
            }],
        },
    ]);
    const service = createTaskSubmissionService({ pool });
    const result = await service.submit({
        ownerId: baseTask.owner_id,
        idempotencyKey: baseTask.idempotency_key,
        taskType: 'image.generate',
        payload: { prompt: 'a cat' },
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
        payload: { prompt: 'a different cat' },
    }), (error) => error instanceof TaskApiError && error.code === 'IDEMPOTENCY_KEY_REUSED' && error.status === 409);
});

test('service refuses to run without a PostgreSQL pool', () => {
    assert.throws(() => createTaskSubmissionService({}), /pool is required/);
    assert.throws(() => createTaskSubmissionService({ pool: { query() {} } }), /pool is required/);
});
