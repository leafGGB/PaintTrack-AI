'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { drizzle } = require('drizzle-orm/node-postgres');
const { createAccountCreditsService } = require('../../lib/server/accountCredits');

async function checkAccountCredits(adminUrl, runtimeUrl, record) {
    const admin = new Pool({ connectionString: adminUrl, max: 2, connectionTimeoutMillis: 3000 });
    const runtime = new Pool({ connectionString: runtimeUrl, max: 2, connectionTimeoutMillis: 3000 });
    const userId = randomUUID();
    const otherUserId = randomUUID();
    const taskId = randomUUID();
    const otherTaskId = randomUUID();
    const eventIds = [];
    const taskIds = [taskId, otherTaskId];
    try {
        const passwordHash = `scrypt:32768:8:3:${'a'.repeat(32)}:${'b'.repeat(128)}`;
        await admin.query(`INSERT INTO users (id,email,password_hash,email_verified_at,role)
            VALUES ($1,$3,$2,clock_timestamp(),'user'),($4,$6,$5,clock_timestamp(),'user')`, [
            userId, passwordHash, `account-credits-${userId}@example.com`, otherUserId, passwordHash, `account-credits-${otherUserId}@example.com`,
        ]);
        await admin.query(`INSERT INTO credit_accounts (user_id,available_tenths,reserved_tenths,unit_version)
            VALUES ($1,100,0,'credit_tenths_v1'),($2,50,0,'credit_tenths_v1')`, [userId, otherUserId]);
        const taskValues = [taskId, otherTaskId];
        await admin.query(`INSERT INTO generation_tasks
            (id,task_type,payload,status,attempts,max_attempts,available_at,created_at,updated_at,owner_id,idempotency_key,request_fingerprint)
            VALUES ($1,'image.generate','{}'::jsonb,'queued',0,3,clock_timestamp(),$3,$3,$4,'fixture-task-1',repeat('a',64)),
                   ($2,'video.generate','{}'::jsonb,'queued',0,3,clock_timestamp(),$3,$3,$5,'fixture-task-2',repeat('b',64))`, [taskId, otherTaskId, '2026-11-18T10:00:00.123456+08:00', userId, otherUserId]);
        for (let index = 0; index < 22; index += 1) {
            const eventId = randomUUID();
            const sourceId = randomUUID();
            eventIds.push(eventId);
            await admin.query(`INSERT INTO credit_ledger_events
                (id,user_id,task_id,kind,credit_tenths,source_type,source_id,idempotency_key,actor,created_at)
                VALUES ($1,$2,NULL,'grant',1,'manual',$3,$4,'admin',$5)`, [
                eventId, userId, sourceId, `grant:manual:${sourceId}`, '2026-11-18T10:00:00.123456+08:00',
            ]);
        }
        const reserveEventId = randomUUID();
        const settleEventId = randomUUID();
        eventIds.push(reserveEventId, settleEventId);
        await admin.query(`INSERT INTO credit_ledger_events
            (id,user_id,task_id,kind,credit_tenths,source_type,source_id,idempotency_key,actor,created_at)
            VALUES ($1,$2,$3,'reserve',7,'task',$3,$4,'system',$5),
                   ($6,$2,$3,'settle',7,'task',$3,$7,'system',$5)`, [
            reserveEventId, userId, taskId, `reserve:${taskId}`, '2026-11-18T10:00:00.123456+08:00', settleEventId, `settle:${taskId}`,
        ]);
        await admin.query(`INSERT INTO credit_ledger_events
            (id,user_id,task_id,kind,credit_tenths,source_type,source_id,idempotency_key,actor,created_at)
            VALUES ($1,$2,$3,'reserve',5,'task',$3,$4,'system',$5)`, [
            randomUUID(), otherUserId, otherTaskId, `reserve:${otherTaskId}`, '2026-11-18T10:00:00.123456+08:00',
        ]);

        const service = createAccountCreditsService({ database: drizzle(runtime) });
        const first = await service.read(userId, { limit: 20 });
        assert.equal(first.events.length, 20);
        assert.ok(first.nextCursor);
        const second = await service.read(userId, { limit: 20, cursor: first.nextCursor });
        assert.equal(second.events.length, 4);
        const allEvents = [...first.events, ...second.events];
        assert.equal(new Set(allEvents.map(event => event.id)).size, 24);
        assert.equal(allEvents.some(event => event.task?.id === taskId), true);
        assert.equal((await service.read(userId, { kind: 'grant', limit: 50 })).events.length, 22);
        assert.equal((await service.read(userId, { kind: 'reserve', limit: 50 })).events[0].task.id, taskId);
        const otherEvents = (await service.read(otherUserId, { limit: 50 })).events;
        assert.equal(otherEvents.length, 1);
        assert.equal(otherEvents[0].task?.id, otherTaskId);
        await assert.rejects(() => service.read(userId, { limit: 51 }), error => error.code === 'INVALID_CREDIT_QUERY');
        await assert.rejects(() => service.read(userId, { kind: 'bogus' }), error => error.code === 'INVALID_CREDIT_QUERY');
        await assert.rejects(() => service.read(userId, { cursor: 'zz' }), error => error.code === 'INVALID_CREDIT_QUERY');
        await assert.rejects(() => runtime.query('INSERT INTO credit_ledger_events (user_id,kind,credit_tenths,source_type,source_id,idempotency_key,actor) VALUES ($1,\'grant\',1,\'manual\',$1,\'x\',\'admin\')', [userId]), error => error.code === '42501');
        assert.equal((await admin.query('SELECT count(*)::int AS n FROM credit_ledger_events WHERE user_id=$1', [userId])).rows[0].n, 24);
        record('账户额度真实PG：游标分页、同微秒时间戳稳定排序、kind筛选、任务owner摘要、双用户隔离与运行身份写拒绝通过', 'passed');
    } finally {
        await admin.query('DELETE FROM credit_ledger_events WHERE user_id = ANY($1::uuid[])', [[userId, otherUserId]]).catch(() => {});
        await admin.query('DELETE FROM generation_tasks WHERE id = ANY($1::uuid[])', [taskIds]).catch(() => {});
        await admin.query('DELETE FROM credit_accounts WHERE user_id = ANY($1::uuid[])', [[userId, otherUserId]]).catch(() => {});
        await admin.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [[userId, otherUserId]]).catch(() => {});
        await runtime.end();
        await admin.end();
    }
}

module.exports = { checkAccountCredits };
