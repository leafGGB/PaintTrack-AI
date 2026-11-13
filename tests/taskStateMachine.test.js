const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
    ALL_TASK_STATUSES,
    ALLOWED_TRANSITIONS,
    CANCEL_PATH,
    TASK_STATUS,
    TERMINAL_STATUSES,
    TRANSITION_ACTION,
    TaskStateError,
    assertTransition,
    canTransition,
    cancelPathFor,
    isLeaseExpired,
    isTaskStatus,
    isTerminalStatus,
    nextStatusAfterFailure,
    resolveTransition,
} = require('../lib/server/worker/taskStateMachine');
const taskQueue = require('../lib/server/worker/taskQueue');

test('任务状态集合固定为五态，成功/失败/取消是终态', () => {
    assert.deepEqual(ALL_TASK_STATUSES, ['queued', 'running', 'succeeded', 'failed', 'cancelled']);
    assert.deepEqual(TERMINAL_STATUSES, ['succeeded', 'failed', 'cancelled']);
    for (const status of ALL_TASK_STATUSES) {
        assert.equal(isTaskStatus(status), true);
        assert.equal(isTerminalStatus(status), TERMINAL_STATUSES.includes(status));
    }
    for (const value of ['', 'done', 'QUEUED', null, undefined, 0, {}]) {
        assert.equal(isTaskStatus(value), false);
        assert.equal(isTerminalStatus(value), false);
    }
});

test('合法转换表与业务规则一致，终态没有出边', () => {
    assert.deepEqual(ALLOWED_TRANSITIONS[TASK_STATUS.QUEUED], [TASK_STATUS.RUNNING, TASK_STATUS.CANCELLED]);
    assert.deepEqual(ALLOWED_TRANSITIONS[TASK_STATUS.RUNNING], [
        TASK_STATUS.QUEUED,
        TASK_STATUS.SUCCEEDED,
        TASK_STATUS.FAILED,
        TASK_STATUS.CANCELLED,
    ]);
    for (const terminal of TERMINAL_STATUSES) {
        assert.deepEqual(ALLOWED_TRANSITIONS[terminal], []);
        for (const next of ALL_TASK_STATUSES) {
            assert.equal(canTransition(terminal, next), false);
        }
    }
    // 不允许跳过执行直接成功，也不能从未领取状态直接失败。
    assert.equal(canTransition(TASK_STATUS.QUEUED, TASK_STATUS.SUCCEEDED), false);
    assert.equal(canTransition(TASK_STATUS.QUEUED, TASK_STATUS.FAILED), false);
    assert.equal(canTransition(TASK_STATUS.QUEUED, TASK_STATUS.RUNNING), true);
    assert.equal(canTransition(TASK_STATUS.RUNNING, TASK_STATUS.QUEUED), true);
});

test('非法转换抛出固定错误码，未知状态单独报 UNKNOWN_STATUS', () => {
    assert.throws(
        () => assertTransition(TASK_STATUS.QUEUED, TASK_STATUS.SUCCEEDED),
        (error) => error instanceof TaskStateError && error.code === 'ILLEGAL_TRANSITION',
    );
    assert.throws(
        () => assertTransition(TASK_STATUS.SUCCEEDED, TASK_STATUS.FAILED),
        (error) => error instanceof TaskStateError && error.code === 'ILLEGAL_TRANSITION',
    );
    assert.throws(
        () => assertTransition('processing', TASK_STATUS.RUNNING),
        (error) => error instanceof TaskStateError && error.code === 'UNKNOWN_STATUS',
    );
    assert.throws(
        () => canTransition(TASK_STATUS.RUNNING, 'done'),
        (error) => error instanceof TaskStateError && error.code === 'UNKNOWN_STATUS',
    );
    assert.equal(assertTransition(TASK_STATUS.QUEUED, TASK_STATUS.RUNNING), true);
});

test('重复终态写入按幂等成功处理，冲突终态必须拒绝而不是覆盖', () => {
    assert.deepEqual(resolveTransition(TASK_STATUS.QUEUED, TASK_STATUS.RUNNING), {
        action: TRANSITION_ACTION.APPLY,
        from: 'queued',
        to: 'running',
    });
    assert.deepEqual(resolveTransition(TASK_STATUS.RUNNING, TASK_STATUS.CANCELLED), {
        action: TRANSITION_ACTION.APPLY,
        from: 'running',
        to: 'cancelled',
    });
    // 同一个终态重复写入：Worker 重试提交完成结果时不应产生第二个副作用。
    for (const terminal of TERMINAL_STATUSES) {
        assert.deepEqual(resolveTransition(terminal, terminal), {
            action: TRANSITION_ACTION.NOOP,
            from: terminal,
            to: terminal,
        });
    }
    // 取消后供应商结果迟到：保留 cancelled，不能被 succeeded 覆盖。
    assert.deepEqual(resolveTransition(TASK_STATUS.CANCELLED, TASK_STATUS.SUCCEEDED), {
        action: TRANSITION_ACTION.CONFLICT,
        from: 'cancelled',
        to: 'succeeded',
    });
    assert.equal(resolveTransition(TASK_STATUS.SUCCEEDED, TASK_STATUS.FAILED).action, TRANSITION_ACTION.CONFLICT);
    assert.equal(resolveTransition(TASK_STATUS.FAILED, TASK_STATUS.QUEUED).action, TRANSITION_ACTION.CONFLICT);
    assert.throws(
        () => resolveTransition(TASK_STATUS.QUEUED, TASK_STATUS.SUCCEEDED),
        (error) => error instanceof TaskStateError && error.code === 'ILLEGAL_TRANSITION',
    );
});

test('失败后的去留由 attempts 与 maxAttempts 决定，边界含最大次数', () => {
    assert.equal(nextStatusAfterFailure({ attempts: 1, maxAttempts: 3 }), TASK_STATUS.QUEUED);
    assert.equal(nextStatusAfterFailure({ attempts: 2, maxAttempts: 3 }), TASK_STATUS.QUEUED);
    assert.equal(nextStatusAfterFailure({ attempts: 3, maxAttempts: 3 }), TASK_STATUS.FAILED);
    assert.equal(nextStatusAfterFailure({ attempts: 1, maxAttempts: 1 }), TASK_STATUS.FAILED);
    for (const input of [{ attempts: -1, maxAttempts: 3 }, { attempts: 1, maxAttempts: 0 }]) {
        assert.throws(() => nextStatusAfterFailure(input), TypeError);
    }
    // attempts 超过 maxAttempts 说明数据已被破坏，不能静默按失败处理。
    assert.throws(() => nextStatusAfterFailure({ attempts: 4, maxAttempts: 3 }), RangeError);
});

test('租约过期只对 running 生效，缺租约的 running 视为状态不一致', () => {
    const now = new Date('2026-11-09T10:00:00.000Z');
    assert.equal(isLeaseExpired({ status: TASK_STATUS.RUNNING, leaseExpiresAt: '2026-11-09T09:59:59.000Z', now }), true);
    assert.equal(isLeaseExpired({ status: TASK_STATUS.RUNNING, leaseExpiresAt: '2026-11-09T10:00:00.000Z', now }), true);
    assert.equal(isLeaseExpired({ status: TASK_STATUS.RUNNING, leaseExpiresAt: new Date('2026-11-09T10:00:01.000Z'), now }), false);
    // queued 的租约字段必须是 NULL，过期判断不适用于它。
    assert.equal(isLeaseExpired({ status: TASK_STATUS.QUEUED, leaseExpiresAt: null, now }), false);
    assert.equal(isLeaseExpired({ status: TASK_STATUS.SUCCEEDED, leaseExpiresAt: null, now }), false);
    assert.throws(
        () => isLeaseExpired({ status: TASK_STATUS.RUNNING, leaseExpiresAt: null, now }),
        (error) => error instanceof TaskStateError && error.code === 'LEASE_INCONSISTENT',
    );
    assert.throws(
        () => isLeaseExpired({ status: TASK_STATUS.RUNNING, leaseExpiresAt: 'not-a-date', now }),
        TypeError,
    );
});

test('取消路径区分未领取立即取消与执行中协作取消', () => {
    assert.equal(cancelPathFor(TASK_STATUS.QUEUED), CANCEL_PATH.IMMEDIATE);
    assert.equal(cancelPathFor(TASK_STATUS.RUNNING), CANCEL_PATH.COOPERATIVE);
    for (const terminal of TERMINAL_STATUSES) {
        assert.equal(cancelPathFor(terminal), null);
    }
    assert.throws(() => cancelPathFor('cancelling'), (error) => error.code === 'UNKNOWN_STATUS');
});

test('taskQueue 复用同一份状态定义，避免队列与状态机漂移', () => {
    assert.equal(taskQueue.TASK_STATUS, TASK_STATUS);
});

test('数据库状态约束与状态机保持同步（schema 与最新 snapshot）', () => {
    const schemaSource = fs.readFileSync(path.join(__dirname, '../lib/server/db/schema.js'), 'utf8');
    const statusCheck = schemaSource.match(/generation_tasks_status_check[^)]*IN \(([^)]*)\)/);
    assert.ok(statusCheck, 'schema.js 必须包含 generation_tasks_status_check');
    const schemaStatuses = statusCheck[1].split(',').map((value) => value.trim().replace(/^'|'$/g, ''));

    const journal = require('../drizzle/meta/_journal.json');
    const latest = journal.entries.at(-1);
    const snapshotFile = `${latest.tag.split('_')[0]}_snapshot.json`;
    const snapshot = require(`../drizzle/meta/${snapshotFile}`);
    const check = snapshot.tables['public.generation_tasks'].checkConstraints['generation_tasks_status_check'];
    const snapshotStatuses = [...check.value.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);

    assert.deepEqual(schemaStatuses, ALL_TASK_STATUSES);
    assert.deepEqual(snapshotStatuses, ALL_TASK_STATUSES);
    assert.ok(
        fs.existsSync(path.join(__dirname, '../drizzle/0012_task_cancellation.sql')),
        '扩展状态约束必须保留对应迁移文件',
    );
});
