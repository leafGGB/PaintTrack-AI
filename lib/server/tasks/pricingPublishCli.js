'use strict';

const fs = require('node:fs');
const { Pool } = require('pg');
const { ledgerOwnerRole } = require('../db/migrate');
const { parseDatabaseTarget, sameDatabaseTarget } = require('../db/testIsolation');
const { createInternalPricingStore } = require('./pricingPersistence');
const { preparePricingVersion } = require('./pricingQuote');

// 运维宿主：价格版本只能由专用 NOLOGIN owner 写入（0025 已对 PUBLIC 撤权）。
// 本模块用管理员身份连目标库，并只在显式事务内 SET LOCAL ROLE 到 owner，
// 事务结束自动失效；管理员权限不进入 store，也不进入 Web/Worker 进程。
// 不改任何角色授权、不构造长期 owner 连接、不新增 HTTP 入口。

const MAX_CONFIG_BYTES = 64 * 1024;
const RESERVED_DATABASES = Object.freeze(['postgres', 'template0', 'template1']);
const TARGET_CONFIRMATION_KEYS = Object.freeze([
    'DATABASE_URL', 'MIGRATION_DATABASE_URL', 'PAINTTRACK_WORKER_DATABASE_URL', 'PAINTTRACK_CLEANUP_DATABASE_URL',
]);
const OWNER_ROLE_PATTERN = /^pt_ledger_owner_[0-9a-f]{16}$/;
const BOOLEAN_FLAGS = Object.freeze(['dry-run']);
const ALLOWED_OPTIONS = Object.freeze({
    publish: ['config', 'effective-from', 'dry-run'],
    cancel: ['model-id', 'pricing-version'],
    revoke: ['model-id', 'pricing-version'],
    timeline: ['model-id'],
});
const REQUIRED_OPTIONS = Object.freeze({
    publish: ['config', 'effective-from'],
    cancel: ['model-id', 'pricing-version'],
    revoke: ['model-id', 'pricing-version'],
    timeline: ['model-id'],
});
const ACTIONS = Object.freeze(Object.keys(ALLOWED_OPTIONS));

class PricingPublishError extends Error {
    constructor(reason) {
        super(reason);
        this.name = 'PricingPublishError';
        this.reason = reason;
    }
}

const fail = (reason) => { throw new PricingPublishError(reason); };
const quoteIdent = (value) => `"${value.replaceAll('"', '""')}"`;
const beginPattern = /^\s*BEGIN\b/i;

function parseArguments(argv = []) {
    const list = Array.isArray(argv) ? argv : [];
    const [action, ...rest] = list;
    if (!action || !ACTIONS.includes(action)) fail('ACTION_INVALID');
    const options = {};
    for (let index = 0; index < rest.length; index += 1) {
        const token = rest[index];
        if (typeof token !== 'string' || !token.startsWith('--')) fail('ARGUMENT_INVALID');
        const equal = token.indexOf('=');
        const name = equal === -1 ? token.slice(2) : token.slice(2, equal);
        if (!name) fail('ARGUMENT_INVALID');
        // 未知参数先于取值校验：打错参数名时要报"不接受该参数"，而不是"缺少取值"。
        if (!ALLOWED_OPTIONS[action].includes(name)) fail('ARGUMENT_UNKNOWN');
        if (Object.prototype.hasOwnProperty.call(options, name)) fail('ARGUMENT_DUPLICATED');
        if (equal !== -1) {
            options[name] = token.slice(equal + 1);
            if (!options[name]) fail('ARGUMENT_VALUE_REQUIRED');
        } else if (BOOLEAN_FLAGS.includes(name)) {
            options[name] = 'true';
        } else {
            const value = rest[index + 1];
            if (typeof value !== 'string' || !value || value.startsWith('--')) fail('ARGUMENT_VALUE_REQUIRED');
            options[name] = value;
            index += 1;
        }
    }
    for (const name of REQUIRED_OPTIONS[action]) {
        if (!Object.prototype.hasOwnProperty.call(options, name)) fail('ARGUMENT_REQUIRED');
    }
    return Object.freeze({ action, options: Object.freeze({ ...options }) });
}

// 只接受整秒：数据库价格时间轴按整秒对齐，避免同一秒内出现两个候选头。
function resolveEffectiveFromUs(text) {
    if (typeof text !== 'string' || !text.trim()) fail('EFFECTIVE_FROM_REQUIRED');
    const raw = text.trim();
    let seconds;
    if (raw.startsWith('@')) {
        if (!/^@\d{1,12}$/.test(raw)) fail('EFFECTIVE_FROM_INVALID');
        seconds = Number(raw.slice(1));
    } else {
        const milliseconds = Date.parse(raw);
        if (!Number.isInteger(milliseconds)) fail('EFFECTIVE_FROM_INVALID');
        if (milliseconds % 1000 !== 0) fail('EFFECTIVE_FROM_NOT_WHOLE_SECOND');
        seconds = milliseconds / 1000;
    }
    if (!Number.isSafeInteger(seconds) || seconds <= 0) fail('EFFECTIVE_FROM_INVALID');
    return (BigInt(seconds) * 1000000n).toString();
}

function readConfigFile(file) {
    if (typeof file !== 'string' || !file) fail('CONFIG_PATH_REQUIRED');
    let stat;
    try {
        stat = fs.statSync(file);
    } catch {
        fail('CONFIG_UNREADABLE');
    }
    if (!stat.isFile()) fail('CONFIG_UNREADABLE');
    if (stat.size > MAX_CONFIG_BYTES) fail('CONFIG_TOO_LARGE');
    let parsed;
    try {
        parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        fail('CONFIG_INVALID_JSON');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('CONFIG_INVALID');
    return parsed;
}

function assertModelIdentifier(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value)) fail('MODEL_ID_INVALID');
    return value;
}

function assertPricingVersionName(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value)) fail('PRICING_VERSION_INVALID');
    return value;
}

// 发布身份必须是独立的管理员身份：与运行、迁移、Worker、cleanup 都不能同名，
// 目标必须是本机回环上的同一业务库；远程/生产发布不在本入口范围内。
function assertPublishEnvironment(env = process.env) {
    // LEDGER_DATABASE_URL 是账务运维命令的统一入口（价格发布与额度发放共用同一管理员身份）。
    const publishUrl = env.LEDGER_DATABASE_URL || env.PUBLISH_DATABASE_URL;
    if (!publishUrl) fail('PUBLISH_DATABASE_URL_REQUIRED');
    if (!env.DATABASE_URL) fail('PUBLISH_TARGET_CONFIRMATION_REQUIRED');
    let target;
    try {
        target = parseDatabaseTarget(publishUrl);
    } catch {
        fail('PUBLISH_DATABASE_URL_INVALID');
    }
    if (!target.loopback) fail('PUBLISH_TARGET_NOT_LOOPBACK');
    if (RESERVED_DATABASES.includes(target.database)) fail('PUBLISH_TARGET_INVALID');
    if (!sameDatabaseTarget(publishUrl, env.DATABASE_URL)) fail('PUBLISH_TARGET_MUST_MATCH');
    for (const key of TARGET_CONFIRMATION_KEYS) {
        const value = env[key];
        if (!value) continue;
        if (parseDatabaseTarget(value).username === target.username) fail('PUBLISH_IDENTITY_MUST_DIFFER');
    }
    const role = ledgerOwnerRole(target.database);
    if (!OWNER_ROLE_PATTERN.test(role)) fail('OWNER_ROLE_INVALID');
    return Object.freeze({ connectionString: publishUrl, database: target.database, role });
}

// store 只认 owner 身份。这里在 BEGIN 之后立刻降级到 owner，并回读校验：
// 连接在事务外仍是管理员，但任何非事务语句都会被拒绝，避免权限外溢。
function createOwnerSessionPool({ connectionString, role, PoolImpl = Pool } = {}) {
    if (typeof connectionString !== 'string' || !connectionString) fail('PUBLISH_DATABASE_URL_REQUIRED');
    if (typeof role !== 'string' || !OWNER_ROLE_PATTERN.test(role)) fail('OWNER_ROLE_INVALID');
    const backing = new PoolImpl({
        connectionString,
        max: 2,
        connectionTimeoutMillis: 3000,
        application_name: 'painttrack-pricing-publisher',
    });
    async function connect() {
        const client = await backing.connect();
        let bound = false;
        return {
            async query(sql, values) {
                const text = String(sql);
                if (!bound && !beginPattern.test(text)) fail('PRICING_SESSION_UNBOUND');
                const result = await client.query(text, values);
                if (!bound) {
                    bound = true;
                    try {
                        await client.query(`SET LOCAL ROLE ${quoteIdent(role)}`);
                        const identity = (await client.query('SELECT current_user AS current_user')).rows[0];
                        if (!identity || identity.current_user !== role) fail('PRICING_EXECUTOR_REQUIRED');
                    } catch (error) {
                        await client.query('ROLLBACK').catch(() => {});
                        throw error;
                    }
                }
                return result;
            },
            release() { client.release(); },
        };
    }
    return Object.freeze({
        connect,
        async end() { await backing.end(); },
    });
}

// 在事务内确认 owner 确实是不可登录、无继承的专用角色：被掉包成可登录角色时立即停止。
async function inspectOwnerRole(client, role) {
    const row = (await client.query(`SELECT rolcanlogin, rolinherit, rolsuper, rolcreatedb, rolcreaterole,
        rolreplication, rolbypassrls FROM pg_catalog.pg_roles WHERE rolname = current_user`)).rows[0];
    if (!row) fail('LEDGER_OWNER_NOT_PREPARED');
    const unexpected = ['rolcanlogin', 'rolinherit', 'rolsuper', 'rolcreatedb', 'rolcreaterole', 'rolreplication', 'rolbypassrls']
        .some((key) => row[key] !== false);
    if (unexpected) fail('LEDGER_OWNER_ATTRIBUTES_INVALID');
    const canWrite = (await client.query(`SELECT has_table_privilege(current_user, $1, 'INSERT') AS allowed`,
        ['public.pricing_versions'])).rows[0];
    if (canWrite?.allowed !== true) fail('LEDGER_OWNER_NOT_PREPARED');
    const identity = (await client.query('SELECT current_user AS current_user')).rows[0];
    if (identity?.current_user !== role) fail('PRICING_EXECUTOR_REQUIRED');
}

async function withOwnerTransaction(pool, role, run) {
    const client = await pool.connect();
    let begun = false;
    try {
        await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
        begun = true;
        await inspectOwnerRole(client, role);
        const result = await run(client);
        await client.query('COMMIT');
        begun = false;
        return result;
    } catch (error) {
        if (begun) await client.query('ROLLBACK').catch(() => {});
        throw error;
    } finally {
        client.release();
    }
}

const timelineRow = (row) => Object.freeze({
    id: row.id,
    pricingVersion: row.pricing_version,
    configHash: row.config_hash,
    effectiveFromUs: row.effective_from_us,
    publishedAtUs: row.published_at_us,
    revokedAtUs: row.revoked_at_us,
    cancelledAtUs: row.cancelled_at_us,
});

async function readTimeline(pool, role, modelId) {
    assertModelIdentifier(modelId);
    return withOwnerTransaction(pool, role, async (client) => {
        const rows = (await client.query(`SELECT pv.id, pv.pricing_version, pv.config_hash, pv.effective_from_us,
            pv.published_at_us, pv.revoked_at_us, pv.cancelled_at_us
            FROM public.pricing_versions pv
            JOIN public.logical_models lm ON lm.id = pv.logical_model_pk
            WHERE lm.logical_model_id = $1 ORDER BY pv.effective_from_us`, [modelId])).rows;
        return rows.map(timelineRow);
    });
}

async function publishVersion(pool, { config, effectiveFromUs }) {
    const store = createInternalPricingStore({ pool });
    return store.publishScheduled({ config, effectiveFromUs });
}

async function changeLifecycle(pool, { modelId, pricingVersion, action }) {
    const store = createInternalPricingStore({ pool });
    return store.changeLifecycle({ modelId, pricingVersion, action });
}

function shortFailure(error) {
    const known = {
        ACTION_INVALID: '需要明确的操作：publish、cancel、revoke 或 timeline。',
        ARGUMENT_INVALID: '参数格式无效。',
        ARGUMENT_DUPLICATED: '同一个参数只能出现一次。',
        ARGUMENT_UNKNOWN: '存在当前操作不接受的参数。',
        ARGUMENT_REQUIRED: '缺少必需的参数。',
        ARGUMENT_VALUE_REQUIRED: '参数缺少取值。',
        EFFECTIVE_FROM_REQUIRED: '需要指定生效时间。',
        EFFECTIVE_FROM_INVALID: '生效时间无法解析；请使用 ISO 8601 时间或 @整秒时间戳。',
        EFFECTIVE_FROM_NOT_WHOLE_SECOND: '生效时间必须是整秒；价格时间轴按整秒对齐。',
        CONFIG_PATH_REQUIRED: '需要指定价格配置文件路径。',
        CONFIG_UNREADABLE: '价格配置文件无法读取。',
        CONFIG_TOO_LARGE: '价格配置文件超过允许大小。',
        CONFIG_INVALID_JSON: '价格配置文件不是合法 JSON。',
        CONFIG_INVALID: '价格配置必须是 JSON 对象。',
        MODEL_ID_INVALID: '模型标识格式无效。',
        PRICING_VERSION_INVALID: '价格版本名格式无效。',
        PUBLISH_DATABASE_URL_REQUIRED: '需要 PUBLISH_DATABASE_URL：专门的管理员身份连接。',
        PUBLISH_DATABASE_URL_INVALID: 'PUBLISH_DATABASE_URL 不是合法的 PostgreSQL 目标。',
        PUBLISH_TARGET_CONFIRMATION_REQUIRED: '需要 DATABASE_URL 用于确认发布目标库一致。',
        PUBLISH_TARGET_NOT_LOOPBACK: '只允许对本机回环数据库发布；远程目标不在本入口范围内。',
        PUBLISH_TARGET_INVALID: '不能对维护库或模板库发布价格。',
        PUBLISH_TARGET_MUST_MATCH: 'PUBLISH_DATABASE_URL 必须与 DATABASE_URL 指向同一业务库。',
        PUBLISH_IDENTITY_MUST_DIFFER: '发布身份必须与运行、迁移、Worker、cleanup 身份不同。',
        OWNER_ROLE_INVALID: '账务 owner 角色名不符合约定。',
        PRICING_SESSION_UNBOUND: '定价写入必须在显式事务内进行。',
        PRICING_EXECUTOR_REQUIRED: '当前连接没有切换到专用账务 owner，已拒绝写入。',
        LEDGER_OWNER_NOT_PREPARED: '专用账务 owner 尚未准备或缺少定价写权限。',
        LEDGER_OWNER_ATTRIBUTES_INVALID: '专用账务 owner 属性被改变，已拒绝写入。',
        PRICING_ROLLBACK_FAILED: '事务回滚失败；请检查数据库日志。',
        NO_ACTIVE_VERSION: '该模型没有可用价格版本。',
        VERSION_CONFLICT: '同一价格版本名已存在但内容不同，拒绝覆盖。',
        EFFECTIVE_TIME_INVALID: '生效时间必须晚于数据库当前时间。',
        TEMPLATE_MISMATCH: '价格模板与模型类型不匹配。',
        LIFECYCLE_INVALID: '该版本当前不允许此生命周期操作。',
        CONFIG_INVALID: '价格配置未通过校验。',
        INPUT_INVALID: '输入不符合要求。',
    };
    if (error instanceof PricingPublishError) return { message: known[error.reason] || '价格发布未完成。', code: error.reason };
    // PricingError 由价格校验层抛出，reason 是稳定枚举，不携带连接信息。
    if (error && typeof error.reason === 'string' && known[error.reason]) return { message: known[error.reason], code: error.reason };
    if (error && error.code === '42501') return { message: '数据库拒绝了该操作：当前身份不能切换到专用账务 owner。', code: 'PUBLISH_SET_ROLE_DENIED' };
    if (error && error.code === '23505') return { message: '同一模型在该生效时间已存在价格版本。', code: '23505' };
    return { message: '价格发布未完成；请检查数据库连接、迁移状态与数据库日志。', code: 'PRICING_PUBLISH_FAILED' };
}

async function main({ argv = process.argv.slice(2), env = process.env, output = process.stdout, errorOutput = process.stderr, PoolImpl = Pool } = {}) {
    let pool;
    try {
        const { action, options } = parseArguments(argv);
        // 本地校验先于任何连接装配：配置或时间写错时不应触碰数据库。
        let preparedInput = null;
        if (action === 'publish') {
            const config = readConfigFile(options.config);
            const effectiveFromUs = resolveEffectiveFromUs(options['effective-from']);
            if (options['dry-run'] === 'true') {
                const prepared = preparePricingVersion({ config, effectiveFromUs, publishedAtUs: null, revokedAtUs: null, cancelledAtUs: null });
                const preview = Object.freeze({
                    action, dryRun: true,
                    modelId: prepared.config.modelId,
                    pricingVersion: prepared.config.pricingVersion,
                    configHash: prepared.configHash,
                    effectiveFromUs,
                });
                output.write(`${JSON.stringify(preview, null, 2)}\n`);
                return preview;
            }
            preparedInput = { config, effectiveFromUs };
        }
        const environment = assertPublishEnvironment(env);
        pool = createOwnerSessionPool({ connectionString: environment.connectionString, role: environment.role, PoolImpl });
        let result;
        if (action === 'publish') {
            const published = await publishVersion(pool, preparedInput);
            result = Object.freeze({
                action, modelId: preparedInput.config.modelId, pricingVersion: preparedInput.config.pricingVersion,
                id: published.id, replayed: published.replayed, effectiveFromUs: preparedInput.effectiveFromUs,
            });
        } else if (action === 'timeline') {
            const modelId = assertModelIdentifier(options['model-id']);
            result = Object.freeze({ action, modelId, versions: await readTimeline(pool, environment.role, modelId) });
        } else {
            const modelId = assertModelIdentifier(options['model-id']);
            const pricingVersion = assertPricingVersionName(options['pricing-version']);
            const changed = await changeLifecycle(pool, { modelId, pricingVersion, action });
            result = Object.freeze({ action, modelId, pricingVersion, id: changed.id, replayed: changed.replayed });
        }
        output.write(`${JSON.stringify(result, null, 2)}\n`);
        return result;
    } catch (error) {
        const failure = shortFailure(error);
        output.write(`${failure.message}\n`);
        errorOutput.write(`${failure.code}\n`);
        process.exitCode = 1;
        return null;
    } finally {
        if (pool) await pool.end().catch(() => {});
    }
}

if (require.main === module) {
    main().catch(() => {
        process.stderr.write('PRICING_PUBLISH_FAILED\n');
        process.exitCode = 1;
    });
}

module.exports = {
    ACTION_LIST: ACTIONS,
    PricingPublishError,
    assertPublishEnvironment,
    changeLifecycle,
    createOwnerSessionPool,
    main,
    parseArguments,
    publishVersion,
    readConfigFile,
    readTimeline,
    resolveEffectiveFromUs,
    shortFailure,
    withOwnerTransaction,
};
