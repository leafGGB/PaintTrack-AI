const assert = require('node:assert/strict');
const {
    CALL_STATUS,
    beginProviderCall,
    claimProviderCallForRecovery,
    markProviderCallAccepted,
    markProviderCallSucceeded,
    markProviderCallUnknown,
    releaseProviderCallForRecovery,
} = require('../../lib/server/providers/providerCallLedger');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function createTask(pool, marker, createdTasks) {
    const result = await pool.query(
        `INSERT INTO generation_tasks(owner_id,idempotency_key,request_fingerprint,task_type,payload)
         VALUES ($1::uuid,$2,$3,$4,$5::jsonb) RETURNING id`,
        [
            '00000000-0000-4000-8000-000000000010',
            `ledger:${marker}:${Date.now()}:${createdTasks.length}`,
            'c'.repeat(64),
            'provider-call-ledger-fixture',
            JSON.stringify({ marker }),
        ],
    );
    createdTasks.push(result.rows[0].id);
    return result.rows[0].id;
}

async function checkProviderCallLedger(pool, record, { webPool, owner }) {
    const createdTasks = [];
    try {
        await runChecks(pool, record, createdTasks, webPool);
    } finally {
        // 本夹具在共享隔离库上跑，后面的 Worker 验收要求 generation_tasks 从空表开始，
        // 因此无论断言是否失败都必须清掉自己造的数据，否则会把后续验收污染成假失败。
        if (createdTasks.length > 0) {
            await owner.query('DELETE FROM provider_calls WHERE task_id = ANY($1::uuid[])', [createdTasks]);
            await owner.query('DELETE FROM generation_tasks WHERE id = ANY($1::uuid[])', [createdTasks]);
        }
    }
}

async function runChecks(pool, record, createdTasks, webPool) {
    const taskId = await createTask(webPool, 'unknown-recovery', createdTasks);
    const idempotencyKey = `painttrack:${taskId}:attempt:1`;
    const started = await beginProviderCall(pool, {
        taskId,
        attemptNo: 1,
        providerName: 'mock-provider',
        idempotencyKey,
        workerId: 'provider-worker-a',
        leaseSeconds: 30,
    });
    assert.equal(started.status, CALL_STATUS.SUBMITTING);
    assert.match(started.lease_token, UUID_PATTERN);

    const duplicate = await Promise.allSettled([
        beginProviderCall(pool, {
            taskId,
            attemptNo: 1,
            providerName: 'mock-provider',
            idempotencyKey,
            workerId: 'provider-worker-b',
            leaseSeconds: 30,
        }),
    ]);
    assert.equal(duplicate[0].status, 'rejected');
    assert.equal(duplicate[0].reason.code, 'ATTEMPT_EXISTS');
    // 同一个 (task_id, attempt_no) 只能有一条不可变身份记录，幂等键必须稳定。
    const rowCount = await pool.query('SELECT count(*)::int AS n FROM provider_calls WHERE task_id=$1', [taskId]);
    assert.equal(rowCount.rows[0].n, 1);

    await markProviderCallUnknown(pool, {
        callId: started.id,
        workerId: 'provider-worker-a',
        leaseToken: started.lease_token,
        errorCode: 'NETWORK_TIMEOUT',
    });
    const persisted = await pool.query(
        'SELECT status, idempotency_key, provider_job_id, last_error_code FROM provider_calls WHERE id=$1',
        [started.id],
    );
    assert.deepEqual(persisted.rows[0], {
        status: CALL_STATUS.UNKNOWN,
        idempotency_key: idempotencyKey,
        provider_job_id: null,
        last_error_code: 'NETWORK_TIMEOUT',
    });

    const recovered = await claimProviderCallForRecovery(pool, { workerId: 'provider-recovery-a', leaseSeconds: 30, taskId });
    assert.equal(recovered.id, started.id);
    assert.equal(recovered.idempotency_key, idempotencyKey);
    assert.equal(recovered.recovery_attempts, 1);
    assert.match(recovered.lease_token, UUID_PATTERN);
    assert.equal(await claimProviderCallForRecovery(pool, { workerId: 'provider-recovery-b', leaseSeconds: 30, taskId }), null);
    await assert.rejects(markProviderCallAccepted(pool, {
        callId: recovered.id,
        workerId: 'provider-recovery-a',
        leaseToken: started.lease_token,
        providerJobId: 'stale-job',
    }), { code: 'LEASE_LOST' });

    await markProviderCallAccepted(pool, {
        callId: recovered.id,
        workerId: 'provider-recovery-a',
        leaseToken: recovered.lease_token,
        providerJobId: 'mock-job-recovered',
    });
    const accepted = await pool.query('SELECT status, provider_job_id, worker_id, lease_token FROM provider_calls WHERE id=$1', [started.id]);
    assert.deepEqual(accepted.rows[0], {
        status: CALL_STATUS.ACCEPTED,
        provider_job_id: 'mock-job-recovered',
        worker_id: null,
        lease_token: null,
    });

    const previousRecoveryToken = recovered.lease_token;
    // 不手工改 lease_expires_at：accepted 的自然状态就是 NULL 租约，
    // 若这里靠手改时间才能领取，说明恢复条件写错了（NULL 与 now() 比较恒为 NULL）。
    const afterAcceptedRecovery = await claimProviderCallForRecovery(pool, {
        workerId: 'provider-poller',
        leaseSeconds: 30,
        taskId,
    });
    assert.equal(afterAcceptedRecovery.status, CALL_STATUS.ACCEPTED);
    assert.equal(afterAcceptedRecovery.provider_job_id, 'mock-job-recovered');
    assert.match(afterAcceptedRecovery.lease_token, UUID_PATTERN);
    assert.notEqual(afterAcceptedRecovery.lease_token, previousRecoveryToken);
    assert.equal(afterAcceptedRecovery.recovery_attempts, 2);
    await markProviderCallSucceeded(pool, {
        callId: started.id,
        workerId: 'provider-poller',
        leaseToken: afterAcceptedRecovery.lease_token,
    });
    const succeeded = await pool.query('SELECT status FROM provider_calls WHERE id=$1', [started.id]);
    assert.equal(succeeded.rows[0].status, CALL_STATUS.SUCCEEDED);

    const taskTwo = await createTask(webPool, 'stale-recovery-lease', createdTasks);
    const startedTwo = await beginProviderCall(pool, {
        taskId: taskTwo,
        attemptNo: 1,
        providerName: 'mock-provider',
        idempotencyKey: `painttrack:${taskTwo}:attempt:1`,
        workerId: 'provider-worker-c',
        leaseSeconds: 30,
    });
    await markProviderCallUnknown(pool, {
        callId: startedTwo.id,
        workerId: 'provider-worker-c',
        leaseToken: startedTwo.lease_token,
        errorCode: 'NETWORK_TIMEOUT',
    });
    // 注意：不要手工只改 lease_expires_at。lease_consistency_check 要求
    // worker_id / lease_token / lease_expires_at 同时为 NULL 或同时非 NULL，
    // 单独塞一个过期时间会直接触发 CHECK 约束失败。unknown 的 NULL 租约本身就可领取。
    const leaseOne = await claimProviderCallForRecovery(pool, { workerId: 'recovery-one', leaseSeconds: 30, taskId: taskTwo });
    await assert.rejects(markProviderCallAccepted(pool, {
        callId: startedTwo.id,
        workerId: 'provider-worker-c',
        leaseToken: startedTwo.lease_token,
        providerJobId: 'stale-job',
    }), { code: 'LEASE_LOST' });

    // 退避窗口：释放后必须真的领取不到，否则退避等于没写。
    await releaseProviderCallForRecovery(pool, {
        callId: leaseOne.id,
        workerId: 'recovery-one',
        leaseToken: leaseOne.lease_token,
        errorCode: 'NETWORK_UNAVAILABLE',
        retryDelaySeconds: 60,
    });
    const released = await pool.query('SELECT status, worker_id, lease_token, lease_expires_at, available_at FROM provider_calls WHERE id=$1', [startedTwo.id]);
    assert.equal(released.rows[0].status, CALL_STATUS.UNKNOWN);
    assert.equal(released.rows[0].worker_id, null);
    assert.equal(released.rows[0].lease_token, null);
    assert.equal(released.rows[0].lease_expires_at, null);
    assert.ok(released.rows[0].available_at.getTime() > Date.now());
    assert.equal(await claimProviderCallForRecovery(pool, { workerId: 'recovery-too-early', leaseSeconds: 30, taskId: taskTwo }), null);

    // 把可领取时间拨回当前，仅用于验证“窗口到期后能正常领取”，不代表实现依赖手工改状态。
    await pool.query('UPDATE provider_calls SET available_at = now() WHERE id=$1', [startedTwo.id]);
    const leaseTwo = await claimProviderCallForRecovery(pool, { workerId: 'recovery-two', leaseSeconds: 30, taskId: taskTwo });
    assert.notEqual(leaseTwo.lease_token, leaseOne.lease_token);
    assert.equal(leaseTwo.recovery_attempts, 2);

    record('provider_calls 持久化未知提交、稳定幂等键、恢复互斥、退避窗口、accepted轮询恢复及租约fencing通过', 'passed');
}

module.exports = { checkProviderCallLedger };
