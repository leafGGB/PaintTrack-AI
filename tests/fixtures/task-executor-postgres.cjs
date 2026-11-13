const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const queue = require('../../lib/server/worker/taskQueue');
const { createTaskProcessor } = require('../../lib/server/worker/taskExecutor');
const { createMockProvider } = require('../../lib/server/providers/mockProvider');
const { createAssetArchive } = require('../../lib/server/assetArchive');
const { MemoryObjectStore } = require('../../lib/server/storage/memoryObjectStore');

const PROVIDER = createMockProvider();
const WORKER_ID = 'executor-acceptance-worker';
const RUN = randomBytes(4).toString('hex');
let sequence = 0;

async function createTask(pool, { payload, maxAttempts = 3 }) {
    const taskType = `executor-acceptance-${RUN}-${++sequence}`;
    const result = await pool.query(
        `INSERT INTO generation_tasks
            (owner_id, idempotency_key, request_fingerprint, task_type, payload, max_attempts, available_at, updated_at)
         VALUES ($1::uuid, $2, $3, $4, $5::jsonb, $6, now(), now())
         RETURNING *`,
        [
            randomUUID(),
            `accept:executor:${RUN}:${sequence}`,
            randomBytes(32).toString('hex'),
            taskType,
            JSON.stringify(payload),
            maxAttempts,
        ],
    );
    return result.rows[0];
}

function claim(pool, task) {
    return queue.claimNextTask(pool, {
        workerId: WORKER_ID,
        leaseSeconds: 60,
        taskType: task.task_type,
    });
}

async function row(pool, table, id) {
    const result = await pool.query(`SELECT * FROM ${table} WHERE id = $1`, [id]);
    return result.rows[0];
}

async function calls(pool, taskId) {
    const result = await pool.query(
        'SELECT * FROM provider_calls WHERE task_id = $1 ORDER BY attempt_no',
        [taskId],
    );
    return result.rows;
}

async function checkTaskExecutor(pool, record, { webPool, owner }) {
    const created = [];
    const createdAssets = [];
    const objectStore = new MemoryObjectStore();
    const assetArchive = createAssetArchive({ pool, objectStore });
    const processTask = createTaskProcessor({ pool, provider: PROVIDER, workerId: WORKER_ID, poll: { minDelayMs: 2, maxDelayMs: 5 } });
    try {
        // 0. bytes 结果在 Worker 的窄列授权下归档，并由同一事务提交任务描述符与资产记录。
        const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
        const binaryProvider = {
            name: `${PROVIDER.name}-binary-archive`,
            async submit() { return { kind: 'completed', providerJobId: `archive-${randomUUID()}`, result: { mediaType: 'image', mimeType: 'image/png', bytes } }; },
            async query() { throw new Error('binary sync provider must not be polled'); },
        };
        const archiveProcess = createTaskProcessor({ pool, provider: binaryProvider, workerId: WORKER_ID, assetArchive });
        const archiveTask = await createTask(webPool, { payload: { archiveProbe: true } });
        created.push(archiveTask.id);
        const archiveOutcome = await archiveProcess(await claim(pool, archiveTask), {});
        assert.equal(archiveOutcome.status, 'succeeded');
        assert.equal(archiveOutcome.result.archive, 'ready');
        assert.equal(archiveOutcome.result.mediaType, 'image');
        assert.equal(archiveOutcome.result.sizeBytes, bytes.length);
        assert.equal(archiveOutcome.result.resultUrl, `/api/assets/${archiveOutcome.result.assetId}/content`);
        const archivedRow = await owner.query('SELECT owner_id,media_type,mime_type,size_bytes,status,storage_key,checksum_sha256 FROM assets WHERE id=$1', [archiveOutcome.result.assetId]);
        assert.equal(archivedRow.rowCount, 1);
        assert.equal(archivedRow.rows[0].owner_id, archiveTask.owner_id);
        assert.equal(archivedRow.rows[0].status, 'ready');
        assert.equal(archivedRow.rows[0].storage_key, `users/${archiveTask.owner_id}/assets/${archiveOutcome.result.assetId}`);
        assert.equal((await objectStore.getObject({ key: archivedRow.rows[0].storage_key })).body.compare(bytes), 0);
        createdAssets.push({ id: archiveOutcome.result.assetId, key: archivedRow.rows[0].storage_key });
        record('Worker列级授权归档二进制结果并提交任务可预览描述符', 'passed');

        // 1. 同步完成：调用记录与任务终态必须同时落库，结果只保存描述符。```
        const syncTask = await createTask(webPool, { payload: { mock: { mode: 'sync' } } });
        created.push(syncTask.id);
        const syncClaim = await claim(pool, syncTask);
        assert.equal(syncClaim.id, syncTask.id);
        assert.equal(syncClaim.attempts, 1);
        const syncOutcome = await processTask(syncClaim, {});
        assert.equal(syncOutcome.status, 'succeeded');
        const syncRow = await row(pool, 'generation_tasks', syncTask.id);
        assert.equal(syncRow.status, 'succeeded');
        // 图片 mock 现在返回真实 PNG 二进制（不再返回文本摘要），因此走 URL/二进制分支，
        // 描述符 kind 固定为 'asset'；视频 mock 仍走内联 asset 分支并保留 'mock-asset'。
        assert.equal(syncRow.result.kind, 'asset');
        assert.equal(syncRow.result.mediaType, 'image');
        assert.equal(syncRow.result.archive, 'not_configured');
        assert.equal(JSON.stringify(syncRow.result).includes('mock-result'), false);
        assert.equal(syncRow.lease_token, null);
        const [syncCall] = await calls(pool, syncTask.id);
        assert.equal(syncCall.status, 'succeeded');
        assert.equal(syncCall.attempt_no, 1);
        assert.equal(syncCall.worker_id, null);
        record('执行器同步成功：任务终态与调用记录同一事务落库且结果不含生成内容', 'passed');

        // 2. 异步受理：轮询到成功，调用记录保留 provider_job_id。
        const asyncTask = await createTask(webPool, { payload: { mock: { mode: 'async' } } });
        created.push(asyncTask.id);
        const asyncOutcome = await processTask(await claim(pool, asyncTask), {});
        assert.equal(asyncOutcome.status, 'succeeded');
        const [asyncCall] = await calls(pool, asyncTask.id);
        assert.equal(asyncCall.status, 'succeeded');
        assert.ok(asyncCall.provider_job_id);
        record('执行器异步受理：租约内轮询到成功并保留供应商任务号', 'passed');

        // 3. 未知提交：只退避重试，不新建第二个提交轮次。
        const unknownTask = await createTask(webPool, { payload: { mock: { unknownSubmit: true } } });
        created.push(unknownTask.id);
        const unknownClaim = await claim(pool, unknownTask);
        await assert.rejects(
            processTask(unknownClaim, {}),
            (error) => error.code === 'PROVIDER_SUBMISSION_UNKNOWN' && error.taskFailure.terminal === false,
        );
        let unknownCalls = await calls(pool, unknownTask.id);
        assert.equal(unknownCalls.length, 1);
        assert.equal(unknownCalls[0].status, 'unknown');
        await queue.failTask(pool, {
            taskId: unknownTask.id,
            leaseToken: unknownClaim.lease_token,
            errorMessage: 'PROVIDER_SUBMISSION_UNKNOWN',
            retryDelaySeconds: 0,
        });
        await pool.query('UPDATE generation_tasks SET available_at = now() WHERE id = $1', [unknownTask.id]);
        const recoveredClaim = await claim(pool, unknownTask);
        assert.equal(recoveredClaim.attempts, 2);
        const recovered = await processTask(recoveredClaim, {});
        assert.equal(recovered.status, 'succeeded');
        unknownCalls = await calls(pool, unknownTask.id);
        assert.equal(unknownCalls.length, 1);
        assert.equal(unknownCalls[0].attempt_no, 1);
        assert.equal(unknownCalls[0].status, 'succeeded');
        record('未知提交恢复：复用同一调用轮次与幂等键，不产生重复提交记录', 'passed');

        // 4. 可重试失败：任务回队列并带退避，调用记录终态失败。
        const retryTask = await createTask(webPool, { payload: { mock: { error: 'RATE_LIMITED' } } });
        created.push(retryTask.id);
        const retryClaim = await claim(pool, retryTask);
        let retryFailure;
        await assert.rejects(processTask(retryClaim, {}), (error) => {
            retryFailure = error.taskFailure;
            return error.code === 'RATE_LIMITED' && error.taskFailure.terminal === false;
        });
        assert.equal(retryFailure.retryDelaySeconds, 30);
        await queue.failTask(pool, {
            taskId: retryTask.id,
            leaseToken: retryClaim.lease_token,
            ...retryFailure,
        });
        const retryRow = await row(pool, 'generation_tasks', retryTask.id);
        assert.equal(retryRow.status, 'queued');
        assert.equal(retryRow.last_error, 'RATE_LIMITED');
        assert.ok(retryRow.available_at > new Date());
        const [retryCall] = await calls(pool, retryTask.id);
        assert.equal(retryCall.status, 'failed');
        assert.equal(retryCall.last_error_code, 'RATE_LIMITED');
        record('可重试失败：任务带退避回队列，调用记录终结为 failed', 'passed');

        // 5. 终态失败：供应商拒绝请求不消耗剩余重试预算。
        const fatalTask = await createTask(webPool, { payload: { mock: { error: 'INVALID_REQUEST' } } });
        created.push(fatalTask.id);
        const fatalClaim = await claim(pool, fatalTask);
        let fatalFailure;
        await assert.rejects(processTask(fatalClaim, {}), (error) => {
            fatalFailure = error.taskFailure;
            return error.code === 'INVALID_REQUEST' && error.taskFailure.terminal === true;
        });
        await queue.failTask(pool, {
            taskId: fatalTask.id,
            leaseToken: fatalClaim.lease_token,
            ...fatalFailure,
        });
        const fatalRow = await row(pool, 'generation_tasks', fatalTask.id);
        assert.equal(fatalRow.status, 'failed');
        assert.equal(fatalRow.result, null);
        assert.ok(fatalRow.completed_at);
        assert.equal(fatalRow.attempts, 1);
        record('终态失败：一次领取即 failed，不被剩余重试次数重新排队', 'passed');

        // 6. 租约丢失：成功写入必须整体回滚，不能出现"调用成功但任务未完成"。
        //    租约在供应商提交途中过期（而不是提交前），才能覆盖"调用已登记、任务尚未结算"的窗口。
        const losingTask = await createTask(webPool, { payload: { mock: { mode: 'sync' } } });
        created.push(losingTask.id);
        const losingClaim = await claim(pool, losingTask);
        const expiringProvider = {
            name: `${PROVIDER.name}-lease-expiry`,
            async submit(input, context) {
                await pool.query(
                    `UPDATE generation_tasks SET lease_expires_at = now() - interval '1 second' WHERE id = $1`,
                    [input.taskId],
                );
                return PROVIDER.submit(input, context);
            },
            query: (...args) => PROVIDER.query(...args),
        };
        const expiringProcess = createTaskProcessor({
            pool, provider: expiringProvider, workerId: WORKER_ID, poll: { minDelayMs: 2, maxDelayMs: 5 },
        });
        await assert.rejects(
            expiringProcess(losingClaim, {}),
            (error) => error instanceof queue.TaskQueueError && error.code === 'LEASE_LOST',
        );
        const losingRow = await row(pool, 'generation_tasks', losingTask.id);
        assert.equal(losingRow.status, 'running');
        assert.equal(losingRow.result, null);
        const [losingCall] = await calls(pool, losingTask.id);
        assert.equal(losingCall.status, 'submitting');
        assert.ok(losingCall.worker_id);
        record('租约丢失：调用成功与任务成功整体回滚，不留下半完成状态', 'passed');

        // 7. 已登记取消：执行器在提交前就停止，不产生任何供应商调用记录。
        const cancelTask = await createTask(webPool, { payload: { mock: { mode: 'sync' } } });
        created.push(cancelTask.id);
        const cancelClaim = await claim(pool, cancelTask);
        await webPool.query('UPDATE generation_tasks SET cancel_requested_at = now() WHERE id = $1', [cancelTask.id]);
        await assert.rejects(
            processTask(cancelClaim, {}),
            (error) => error.code === 'TASK_CANCELLED' && error.cancelled === true,
        );
        assert.equal((await calls(pool, cancelTask.id)).length, 0);
        assert.equal((await row(pool, 'generation_tasks', cancelTask.id)).status, 'running');
        const cancelled = await queue.cancelClaimedTask(pool, {
            taskId: cancelTask.id,
            leaseToken: cancelClaim.lease_token,
        });
        assert.equal(cancelled.status, 'cancelled');
        assert.ok(cancelled.completed_at);
        record('执行器尊重取消意图：提交前停止且不创建供应商调用', 'passed');
    } finally {
        if (createdAssets.length > 0) {
            await owner.query('DELETE FROM assets WHERE id = ANY($1::uuid[])', [createdAssets.map((asset) => asset.id)]);
            for (const asset of createdAssets) await objectStore.deleteObject({ key: asset.key });
        }
        if (created.length > 0) {
            await owner.query('DELETE FROM provider_calls WHERE task_id = ANY($1::uuid[])', [created]);
            await owner.query('DELETE FROM generation_tasks WHERE id = ANY($1::uuid[])', [created]);
        }
    }
}

module.exports = { checkTaskExecutor };
