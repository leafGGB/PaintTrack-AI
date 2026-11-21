'use strict';

const { validateCreateTaskRequest, requestFingerprint, TaskApiError } = require('./taskSubmission');
const { createTrustedQuoteService, PricingError } = require('./pricingQuote');
const { assertTrustedRoute, UUID_PATTERN } = require('./trustedRouteSnapshot');
const { toPublicTask } = require('./taskView');

const KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const clockSql = `SELECT trunc(extract(epoch FROM pg_catalog.clock_timestamp()) * 1000000)::text AS us`;
const versionRecord = row => ({ config: row.config, publishedAtUs: row.published_at_us,
    effectiveFromUs: row.effective_from_us, revokedAtUs: row.revoked_at_us, cancelledAtUs: row.cancelled_at_us });
const fail = reason => { throw new PricingError(reason); };

// 报价失败必须落到稳定的HTTP语义：余额类拒绝是402，其余是可重试的409/503。
const pricingStatus = new Map([
    ['INPUT_INVALID', 400],
    ['IDEMPOTENCY_KEY_REUSED', 409],
    ['MODEL_ROUTE_REQUIRED', 409],
    ['MODEL_ROUTE_INVALID', 409],
    ['MODEL_ROUTE_HASH_MISMATCH', 409],
    ['NO_ACTIVE_VERSION', 409],
    ['CONFIG_INVALID', 503],
    ['VERSION_HISTORY_LIMIT', 503],
    ['RESULT_OVERFLOW', 503],
]);
// 数据库只回固定理由：不透传SQL细节，也不把拒绝当成成功。
const databaseFailures = new Map([
    ['CREDIT_INSUFFICIENT', [402, 'CREDIT_INSUFFICIENT']],
    ['CREDIT_ACCOUNT_NOT_FOUND', [402, 'CREDIT_ACCOUNT_NOT_FOUND']],
    ['CREDIT_QUOTE_EXPIRED', [409, 'QUOTE_EXPIRED']],
    ['CREDIT_QUOTE_TASK_MISMATCH', [409, 'ATOMIC_QUOTE_MISMATCH']],
    ['CREDIT_TASK_NOT_FOUND', [409, 'TASK_CHARGE_MISMATCH']],
    ['CREDIT_QUOTE_MODEL_MISMATCH', [409, 'TASK_CHARGE_MISMATCH']],
    ['CREDIT_CHARGE_INVALID', [409, 'TASK_CHARGE_INVALID']],
    ['PRICING_SNAPSHOT_MISMATCH', [503, 'PRICING_SNAPSHOT_MISMATCH']],
]);

function translate(error) {
    if (error instanceof TaskApiError) return error;
    if (error instanceof PricingError) {
        return new TaskApiError(error.reason, pricingStatus.get(error.reason) ?? 503);
    }
    const known = databaseFailures.get(error?.message);
    if (known) return new TaskApiError(known[1], known[0]);
    // 权限或未知数据库错误交给上层按 503 处理，不暴露连接与语句细节。
    return error;
}

/**
 * 收费提交入口：Web 运行身份在这里完成「报价 + 建任务 + 冻结」的事务。
 * 运行身份对 pricing_versions / pricing_quotes / 账本没有任何直接权限，
 * 价格时间轴与报价落库都只经 owner 所有的 SECURITY DEFINER 函数。
 */
function createChargedSubmissionService({ pool, routeResolver } = {}) {
    if (!pool || typeof pool.connect !== 'function') throw new TypeError('pool is required');
    // 可信路由解析器是构造期硬依赖：不接受调用方临时塞入的路由或快照。
    if (!routeResolver || typeof routeResolver.resolve !== 'function') {
        throw new TypeError('trusted routeResolver required');
    }

    async function transaction(run) {
        const client = await pool.connect();
        let begun = false;
        try {
            await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
            begun = true;
            const result = await run(client);
            await client.query('COMMIT');
            begun = false;
            return result;
        } catch (error) {
            if (begun) {
                try { await client.query('ROLLBACK'); }
                catch (rollbackError) { throw new AggregateError([error, rollbackError], 'CHARGED_ROLLBACK_FAILED'); }
            }
            throw translate(error);
        } finally { client.release(); }
    }

    async function lockModel(client, modelId) {
        const identity = (await client.query('SELECT id FROM public.logical_models WHERE logical_model_id=$1', [modelId])).rows[0];
        if (!identity) fail('NO_ACTIVE_VERSION');
        await client.query('SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 626))', [identity.id]);
        const model = (await client.query(`SELECT id, logical_model_id, catalog_version, enabled,
            media_type, supported_operations FROM public.logical_models WHERE id=$1 AND logical_model_id=$2`,
        [identity.id, modelId])).rows[0];
        if (!model) fail('NO_ACTIVE_VERSION');
        return model;
    }

    // 重放只读既有报价与冻结：不允许按当前价格重算，否则同一幂等键会得到两个价格。
    async function replayCharge(client, userId, taskId) {
        try {
            return (await client.query('SELECT * FROM public.credit_charge_task_verified($1,$2)', [userId, taskId])).rows[0];
        } catch (error) {
            if (error?.message === 'CREDIT_CHARGE_INVALID') {
                // 该幂等键对应的任务来自未启用收费的旧入口，不能在这里补收费或伪装成功。
                throw new TaskApiError('TASK_REPLAY_UNCHARGED', 409);
            }
            throw error;
        }
    }

    return Object.freeze({
        async submit({ ownerId, idempotencyKey, taskType, payload, maxAttempts = 3 } = {}) {
            if (typeof ownerId !== 'string' || !UUID_PATTERN.test(ownerId)
                || typeof idempotencyKey !== 'string' || !KEY_PATTERN.test(idempotencyKey)) {
                throw new TaskApiError('INVALID_TASK_REQUEST', 400);
            }
            if (!Number.isSafeInteger(maxAttempts) || maxAttempts <= 0) {
                throw new TaskApiError('INVALID_TASK_REQUEST', 400);
            }
            const normalized = validateCreateTaskRequest({ taskType, payload });
            const fingerprint = requestFingerprint(normalized);
            // 路由解析在事务外完成：解析失败不占用事务，也不会留下任何账务写入。
            let route;
            try {
                route = assertTrustedRoute(await routeResolver.resolve(normalized), normalized);
            } catch (error) {
                // 目录错误保持原样交给HTTP层按白名单映射；报价错误在这里落到稳定状态码。
                throw translate(error);
            }
            const user = ownerId.toLowerCase();

            return transaction(async (client) => {
                await client.query('SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 625))', [`${user}:${idempotencyKey}`]);
                const priorTask = (await client.query(`SELECT * FROM public.generation_tasks
                    WHERE owner_id=$1 AND idempotency_key=$2`, [user, idempotencyKey])).rows[0];
                if (priorTask) {
                    if (priorTask.request_fingerprint !== fingerprint) fail('IDEMPOTENCY_KEY_REUSED');
                    const charge = await replayCharge(client, user, priorTask.id);
                    return Object.freeze({
                        task: toPublicTask(priorTask), replayed: true,
                        credit: Object.freeze({ tenths: charge.credit_tenths, quoteId: charge.quote_id, reserved: charge.event_id !== null }),
                    });
                }

                const model = await lockModel(client, normalized.payload.logicalModelId);
                if (!model.enabled || !model.supported_operations.includes(normalized.taskType)) fail('NO_ACTIVE_VERSION');
                // 路由必须指向本次锁定的同一模型与同一目录版本，避免价格和一个过期路由一起落库。
                if (route.logicalModelPk !== model.id
                    || route.routeSnapshot.logicalModelVersion !== model.catalog_version) fail('MODEL_ROUTE_INVALID');
                const records = (await client.query('SELECT * FROM public.pricing_versions_for_submission($1)', [model.id])).rows;
                if (records.length === 0) fail('NO_ACTIVE_VERSION');
                const now = (await client.query(clockSql)).rows[0].us;
                const snapshot = createTrustedQuoteService({ versions: records.map(versionRecord) }).quote({
                    request: normalized, databaseTime: { source: 'postgresql.clock_timestamp', epochMicroseconds: now },
                });
                const selected = records.find(row => row.pricing_version === snapshot.pricingVersion);
                if (!selected || selected.config_hash !== snapshot.configHash) fail('CONFIG_INVALID');

                const task = (await client.query(`INSERT INTO public.generation_tasks
                    (owner_id,idempotency_key,request_fingerprint,task_type,payload,max_attempts,logical_model_pk,route_snapshot,route_snapshot_version,route_snapshot_hash)
                    VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8::jsonb,$9,$10) RETURNING *`,
                [user, idempotencyKey, fingerprint, normalized.taskType, JSON.stringify(normalized.payload), maxAttempts,
                    route.logicalModelPk, JSON.stringify(route.routeSnapshot),
                    route.routeSnapshotVersion, route.routeSnapshotHash])).rows[0];
                // 免费档（0 credit_tenths）同样写不可变报价，但不冻结、不产生账本事件。
                const charge = (await client.query(`SELECT * FROM public.credit_charge_task_verified($1,$2,$3,$4::jsonb,$5,$6,$7,$8)`,
                    [user, task.id, selected.id, JSON.stringify(snapshot), snapshot.snapshotHash,
                        snapshot.credit_tenths, snapshot.createdAtUs, snapshot.expiresAtUs])).rows[0];
                return Object.freeze({
                    task: toPublicTask(task), replayed: false,
                    credit: Object.freeze({ tenths: charge.credit_tenths, quoteId: charge.quote_id, reserved: charge.event_id !== null }),
                });
            });
        },
    });
}

module.exports = { createChargedSubmissionService };
