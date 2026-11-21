const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { main } = require('../../lib/server/tasks/creditGrantCli');

const PASSWORD = `scrypt:32768:8:3:${'a'.repeat(32)}:${'b'.repeat(128)}`;

async function createUser(admin, tag) {
    const id = randomUUID();
    await admin.query('INSERT INTO public.users(id,email,password_hash) VALUES ($1,$2,$3)',
        [id, `grant-${tag}-${id}@example.test`, PASSWORD]);
    return id;
}

const accountRow = async (admin, userId) => (await admin.query(
    'SELECT available_tenths, reserved_tenths FROM public.credit_accounts WHERE user_id=$1', [userId])).rows[0];
const grantEvents = async (admin, userId) => (await admin.query(`SELECT id,task_id,kind,credit_tenths,source_type,source_id,idempotency_key,actor
    FROM public.credit_ledger_events WHERE user_id=$1 ORDER BY created_at`, [userId])).rows;

// 端到端跑真实 CLI 入口：发放身份只在事务内降级到 owner，不新增任何角色授权。
async function checkCreditGrant(admin, adminUrl, urls, record) {
    const database = (await admin.query('SELECT current_database() AS db')).rows[0].db;
    assert.match(database, /^pt_acceptance_[a-z0-9]+_[a-f0-9]{6}$/);

    const env = { LEDGER_DATABASE_URL: adminUrl, DATABASE_URL: urls.runtimeUrl };
    const run = async (argv, environment = env) => {
        let out = '';
        let err = '';
        const saved = process.exitCode;
        try {
            const result = await main({
                argv, env: environment,
                output: { write: (chunk) => { out += chunk; } },
                errorOutput: { write: (chunk) => { err += chunk; } },
            });
            return { result, out, err: err.trim() };
        } finally {
            process.exitCode = saved;
        }
    };

    const user = await createUser(admin, 'main');
    const sourceId = randomUUID();

    // 一、发放即开户：账户行原本不存在，发放后可用余额与账本同时出现。
    assert.equal(await accountRow(admin, user), undefined);
    const absent = await run(['balance', '--user-id', user]);
    assert.equal(absent.err, '');
    assert.equal(absent.result.exists, false);
    assert.equal(absent.result.availableTenths, null);

    const granted = await run(['grant', '--user-id', user, '--amount', '1000', '--source-id', sourceId]);
    assert.equal(granted.err, '', `发放不应失败：${granted.out}`);
    assert.equal(granted.result.replayed, false);
    assert.equal(granted.result.creditTenths, '1000');
    assert.equal(granted.result.sourceType, 'manual');
    const afterGrant = await accountRow(admin, user);
    assert.equal(afterGrant.available_tenths, '1000');
    assert.equal(afterGrant.reserved_tenths, '0');
    const events = await grantEvents(admin, user);
    assert.equal(events.length, 1);
    assert.equal(events[0].id, granted.result.eventId);
    assert.equal(events[0].kind, 'grant');
    assert.equal(events[0].task_id, null, '发放事件不得绑定任务');
    assert.equal(events[0].source_type, 'manual');
    assert.equal(events[0].source_id, sourceId);
    assert.equal(events[0].actor, 'admin');
    assert.equal(events[0].idempotency_key, `grant:manual:${sourceId}`);
    const balance = await run(['balance', '--user-id', user]);
    assert.deepEqual(balance.result, { action: 'balance', userId: user, exists: true, availableTenths: '1000', reservedTenths: '0' });
    record('额度发放：无账户用户首次发放即开户，账本记录 grant 且 task_id 为空、actor 为 admin', 'passed');

    // 二、同一来由重放：返回原事件，余额与账本行数不变。
    const replay = await run(['grant', '--user-id', user, '--amount', '1000', '--source-id', sourceId]);
    assert.equal(replay.err, '');
    assert.equal(replay.result.replayed, true);
    assert.equal(replay.result.eventId, granted.result.eventId);
    assert.equal((await accountRow(admin, user)).available_tenths, '1000');
    assert.equal((await grantEvents(admin, user)).length, 1);
    // 同一来由换金额或换用户都必须拒绝，不能把别人的发放伪装成这次的结果。
    const conflict = await run(['grant', '--user-id', user, '--amount', '2000', '--source-id', sourceId]);
    assert.equal(conflict.result, null);
    assert.equal(conflict.err, 'CREDIT_GRANT_CONFLICT');
    const otherUser = await createUser(admin, 'other');
    const crossUser = await run(['grant', '--user-id', otherUser, '--amount', '1000', '--source-id', sourceId]);
    assert.equal(crossUser.err, 'CREDIT_GRANT_CONFLICT');
    assert.equal(await accountRow(admin, otherUser), undefined, '冲突不得为用户建户');
    assert.equal((await accountRow(admin, user)).available_tenths, '1000');
    record('额度发放：同来由重放回原事件，换金额或换用户按 CREDIT_GRANT_CONFLICT 拒绝且余额不变', 'passed');

    // 三、signup 来源的 actor 由数据库派生为 system，同一用户只可能有一次注册发放。
    const signupUser = await createUser(admin, 'signup');
    const signup = await run(['grant', '--user-id', signupUser, '--amount', '300', '--source-id', signupUser, '--source-type', 'signup']);
    assert.equal(signup.err, '');
    assert.equal(signup.result.sourceType, 'signup');
    const signupEvents = await grantEvents(admin, signupUser);
    assert.equal(signupEvents.length, 1);
    assert.equal(signupEvents[0].actor, 'system');
    assert.equal(signupEvents[0].idempotency_key, `grant:signup:${signupUser}`);
    const signupReplay = await run(['grant', '--user-id', signupUser, '--amount', '300', '--source-id', signupUser, '--source-type', 'signup']);
    assert.equal(signupReplay.result.replayed, true);
    assert.equal((await accountRow(admin, signupUser)).available_tenths, '300');
    record('额度发放：signup 来由的 actor 由数据库派生为 system，同一用户重复注册发放按重放处理', 'passed');

    // 四、非法输入在连库前或函数内被拒，不产生账户与账本残留。
    const nobody = randomUUID();
    const unknownUser = await run(['grant', '--user-id', nobody, '--amount', '10', '--source-id', randomUUID()]);
    assert.equal(unknownUser.err, 'CREDIT_USER_NOT_FOUND');
    assert.equal(await accountRow(admin, nobody), undefined);
    const zero = await run(['grant', '--user-id', user, '--amount', '0', '--source-id', randomUUID()]);
    assert.equal(zero.err, 'AMOUNT_INVALID');
    assert.equal((await grantEvents(admin, user)).length, 1);
    // 绕过 CLI 直接调用函数：0、负数、小数与未知来源都必须 22023。
    for (const [amount, sourceType] of [['0', 'manual'], ['-5', 'manual'], ['1.5', 'manual'], ['10', 'promo']]) {
        await assert.rejects(
            admin.query('SELECT public.credit_grant($1,$2,$3,$4)', [user, amount, sourceType, randomUUID()]),
            (error) => ['22023', '22P02'].includes(error.code), `${amount}/${sourceType} 应被函数拒绝`);
    }
    const invalidSource = await run(['grant', '--user-id', user, '--amount', '10', '--source-id', randomUUID(), '--source-type', 'promo']);
    assert.equal(invalidSource.err, 'SOURCE_TYPE_INVALID');
    assert.equal((await accountRow(admin, user)).available_tenths, '1000');
    record('额度发放：未知用户、零/负/小数金额与未知来源均被拒绝且无账户或账本残留', 'passed');

    // 五、余额上限：达到 bigint 上限后发放报 CREDIT_BALANCE_OVERFLOW，不写账本。
    const maxUser = await createUser(admin, 'max');
    await admin.query('INSERT INTO public.credit_accounts(user_id,available_tenths) VALUES ($1,9223372036854775807)', [maxUser]);
    const overflow = await run(['grant', '--user-id', maxUser, '--amount', '1', '--source-id', randomUUID()]);
    assert.equal(overflow.result, null);
    assert.equal(overflow.err, 'CREDIT_BALANCE_OVERFLOW');
    assert.equal((await accountRow(admin, maxUser)).available_tenths, '9223372036854775807');
    assert.equal((await grantEvents(admin, maxUser)).length, 0);
    record('额度发放：余额达到上限时拒绝溢出发放且不写账本', 'passed');

    // 六、账本形状：task_id 可空没有放松任务类事件，发放事件的字段约束同样收紧。
    await assert.rejects(admin.query(`INSERT INTO public.credit_ledger_events(user_id,task_id,kind,credit_tenths,source_type,source_id,idempotency_key,actor)
        VALUES ($1,NULL,'reserve',10,'task',$2,'reserve:'||($2::uuid)::text,'system')`, [user, randomUUID()]),
    (error) => error.code === '23514', '任务类事件不得缺少 task_id');
    await assert.rejects(admin.query(`INSERT INTO public.credit_ledger_events(user_id,task_id,kind,credit_tenths,source_type,source_id,idempotency_key,actor)
        VALUES ($1,NULL,'grant',10,'task',$2,'grant:task:'||($2::uuid)::text,'admin')`, [user, randomUUID()]),
    (error) => error.code === '23514', '发放事件不得声明 task 来源');
    await assert.rejects(admin.query(`INSERT INTO public.credit_ledger_events(user_id,task_id,kind,credit_tenths,source_type,source_id,idempotency_key,actor)
        VALUES ($1,NULL,'grant',10,'manual',$2,'grant:manual:'||($2::uuid)::text,'nobody')`, [user, randomUUID()]),
    (error) => error.code === '23514', '发放事件的 actor 只能是 system 或 admin');
    assert.equal((await grantEvents(admin, user)).length, 1);
    record('额度发放：账本形状收紧，任务类事件缺 task_id、grant 声明 task 来源、actor 越界均 23514', 'passed');

    // 七、身份边界：低权身份既不能调用发放函数，也不能直接写账本或账户。
    const { Pool } = require('pg');
    for (const [label, url] of [['运行', urls.runtimeUrl], ['Worker', urls.workerUrl], ['cleanup', urls.cleanupUrl]]) {
        const probe = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 3000 });
        try {
            await assert.rejects(probe.query('SELECT public.credit_grant($1,10,$2,$3)', [user, 'manual', randomUUID()]),
                { code: '42501' }, `${label}不应能调用发放函数`);
            await assert.rejects(probe.query(`INSERT INTO public.credit_ledger_events(user_id,task_id,kind,credit_tenths,source_type,source_id,idempotency_key,actor)
                VALUES ($1,NULL,'grant',10,'manual',$1,'grant:manual:'||($1::uuid)::text,'admin')`, [user]),
            { code: '42501' }, `${label}不应能直接写账本`);
            await assert.rejects(probe.query('UPDATE public.credit_accounts SET available_tenths=available_tenths+1 WHERE user_id=$1', [user]),
                { code: '42501' }, `${label}不应能直接改余额`);
        } finally {
            await probe.end();
        }
    }
    const workerAttempt = await run(['balance', '--user-id', user], { LEDGER_DATABASE_URL: urls.workerUrl, DATABASE_URL: urls.runtimeUrl });
    assert.equal(workerAttempt.err, 'LEDGER_SET_ROLE_DENIED');
    const sameAsRuntime = await run(['balance', '--user-id', user], { LEDGER_DATABASE_URL: urls.runtimeUrl, DATABASE_URL: urls.runtimeUrl });
    assert.equal(sameAsRuntime.err, 'LEDGER_IDENTITY_MUST_DIFFER');
    assert.equal((await admin.query('SELECT current_user AS u')).rows[0].u, (await admin.query('SELECT session_user AS u')).rows[0].u);
    record('额度发放：运行/Worker/cleanup 调用发放函数与写账本均42501，Worker 事务内 SET ROLE 被拒，管理员身份复原', 'passed');

    // 八、发放与既有终态链不冲突：账本仍只有任务类事件参与冻结与结算。
    const reservationCount = (await admin.query('SELECT count(*)::int AS n FROM public.credit_reservations WHERE user_id=$1', [user])).rows[0].n;
    const settlementCount = (await admin.query('SELECT count(*)::int AS n FROM public.credit_settlements WHERE user_id=$1', [user])).rows[0].n;
    assert.equal(reservationCount, 0);
    assert.equal(settlementCount, 0);
    record('额度发放：发放不创建冻结或终态行，账本任务事件族不受影响', 'passed');
    record('额度发放真实PG：开户、重放、冲突、上限、形状与身份边界全部通过', 'passed');
}

module.exports = { checkCreditGrant };
