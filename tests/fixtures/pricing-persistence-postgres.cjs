const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { createInternalPricingStore } = require('../../lib/server/tasks/pricingPersistence');

// 仅新建隔离库验收使用管理员会话SET LOCAL ROLE，业务模块本身不接收管理员连接或环境。
async function checkPricingPersistence(admin, owner, pools, names, adminUrl, record) {
    assert.equal((await admin.query('SELECT current_database() AS db')).rows[0].db, names.database);
    assert.match(names.database, /^pt_acceptance_[a-z0-9]+_[a-f0-9]{6}$/);
    assert.match(names.ledgerOwnerRole, /^pt_ledger_owner_[a-f0-9]{16}$/);
    const url = new URL(adminUrl);
    assert.equal(url.pathname, `/${names.database}`);
    const functions = ['pricing_reject_mutation()', 'pricing_guard_version()', 'pricing_guard_quote()', 'pricing_lock_model_mutation()'];
    for (const fn of functions) {
        const row = (await admin.query(`SELECT p.prosecdef,p.proconfig,r.rolname FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.oid=$1::regprocedure`, [`public.${fn}`])).rows[0];
        assert.deepEqual(row, { prosecdef: true, proconfig: ['search_path=pg_catalog, pg_temp'], rolname: names.ledgerOwnerRole });
        assert.equal((await admin.query(`SELECT count(*)::int AS n FROM pg_proc p,LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid=$1::regprocedure AND a.grantee=0`, [`public.${fn}`])).rows[0].n, 0);
    }
    for (const pool of [...pools, owner]) {
        for (const table of ['pricing_versions', 'pricing_quotes']) {
            const rights = (await pool.query(`SELECT has_any_column_privilege(current_user,$1,'SELECT,INSERT,UPDATE,REFERENCES') AS columns,has_table_privilege(current_user,$1,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS tables`, [`public.${table}`])).rows[0];
            if (pool !== owner) assert.deepEqual(rights, { columns: false, tables: false });
            if (pool !== owner) await assert.rejects(pool.query(`SELECT * FROM public.${table}`), { code: '42501' });
        }
        for (const fn of functions) assert.equal((await pool.query(`SELECT has_function_privilege(current_user,$1,'EXECUTE') AS allowed`, [`public.${fn}`])).rows[0].allowed, false);
    }
    // migration不是业务身份，即使表owner可写，也被JS入口拒绝。
    await assert.rejects(createInternalPricingStore({ pool: { connect: async () => ({ query: (...args) => owner.query(...args), release() {} }) } }).quote({ ownerId: randomUUID(), idempotencyKey: 'reject-migrate-key', request: { taskType: 'image.generate', payload: { logicalModelId: 'reject-model', prompt: '合成', aspectRatio: '1:1', size: '1024x1024', outputCount: 1 } } }), error => error.reason === 'PRICING_EXECUTOR_REQUIRED');
    record('报价内部权限：PUBLIC撤权、专用owner、运行角色零读写/调用及migration业务入口拒绝', 'passed');

    const backing = new Pool({ connectionString: adminUrl, max: 4, connectionTimeoutMillis: 3000 });
    const restrictedPool = { async connect() {
        const client = await backing.connect();
        return { async query(sql, values) {
            const result = await client.query(sql, values);
            if (sql.startsWith('BEGIN')) await client.query(`SET LOCAL ROLE "${names.ledgerOwnerRole}"`);
            return result;
        }, release() { client.release(); } };
    } };
    const store = createInternalPricingStore({ pool: restrictedPool });
    const modelPk = randomUUID();
    const user = randomUUID();
    const modelId = `price-${modelPk}`;
    const config = version => ({ modelId, modelVersion: 1, pricingVersion: version, enabled: true,
        templateType: 'image_resolution_quantity', currencyUnit: 'credit_tenths', roundingMode: 'ceil_to_atom',
        precisionVersion: 'integer_rational_ms_v1', roundingModeVersion: 'ceil_to_atom_v1', quantityMode: 'per_unit',
        maxOutputCount: 1, resolutions: [{ resolutionKey: '1024x1024', enabled: true, unitPriceTenths: '7' }] });
    const request = { taskType: 'image.generate', payload: { logicalModelId: modelId, prompt: '隔离PG报价测试', aspectRatio: '1:1', size: '1024x1024', outputCount: 1 } };
    const quote = key => store.quote({ ownerId: user, idempotencyKey: key, request });
    const expectCode = async (sql, values, code) => {
        await admin.query('BEGIN');
        try { await assert.rejects(admin.query(sql, values), { code }); }
        finally { await admin.query('ROLLBACK'); }
    };
    try {
        await admin.query(`INSERT INTO public.users(id,email,password_hash) VALUES ($1,$2,$3)`, [user, `pricing-${user}@example.test`, `scrypt:32768:8:3:${'a'.repeat(32)}:${'b'.repeat(128)}`]);
        await admin.query(`INSERT INTO public.logical_models(id,logical_model_id,display_name,media_type,supported_operations,enabled) VALUES ($1,$2,'合成报价','image','["image.generate"]',true)`, [modelPk, modelId]);
        const times = (await admin.query(`SELECT ((floor(extract(epoch FROM clock_timestamp()))+2)*1000000)::text AS first, ((floor(extract(epoch FROM clock_timestamp()))+60)*1000000)::text AS future`)).rows[0];
        const v1 = await store.publishScheduled({ config: config('v1'), effectiveFromUs: times.first });
        assert.equal((await store.publishScheduled({ config: config('v1'), effectiveFromUs: times.first })).id, v1.id);
        await assert.rejects(store.publishScheduled({ config: { ...config('v1'), enabled: false }, effectiveFromUs: times.first }));
        await assert.rejects(store.publishScheduled({ config: config('same-second'), effectiveFromUs: times.first }), { code: '23505' });
        const future = await store.publishScheduled({ config: config('cancelled'), effectiveFromUs: times.future });
        await store.changeLifecycle({ modelId, pricingVersion: 'cancelled', action: 'cancel' });
        assert.equal((await store.changeLifecycle({ modelId, pricingVersion: 'cancelled', action: 'cancel' })).replayed, true);
        await assert.rejects(store.changeLifecycle({ modelId, pricingVersion: 'cancelled', action: 'revoke' }));
        // 事务先开始、模型锁后才过生效点：真正等待数据库锁，不用进程时钟伪造采样。
        await admin.query('BEGIN');
        await admin.query('SELECT pg_advisory_xact_lock(hashtextextended($1,626))', [modelPk]);
        const pending = quote('pricing-lock-wait');
        pending.catch(() => {});
        // 锁阻塞可观测屏障；查询本身让出事件循环，不靠固定进程延时猜调度。
        let waiting = false;
        for (let i = 0; i < 500; i++) {
            // 同事务统计快照会缓存；每轮查询前清除，才能观测后来进入锁等待的后端。
            await admin.query('SELECT pg_catalog.pg_stat_clear_snapshot()');
            waiting = (await admin.query(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE '%hashtextextended($1, 626)%') AS waiting`)).rows[0].waiting;
            if (waiting) break;
        }
        assert.equal(waiting, true);
        await admin.query(`SELECT pg_sleep(greatest(0, $1::numeric/1000000 - extract(epoch FROM clock_timestamp()) + 0.01))`, [times.first]);
        await admin.query('COMMIT');
        const first = await pending;
        assert.ok(BigInt(first.snapshot.createdAtUs) >= BigInt(times.first));
        assert.equal(first.snapshot.pricingVersion, 'v1');
        assert.equal(first.snapshot.credit_tenths, '7');
        const pair = await Promise.all([quote('pricing-concurrent'), store.quote({ ownerId: user.toUpperCase(), idempotencyKey: 'pricing-concurrent', request })]);
        assert.equal(pair[0].id, pair[1].id);
        assert.equal(pair.filter(item => !item.replayed).length, 1);
        assert.equal((await quote('pricing-lock-wait')).snapshot.snapshotHash, first.snapshot.snapshotHash);
        await assert.rejects(store.quote({ ownerId: user, idempotencyKey: 'pricing-concurrent', request: { ...request, payload: { ...request.payload, prompt: '不同请求' } } }), error => error.reason === 'QUOTE_REPLAY_CONFLICT');
        await assert.rejects(store.changeLifecycle({ modelId, pricingVersion: 'v1', action: 'cancel' }));
        for (const sql of [
            `UPDATE public.pricing_quotes SET credit_tenths=8 WHERE id=$1`,
            `DELETE FROM public.pricing_quotes WHERE id=$1`,
            `UPDATE public.pricing_versions SET config='{}' WHERE id=$1`,
        ]) await expectCode(sql, [sql.includes('pricing_versions') ? v1.id : first.id], '42501');
        await expectCode('TRUNCATE public.pricing_quotes', [], '42501');
        await expectCode('DELETE FROM public.pricing_versions WHERE id=$1', [future.id], '42501');
        const nextTime = (await admin.query('SELECT ((floor(extract(epoch FROM clock_timestamp()))+1)*1000000)::text AS us')).rows[0].us;
        const v2 = await store.publishScheduled({ config: config('v2'), effectiveFromUs: nextTime });
        await admin.query('SELECT pg_sleep(greatest(0,$1::numeric/1000000-extract(epoch FROM clock_timestamp())+0.01))', [nextTime]);
        assert.equal((await quote('pricing-new-head')).snapshot.pricingVersion, 'v2');
        // V1仍未撤销；V2撤销后必须拒绝，不能退回V1。
        await store.changeLifecycle({ modelId, pricingVersion: 'v2', action: 'revoke' });
        await assert.rejects(quote('pricing-after-revoke'), error => error.reason === 'NO_ACTIVE_VERSION');
        await expectCode('UPDATE public.pricing_versions SET revoked_at_us=NULL WHERE id=$1', [v2.id], '42501');
        await expectCode('UPDATE public.pricing_versions SET cancelled_at_us=NULL WHERE id=$1', [future.id], '42501');
        await expectCode(`UPDATE public.logical_models SET logical_model_id='changed-identity' WHERE id=$1`, [modelPk], '42501');
        // 非法金额投影须拒绝，事务回滚不留下新凭证。
        await expectCode(`INSERT INTO public.pricing_quotes(owner_id,idempotency_key,request_fingerprint,pricing_version_id,snapshot,snapshot_hash,credit_tenths,created_at_us,expires_at_us)
            SELECT owner_id,'pricing-invalid-projection',request_fingerprint,pricing_version_id,snapshot,snapshot_hash,credit_tenths+1,created_at_us,expires_at_us FROM public.pricing_quotes WHERE id=$1`, [first.id], '23514');
        await admin.query('BEGIN');
        await admin.query(`SET LOCAL ROLE "${names.ledgerOwnerRole}"`);
        await assert.rejects(admin.query('UPDATE public.logical_models SET enabled=false WHERE id=$1', [modelPk]), { code: '42501' });
        await admin.query('ROLLBACK');
        assert.equal((await quote('pricing-lock-wait')).id, first.id);
        assert.equal((await admin.query('SELECT count(*)::int AS n FROM public.pricing_quotes WHERE owner_id=$1', [user])).rows[0].n, 3);
        assert.equal((await admin.query('SELECT count(*)::int AS n FROM public.generation_tasks WHERE owner_id=$1', [user])).rows[0].n, 0);
        assert.equal((await admin.query('SELECT count(*)::int AS n FROM public.credit_accounts WHERE user_id=$1', [user])).rows[0].n, 0);
        record('报价真实PG：锁等待后clock_timestamp、预约取消、发布冲突、同键并发/重放、不可变快照、撤销不回退及失败零task/账务', 'passed');
    } finally {
        await admin.query('ROLLBACK');
        await backing.end();
        // 不破坏不可变历史；本轮新建隔离库及其合成凭证按验收策略保留。
    }
}
module.exports = { checkPricingPersistence };
