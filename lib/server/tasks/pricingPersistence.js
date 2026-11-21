'use strict';

const { createTrustedQuoteService, preparePricingVersion, copyFrozenQuoteSnapshot, PricingError } = require('./pricingQuote');
const { validateCreateTaskRequest, requestFingerprint, stableStringify } = require('./taskSubmission');

const fail = reason => { throw new PricingError(reason); };
const clockSql = `SELECT trunc(extract(epoch FROM pg_catalog.clock_timestamp()) * 1000000)::text AS us`;
const versionRecord = row => ({ config: row.config, publishedAtUs: row.published_at_us,
    effectiveFromUs: row.effective_from_us, revokedAtUs: row.revoked_at_us, cancelledAtUs: row.cancelled_at_us });

// 未开放内部宿主：pool 必须由受限执行身份装配，本 store 只认 current_user 为专用 owner。
// 隔离验收与运维 CLI（pricingPublishCli.js）都先开显式事务、SET LOCAL ROLE 到 owner 再交给
// 本 store，管理员权限不进入事务且随 COMMIT/ROLLBACK 自动失效。没有 HTTP/环境变量接线。
function createInternalPricingStore({ pool } = {}) {
    if (!pool || typeof pool.connect !== 'function') throw new TypeError('受限事务连接池必填');
    async function transaction(run) {
        const client = await pool.connect();
        let begun = false;
        try {
            await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
            begun = true;
            const identity = (await client.query(`SELECT current_user = 'pt_ledger_owner_' ||
                substr(md5(current_database()), 1, 16) AS allowed`)).rows[0];
            if (identity?.allowed !== true) fail('PRICING_EXECUTOR_REQUIRED');
            const result = await run(client);
            await client.query('COMMIT');
            begun = false;
            return result;
        } catch (error) {
            if (begun) {
                try { await client.query('ROLLBACK'); }
                catch (rollbackError) { throw new AggregateError([error, rollbackError], 'PRICING_ROLLBACK_FAILED'); }
            }
            throw error;
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
    async function timeline(client, model) {
        return (await client.query('SELECT * FROM public.pricing_versions WHERE logical_model_pk=$1 ORDER BY effective_from_us', [model.id])).rows;
    }
    return Object.freeze({
        // 只有未来可信配置宿主可调用；当前只支持未来整秒预约，无草稿/立即发布/配置写 API。
        async publishScheduled({ config, effectiveFromUs } = {}) {
            const prepared = preparePricingVersion({ config, effectiveFromUs, publishedAtUs: null, revokedAtUs: null, cancelledAtUs: null });
            return transaction(async client => {
                const model = await lockModel(client, prepared.config.modelId);
                if (model.catalog_version !== prepared.config.modelVersion
                    || (model.media_type === 'image') !== (prepared.config.templateType === 'image_resolution_quantity')) fail('TEMPLATE_MISMATCH');
                const records = await timeline(client, model);
                const existing = records.find(row => row.pricing_version === prepared.config.pricingVersion);
                if (existing) {
                    if (existing.config_hash !== prepared.configHash || existing.effective_from_us !== effectiveFromUs
                        || stableStringify(existing.config) !== stableStringify(prepared.config)) fail('VERSION_CONFLICT');
                    return Object.freeze({ id: existing.id, replayed: true });
                }
                const now = (await client.query(clockSql)).rows[0].us;
                if (BigInt(effectiveFromUs) <= BigInt(now)) fail('EFFECTIVE_TIME_INVALID');
                const inserted = (await client.query(`INSERT INTO public.pricing_versions
                    (logical_model_pk,pricing_version,config,config_hash,effective_from_us,published_at_us)
                    VALUES ($1,$2,$3::jsonb,$4,$5,$6) RETURNING id`,
                [model.id, prepared.config.pricingVersion, JSON.stringify(prepared.config), prepared.configHash, effectiveFromUs, now])).rows[0];
                return Object.freeze({ id: inserted.id, replayed: false });
            });
        },
        async changeLifecycle({ modelId, pricingVersion, action } = {}) {
            if (!['cancel', 'revoke'].includes(action)) fail('LIFECYCLE_INVALID');
            return transaction(async client => {
                const model = await lockModel(client, modelId);
                const rows = await timeline(client, model);
                const existing = rows.find(row => row.pricing_version === pricingVersion);
                if (!existing) fail('NO_ACTIVE_VERSION');
                const field = action === 'cancel' ? 'cancelled_at_us' : 'revoked_at_us';
                if (existing[field] !== null) return Object.freeze({ id: existing.id, replayed: true });
                if (existing.cancelled_at_us !== null || existing.revoked_at_us !== null) fail('LIFECYCLE_INVALID');
                const now = (await client.query(clockSql)).rows[0].us;
                if (action === 'cancel' && BigInt(now) >= BigInt(existing.effective_from_us)) fail('LIFECYCLE_INVALID');
                // field 来自上方固定枚举，不含调用方 SQL。
                await client.query(`UPDATE public.pricing_versions SET ${field}=$2 WHERE id=$1`, [existing.id, now]);
                return Object.freeze({ id: existing.id, replayed: false });
            });
        },
        async quote({ ownerId, idempotencyKey, request } = {}) {
            if (typeof ownerId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ownerId)
                || typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) fail('INPUT_INVALID');
            ownerId = ownerId.toLowerCase();
            // 请求及身份只能由可信宿主提供；不接受金额、时钟或价格配置参数。
            const normalized = validateCreateTaskRequest(JSON.parse(stableStringify(request)));
            const fingerprint = requestFingerprint(normalized);
            return transaction(async client => {
                // 同owner/key跨模型也串行；模型锁仍是生命周期/选价的共同边界。
                await client.query('SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 625))', [`${ownerId}:${idempotencyKey}`]);
                const prior = (await client.query('SELECT * FROM public.pricing_quotes WHERE owner_id=$1 AND idempotency_key=$2', [ownerId, idempotencyKey])).rows[0];
                if (prior) {
                    if (prior.request_fingerprint !== fingerprint) fail('QUOTE_REPLAY_CONFLICT');
                    return Object.freeze({ id: prior.id, snapshot: copyFrozenQuoteSnapshot(prior.snapshot), replayed: true });
                }
                const model = await lockModel(client, normalized.payload.logicalModelId);
                if (!model.enabled || !model.supported_operations.includes(normalized.taskType)) fail('NO_ACTIVE_VERSION');
                // 必须读完整时间轴，再采样；不筛撤销、取消或旧模型版本来假造可用头。
                const records = await timeline(client, model);
                const now = (await client.query(clockSql)).rows[0].us;
                const snapshot = createTrustedQuoteService({ versions: records.map(versionRecord) }).quote({ request: normalized,
                    databaseTime: { source: 'postgresql.clock_timestamp', epochMicroseconds: now } });
                if (snapshot.modelVersion !== model.catalog_version) fail('MODEL_VERSION_CHANGED');
                const selected = records.find(row => row.pricing_version === snapshot.pricingVersion);
                if (selected.config_hash !== snapshot.configHash) fail('CONFIG_INVALID');
                const inserted = (await client.query(`INSERT INTO public.pricing_quotes
                    (owner_id,idempotency_key,request_fingerprint,pricing_version_id,snapshot,snapshot_hash,credit_tenths,created_at_us,expires_at_us)
                    VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9) RETURNING id`,
                [ownerId, idempotencyKey, fingerprint, selected.id, JSON.stringify(snapshot), snapshot.snapshotHash,
                    snapshot.credit_tenths, snapshot.createdAtUs, snapshot.expiresAtUs])).rows[0];
                return Object.freeze({ id: inserted.id, snapshot, replayed: false });
            });
        },
    });
}

module.exports = { createInternalPricingStore };
