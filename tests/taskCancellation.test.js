const test = require('node:test');
const assert = require('node:assert/strict');
const { createTaskCancellationService } = require('../lib/server/tasks/taskCancellation');
const { TaskApiError } = require('../lib/server/tasks/taskSubmission');

const OWNER = '00000000-0000-4000-8000-0000000000a1';
const TASK_ID = '00000000-0000-4000-8000-0000000000b1';

function row(overrides = {}) {
    return {
        id: TASK_ID,
        task_type: 'image.generate',
        status: 'queued',
        created_at: new Date('2026-11-09T02:00:00Z'),
        updated_at: new Date('2026-11-09T02:00:00Z'),
        completed_at: null,
        cancel_requested_at: null,
        result: null,
        last_error: null,
        owner_id: OWNER,
        payload: { prompt: 'must not leak' },
        ...overrides,
    };
}

function transactionalPool(results) {
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
                release() { calls.push({ text: 'RELEASE' }); },
            };
        },
    };
}

const service = (results) => {
    const pool = transactionalPool(results);
    return { pool, cancel: createTaskCancellationService({ pool }).cancel };
};

test('queued 任务直接取消，并同时记录取消时间与完成时间', async () => {
    const { pool, cancel } = service([
        { rowCount: 1, rows: [row()] },
        { rowCount: 1, rows: [row({ status: 'cancelled' })] },
    ]);
    const result = await cancel({ ownerId: OWNER, taskId: TASK_ID });
    assert.equal(result.outcome, 'cancelled');
    assert.equal(result.task.status, 'cancelled');
    assert.equal('payload' in result.task, false);

    const update = pool.calls.find((call) => /^UPDATE/.test(call.text));
    assert.match(update.text, /status = \$1/);
    assert.match(update.text, /completed_at = now\(\)/);
    assert.match(update.text, /COALESCE\(cancel_requested_at, now\(\)\)/);
    assert.equal(update.values[0], 'cancelled');
    assert.equal(update.values[3], 'queued');
    assert.ok(pool.calls.some((call) => call.text === 'COMMIT'));
});

test('running 任务只登记取消意图，不直接改状态', async () => {
    const { pool, cancel } = service([
        { rowCount: 1, rows: [row({ status: 'running', cancel_requested_at: null })] },
        { rowCount: 1, rows: [row({ status: 'running', cancel_requested_at: new Date('2026-11-09T03:00:00Z') })] },
    ]);
    const result = await cancel({ ownerId: OWNER, taskId: TASK_ID });
    assert.equal(result.outcome, 'requested');
    assert.equal(result.task.status, 'running');
    assert.ok(result.task.cancelRequestedAt);

    const update = pool.calls.find((call) => /^UPDATE/.test(call.text));
    assert.doesNotMatch(update.text, /SET\s+status/);
    assert.match(update.text, /cancel_requested_at = COALESCE\(cancel_requested_at, now\(\)\)/);
});

test('重复取消按幂等返回，不覆盖已有取消时间', async () => {
    const requestedAt = new Date('2026-11-09T03:00:00Z');
    const { pool, cancel } = service([
        { rowCount: 1, rows: [row({ status: 'running', cancel_requested_at: requestedAt })] },
        { rowCount: 1, rows: [row({ status: 'running', cancel_requested_at: requestedAt })] },
    ]);
    const result = await cancel({ ownerId: OWNER, taskId: TASK_ID });
    assert.equal(result.outcome, 'requested');
    assert.equal(new Date(result.task.cancelRequestedAt).toISOString(), requestedAt.toISOString());
});

test('已取消的任务重复取消返回当前记录而不是冲突', async () => {
    const { pool, cancel } = service([
        { rowCount: 1, rows: [row({ status: 'cancelled', cancel_requested_at: new Date() })] },
    ]);
    const result = await cancel({ ownerId: OWNER, taskId: TASK_ID });
    assert.equal(result.outcome, 'already_cancelled');
    assert.equal(pool.calls.some((call) => /^UPDATE/.test(call.text)), false);
});

for (const status of ['succeeded', 'failed']) {
    test(`${status} 终态不可取消，返回 409 且保留原终态`, async () => {
        const { pool, cancel } = service([{ rowCount: 1, rows: [row({ status })] }]);
        await assert.rejects(
            cancel({ ownerId: OWNER, taskId: TASK_ID }),
            (error) => error instanceof TaskApiError
                && error.code === 'TASK_NOT_CANCELLABLE' && error.status === 409,
        );
        assert.equal(pool.calls.some((call) => /^UPDATE/.test(call.text)), false);
        assert.ok(pool.calls.some((call) => call.text === 'ROLLBACK'));
    });
}

test('他人或不存在的任务统一返回 404，且不泄露是否存在', async () => {
    const { pool, cancel } = service([{ rowCount: 0, rows: [] }]);
    await assert.rejects(
        cancel({ ownerId: OWNER, taskId: TASK_ID }),
        (error) => error instanceof TaskApiError && error.code === 'TASK_NOT_FOUND' && error.status === 404,
    );
    assert.match(pool.calls.find((call) => /^SELECT/.test(call.text)).text, /owner_id = \$2::uuid/);
    assert.ok(pool.calls.some((call) => call.text === 'ROLLBACK'));
});

test('非法任务 ID 在建立数据库连接前就按未找到处理', async () => {
    const { pool, cancel } = service([]);
    for (const taskId of ['not-a-uuid', '', undefined]) {
        await assert.rejects(
            cancel({ ownerId: OWNER, taskId }),
            (error) => error instanceof TaskApiError && error.code === 'TASK_NOT_FOUND',
        );
    }
    assert.equal(pool.calls.length, 0);
});

test('数据库异常回滚后原样抛出，便于上层映射为 503', async () => {
    const failure = new Error('connection terminated');
    const { pool, cancel } = service([failure]);
    await assert.rejects(cancel({ ownerId: OWNER, taskId: TASK_ID }), (error) => error === failure);
    assert.ok(pool.calls.some((call) => call.text === 'ROLLBACK'));
    assert.ok(pool.calls.some((call) => call.text === 'RELEASE'));
});
