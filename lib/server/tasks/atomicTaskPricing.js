'use strict';

const { createTrustedQuoteService, copyFrozenQuoteSnapshot, PricingError } = require('./pricingQuote');
const { validateCreateTaskRequest, requestFingerprint, stableStringify } = require('./taskSubmission');
const { assertTrustedRoute } = require('./trustedRouteSnapshot');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const clockSql = `SELECT trunc(extract(epoch FROM pg_catalog.clock_timestamp()) * 1000000)::text AS us`;
const versionRecord = row => ({ config: row.config, publishedAtUs: row.published_at_us,
    effectiveFromUs: row.effective_from_us, revokedAtUs: row.revoked_at_us, cancelledAtUs: row.cancelled_at_us });
const fail = reason => { throw new PricingError(reason); };
// 数据库拒绝只暴露固定理由：既不把SQL细节带给调用方，也不把失败误判成成功。
const databaseReasons = new Map([
    ['CREDIT_INSUFFICIENT', 'CREDIT_INSUFFICIENT'],
    ['CREDIT_QUOTE_EXPIRED', 'QUOTE_EXPIRED'],
    ['CREDIT_ACCOUNT_NOT_FOUND', 'CREDIT_ACCOUNT_NOT_FOUND'],
    ['CREDIT_QUOTE_TASK_MISMATCH', 'ATOMIC_QUOTE_MISMATCH'],
    ['CREDIT_AMOUNT_INVALID', 'CONFIG_INVALID'],
]);
const translateFailure = error => {
    if (error instanceof PricingError) return error;
    const reason = databaseReasons.get(error?.message);
    if (!reason) return error;
    const wrapped = new PricingError(reason);
    wrapped.cause = error;
    return wrapped;
};

// 仅供已受信的账务 owner 宿主使用。不会接收管理员/迁移连接，也不接 HTTP。
function createAtomicTaskPricingStore({ pool, routeResolver } = {}) {
    if (!pool || typeof pool.connect !== 'function') throw new TypeError('pool is required');
    // 可信路由解析器是构造期硬依赖：本入口不接受调用方临时塞入的路由。
    if (!routeResolver || typeof routeResolver.resolve !== 'function') {
        throw new TypeError('trusted routeResolver required');
    }

    async function transaction(run) {
        const client = await pool.connect();
        let begun = false;
        try {
            await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
            begun = true;
            const allowed = (await client.query(`SELECT current_user = 'pt_ledger_owner_' ||
                substr(md5(current_database()), 1, 16) AS allowed`)).rows[0]?.allowed;
            if (allowed !== true) fail('PRICING_EXECUTOR_REQUIRED');
            const result = await run(client);
            await client.query('COMMIT');
            begun = false;
            return result;
        } catch (error) {
            if (begun) {
                try { await client.query('ROLLBACK'); }
                catch (rollbackError) { throw new AggregateError([error, rollbackError], 'ATOMIC_ROLLBACK_FAILED'); }
            }
            throw translateFailure(error);
        } finally { client.release(); }
    }

    async function lockModel(client, modelId) {
        const identity = (await client.query('SELECT id FROM public.logical_models WHERE logical_model_id=$1', [modelId])).rows[0];
        if (!identity) fail('NO_ACTIVE_VERSION');
        await client.query('SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 626))', [identity.id]);
        const model = (await client.query(`SELECT id, logical_model_id, catalog_version, enabled,
            media_type, supported_operations FROM public.logical_models WHERE id=$1 AND logical_model_id=$2`, [identity.id, modelId])).rows[0];
        if (!model) fail('NO_ACTIVE_VERSION');
        return model;
    }

    return Object.freeze({
        async submit({ ownerId, idempotencyKey, request, maxAttempts = 3 } = {}) {
            if (typeof ownerId !== 'string' || !UUID_PATTERN.test(ownerId)
                || typeof idempotencyKey !== 'string' || !KEY_PATTERN.test(idempotencyKey)) fail('INPUT_INVALID');
            if (!Number.isSafeInteger(maxAttempts) || maxAttempts <= 0) fail('INPUT_INVALID');
            const normalized = validateCreateTaskRequest(JSON.parse(stableStringify(request)));
            const fingerprint = requestFingerprint(normalized);
            // 路由解析在事务外完成：解析失败不占用数据库事务，也不会留下任何账务写入。
            const route = assertTrustedRoute(await routeResolver.resolve(normalized), normalized);
            const user = ownerId.toLowerCase();

            return transaction(async client => {
                await client.query('SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 625))', [`${user}:${idempotencyKey}`]);
                const priorTask = (await client.query(`SELECT * FROM public.generation_tasks
                    WHERE owner_id=$1 AND idempotency_key=$2`, [user, idempotencyKey])).rows[0];
                if (priorTask) {
                    if (priorTask.request_fingerprint !== fingerprint) fail('IDEMPOTENCY_KEY_REUSED');
                    const prior = (await client.query(`SELECT id,task_id,snapshot FROM public.pricing_quotes
                        WHERE owner_id=$1 AND task_id=$2`, [user, priorTask.id])).rows[0];
                    if (!prior) fail('ATOMIC_REPLAY_INCOMPLETE');
                    return Object.freeze({ task: priorTask, quoteId: prior.id, snapshot: copyFrozenQuoteSnapshot(prior.snapshot), replayed: true });
                }

                const model = await lockModel(client, normalized.payload.logicalModelId);
                if (!model.enabled || !model.supported_operations.includes(normalized.taskType)) fail('NO_ACTIVE_VERSION');
                // 路由必须指向本次锁定的同一模型与同一目录版本，避免价格和一个过期路由一起落库。
                if (route.logicalModelPk !== model.id
                    || route.routeSnapshot.logicalModelVersion !== model.catalog_version) fail('MODEL_ROUTE_INVALID');
                const records = (await client.query('SELECT * FROM public.pricing_versions WHERE logical_model_pk=$1 ORDER BY effective_from_us', [model.id])).rows;
                const now = (await client.query(clockSql)).rows[0].us;
                const snapshot = createTrustedQuoteService({ versions: records.map(versionRecord) }).quote({
                    request: normalized, databaseTime: { source: 'postgresql.clock_timestamp', epochMicroseconds: now },
                });
                const selected = records.find(row => row.pricing_version === snapshot.pricingVersion);
                if (!selected || selected.config_hash !== snapshot.configHash) fail('CONFIG_INVALID');
                if (snapshot.credit_tenths === '0') fail('CREDIT_FREE_RESERVE_UNSUPPORTED');

                const taskValues = [user, idempotencyKey, fingerprint, normalized.taskType, JSON.stringify(normalized.payload), maxAttempts,
                    route.logicalModelPk, JSON.stringify(route.routeSnapshot),
                    route.routeSnapshotVersion, route.routeSnapshotHash];
                const task = (await client.query(`INSERT INTO public.generation_tasks
                    (owner_id,idempotency_key,request_fingerprint,task_type,payload,max_attempts,logical_model_pk,route_snapshot,route_snapshot_version,route_snapshot_hash)
                    VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8::jsonb,$9,$10) RETURNING *`, taskValues)).rows[0];
                const quote = (await client.query(`INSERT INTO public.pricing_quotes
                    (owner_id,task_id,idempotency_key,request_fingerprint,pricing_version_id,snapshot,snapshot_hash,credit_tenths,created_at_us,expires_at_us)
                    VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10) RETURNING id`,
                [user, task.id, idempotencyKey, fingerprint, selected.id, JSON.stringify(snapshot), snapshot.snapshotHash,
                    snapshot.credit_tenths, snapshot.createdAtUs, snapshot.expiresAtUs])).rows[0];
                const reserve = (await client.query('SELECT public.credit_reserve_task($1,$2,$3,$4) AS event_id',
                    [user, task.id, quote.id, snapshot.credit_tenths])).rows[0];
                return Object.freeze({ task, quoteId: quote.id, reserveEventId: reserve.event_id, snapshot, replayed: false });
            });
        },
    });
}

module.exports = { createAtomicTaskPricingStore };
