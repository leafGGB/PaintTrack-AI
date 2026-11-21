const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

// 只由 accept-database-local 在本轮新建的隔离库调用；全部合成账本数据在事务末尾回滚。
async function checkCreditFoundation(admin, owner, pools, names, record) {
    const identity = (await admin.query('SELECT current_database() AS database')).rows[0];
    assert.equal(identity.database, names.database);
    assert.match(identity.database, /^pt_acceptance_[a-z0-9]+_[a-f0-9]{6}$/);
    const role = names.ledgerOwnerRole;
    assert.match(role, /^pt_ledger_owner_[a-f0-9]{16}$/);
    const functions = ['credit_initialize_zero_account(uuid)', 'credit_assert_reservation_replay(uuid,numeric)', 'credit_reject_mutation()', 'credit_check_task_owner()'];
    const tables = ['credit_accounts', 'credit_ledger_events', 'credit_reservations'];
    const attrs = (await admin.query(`SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolinherit FROM pg_roles WHERE rolname=$1`, [role])).rows[0];
    assert.ok(Object.values(attrs).every((value) => value === false));
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM pg_auth_members WHERE roleid=(SELECT oid FROM pg_roles WHERE rolname=$1) OR member=(SELECT oid FROM pg_roles WHERE rolname=$1)', [role])).rows[0].n, 0);
    for (const fn of functions) {
        const metadata = (await admin.query(`SELECT p.prosecdef, p.proconfig, r.rolname FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.oid=$1::regprocedure`, [`public.${fn}`])).rows[0];
        assert.deepEqual(metadata, { prosecdef: true, proconfig: ['search_path=pg_catalog, pg_temp'], rolname: role });
        assert.equal((await admin.query(`SELECT count(*)::int AS n FROM pg_proc p, LATERAL aclexplode(coalesce(p.proacl, acldefault('f',p.proowner))) a WHERE p.oid=$1::regprocedure AND a.grantee=0 AND a.privilege_type='EXECUTE'`, [`public.${fn}`])).rows[0].n, 0);
    }
    for (const pool of pools) {
        for (const table of tables) {
            const result = await pool.query(`SELECT has_any_column_privilege(current_user,$1,'SELECT,INSERT,UPDATE,REFERENCES') AS columns, has_table_privilege(current_user,$1,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS table_access`, [`public.${table}`]);
            const expectedReadOnly = pool === pools[0] && table !== 'credit_reservations';
            assert.equal(result.rows[0].table_access, false);
            assert.equal(result.rows[0].columns, expectedReadOnly);
            if (expectedReadOnly) {
                await assert.doesNotReject(pool.query(`SELECT user_id FROM public.${table} LIMIT 1`));
            } else {
                await assert.rejects(pool.query(`SELECT * FROM public.${table}`), { code: '42501' });
            }
            await assert.rejects(pool.query(`DELETE FROM public.${table}`), { code: '42501' });
        }
        for (const fn of functions) assert.equal((await pool.query('SELECT has_function_privilege(current_user,$1,\'EXECUTE\') AS allowed', [`public.${fn}`])).rows[0].allowed, false);
        await assert.rejects(pool.query('SELECT public.credit_initialize_zero_account($1)', [randomUUID()]), { code: '42501' });
        await assert.rejects(pool.query('SELECT public.credit_assert_reservation_replay($1,1)', [randomUUID()]), { code: '42501' });
    }
    await assert.rejects(owner.query('SELECT public.credit_initialize_zero_account($1)', [randomUUID()]), { code: '42501' });
    record('账本函数专用NOLOGIN owner、安全search_path、PUBLIC撤权及Web/Worker/cleanup/bootstrap/migration拒绝调用', 'passed');

    await admin.query('BEGIN');
    const expectCode = async (text, values, code) => {
        await admin.query('SAVEPOINT credit_negative');
        try {
            await assert.rejects(admin.query(text, values), { code });
        } catch (error) {
            error.message = `expected ${code} for ${text}: ${error.message}`;
            throw error;
        } finally {
            await admin.query('ROLLBACK TO SAVEPOINT credit_negative');
        }
    };
    const user = randomUUID();
    const other = randomUUID();
    const task = randomUUID();
    const event = randomUUID();
    try {
        for (const id of [user, other]) await admin.query(`INSERT INTO public.users(id,email,password_hash) VALUES ($1,$2,$3)`, [id, `credit-${id}@example.test`, `scrypt:32768:8:3:${'a'.repeat(32)}:${'b'.repeat(128)}`]);
        await admin.query(`INSERT INTO public.generation_tasks(id,task_type,payload,owner_id,idempotency_key,request_fingerprint) VALUES ($1,'image.generate','{}',$2,$3,$4)`, [task, user, `credit:${task}`, 'a'.repeat(64)]);
        await admin.query(`SET LOCAL ROLE "${role}"`);
        await admin.query('SELECT public.credit_initialize_zero_account($1)', [user]);
        await admin.query('SELECT public.credit_initialize_zero_account($1)', [user]);
        await expectCode('SELECT public.credit_assert_reservation_replay($1,1)', [task], '55000');
        for (const amount of ['0', '-1', '0.1', '1.5', 'NaN', 'Infinity', '9223372036854775808']) await expectCode('SELECT public.credit_assert_reservation_replay($1,$2)', [task, amount], '22023');
        await admin.query('RESET ROLE');
        assert.deepEqual((await admin.query('SELECT available_tenths,reserved_tenths FROM public.credit_accounts WHERE user_id=$1', [user])).rows, [{ available_tenths: '0', reserved_tenths: '0' }]);
        for (const amount of ['-1', '0.1', 'NaN', 'Infinity', '9223372036854775808']) await expectCode('UPDATE public.credit_accounts SET available_tenths=$2 WHERE user_id=$1', [user, amount], '23514');
        await admin.query('INSERT INTO public.credit_accounts(user_id) VALUES ($1)', [other]);
        const insertEvent = `INSERT INTO public.credit_ledger_events(id,user_id,task_id,kind,credit_tenths,source_type,source_id,idempotency_key,actor) VALUES ($1,$2,$3,'reserve',$4,'task',$3,$5,'system')`;
        await expectCode(insertEvent, [event, other, task, '10', `reserve:${task}`], '23514');
        for (const amount of ['0', '-1', '1.1', 'NaN', 'Infinity', '9223372036854775808']) await expectCode(insertEvent, [event, user, task, amount, `reserve:${task}`], '23514');
        // 结构测试合成夹具，不通过任何运行入口加钱/reserve；没有构造或宣称可信 quote。
        await admin.query(insertEvent, [event, user, task, '10', `reserve:${task}`]);
        await expectCode(insertEvent, [randomUUID(), user, task, '10', `reserve:${task}`], '23505');
        await expectCode('INSERT INTO public.credit_reservations(task_id,user_id,credit_tenths,reserve_event_id) VALUES ($1,$2,11,$3)', [task, user, event], '23503');
        await admin.query('INSERT INTO public.credit_reservations(task_id,user_id,credit_tenths,reserve_event_id) VALUES ($1,$2,10,$3)', [task, user, event]);
        await admin.query(`SET LOCAL ROLE "${role}"`);
        for (let i = 0; i < 2; i++) assert.equal((await admin.query('SELECT public.credit_assert_reservation_replay($1,10) AS id', [task])).rows[0].id, event);
        await expectCode('SELECT public.credit_assert_reservation_replay($1,11)', [task], '23505');
        // owner 本身也没有加钱、事件/预留写权限或 DDL 权限。
        await expectCode('UPDATE public.credit_accounts SET unit_version=\'invalid\' WHERE user_id=$1', [user], '42501');
        await expectCode(insertEvent, [randomUUID(), user, randomUUID(), '10', `reserve:${task}`], '42501');
        await expectCode('CREATE TABLE public.credit_escape(id int)', [], '42501');
        await admin.query('RESET ROLE');
        // 超级用户会绕过ACL；这里显式降为本轮隔离库的runtime角色，才能真实验证运行身份拒绝账务历史修改。
        await admin.query(`SET LOCAL ROLE "${names.runtimeRole}"`);
        for (const table of ['credit_ledger_events', 'credit_reservations']) {
            for (const sql of [`UPDATE public.${table} SET credit_tenths=11`, `DELETE FROM public.${table}`, `TRUNCATE public.${table} CASCADE`]) await expectCode(sql, [], '42501');
        }
        await admin.query('RESET ROLE');
        await expectCode('DELETE FROM public.users WHERE id=$1', [user], '23503');
    } finally {
        await admin.query('ROLLBACK');
    }
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM public.credit_accounts WHERE user_id=$1', [user])).rows[0].n, 0);
    record('账本基础真实PG：零账户幂等、整数非负/上界、owner一致性、业务唯一键、重放金额冲突、不可变历史及事务回滚', 'passed');
}

module.exports = { checkCreditFoundation };
