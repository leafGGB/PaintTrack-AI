const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { createAtomicTaskPricingStore } = require('../../lib/server/tasks/atomicTaskPricing');
const { createInternalPricingStore } = require('../../lib/server/tasks/pricingPersistence');
const { createModelRouteResolver } = require('../../lib/server/tasks/modelRouteResolver');
const { createCreditSettlementStore } = require('../../lib/server/tasks/creditSettlement');

const userId = '55555555-5555-4555-8555-555555555555';
const modelPk = '66666666-6666-4666-8666-666666666666';
const modelId = 'settle-acceptance-model';
const catalogEntry = {
    id: modelPk, logicalModelId: modelId, catalogVersion: 1, enabled: true,
    mediaType: 'image', supportedOperations: ['image.generate'],
    bindings: [{
        id: 'settle-binding', enabled: true, isPrimary: true, bindingVersion: 1,
        providerInstance: { id: 'settle-provider', enabled: true, configVersion: 1, credentialVersion: 1, adapterType: 'synthetic' },
        providerModel: { id: 'settle-upstream', enabled: true, validationState: 'verified', mediaType: 'image',
            capabilities: { operations: ['image.generate'] }, upstreamModelName: 'settle-upstream-model',
            adapterVersion: '1', operationProfile: 'image.generate', requestMappingVersion: 1, responseMappingVersion: 1 },
    }],
};

async function checkCreditSettlement(admin, migrationClient, pools, names, adminUrl, record) {
    const config = {
        modelId, modelVersion: 1, pricingVersion: 'settle-v1', enabled: true,
        templateType: 'image_resolution_quantity', currencyUnit: 'credit_tenths',
        roundingMode: 'ceil_to_atom', precisionVersion: 'integer_rational_ms_v1',
        roundingModeVersion: 'ceil_to_atom_v1', quantityMode: 'per_unit', maxOutputCount: 1,
        resolutions: [{ resolutionKey: '1024x1024', enabled: true, unitPriceTenths: '7' }],
    };
    const request = { taskType: 'image.generate', payload: {
        logicalModelId: modelId, prompt: '终态裁决验收', aspectRatio: '1:1', size: '1024x1024', outputCount: 1,
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
    try {
        await admin.query('INSERT INTO public.users(id,email,password_hash) VALUES ($1,$2,$3)',
            [userId, `settle-${userId}@example.test`, `scrypt:32768:8:3:${'a'.repeat(32)}:${'b'.repeat(128)}`]);
        await admin.query(`INSERT INTO public.logical_models(id,logical_model_id,display_name,media_type,supported_operations,enabled)
            VALUES ($1,$2,'终态裁决PG模型','image',$3::jsonb,true)`, [modelPk, modelId, JSON.stringify(['image.generate'])]);
        const effectiveFromUs = (await admin.query(`SELECT ((floor(extract(epoch FROM clock_timestamp()))+2)*1000000)::text AS us`)).rows[0].us;
        await createInternalPricingStore({ pool: poolForOwner }).publishScheduled({ config, effectiveFromUs });
        await admin.query(`SELECT pg_sleep(greatest(0,$1::numeric/1000000-extract(epoch FROM clock_timestamp())+0.01))`, [effectiveFromUs]);
        // 三个任务各冻结 7/10 credit：一个成功、一个失败、一个仍在排队。
        await admin.query('INSERT INTO public.credit_accounts(user_id,available_tenths,reserved_tenths) VALUES ($1,21,0)', [userId]);

        const pricing = createAtomicTaskPricingStore({
            pool: poolForOwner,
            routeResolver: createModelRouteResolver({ catalog: { async getLogicalModel() { return catalogEntry; } } }),
        });
        const tasks = [];
        for (const key of ['settle-accept-1', 'settle-accept-2', 'settle-accept-3']) {
            const submitted = await pricing.submit({ ownerId: userId, idempotencyKey: key, request });
            tasks.push(submitted.task.id);
        }
        assert.deepEqual(await balances(), { available: '0', reserved: '21' });
        await admin.query(`UPDATE public.generation_tasks SET status='succeeded', result='{"kind":"settle-probe"}'::jsonb,
            completed_at=clock_timestamp() WHERE id=$1`, [tasks[0]]);
        await admin.query(`UPDATE public.generation_tasks SET status='failed', last_error='settle-probe',
            completed_at=clock_timestamp() WHERE id=$1`, [tasks[1]]);

        const settlement = createCreditSettlementStore({ pool: poolForOwner });
        const settled = await settlement.finalize({ ownerId: userId, taskId: tasks[0], outcome: 'settle' });
        assert.equal(settled.replayed, false);
        assert.match(settled.eventId, /^[0-9a-f-]{36}$/);
        // 成功任务扣费：冻结减少，可用不变。
        assert.deepEqual(await balances(), { available: '0', reserved: '14' });
        assert.equal((await admin.query('SELECT kind, credit_tenths::text AS amount FROM public.credit_ledger_events WHERE task_id=$1',
            [tasks[0]])).rows.map(row => `${row.kind}:${row.amount}`).sort().join(','), 'reserve:7,settle:7');
        assert.equal((await admin.query('SELECT kind FROM public.credit_settlements WHERE task_id=$1', [tasks[0]])).rows[0].kind, 'settle');

        // 同一个裁决重复提交必须返回原事件，余额不再变化。
        const replay = await settlement.finalize({ ownerId: userId.toUpperCase(), taskId: tasks[0].toUpperCase(), outcome: 'settle' });
        assert.equal(replay.replayed, true);
        assert.equal(replay.eventId, settled.eventId);
        assert.deepEqual(await balances(), { available: '0', reserved: '14' });

        // 失败任务释放：冻结退回可用。
        const released = await settlement.finalize({ ownerId: userId, taskId: tasks[1], outcome: 'release' });
        assert.equal(released.replayed, false);
        assert.deepEqual(await balances(), { available: '7', reserved: '7' });
        assert.equal((await admin.query('SELECT kind, credit_tenths::text AS amount FROM public.credit_ledger_events WHERE task_id=$1 ORDER BY kind',
            [tasks[1]])).rows.map(row => `${row.kind}:${row.amount}`).join(','), 'release:7,reserve:7');

        // 反向裁决、未终态任务和不存在的冻结都必须在写账本前拒绝。
        const expectReason = async (args, reason) => {
            await assert.rejects(settlement.finalize(args), error => error.reason === reason);
        };
        await expectReason({ ownerId: userId, taskId: tasks[1], outcome: 'settle' }, 'SETTLE_CONFLICT');
        await expectReason({ ownerId: userId, taskId: tasks[2], outcome: 'release' }, 'TASK_NOT_TERMINAL');
        await expectReason({ ownerId: userId, taskId: tasks[2], outcome: 'settle' }, 'TASK_NOT_TERMINAL');
        await expectReason({ ownerId: userId, taskId: '77777777-7777-4777-8777-777777777777', outcome: 'settle' }, 'RESERVE_NOT_FOUND');
        assert.deepEqual(await balances(), { available: '7', reserved: '7' });
        assert.equal((await admin.query('SELECT count(*)::int AS n FROM public.credit_settlements WHERE user_id=$1', [userId])).rows[0].n, 2);
        assert.equal((await admin.query('SELECT count(*)::int AS n FROM public.credit_ledger_events WHERE user_id=$1', [userId])).rows[0].n, 5);

        // 运行身份与迁移身份都不能直接调用终态裁决；裁决表也未向任何运行身份开放。
        for (const pool of pools) {
            await assert.rejects(pool.query('SELECT public.credit_finalize_task($1,$2,$3)', [userId, tasks[0], 'settle']),
                error => error.code === '42501');
            await assert.rejects(pool.query('SELECT count(*) FROM public.credit_settlements'), error => error.code === '42501');
        }
        // 迁移身份虽是建表者，但函数所有权已转给专用owner且只授给owner，因此无法作为业务入口。
        await assert.rejects(migrationClient.query('SELECT public.credit_finalize_task($1,$2,$3)', [userId, tasks[0], 'settle']),
            error => error.code === '42501');

        // 裁决历史一旦写入不可改、不可删、不可清空；账本也不接受未知 kind。
        await admin.query('BEGIN');
        try {
            for (const sql of ['UPDATE public.credit_settlements SET kind=\'settle\'', 'DELETE FROM public.credit_settlements',
                'TRUNCATE public.credit_settlements CASCADE']) {
                await admin.query('SAVEPOINT settle_immutable');
                await assert.rejects(admin.query(sql), { code: '42501' });
                await admin.query('ROLLBACK TO SAVEPOINT settle_immutable');
            }
            await admin.query('SAVEPOINT settle_kind');
            await assert.rejects(admin.query(`INSERT INTO public.credit_ledger_events(user_id,task_id,kind,credit_tenths,source_type,source_id,idempotency_key,actor)
                VALUES ($1,$2::uuid,'refund',7,'task',$2::uuid,'refund:'||$3::text,'system')`, [userId, tasks[2], tasks[2]]), { code: '23514' });
            await admin.query('ROLLBACK TO SAVEPOINT settle_kind');
        } finally { await admin.query('ROLLBACK'); }
        record('终态裁决真实PG：结算/释放各一次、重放幂等、反向与未终态拒绝、历史不可变、运行与迁移身份越权拒绝', 'passed');
    } finally {
        // 共享验收库里不得留下可被后续worker夹具领取的排队任务。
        await admin.query(`UPDATE public.generation_tasks SET status='cancelled', completed_at=clock_timestamp()
            WHERE owner_id=$1 AND status='queued'`, [userId]);
        // 同样不得留下未裁决的冻结：终态扫描是全局的，遗留候选会被下一个夹具看到。
        await createCreditSettlementStore({ pool: poolForOwner }).sweep({ limit: 50 }).catch(() => {});
        await backing.end();
    }
}

module.exports = { checkCreditSettlement };
