const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { createAtomicTaskPricingStore } = require('../../lib/server/tasks/atomicTaskPricing');
const { createInternalPricingStore } = require('../../lib/server/tasks/pricingPersistence');
const { createModelRouteResolver } = require('../../lib/server/tasks/modelRouteResolver');
const { createCreditSettlementStore } = require('../../lib/server/tasks/creditSettlement');

const userId = '11111111-1111-4111-8111-111111111111';
const modelPk = '22222222-2222-4222-8222-222222222222';
const modelId = 'atomic-acceptance-model';
// 合成目录只服务隔离库验收：路由标识与DB模型一致，Provider绑定不落库。
const catalogEntry = {
    id: modelPk, logicalModelId: modelId, catalogVersion: 1, enabled: true,
    mediaType: 'image', supportedOperations: ['image.generate'],
    bindings: [{
        id: 'atomic-binding', enabled: true, isPrimary: true, bindingVersion: 1,
        providerInstance: { id: 'atomic-provider', enabled: true, configVersion: 1, credentialVersion: 1, adapterType: 'synthetic' },
        providerModel: { id: 'atomic-upstream', enabled: true, validationState: 'verified', mediaType: 'image',
            capabilities: { operations: ['image.generate'] }, upstreamModelName: 'atomic-upstream-model',
            adapterVersion: '1', operationProfile: 'image.generate', requestMappingVersion: 1, responseMappingVersion: 1 },
    }],
};

async function checkAtomicTaskPricing(admin, _owner, _pools, names, adminUrl, record) {
    const config = {
        modelId, modelVersion: 1, pricingVersion: 'atomic-v1', enabled: true,
        templateType: 'image_resolution_quantity', currencyUnit: 'credit_tenths',
        roundingMode: 'ceil_to_atom', precisionVersion: 'integer_rational_ms_v1',
        roundingModeVersion: 'ceil_to_atom_v1', quantityMode: 'per_unit', maxOutputCount: 1,
        resolutions: [{ resolutionKey: '1024x1024', enabled: true, unitPriceTenths: '7' }],
    };
    const request = { taskType: 'image.generate', payload: {
        logicalModelId: modelId, prompt: '原子PG验收', aspectRatio: '1:1', size: '1024x1024', outputCount: 1,
    } };
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
        await admin.query(`INSERT INTO public.users(id,email,password_hash) VALUES ($1,$2,$3)`, [userId, `atomic-${userId}@example.test`, `scrypt:32768:8:3:${'a'.repeat(32)}:${'b'.repeat(128)}`]);
        await admin.query(`INSERT INTO public.logical_models(id,logical_model_id,display_name,media_type,supported_operations,enabled) VALUES ($1,$2,'原子PG模型','image',$3::jsonb,true)`, [modelPk, modelId, JSON.stringify(['image.generate'])]);
        // 价格版本必须由真实发布路径写入：生效点在将来整秒，随后的报价时钟才满足effective<=created。
        const effectiveFromUs = (await admin.query(`SELECT ((floor(extract(epoch FROM clock_timestamp()))+2)*1000000)::text AS us`)).rows[0].us;
        await createInternalPricingStore({ pool: poolForOwner }).publishScheduled({ config, effectiveFromUs });
        await admin.query(`SELECT pg_sleep(greatest(0,$1::numeric/1000000-extract(epoch FROM clock_timestamp())+0.01))`, [effectiveFromUs]);
        await admin.query(`INSERT INTO public.credit_accounts(user_id,available_tenths,reserved_tenths) VALUES ($1,14,0)`, [userId]);

        const store = createAtomicTaskPricingStore({
            pool: poolForOwner,
            routeResolver: createModelRouteResolver({ catalog: { async getLogicalModel() { return catalogEntry; } } }),
        });
        const first = await store.submit({ ownerId: userId, idempotencyKey: 'atomic-accept-1', request });
        assert.equal(first.replayed, false);
        assert.equal(first.snapshot.credit_tenths, '7');
        // 任务必须带着与价格同事务写入的可信路由快照，不能在库里留下空路由。
        assert.equal(first.task.logical_model_pk, modelPk);
        assert.equal(first.task.route_snapshot.logicalModelId, modelId);
        assert.equal(first.task.route_snapshot.capabilitySnapshot.operation, 'image.generate');
        assert.equal(first.task.route_snapshot_version, 1);
        assert.match(first.task.route_snapshot_hash, /^[0-9a-f]{64}$/);
        const balances = (await admin.query('SELECT available_tenths::text,reserved_tenths::text FROM public.credit_accounts WHERE user_id=$1', [userId])).rows[0];
        assert.deepEqual(balances, { available_tenths: '7', reserved_tenths: '7' });
        assert.equal((await admin.query('SELECT count(*)::int AS n FROM public.generation_tasks WHERE id=$1', [first.task.id])).rows[0].n, 1);
        assert.equal((await admin.query('SELECT count(*)::int AS n FROM public.pricing_quotes WHERE task_id=$1', [first.task.id])).rows[0].n, 1);
        assert.equal((await admin.query('SELECT count(*)::int AS n FROM public.credit_reservations WHERE task_id=$1', [first.task.id])).rows[0].n, 1);
        const replay = await store.submit({ ownerId: userId.toUpperCase(), idempotencyKey: 'atomic-accept-1', request });
        assert.equal(replay.replayed, true);
        assert.equal(replay.task.id, first.task.id);
        assert.equal(replay.task.route_snapshot_hash, first.task.route_snapshot_hash);
        assert.deepEqual(replay.task.route_snapshot, first.task.route_snapshot);
        await assert.rejects(store.submit({ ownerId: userId, idempotencyKey: 'atomic-accept-1', request: { ...request, payload: { ...request.payload, prompt: '冲突请求' } } }), error => error.reason === 'IDEMPOTENCY_KEY_REUSED');
        const concurrent = await Promise.allSettled([
            store.submit({ ownerId: userId, idempotencyKey: 'atomic-accept-2', request }),
            store.submit({ ownerId: userId, idempotencyKey: 'atomic-accept-3', request }),
        ]);
        assert.equal(concurrent.filter(result => result.status === 'fulfilled').length, 1);
        assert.equal(concurrent.filter(result => result.status === 'rejected').length, 1);
        assert.equal(concurrent.find(result => result.status === 'rejected').reason.reason, 'CREDIT_INSUFFICIENT');
        assert.deepEqual((await admin.query('SELECT available_tenths::text,reserved_tenths::text FROM public.credit_accounts WHERE user_id=$1', [userId])).rows[0], { available_tenths: '0', reserved_tenths: '14' });
        assert.equal((await admin.query("SELECT count(*)::int AS n FROM public.generation_tasks WHERE owner_id=$1 AND idempotency_key IN ('atomic-accept-2','atomic-accept-3')", [userId])).rows[0].n, 1);
        assert.equal((await admin.query('SELECT count(*)::int AS n FROM public.generation_tasks WHERE owner_id=$1 AND (logical_model_pk IS NULL OR route_snapshot IS NULL OR route_snapshot_version IS NULL OR route_snapshot_hash IS NULL)', [userId])).rows[0].n, 0);
        record('原子任务报价冻结真实PG：可信路由快照必填、同事务提交、失败回滚、重放/冲突、余额锁与并发不超额', 'passed');
    } finally {
        // 共享验收库里不得留下可被后续worker夹具领取的排队任务，否则会串到别的验收项。
        await admin.query(`UPDATE public.generation_tasks SET status='cancelled', completed_at=clock_timestamp()
            WHERE owner_id=$1 AND status='queued'`, [userId]);
        // 冻结也要收敛干净：终态扫描是全局的，遗留候选会被下一个夹具看到。
        await createCreditSettlementStore({ pool: poolForOwner }).sweep({ limit: 50 }).catch(() => {});
        await backing.end();
    }
}

module.exports = { checkAtomicTaskPricing };
