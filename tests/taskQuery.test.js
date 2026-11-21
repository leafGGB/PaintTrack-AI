const test = require('node:test');
const assert = require('node:assert/strict');
const {
    MAX_LIMIT,
    createTaskQueryService,
    decodeCursor,
    encodeCursor,
    parseLimit,
} = require('../lib/server/tasks/taskQuery');
const { TaskApiError } = require('../lib/server/tasks/taskSubmission');

const OWNER = '00000000-0000-4000-8000-0000000000a1';
const TASK_ID = '00000000-0000-4000-8000-0000000000b1';

function scriptedPool(results) {
    const calls = [];
    return {
        calls,
        async query(text, values) {
            calls.push({ text, values });
            const next = results.shift();
            if (next instanceof Error) throw next;
            return next || { rowCount: 0, rows: [] };
        },
    };
}

function row(overrides = {}) {
    return {
        id: TASK_ID,
        task_type: 'image.generate',
        status: 'queued',
        created_at: new Date('2026-11-09T02:00:00Z'),
        updated_at: new Date('2026-11-09T02:00:00Z'),
        completed_at: null,
        cancel_requested_at: null,
        result: null,
        last_error: null,
        // 以下字段即使被误选也不能出现在响应里。
        owner_id: OWNER,
        payload: { prompt: 'secret prompt' },
        ...overrides,
    };
}

test('列表按 owner 过滤并使用 keyset 分页，不返回 payload 或租约字段', async () => {
    const pool = scriptedPool([{ rowCount: 1, rows: [row()] }]);
    const service = createTaskQueryService({ pool });
    const page = await service.list({ ownerId: OWNER, limit: '10' });

    assert.equal(page.tasks.length, 1);
    assert.equal(page.nextCursor, null);
    assert.deepEqual(Object.keys(page.tasks[0]).sort(), [
        'cancelRequestedAt', 'completedAt', 'createdAt', 'errorCode', 'id',
        'result', 'status', 'taskType', 'updatedAt',
    ]);
    assert.equal(JSON.stringify(page.tasks[0]).includes('secret prompt'), false);

    const sql = pool.calls[0].text.replace(/\s+/g, ' ');
    assert.match(sql, /WHERE owner_id = \$1::uuid/);
    assert.match(sql, /ORDER BY created_at DESC, id DESC/);
    assert.doesNotMatch(sql, /payload/);
    assert.equal(pool.calls[0].values[3], 11);
});

test('游标返回下一页且不会重复上一页最后一条记录', async () => {
    const firstPage = Array.from({ length: 21 }, (_, index) => row({
        id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        created_at: new Date(Date.UTC(2026, 10, 9, 2, 0, 0) - index * 1000),
    }));
    const pool = scriptedPool([{ rowCount: 21, rows: firstPage }]);
    const service = createTaskQueryService({ pool });
    const page = await service.list({ ownerId: OWNER, limit: '20' });

    assert.equal(page.tasks.length, 20);
    assert.ok(page.nextCursor);
    const decoded = decodeCursor(page.nextCursor);
    assert.equal(decoded.id, firstPage[19].id);
    assert.equal(decoded.createdAt, firstPage[19].created_at.toISOString());

    const second = createTaskQueryService({
        pool: scriptedPool([{ rowCount: 1, rows: [row()] }]),
    });
    await second.list({ ownerId: OWNER, cursor: page.nextCursor });
});

test('limit 与游标有严格上界，非法输入统一返回 INVALID_PAGINATION', () => {
    assert.equal(parseLimit(undefined), 20);
    assert.equal(parseLimit('1'), 1);
    assert.equal(parseLimit(String(MAX_LIMIT)), MAX_LIMIT);
    for (const value of ['0', '-1', '1.5', 'abc', String(MAX_LIMIT + 1), ' 5']) {
        assert.throws(() => parseLimit(value), (error) => error instanceof TaskApiError
            && error.code === 'INVALID_PAGINATION' && error.status === 400);
    }
    for (const value of ['not-base64', Buffer.from('{"id":"nope"}').toString('base64url'),
        Buffer.from('{"id":"' + TASK_ID + '","createdAt":"not-a-date"}').toString('base64url')]) {
        assert.throws(() => decodeCursor(value), (error) => error.code === 'INVALID_PAGINATION');
    }
    assert.equal(encodeCursor(row()).length > 0, true);
});

test('Studio 历史只投影同属当前账号的成功任务和未删除的匹配归档，并按游标翻页', async () => {
    const assetId = '00000000-0000-4000-8000-0000000000c1';
    const entry = row({
        asset_id: assetId, result_url: `/api/assets/${assetId}/content`,
        logical_model_id: 'local-mock-video', prompt: 'my video', cursor_time: '2026-11-09T02:00:00.000123Z',
    });
    const pool = scriptedPool([{ rows: [entry, row()] }, { rows: [] }]);
    const service = createTaskQueryService({ pool });
    const first = await service.listStudioHistory({ ownerId: OWNER, media: 'video', limit: '1' });
    assert.deepEqual(first.items, [{ id: TASK_ID, assetId, resultUrl: entry.result_url, logicalModelId: 'local-mock-video', prompt: 'my video', createdAt: entry.created_at }]);
    assert.equal(first.nextCursor, encodeCursor(entry, entry.cursor_time));
    assert.deepEqual(await service.listStudioHistory({ ownerId: OWNER, media: 'video', limit: '1', cursor: first.nextCursor }), { items: [], nextCursor: null });
    assert.deepEqual(pool.calls[0].values, [OWNER, 'video', null, null, 2]);
    assert.deepEqual(pool.calls[1].values, [OWNER, 'video', entry.cursor_time, TASK_ID, 2]);
    const sql = pool.calls[0].text;
    for (const predicate of [/t.owner_id = \$1::uuid/, /a.owner_id = t.owner_id/, /a.id::text = t.result->>'assetId'/, /t.status = 'succeeded'/, /a.status = 'ready'/, /a.deleted_at IS NULL/, /a.media_type = \$2::text/, /t.task_type = CASE/, /ORDER BY t.created_at DESC, t.id DESC/]) assert.match(sql, predicate);
    await assert.rejects(service.listStudioHistory({ ownerId: OWNER, media: 'audio' }), { code: 'INVALID_MEDIA_FILTER' });
    await assert.rejects(service.listStudioHistory({ ownerId: OWNER, media: 'image', cursor: 'invalid' }), { code: 'INVALID_PAGINATION' });
    assert.equal(pool.calls.length, 2);
});

test('详情按 owner 查询，非法或他人任务统一返回 null 而不是区分错误', async () => {
    const pool = scriptedPool([{ rowCount: 1, rows: [row()] }]);
    const service = createTaskQueryService({ pool });
    const task = await service.get({ ownerId: OWNER, taskId: TASK_ID });
    assert.equal(task.id, TASK_ID);
    assert.match(pool.calls[0].text, /WHERE id = \$1::uuid AND owner_id = \$2::uuid/);

    const empty = createTaskQueryService({ pool: scriptedPool([{ rowCount: 0, rows: [] }]) });
    assert.equal(await empty.get({ ownerId: OWNER, taskId: TASK_ID }), null);
    for (const taskId of ['not-a-uuid', '', undefined, `${TASK_ID}-extra`]) {
        assert.equal(await empty.get({ ownerId: OWNER, taskId }), null);
    }
});

test('原始异常文本不会被当成错误码暴露给用户', async () => {
    const service = createTaskQueryService({
        pool: scriptedPool([{
            rowCount: 1,
            rows: [row({ status: 'failed', last_error: 'connect ECONNREFUSED 127.0.0.1:5432' })],
        }]),
    });
    const task = await service.get({ ownerId: OWNER, taskId: TASK_ID });
    assert.equal(task.errorCode, 'TASK_FAILED');

    const coded = createTaskQueryService({
        pool: scriptedPool([{ rowCount: 1, rows: [row({ status: 'failed', last_error: 'RATE_LIMITED' })] }]),
    });
    assert.equal((await coded.get({ ownerId: OWNER, taskId: TASK_ID })).errorCode, 'RATE_LIMITED');
});

test('查询服务要求连接池与合法 owner，避免无归属查询', async () => {
    assert.throws(() => createTaskQueryService({}), /pool is required/);
    const service = createTaskQueryService({ pool: scriptedPool([]) });
    await assert.rejects(service.list({ ownerId: 'not-a-uuid' }), /ownerId must be a UUID/);
});
