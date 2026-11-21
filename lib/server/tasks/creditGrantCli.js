const { Pool } = require('pg');
const {
    PricingPublishError,
    assertPublishEnvironment,
    createOwnerSessionPool,
    withOwnerTransaction,
} = require('./pricingPublishCli');

// 额度发放是运维命令，不是管理员页面：与价格发布共用同一套“管理员身份 + 事务内降级到 owner”的会话范式。
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AMOUNT_PATTERN = /^[1-9][0-9]{0,18}$/;
const SOURCE_TYPES = Object.freeze(['signup', 'manual']);
const ALLOWED_OPTIONS = Object.freeze({
    grant: ['user-id', 'amount', 'source-id', 'source-type'],
    balance: ['user-id'],
});
const REQUIRED_OPTIONS = Object.freeze({
    grant: ['user-id', 'amount', 'source-id'],
    balance: ['user-id'],
});
const ACTIONS = Object.freeze(Object.keys(ALLOWED_OPTIONS));

class CreditGrantError extends Error {
    constructor(reason) {
        super(reason);
        this.name = 'CreditGrantError';
        this.reason = reason;
    }
}

const fail = (reason) => { throw new CreditGrantError(reason); };

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
        // 与价格发布保持同一语义：未知参数先于取值校验。
        if (!ALLOWED_OPTIONS[action].includes(name)) fail('ARGUMENT_UNKNOWN');
        if (Object.prototype.hasOwnProperty.call(options, name)) fail('ARGUMENT_DUPLICATED');
        if (equal !== -1) {
            options[name] = token.slice(equal + 1);
            if (!options[name]) fail('ARGUMENT_VALUE_REQUIRED');
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

function assertUuid(value, reason) {
    if (typeof value !== 'string' || !UUID_PATTERN.test(value)) fail(reason);
    return value.toLowerCase();
}

// 发放额度只接受正整数十个进制字符串：账本以 credit_tenths 为原子单位，不接受小数、指数或负数。
// 上限与账本列一致（bigint），越界在连库前就拒绝，而不是等数据库报 22003。
const MAX_GRANT_TENTHS = 9223372036854775807n;

function assertAmount(value) {
    if (typeof value !== 'string' || !AMOUNT_PATTERN.test(value)) fail('AMOUNT_INVALID');
    if (BigInt(value) > MAX_GRANT_TENTHS) fail('AMOUNT_INVALID');
    return value;
}

// owner 必须真的有发放执行权；角色被掉包或缺函数授权时立即停止。
async function assertGrantPrivilege(client) {
    const row = (await client.query(`SELECT has_function_privilege(current_user, $1, 'EXECUTE') AS allowed`,
        ['public.credit_grant(uuid,numeric,text,uuid)'])).rows[0];
    if (row?.allowed !== true) fail('LEDGER_OWNER_NOT_PREPARED');
}

const grantKey = (sourceType, sourceId) => `grant:${sourceType}:${sourceId}`;

async function grantCredit(pool, role, { userId, amount, sourceType, sourceId } = {}) {
    return withOwnerTransaction(pool, role, async (client) => {
        await assertGrantPrivilege(client);
        const key = grantKey(sourceType, sourceId);
        const existing = (await client.query('SELECT id FROM public.credit_ledger_events WHERE idempotency_key = $1',
            [key])).rows[0];
        const row = (await client.query('SELECT public.credit_grant($1,$2,$3,$4) AS event_id',
            [userId, amount, sourceType, sourceId])).rows[0];
        if (!row?.event_id) fail('LEDGER_OWNER_NOT_PREPARED');
        return Object.freeze({ eventId: row.event_id, replayed: Boolean(existing) });
    });
}

async function readBalance(pool, role, { userId } = {}) {
    return withOwnerTransaction(pool, role, async (client) => {
        const row = (await client.query(
            'SELECT available_tenths, reserved_tenths FROM public.credit_accounts WHERE user_id = $1', [userId])).rows[0];
        if (!row) return Object.freeze({ exists: false, availableTenths: null, reservedTenths: null });
        return Object.freeze({ exists: true, availableTenths: row.available_tenths, reservedTenths: row.reserved_tenths });
    });
}

function shortFailure(error) {
    const known = {
        ACTION_INVALID: '需要明确的操作：grant 或 balance。',
        ARGUMENT_INVALID: '参数格式无效。',
        ARGUMENT_DUPLICATED: '同一个参数只能出现一次。',
        ARGUMENT_UNKNOWN: '存在当前操作不接受的参数。',
        ARGUMENT_REQUIRED: '缺少必需的参数。',
        ARGUMENT_VALUE_REQUIRED: '参数缺少取值。',
        USER_ID_INVALID: '用户标识必须是 UUID。',
        SOURCE_ID_INVALID: '发放来由标识必须是 UUID。',
        SOURCE_TYPE_INVALID: '发放来由只接受 signup 或 manual。',
        AMOUNT_INVALID: '发放额度必须是正整数的 credit_tenths（0.1 额度）数量。',
        // 发放与价格发布共用同一套管理员身份校验，输出统一改用 LEDGER_ 前缀。
        LEDGER_DATABASE_URL_REQUIRED: '需要单独的 LEDGER_DATABASE_URL：专门的管理员身份连接。',
        LEDGER_DATABASE_URL_INVALID: 'LEDGER_DATABASE_URL 不是合法的 PostgreSQL 目标。',
        LEDGER_TARGET_CONFIRMATION_REQUIRED: '需要 DATABASE_URL 用于确认发放目标库一致。',
        LEDGER_TARGET_NOT_LOOPBACK: '只允许对本机回环数据库发放额度。',
        LEDGER_TARGET_INVALID: '不能对维护库或模板库发放额度。',
        LEDGER_TARGET_MUST_MATCH: 'LEDGER_DATABASE_URL 必须与 DATABASE_URL 指向同一业务库。',
        LEDGER_IDENTITY_MUST_DIFFER: '发放身份必须与运行、迁移、Worker、cleanup 身份不同。',
        OWNER_ROLE_INVALID: '账务 owner 角色名不符合约定。',
        PRICING_SESSION_UNBOUND: '账务写入必须在显式事务内进行。',
        PRICING_EXECUTOR_REQUIRED: '当前连接没有切换到专用账务 owner，已拒绝写入。',
        LEDGER_OWNER_NOT_PREPARED: '专用账务 owner 尚未准备或缺少发放权限。',
        LEDGER_OWNER_ATTRIBUTES_INVALID: '专用账务 owner 属性被改变，已拒绝写入。',
        CREDIT_GRANT_INVALID: '发放参数不符合数据库要求。',
        CREDIT_GRANT_CONFLICT: '同一发放来由已存在且金额或用户不同，拒绝覆盖。',
        CREDIT_USER_NOT_FOUND: '目标用户不存在。',
        CREDIT_BALANCE_OVERFLOW: '发放后余额将超出允许上限，已拒绝。',
    };
    if (error instanceof CreditGrantError) {
        return { message: known[error.reason] || '额度操作未完成。', code: error.reason };
    }
    if (error instanceof PricingPublishError) {
        const code = error.reason.startsWith('PUBLISH_')
            ? `LEDGER_${error.reason.slice('PUBLISH_'.length)}`
            : error.reason;
        return { message: known[code] || '额度操作未完成。', code };
    }
    // 数据库侧拒绝：只回稳定码与中文说明，不回显连接串。
    if (typeof error?.message === 'string' && known[error.message]) {
        return { message: known[error.message], code: error.message };
    }
    // 目标用户不存在由 credit_accounts 的外键裁决，owner 不持有 users 读权限。
    if (error?.code === '23503' && error?.constraint === 'credit_accounts_user_id_users_id_fk') {
        return { message: known.CREDIT_USER_NOT_FOUND, code: 'CREDIT_USER_NOT_FOUND' };
    }
    if (error?.code === '42501') return { message: '数据库拒绝了该操作：当前身份不能执行该账务写操作。', code: 'LEDGER_SET_ROLE_DENIED' };
    if (error?.code === '23505') return { message: '同一发放来由已存在且内容不同，已拒绝。', code: '23505' };
    if (error?.code === '22023') return { message: '发放金额或来源不符合要求。', code: '22023' };
    if (error?.code === '22003') return { message: '余额将超出允许上限，已拒绝。', code: '22003' };
    return { message: '额度操作未完成；请检查数据库连接、迁移状态与数据库日志。', code: 'CREDIT_GRANT_FAILED' };
}

async function main({ argv = process.argv.slice(2), env = process.env, output = process.stdout, errorOutput = process.stderr, PoolImpl = Pool } = {}) {
    let pool;
    try {
        const { action, options } = parseArguments(argv);
        // 参数与环境校验全部先于任何连接装配。
        const userId = assertUuid(options['user-id'], 'USER_ID_INVALID');
        let intent = null;
        if (action === 'grant') {
            const sourceType = options['source-type'] ?? 'manual';
            if (!SOURCE_TYPES.includes(sourceType)) fail('SOURCE_TYPE_INVALID');
            intent = Object.freeze({
                userId,
                amount: assertAmount(options.amount),
                sourceType,
                sourceId: assertUuid(options['source-id'], 'SOURCE_ID_INVALID'),
            });
        }
        const environment = assertPublishEnvironment(env);
        pool = createOwnerSessionPool({ connectionString: environment.connectionString, role: environment.role, PoolImpl });
        let result;
        if (action === 'grant') {
            const granted = await grantCredit(pool, environment.role, intent);
            result = Object.freeze({
                action, userId, creditTenths: intent.amount,
                sourceType: intent.sourceType, sourceId: intent.sourceId,
                eventId: granted.eventId, replayed: granted.replayed,
            });
        } else {
            const balance = await readBalance(pool, environment.role, { userId });
            result = Object.freeze({ action, userId, ...balance });
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
        process.stderr.write('CREDIT_GRANT_FAILED\n');
        process.exitCode = 1;
    });
}

module.exports = {
    ACTION_LIST: ACTIONS,
    CreditGrantError,
    assertAmount,
    assertUuid,
    grantCredit,
    main,
    parseArguments,
    readBalance,
    shortFailure,
};
