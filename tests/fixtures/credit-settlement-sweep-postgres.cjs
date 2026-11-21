const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { createAtomicTaskPricingStore } = require('../../lib/server/tasks/atomicTaskPricing');
const { createInternalPricingStore } = require('../../lib/server/tasks/pricingPersistence');
const { createModelRouteResolver } = require('../../lib/server/tasks/modelRouteResolver');
const { createCreditSettlementStore } = require('../../lib/server/tasks/creditSettlement');
const queue = require('../../lib/server/worker/taskQueue');

const userId = '88888888-8888-4888-8888-888888888888';
const modelPk = '99999999-9999-4999-8999-999999999999';
const modelId = 'sweep-acceptance-model';
const WORKER_ID = 'pt-sweep-fixture-worker';
const catalogEntry = {
    id: modelPk, logicalModelId: modelId, catalogVersion: 1, enabled: true,
    mediaType: 'image', supportedOperations: ['image.generate'],
    bindings: [{
        id: 'sweep-binding', enabled: true, isPrimary: true, bindingVersion: 1,
        providerInstance: { id: 'sweep-provider', enabled: true, configVersion: 1, credentialVersion: 1, adapterType: 'synthetic' },
        providerModel: { id: 'sweep-upstream', enabled: true, validationState: 'verified', mediaType: 'image',
            capabilities: { operations: ['image.generate'] }, upstreamModelName: 'sweep-upstream-model',
            adapterVersion: '1', operationProfile: 'image.generate', requestMappingVersion: 1, responseMappingVersion: 1 },
    }],
};

async function checkCreditSettlementSweep(admin, migrationClient, pools, names, adminUrl, record) {
    const config = {
        modelId, modelVersion: 1, pricingVersion: 'sweep-v1', enabled: true,
        templateType: 'image_resolution_quantity', currencyUnit: 'credit_tenths',
        roundingMode: 'ceil_to_atom', precisionVersion: 'integer_rational_ms_v1',
        roundingModeVersion: 'ceil_to_atom_v1', quantityMode: 'per_unit', maxOutputCount: 1,
        resolutions: [{ resolutionKey: '1024x1024', enabled: true, unitPriceTenths: '7' }],
    };
    const request = { taskType: 'image.generate', payload: {
        logicalModelId: modelId, prompt: '终态结算扫描验收', aspectRatio: '1:1', size: '1024x1024', outputCount: 1,
    } };
    const balances = async () => (await admin.query(
        'SELECT available_tenths::text AS available, reserved_tenths::text AS reserved FROM public.credit_accounts WHERE user_id=$1',
        [userId])).rows[0];
    const backing = new Pool({ connectionString: adminUrl, max: 8, connectionTimeoutMillis: 3000 });
    // 业务入口只接受专用owner身份：BEGIN后立即SET LOCAL ROLE，不把管理员权限带进事务。
    const poolForOwner = { async connect() {
        const client = await backing.connect();
        return { async query(sql, values) {
            const result = await client.query(sql, values);
            if (sql.startsWith('BEGIN')) await client.query(`SET LOCAL ROLE "${names.ledgerOwnerRole}"`);
            return result;
        }, release() { client.release(); } };
    } };
    // 需要显式控制事务边界的负向断言（例如"owner 仍然不能改冻结行"）走这个包装。
    const asOwner = async run => {
        const client = await backing.connect();
        try {
            await client.query('BEGIN');
            await client.query(`SET LOCAL ROLE "${names.ledgerOwnerRole}"`);
            return await run(client);
        } finally {
            await client.query('ROLLBACK').catch(() => {});
            client.release();
        }
    };
    const workerPool = pools[1];
    const createdTasks = [];
    try {
        await admin.query('INSERT INTO public.users(id,email,password_hash) VALUES ($1,$2,$3)',
            [userId, `sweep-${userId}@example.test`, `scrypt:32768:8:3:${'a'.repeat(32)}:${'b'.repeat(128)}`]);
        await admin.query(`INSERT INTO public.logical_models(id,logical_model_id,display_name,media_type,supported_operations,enabled)
            VALUES ($1,$2,'结算扫描PG模型','image',$3::jsonb,true)`, [modelPk, modelId, JSON.stringify(['image.generate'])]);
        const effectiveFromUs = (await admin.query(`SELECT ((floor(extract(epoch FROM clock_timestamp()))+2)*1000000)::text AS us`)).rows[0].us;
        await createInternalPricingStore({ pool: poolForOwner }).publishScheduled({ config, effectiveFromUs });
        await admin.query(`SELECT pg_sleep(greatest(0,$1::numeric/1000000-extract(epoch FROM clock_timestamp())+0.01))`, [effectiveFromUs]);
        await admin.query('INSERT INTO public.credit_accounts(user_id,available_tenths,reserved_tenths) VALUES ($1,21,0)', [userId]);

        // 前置夹具必须已清空排队任务：claimNextTask 是全局扫描，否则会领走别人的任务。
        assert.equal((await admin.query("SELECT count(*)::int AS n FROM public.generation_tasks WHERE status='queued'")).rows[0].n, 0,
            '结算扫描夹具要求进入时没有遗留排队任务');

        const pricing = createAtomicTaskPricingStore({
            pool: poolForOwner,
            routeResolver: createModelRouteResolver({ catalog: { async getLogicalModel() { return catalogEntry; } } }),
        });
        for (const key of ['sweep-accept-1', 'sweep-accept-2', 'sweep-accept-3']) {
            const submitted = await pricing.submit({ ownerId: userId, idempotencyKey: key, request });
            createdTasks.push(submitted.task.id);
        }
        const mine = new Set(createdTasks);
        assert.deepEqual(await balances(), { available: '0', reserved: '21' });

        // 真实 Worker 路径把三个任务推到三种终态：成功、失败、取消。
        const claimed = new Map();
        for (let index = 0; index < createdTasks.length; index += 1) {
            const task = await queue.claimNextTask(workerPool, { workerId: WORKER_ID });
            assert.ok(task, '应当能领取本夹具创建的排队任务');
            assert.ok(mine.has(task.id), `领取到非本夹具任务 ${task.id}，说明前置夹具留下了排队任务`);
            claimed.set(task.id, task);
        }
        const [succeededId, failedId, cancelledId] = createdTasks;
        await queue.completeTask(workerPool, {
            taskId: succeededId, leaseToken: claimed.get(succeededId).lease_token, result: { kind: 'sweep-probe' },
        });
        const failedTask = await queue.failTask(workerPool, {
            taskId: failedId, leaseToken: claimed.get(failedId).lease_token, errorMessage: 'sweep-probe', terminal: true,
        });
        assert.equal(failedTask.status, 'failed');
        const cancelledTask = await queue.cancelClaimedTask(workerPool, {
            taskId: cancelledId, leaseToken: claimed.get(cancelledId).lease_token,
        });
        assert.equal(cancelledTask.status, 'cancelled');
        // Worker 只改任务状态，绝不能顺带动额度。
        assert.deepEqual(await balances(), { available: '0', reserved: '21' });

        const settlement = createCreditSettlementStore({ pool: poolForOwner });
        // 扫描是只读的：列出候选不改变任何余额，也不写账本。
        const listed = await settlement.pending({ limit: 10 });
        assert.equal(listed.length, 3);
        assert.deepEqual(listed.map(row => row.outcome).sort(), ['release', 'release', 'settle']);
        assert.ok(listed.every(row => row.ownerId === userId && row.creditTenths === '7'));
        assert.deepEqual(await balances(), { available: '0', reserved: '21' });
        assert.equal((await admin.query('SELECT count(*)::int AS n FROM public.credit_ledger_events WHERE user_id=$1', [userId])).rows[0].n, 3);

        // 分批收敛：limit 只限制本次处理量，剩余候选留给下一轮。
        const firstBatch = await settlement.sweep({ limit: 2 });
        assert.equal(firstBatch.examined, 2);
        assert.equal(firstBatch.finalized.length, 2);
        assert.deepEqual(firstBatch.failed, []);
        const secondBatch = await settlement.sweep({ limit: 10 });
        assert.equal(secondBatch.examined, 1);
        assert.equal(secondBatch.finalized.length, 1);
        // 收敛完成后再次扫描必须为空：幂等，不重复扣减或重复退回。
        const drained = await settlement.sweep({ limit: 10 });
        assert.deepEqual({ examined: drained.examined, finalized: drained.finalized, failed: drained.failed },
            { examined: 0, finalized: [], failed: [] });

        // 一结算两释放：可用回到 14，冻结归零。
        assert.deepEqual(await balances(), { available: '14', reserved: '0' });
        const settlements = (await admin.query(
            'SELECT task_id, kind, credit_tenths::text AS amount FROM public.credit_settlements WHERE user_id=$1 ORDER BY kind, task_id',
            [userId])).rows;
        assert.equal(settlements.length, 3);
        assert.equal(settlements.filter(row => row.kind === 'settle').length, 1);
        assert.equal(settlements.filter(row => row.kind === 'release').length, 2);
        assert.ok(settlements.every(row => row.amount === '7'));
        assert.equal(settlements.find(row => row.kind === 'settle').task_id, succeededId);
        assert.deepEqual(settlements.filter(row => row.kind === 'release').map(row => row.task_id).sort(), [failedId, cancelledId].sort());
        assert.equal((await admin.query('SELECT count(*)::int AS n FROM public.credit_ledger_events WHERE user_id=$1', [userId])).rows[0].n, 6);

        // 扫描函数只读：owner 现在能读冻结行，但仍然不能改、不能删。
        assert.equal((await asOwner(client => client.query(
            'SELECT count(*)::int AS n FROM public.credit_reservations WHERE user_id=$1', [userId]))).rows[0].n, 3);
        await assert.rejects(asOwner(client => client.query('UPDATE public.credit_reservations SET credit_tenths=1')), { code: '42501' });
        await assert.rejects(asOwner(client => client.query('DELETE FROM public.credit_reservations')), { code: '42501' });

        // 运行身份与迁移身份都拿不到扫描与裁决入口。
        for (const pool of pools) {
            await assert.rejects(pool.query('SELECT * FROM public.credit_pending_settlements(10)'), error => error.code === '42501');
            await assert.rejects(pool.query('SELECT public.credit_finalize_task($1,$2,$3)', [userId, succeededId, 'settle']),
                error => error.code === '42501');
        }
        await assert.rejects(migrationClient.query('SELECT * FROM public.credit_pending_settlements(10)'),
            error => error.code === '42501');
        await assert.rejects(migrationClient.query('SELECT public.credit_finalize_task($1,$2,$3)', [userId, succeededId, 'settle']),
            error => error.code === '42501');
        // 数据库侧同样拒绝越界批次，不能靠 JS 单方面限制。
        await assert.rejects(admin.query('SELECT * FROM public.credit_pending_settlements(0)'), { code: '22023' });
        await assert.rejects(admin.query('SELECT * FROM public.credit_pending_settlements(501)'), { code: '22023' });

        record('终态结算扫描真实PG：Worker三种终态被自动收敛、扫描只读、分批与重复扫描幂等、运行与迁移身份越权拒绝', 'passed');
    } finally {
        // 失败时也要把自己的任务收干净：先取消未终态任务，再收敛，避免留下排队任务或悬空冻结。
        if (createdTasks.length > 0) {
            await admin.query(`UPDATE public.generation_tasks SET status='cancelled', completed_at=COALESCE(completed_at,clock_timestamp())
                WHERE id=ANY($1::uuid[]) AND status IN ('queued','running')`, [createdTasks]).catch(() => {});
            await createCreditSettlementStore({ pool: poolForOwner }).sweep({ limit: 10 }).catch(() => {});
        }
        await backing.end();
    }
}

module.exports = { checkCreditSettlementSweep };
