const test = require('node:test');
const assert = require('node:assert/strict');
const {
    CALL_STATUS,
    ProviderCallLedgerError,
    beginProviderCall,
    claimProviderCallForRecovery,
    markProviderCallAccepted,
    markProviderCallTerminal,
    markProviderCallUnknown,
    releaseProviderCallForRecovery,
} = require('../lib/server/providers/providerCallLedger');

function scriptedPool(results) {
    const calls = [];
    return {
        calls,
        async query(text, values) {
            calls.push({ text, values });
            const next = results.shift();
            if (next instanceof Error) throw next;
            return next || { rowCount: 0, rows: [] };
        },
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

const call = {
    id: '00000000-0000-4000-8000-000000000001',
    task_id: '00000000-0000-4000-8000-000000000002',
    attempt_no: 1,
    provider_name: 'mock-provider',
    idempotency_key: 'task-attempt-key',
    status: CALL_STATUS.UNKNOWN,
    lease_token: '00000000-0000-4000-8000-000000000003',
    worker_id: 'worker-a',
};

test('beginProviderCall persists one submitting intent with stable identity and recovery lease', async () => {
    const pool = scriptedPool([{ rowCount: 1, rows: [{ ...call, status: CALL_STATUS.SUBMITTING }] }]);
    const result = await beginProviderCall(pool, {
        taskId: call.task_id,
        attemptNo: 1,
        providerName: 'mock-provider',
        idempotencyKey: 'task-attempt-key',
        workerId: 'worker-a',
        leaseSeconds: 30,
    });
    assert.equal(result.status, CALL_STATUS.SUBMITTING);
    assert.equal(result.idempotency_key, 'task-attempt-key');
    assert.match(pool.calls[1].text, /ON CONFLICT \(task_id, attempt_no\) DO NOTHING/);
    assert.match(pool.calls[1].text, /lease_expires_at/);
    assert.deepEqual(pool.calls.slice(-1)[0], { text: 'COMMIT', values: undefined });
});

test('unknown submission is persisted only by the active owner and lease token', async () => {
    const pool = scriptedPool([{ rowCount: 1, rows: [{ ...call, status: CALL_STATUS.UNKNOWN }] }]);
    await markProviderCallUnknown(pool, {
        callId: call.id,
        workerId: 'worker-a',
        leaseToken: call.lease_token,
        errorCode: 'NETWORK_TIMEOUT',
    });
    assert.match(pool.calls[0].text, /status = \$4 AND worker_id = \$5 AND lease_token = \$6::uuid/);
    assert.ok(pool.calls[0].values.includes('NETWORK_TIMEOUT'));

    const stalePool = scriptedPool([{ rowCount: 0, rows: [] }]);
    await assert.rejects(markProviderCallUnknown(stalePool, {
        callId: call.id,
        workerId: 'worker-old',
        leaseToken: 'stale-token',
        errorCode: 'NETWORK_TIMEOUT',
    }), (error) => error instanceof ProviderCallLedgerError && error.code === 'LEASE_LOST');
});

test('recovery claim selects submitting/unknown/accepted calls and uses SKIP LOCKED', async () => {
    const pool = scriptedPool([
        { rowCount: 1, rows: [{ ...call, status: CALL_STATUS.UNKNOWN }] },
        { rowCount: 1, rows: [{ ...call, worker_id: 'worker-b', lease_token: 'new-token' }] },
    ]);
    const claimed = await claimProviderCallForRecovery(pool, { workerId: 'worker-b', leaseSeconds: 45 });
    assert.equal(claimed.worker_id, 'worker-b');
    assert.match(pool.calls.find((entry) => /SELECT \* FROM provider_calls/.test(entry.text)).text, /FOR UPDATE SKIP LOCKED/);
    // accepted 调用同样需要被恢复领取（用于轮询已受理任务），不只是 unknown 提交。
    const selectEntry = pool.calls.find((entry) => /SELECT \* FROM provider_calls/.test(entry.text));
    assert.deepEqual(selectEntry.values[0], [CALL_STATUS.SUBMITTING, CALL_STATUS.UNKNOWN, CALL_STATUS.ACCEPTED]);
    // 租约 NULL 也必须可领取：unknown/accepted 的自然状态就是 NULL 租约，
    // 只写 `lease_expires_at <= now()` 会因 NULL 比较恒为 NULL 而永远领不到。
    assert.match(selectEntry.text, /lease_expires_at IS NULL OR lease_expires_at <= now\(\)/);
    // 退避窗口属于 available_at，不能塞回租约列（租约列表达“谁持有”，不是“何时能领”）。
    assert.match(selectEntry.text, /available_at <= now\(\)/);
    // accepted 但缺 provider_job_id 的调用不可恢复，必须在 SQL 层直接排除。
    assert.match(selectEntry.text, /status <> \$3 OR provider_job_id IS NOT NULL/);
    // 每次恢复领取必须累计 recovery_attempts，避免无限重试被静默吞掉。
    const updateEntry = pool.calls.find((entry) => /UPDATE provider_calls/.test(entry.text));
    assert.match(updateEntry.text, /recovery_attempts = recovery_attempts \+ 1/);
});

test('attempt 已存在时 beginProviderCall 不接管，只要求走恢复领取', async () => {
    const pool = scriptedPool([
        { rowCount: 0, rows: [] },
        { rowCount: 1, rows: [{ ...call, status: CALL_STATUS.ACCEPTED, provider_job_id: 'provider-job-1' }] },
    ]);
    await assert.rejects(
        beginProviderCall(pool, {
            taskId: call.task_id,
            attemptNo: 1,
            providerName: 'mock-provider',
            idempotencyKey: 'task-attempt-key',
            workerId: 'worker-b',
            leaseSeconds: 30,
        }),
        (error) => error instanceof ProviderCallLedgerError && error.code === 'ATTEMPT_EXISTS',
    );
    // 关键：不得发出任何 UPDATE 去抢租约，接管职责唯一的入口是 claimProviderCallForRecovery。
    assert.equal(pool.calls.some((entry) => /UPDATE provider_calls/.test(entry.text)), false);
});

test('attempt 身份不一致时拒绝，而不是静默复用别人的幂等键', async () => {
    const pool = scriptedPool([
        { rowCount: 0, rows: [] },
        { rowCount: 1, rows: [{ ...call, idempotency_key: 'other-key' }] },
    ]);
    await assert.rejects(
        beginProviderCall(pool, {
            taskId: call.task_id,
            attemptNo: 1,
            providerName: 'mock-provider',
            idempotencyKey: 'task-attempt-key',
            workerId: 'worker-b',
            leaseSeconds: 30,
        }),
        (error) => error instanceof ProviderCallLedgerError && error.code === 'ATTEMPT_IDENTITY_MISMATCH',
    );
});

test('recovery release clears the lease, keeps unknown state and backs off via available_at', async () => {
    const pool = scriptedPool([{ rowCount: 1, rows: [{ ...call, status: CALL_STATUS.UNKNOWN, worker_id: null }] }]);
    await releaseProviderCallForRecovery(pool, {
        callId: call.id,
        workerId: 'worker-a',
        leaseToken: call.lease_token,
        errorCode: 'NETWORK_UNAVAILABLE',
        retryDelaySeconds: 10,
    });
    assert.match(pool.calls[0].text, /status = \$4 AND worker_id = \$5 AND lease_token = \$6::uuid/);
    assert.match(pool.calls[0].text, /worker_id = NULL, lease_token = NULL, lease_expires_at = NULL/);
    assert.match(pool.calls[0].text, /available_at = now\(\) \+/);
    assert.ok(pool.calls[0].values.includes(10));
});

test('accepted and terminal transitions require a valid active lease', async () => {
    const acceptedPool = scriptedPool([{ rowCount: 1, rows: [{ ...call, status: CALL_STATUS.ACCEPTED }] }]);
    await markProviderCallAccepted(acceptedPool, {
        callId: call.id,
        workerId: 'worker-a',
        leaseToken: call.lease_token,
        providerJobId: 'provider-job-1',
    });
    assert.ok(acceptedPool.calls[0].values.includes('provider-job-1'));
    assert.match(acceptedPool.calls[0].text, /lease_expires_at > now\(\)/);

    const terminalPool = scriptedPool([{ rowCount: 1, rows: [{ ...call, status: CALL_STATUS.SUCCEEDED }] }]);
    await markProviderCallTerminal(terminalPool, {
        callId: call.id,
        workerId: 'worker-a',
        leaseToken: call.lease_token,
        status: CALL_STATUS.SUCCEEDED,
    });
    assert.equal(terminalPool.calls[0].values[0], CALL_STATUS.SUCCEEDED);

    const stalePool = scriptedPool([{ rowCount: 0, rows: [] }]);
    await assert.rejects(markProviderCallAccepted(stalePool, {
        callId: call.id,
        workerId: 'worker-old',
        leaseToken: 'stale-token',
        providerJobId: 'provider-job-1',
    }), (error) => error instanceof ProviderCallLedgerError && error.code === 'LEASE_LOST');
});
