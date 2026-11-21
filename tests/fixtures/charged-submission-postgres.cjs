const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { createChargedSubmissionService } = require('../../lib/server/tasks/chargedSubmission');
const { createInternalPricingStore } = require('../../lib/server/tasks/pricingPersistence');
const { createModelRouteResolver } = require('../../lib/server/tasks/modelRouteResolver');
const { createCreditSettlementStore } = require('../../lib/server/tasks/creditSettlement');
const { ledgerOwnerRole } = require('../../lib/server/db/migrate');
const { grantChargedSubmissionPermissions } = require('../../lib/server/db/runtimePermissions');

const PASSWORD = `scrypt:32768:8:3:${'a'.repeat(32)}:${'b'.repeat(128)}`;
const modelPk = '33333333-3333-4333-8333-333333333333';
const modelId = 'charged-acceptance-model';
const freeModelPk = '44444444-4444-4444-8444-444444444444';
const freeModelId = 'charged-free-model';

// 合成目录只服务隔离库验收：路由标识与库内模型一致，Provider绑定不落库。
function catalogEntry(id, logicalModelId) {
    return {
        id, logicalModelId, catalogVersion: 1, enabled: true,
        mediaType: 'image', supportedOperations: ['image.generate'],
        bindings: [{
            id: `charged-${logicalModelId}-binding`, enabled: true, isPrimary: true, bindingVersion: 1,
            providerInstance: { id: 'charged-provider', enabled: true, configVersion: 1, credentialVersion: 1, adapterType: 'synthetic' },
            providerModel: { id: `charged-${logicalModelId}-upstream`, enabled: true, validationState: 'verified', mediaType: 'image',
                capabilities: { operations: ['image.generate'] }, upstreamModelName: logicalModelId,
                adapterVersion: '1', operationProfile: 'image.generate', requestMappingVersion: 1, responseMappingVersion: 1 },
        }],
    };
}

const requestFor = (logicalModelId, prompt = '收费入口PG验收') => ({ taskType: 'image.generate', payload: {
    logicalModelId, prompt, aspectRatio: '1:1', size: '1024x1024', outputCount: 1 } });

function priceConfig(logicalModelId, pricingVersion, unitPriceTenths) {
    return {
        modelId: logicalModelId, modelVersion: 1, pricingVersion, enabled: true,
        templateType: 'image_resolution_quantity', currencyUnit: 'credit_tenths',
        roundingMode: 'ceil_to_atom', precisionVersion: 'integer_rational_ms_v1',
        roundingModeVersion: 'ceil_to_atom_v1', quantityMode: 'per_unit', maxOutputCount: 1,
        resolutions: [{ resolutionKey: '1024x1024', enabled: true, unitPriceTenths }],
    };
}

async function createUser(admin, tag) {
    const id = randomUUID();
    await admin.query('INSERT INTO public.users(id,email,password_hash) VALUES ($1,$2,$3)',
        [id, `charged-${tag}-${id}@example.test`, PASSWORD]);
    return id;
}

const accountRow = async (admin, userId) => (await admin.query(
    'SELECT available_tenths, reserved_tenths FROM public.credit_accounts WHERE user_id=$1', [userId])).rows[0];

async function publishAndWait(admin, ownerPool, { config, label }) {
    const effectiveFromUs = (await admin.query(
        `SELECT ((floor(extract(epoch FROM clock_timestamp()))+2)*1000000)::text AS us`)).rows[0].us;
    await createInternalPricingStore({ pool: ownerPool }).publishScheduled({ config, effectiveFromUs });
    await admin.query(`SELECT pg_sleep(greatest(0,$1::numeric/1000000-extract(epoch FROM clock_timestamp())+0.05))`, [effectiveFromUs]);
    return effectiveFromUs;
}

// 端到端跑真实 HTTP 处理器所装配的同一个服务：运行身份只经 owner 函数收费。
async function checkChargedSubmission(admin, adminUrl, urls, record) {
    const backing = new Pool({ connectionString: adminUrl, max: 8, connectionTimeoutMillis: 3000 });
    const runtime = new Pool({ connectionString: urls.runtimeUrl, max: 4, connectionTimeoutMillis: 3000 });
    const worker = new Pool({ connectionString: urls.workerUrl, max: 2, connectionTimeoutMillis: 3000 });
    const users = [];
    let grantedSnapshotColumns = false;
    try {
        const database = (await admin.query('SELECT current_database() AS db')).rows[0].db;
        assert.match(database, /^pt_acceptance_[a-z0-9]+_[a-f0-9]{6}$/);
        // owner 名字必须由库名派生：pg_roles 是集群级的，LIKE 查询会命中其他验收库的同名角色。
        const ownerRole = ledgerOwnerRole(database);
        assert.ok((await admin.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [ownerRole])).rowCount === 1);
        // 收费入口的授权与迁移分离：运行角色在迁移之后创建，只能由能切换为 owner 的身份追加。
        // 授权中的任一语句失败都必须回滚此前列权限，避免留下半授权状态。
        const grantCalls = [];
        const failingGrantClient = { async query(sql) {
            grantCalls.push(sql);
            if (sql.startsWith('GRANT EXECUTE ON FUNCTION public.credit_charge_task_verified')) {
                throw Object.assign(new Error('synthetic grant failure'), { code: '42501' });
            }
            return { rows: sql === 'SELECT current_user AS role' ? [{ role: ownerRole }] : [] };
        } };
        await assert.rejects(grantChargedSubmissionPermissions(failingGrantClient, urls.runtimeRole, ownerRole), /synthetic grant failure/);
        assert.equal(grantCalls[0], 'BEGIN');
        assert.equal(grantCalls.at(-1), 'ROLLBACK');
        assert.ok(grantCalls.some(sql => sql.startsWith('GRANT INSERT(')));
        assert.ok(grantCalls.indexOf('SET LOCAL ROLE "' + ownerRole + '"') < grantCalls.findIndex(sql => sql.startsWith('REVOKE EXECUTE ON FUNCTION public.credit_charge_task(')));

        await grantChargedSubmissionPermissions(admin, urls.runtimeRole, ownerRole);
        grantedSnapshotColumns = true;
        // 业务入口只接受专用owner身份：BEGIN后立即SET LOCAL ROLE，不把管理员权限带进事务。
        const ownerSession = { async connect() {
            const client = await backing.connect();
            return { async query(sql, values) {
                const result = await client.query(sql, values);
                if (sql.startsWith('BEGIN')) await client.query(`SET LOCAL ROLE "${ownerRole}"`);
                return result;
            }, release() { client.release(); } };
        } };

        const payer = await createUser(admin, 'payer');
        const freeUser = await createUser(admin, 'free');
        users.push(payer, freeUser);
        await admin.query(`INSERT INTO public.logical_models(id,logical_model_id,display_name,media_type,supported_operations,enabled)
            VALUES ($1,$2,'收费入口模型','image',$3::jsonb,true)`, [modelPk, modelId, JSON.stringify(['image.generate'])]);
        await admin.query(`INSERT INTO public.logical_models(id,logical_model_id,display_name,media_type,supported_operations,enabled)
            VALUES ($1,$2,'免费档模型','image',$3::jsonb,true)`, [freeModelPk, freeModelId, JSON.stringify(['image.generate'])]);
        await publishAndWait(admin, ownerSession, { config: priceConfig(modelId, 'charged-v1', '7'), label: 'charged' });
        await publishAndWait(admin, ownerSession, { config: priceConfig(freeModelId, 'charged-free-v1', '0'), label: 'free' });

        const catalog = { async getLogicalModel(id) {
            if (id === modelId) return catalogEntry(modelPk, modelId);
            if (id === freeModelId) return catalogEntry(freeModelPk, freeModelId);
            return null;
        } };
        const service = createChargedSubmissionService({
            pool: runtime, routeResolver: createModelRouteResolver({ catalog }),
        });

        // 一、没有账户时不得建任务：整笔回滚，库里不留半成品。
        const noAccount = await service.submit({ ownerId: payer, idempotencyKey: 'charged-no-account', ...requestFor(modelId) })
            .then(() => null, (error) => error);
        assert.equal(noAccount?.code, 'CREDIT_ACCOUNT_NOT_FOUND');
        assert.equal(noAccount.status, 402);
        assert.equal((await admin.query('SELECT count(*)::int AS n FROM public.generation_tasks WHERE owner_id=$1', [payer])).rows[0].n, 0);
        assert.equal((await admin.query('SELECT count(*)::int AS n FROM public.pricing_quotes WHERE owner_id=$1', [payer])).rows[0].n, 0);
        record('收费入口：账户缺失时整笔回滚，不留下任务行或报价行', 'passed');

        // 二、正常收费：任务、报价、冻结同事务落库，余额从 14 变 7/7。
        await admin.query('INSERT INTO public.credit_accounts(user_id,available_tenths,reserved_tenths) VALUES ($1,14,0)', [payer]);
        const charged = await service.submit({ ownerId: payer, idempotencyKey: 'charged-accept-1', ...requestFor(modelId) });
        assert.equal(charged.replayed, false);
        assert.deepEqual(charged.credit, { tenths: '7', quoteId: charged.credit.quoteId, reserved: true });
        assert.match(charged.credit.quoteId, /^[0-9a-f-]{36}$/);
        const taskRow = (await admin.query(`SELECT logical_model_pk,route_snapshot,route_snapshot_version,route_snapshot_hash,status
            FROM public.generation_tasks WHERE id=$1`, [charged.task.id])).rows[0];
        assert.equal(taskRow.logical_model_pk, modelPk);
        assert.equal(taskRow.route_snapshot.logicalModelId, modelId);
        assert.equal(taskRow.route_snapshot_version, 1);
        assert.match(taskRow.route_snapshot_hash, /^[0-9a-f]{64}$/);
        assert.deepEqual(await accountRow(admin, payer), { available_tenths: '7', reserved_tenths: '7' });
        const quote = (await admin.query(`SELECT task_id,credit_tenths::text,snapshot->>'credit_tenths' AS snapshot_amount
            FROM public.pricing_quotes WHERE task_id=$1`, [charged.task.id])).rows[0];
        assert.deepEqual(quote, { task_id: charged.task.id, credit_tenths: '7', snapshot_amount: '7' });
        assert.equal((await admin.query('SELECT count(*)::int AS n FROM public.credit_reservations WHERE task_id=$1', [charged.task.id])).rows[0].n, 1);
        assert.equal((await admin.query(`SELECT count(*)::int AS n FROM public.credit_ledger_events
            WHERE task_id=$1 AND kind='reserve' AND credit_tenths=7`, [charged.task.id])).rows[0].n, 1);
        record('收费入口：运行身份经 owner 函数完成报价、建任务与冻结，余额与账本同步收敛', 'passed');

        // 三、重放不重复扣费，换内容按冲突拒绝。
        const replay = await service.submit({ ownerId: payer.toUpperCase(), idempotencyKey: 'charged-accept-1', ...requestFor(modelId) });
        assert.equal(replay.replayed, true);
        assert.equal(replay.task.id, charged.task.id);
        assert.deepEqual(replay.credit, { tenths: '7', quoteId: charged.credit.quoteId, reserved: true });
        assert.deepEqual(await accountRow(admin, payer), { available_tenths: '7', reserved_tenths: '7' });
        assert.equal((await admin.query('SELECT count(*)::int AS n FROM public.pricing_quotes WHERE owner_id=$1', [payer])).rows[0].n, 1);
        const reused = await service.submit({
            ownerId: payer, idempotencyKey: 'charged-accept-1', ...requestFor(modelId, '换内容的同一幂等键'),
        }).then(() => null, (error) => error);
        assert.equal(reused?.code, 'IDEMPOTENCY_KEY_REUSED');
        assert.equal(reused.status, 409);
        record('收费入口：同幂等键重放不重复扣费，换请求内容按 409 拒绝', 'passed');

        // 四、余额不足由数据库裁决：不建任务、不写报价、余额不变。
        // 付款人此时 7 可用 / 7 冻结，恰好够再买一单，所以另起一个余额不足的用户来验负例。
        const poorUser = await createUser(admin, 'poor');
        users.push(poorUser);
        await admin.query('INSERT INTO public.credit_accounts(user_id,available_tenths,reserved_tenths) VALUES ($1,6,0)', [poorUser]);
        const insufficient = await service.submit({ ownerId: poorUser, idempotencyKey: 'charged-accept-2', ...requestFor(modelId) })
            .then(() => null, (error) => error);
        assert.equal(insufficient?.code, 'CREDIT_INSUFFICIENT');
        assert.equal(insufficient.status, 402);
        assert.equal((await admin.query('SELECT count(*)::int AS n FROM public.generation_tasks WHERE owner_id=$1', [poorUser])).rows[0].n, 0);
        assert.equal((await admin.query('SELECT count(*)::int AS n FROM public.pricing_quotes WHERE owner_id=$1', [poorUser])).rows[0].n, 0);
        assert.deepEqual(await accountRow(admin, poorUser), { available_tenths: '6', reserved_tenths: '0' });
        record('收费入口：余额不足按 402 拒绝，且不留下任务或报价', 'passed');

        // 五、免费档位：不需要账户，落不可变报价但不冻结、不写账本。
        const free = await service.submit({ ownerId: freeUser, idempotencyKey: 'charged-free-1', ...requestFor(freeModelId) });
        assert.deepEqual({ tenths: free.credit.tenths, reserved: free.credit.reserved }, { tenths: '0', reserved: false });
        assert.equal(await accountRow(admin, freeUser), undefined);
        assert.equal((await admin.query('SELECT credit_tenths::text FROM public.pricing_quotes WHERE task_id=$1', [free.task.id])).rows[0].credit_tenths, '0');
        assert.equal((await admin.query('SELECT count(*)::int AS n FROM public.credit_reservations WHERE task_id=$1', [free.task.id])).rows[0].n, 0);
        assert.equal((await admin.query('SELECT count(*)::int AS n FROM public.credit_ledger_events WHERE user_id=$1', [freeUser])).rows[0].n, 0);
        record('收费入口：免费档位照常落报价，但不建账户、不冻结、不写账本', 'passed');

        // 七、运行身份不能将正价版本篡改成零价或其他金额；函数级复算必须拒绝且不留任何行。
        const forgedUser = await createUser(admin, 'forged');
        users.push(forgedUser);
        await admin.query('INSERT INTO public.credit_accounts(user_id,available_tenths,reserved_tenths) VALUES ($1,14,0)', [forgedUser]);
        const forgedTask = (await admin.query(`INSERT INTO public.generation_tasks
            (owner_id,idempotency_key,request_fingerprint,task_type,payload,max_attempts,logical_model_pk,route_snapshot,route_snapshot_version,route_snapshot_hash)
            VALUES ($1,'charged-forged-zero','${'f'.repeat(64)}','image.generate',$2::jsonb,3,$3,$4::jsonb,1,$5) RETURNING id`,
        [forgedUser, JSON.stringify({ ...requestFor(modelId).payload }), modelPk,
            JSON.stringify({ fake: true }), 'a'.repeat(64)])).rows[0];
        const chargedVersion = (await admin.query('SELECT id FROM public.pricing_versions WHERE logical_model_pk=$1', [modelPk])).rows[0].id;
        const forgedSnapshot = { pricingVersion: 'charged-v1', configHash: (await admin.query('SELECT config_hash FROM public.pricing_versions WHERE id=$1', [chargedVersion])).rows[0].config_hash,
            credit_tenths: '0', snapshotHash: 'b'.repeat(64) };
        const forgedZero = await runtime.query(`SELECT * FROM public.credit_charge_task_verified($1,$2,$3,$4::jsonb,$5,$6,1,9999999999999999)` ,
            [forgedUser, forgedTask.id, chargedVersion, JSON.stringify(forgedSnapshot), 'b'.repeat(64), '0'])
            .then(() => null, error => error);
        assert.equal(forgedZero?.code, '23514');
        assert.equal((await admin.query('SELECT count(*)::int AS n FROM public.pricing_quotes WHERE task_id=$1', [forgedTask.id])).rows[0].n, 0);
        assert.deepEqual(await accountRow(admin, forgedUser), { available_tenths: '14', reserved_tenths: '0' });
        record('收费入口：运行身份伪造正价版本零价被数据库拒绝且无报价或冻结', 'passed');

        // 六、身份边界：运行身份可读取用户账单投影，但没有定价表直接读写、账务写入或账务 owner 函数执行权。
        const forbidden = async (pool, sql, values = []) => (await pool.query(sql, values).then(() => null, (error) => error?.code));
        assert.equal(await forbidden(runtime, 'SELECT count(*) FROM public.pricing_quotes'), '42501');
        assert.equal(await forbidden(runtime, 'SELECT count(*) FROM public.pricing_versions'), '42501');
        assert.equal(await forbidden(runtime, 'SELECT count(*) FROM public.credit_ledger_events'), null);
        assert.equal(await forbidden(runtime, `INSERT INTO public.pricing_quotes
            (owner_id,idempotency_key,request_fingerprint,pricing_version_id,snapshot,snapshot_hash,credit_tenths,created_at_us,expires_at_us)
            VALUES ($1,'charged-direct','${'a'.repeat(64)}',gen_random_uuid(),'{}'::jsonb,'${'a'.repeat(64)}',1,1,1)`, [payer]), '42501');
        assert.equal(await forbidden(runtime, 'SELECT * FROM public.credit_charge_task($1,$2)', [payer, charged.task.id]), '42501');
        assert.equal(await forbidden(worker, 'SELECT * FROM public.credit_charge_task_verified($1,$2)', [payer, charged.task.id]), '42501');
        assert.equal(await forbidden(worker, 'SELECT * FROM public.pricing_versions_for_submission($1)', [modelPk]), '42501');
        // 运行身份经函数读到的时间轴只含报价所需列，不能借此改价。
        const timeline = (await runtime.query('SELECT pricing_version,config_hash FROM public.pricing_versions_for_submission($1)', [modelPk])).rows;
        assert.equal(timeline.length, 1);
        assert.equal(timeline[0].pricing_version, 'charged-v1');
        assert.match(timeline[0].config_hash, /^[0-9a-f]{64}$/);
        record('收费入口：运行身份对定价表与账本零直接读写，Worker 也不能执行收费函数', 'passed');
    } finally {
        // 共享验收库里不得留下可被后续 worker 夹具领取的排队任务。
        if (users.length) {
            await admin.query(`UPDATE public.generation_tasks SET status='cancelled', completed_at=clock_timestamp()
                WHERE owner_id = ANY($1::uuid[]) AND status='queued'`, [users]).catch(() => {});
        }
        const database = (await admin.query('SELECT current_database() AS db')).rows[0].db;
        const ownerRole = ledgerOwnerRole(database);
        // 收费入口的授权只服务本夹具：后续 local-mock 夹具断言运行身份没有快照列写入权。
        if (grantedSnapshotColumns) {
            await admin.query(`REVOKE INSERT(logical_model_pk,route_snapshot,route_snapshot_version,route_snapshot_hash)
                ON public.generation_tasks FROM "${urls.runtimeRole}"`).catch(() => {});
        }
        const ownerSession = { async connect() {
            const client = await backing.connect();
            return { async query(sql, values) {
                const result = await client.query(sql, values);
                if (sql.startsWith('BEGIN')) await client.query(`SET LOCAL ROLE "${ownerRole}"`);
                return result;
            }, release() { client.release(); } };
        } };
        // 冻结也要收敛干净：终态扫描是全局的，遗留候选会被下一个夹具看到。
        await createCreditSettlementStore({ pool: ownerSession }).sweep({ limit: 50 }).catch(() => {});
        await runtime.end();
        await worker.end();
        await backing.end();
    }
}

module.exports = { checkChargedSubmission };
