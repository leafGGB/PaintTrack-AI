'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PgDialect } = require('drizzle-orm/pg-core');
const { createAdminAnalyticsReadService } = require('../lib/server/adminAnalyticsRead');

const dialect = new PgDialect();
const asOf = '2026-11-19T12:00:00.123456Z';
const from = '2026-11-18T00:00:00.000Z';
const to = '2026-11-19T00:00:00.000Z';
const params = () => new URLSearchParams({ from, to });
const uuid = n => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
const modelPk = uuid(100);
const userId = uuid(1);
const totalRow = (overrides = {}) => ({ section: 'totals', id: null, label: null,
    task_count: '0', succeeded_task_count: '0', settled_tenths: '0', model_count: '0', user_count: '0', ...overrides });
const modelRow = (overrides = {}) => ({ section: 'model', id: modelPk, label: 'mock.image',
    task_count: '1', succeeded_task_count: '1', ...overrides });
const userRow = (overrides = {}) => ({ section: 'user', id: userId, label: null,
    task_count: '1', succeeded_task_count: '1', settled_tenths: '0', ...overrides });

function databaseStub(rows = [totalRow()], { error = null } = {}) {
    const calls = [];
    const transactions = [];
    const outcomes = [];
    const database = { async transaction(run, config) {
        transactions.push(config);
        try {
            const value = await run({ async execute(query) {
                const compiled = dialect.sqlToQuery(query);
                calls.push(compiled);
                if (compiled.sql.startsWith('SET LOCAL')) return { rows: [] };
                if (compiled.sql.startsWith('SELECT to_char')) return { rows: [{ as_of: asOf }] };
                if (error) throw error;
                return { rows };
            } });
            outcomes.push('commit');
            return value;
        } catch (cause) { outcomes.push('rollback'); throw cause; }
    } };
    return { database, calls, transactions, outcomes };
}
function service(stub, options = {}) {
    return createAdminAnalyticsReadService({ database: stub.database, environment: { NODE_ENV: 'test' }, ...options });
}
function aggregateCall(stub) { return stub.calls.find(call => call.sql.startsWith('WITH task_batch')); }

// 这是独立关系夹具 oracle，并非 PG/SQL 引擎；下方另断言实际生成 SQL 的聚合/筛选/联结形状。
function fixtureRows(tasks, events, users = []) {
    const microseconds = time => BigInt(Date.parse(time)) * 1000n + BigInt((time.match(/\.(\d{6})Z$/)?.[1] ?? '000000').slice(3));
    const inWindow = time => microseconds(time) >= microseconds(from) && microseconds(time) < microseconds(to);
    const eligible = task => ['image.generate', 'video.generate'].includes(task.task_type);
    const batch = tasks.filter(task => eligible(task) && inWindow(task.created_at));
    const models = new Map();
    const owners = new Map();
    const unclassified = new Map();
    const owner = id => {
        if (!owners.has(id)) owners.set(id, userRow({ id, label: users.find(user => user.id === id)?.email ?? null,
            task_count: '0', succeeded_task_count: '0' }));
        return owners.get(id);
    };
    const increment = (row, task) => {
        row.task_count = (BigInt(row.task_count) + 1n).toString();
        row.succeeded_task_count = (BigInt(row.succeeded_task_count) + (task.status === 'succeeded' ? 1n : 0n)).toString();
    };
    for (const task of batch) {
        increment(owner(task.owner_id), task);
        const snapshot = task.route_snapshot;
        let reason = null;
        if ([task.logical_model_pk, snapshot, task.route_snapshot_version, task.route_snapshot_hash].some(value => value == null)) reason = 'missing_route';
        else if (task.route_snapshot_version !== 1 || (typeof snapshot.snapshotVersion === 'number' && snapshot.snapshotVersion !== 1)) reason = 'unsupported_version';
        else if (snapshot.snapshotVersion !== 1 || typeof snapshot.logicalModelId !== 'string'
            || !/^[a-z0-9][a-z0-9._-]{1,127}$/.test(snapshot.logicalModelId)
            || !Number.isSafeInteger(snapshot.logicalModelVersion) || snapshot.logicalModelVersion <= 0
            || snapshot.capabilitySnapshot?.operation !== task.task_type
            || snapshot.capabilitySnapshot?.mediaType !== task.task_type.split('.')[0]
            || !/^[0-9a-f]{64}$/.test(task.route_snapshot_hash)) reason = 'invalid_identity';
        if (reason) {
            if (!unclassified.has(reason)) unclassified.set(reason, { section: 'unclassified', id: reason,
                task_count: '0', succeeded_task_count: '0' });
            increment(unclassified.get(reason), task);
        } else {
            const key = `${task.logical_model_pk}:${snapshot.logicalModelId}`;
            if (!models.has(key)) models.set(key, modelRow({ id: task.logical_model_pk, label: snapshot.logicalModelId,
                task_count: '0', succeeded_task_count: '0' }));
            increment(models.get(key), task);
        }
    }
    for (const event of events) {
        if (event.kind !== 'settle' || !inWindow(event.created_at)) continue;
        const task = tasks.find(task => task.id === event.task_id && task.owner_id === event.user_id && eligible(task));
        if (!task) continue;
        const row = owner(event.user_id);
        row.settled_tenths = (BigInt(row.settled_tenths) + BigInt(event.credit_tenths)).toString();
    }
    const compare = (a, b) => BigInt(a.task_count) > BigInt(b.task_count) ? -1
        : BigInt(a.task_count) < BigInt(b.task_count) ? 1 : a.id.localeCompare(b.id) || (a.label ?? '').localeCompare(b.label ?? '');
    const totals = totalRow({ task_count: String(batch.length),
        succeeded_task_count: String(batch.filter(task => task.status === 'succeeded').length),
        settled_tenths: [...owners.values()].reduce((sum, row) => sum + BigInt(row.settled_tenths), 0n).toString(),
        model_count: String(models.size), user_count: String(owners.size) });
    return [...models.values()].sort(compare).slice(0, 10).concat([...owners.values()].sort(compare).slice(0, 10), [...unclassified.values()], totals);
}
function task(overrides = {}) {
    return { id: uuid(200), owner_id: userId, task_type: 'image.generate', created_at: from, status: 'succeeded',
        logical_model_pk: modelPk, route_snapshot_version: 1, route_snapshot_hash: 'a'.repeat(64),
        route_snapshot: { snapshotVersion: 1, logicalModelId: 'mock.image', logicalModelVersion: 1,
            capabilitySnapshot: { operation: 'image.generate', mediaType: 'image' } }, ...overrides };
}
function event(taskId, overrides = {}) {
    return { task_id: taskId, user_id: userId, kind: 'settle', credit_tenths: '7', created_at: from, ...overrides };
}
async function fixture(tasks, events = [], users = []) {
    const stub = databaseStub(fixtureRows(tasks, events, users));
    return { stub, result: await service(stub).read(params()) };
}

test('仅公开只读工厂，生产不接受替换时钟', () => {
    assert.deepEqual(Object.keys(require('../lib/server/adminAnalyticsRead')), ['createAdminAnalyticsReadService']);
    assert.throws(() => createAdminAnalyticsReadService({ database: {} }), /database/);
    assert.throws(() => createAdminAnalyticsReadService({ clock: null }), /clock/);
    assert.throws(() => createAdminAnalyticsReadService({ environment: { NODE_ENV: 'production' }, clock: () => asOf }), /不可替换/);
    assert.deepEqual(Object.keys(service(databaseStub())), ['read']);
});

test('默认连续31天，DB时钟只采样一次并保留微秒，只读事务内有限超时', async () => {
    const stub = databaseStub();
    const result = await service(stub).read();
    assert.deepEqual(result.window, { from: '2026-10-19T12:00:00.123456Z', to: asOf, asOf,
        timeZone: 'UTC', interval: '[from,to)', defaultDays: 31, maxDays: 31 });
    assert.deepEqual(stub.transactions, [{ isolationLevel: 'repeatable read', accessMode: 'read only' }]);
    assert.equal(stub.calls.length, 3);
    assert.match(stub.calls[0].sql, /^SET LOCAL statement_timeout = '5s'$/);
    assert.match(stub.calls[1].sql, /pg_catalog.clock_timestamp\(\)/);
    assert.deepEqual(aggregateCall(stub).params, [result.window.from, asOf, result.window.from, asOf]);
    assert.deepEqual(stub.outcomes, ['commit']);
});

test('显式窗口接受有效闰日、整秒和毫秒，恰31日与to等于asOf均有效', async () => {
    const stub = databaseStub();
    const result = await service(stub).read(new URLSearchParams({ from: '2024-02-29T00:00:00Z', to: '2024-03-31T00:00:00Z' }));
    assert.equal(result.window.from, '2024-02-29T00:00:00.000Z');
    const exact = await service(databaseStub(), { clock: async () => '2026-11-19T00:00:00.000000Z' }).read(params());
    assert.equal(exact.window.to, to);
});

const invalidQueries = [
    ['缺to', `from=${from}`], ['缺from', `to=${to}`], ['重复键', `from=${from}&from=${from}&to=${to}`],
    ['未知键', 'limit=10'], ['未知排序', `from=${from}&to=${to}&sort=settledTenths`],
    ['空值', 'from=&to='], ['本地日期', 'from=2026-11-18&to=2026-11-19'],
    ['缺时区', 'from=2026-11-18T00:00:00&to=2026-11-19T00:00:00'],
    ['非UTC', 'from=2026-11-18T00:00:00%2B00:00&to=2026-11-19T00:00:00Z'],
    ['错误闰日', 'from=2026-02-29T00:00:00Z&to=2026-03-01T00:00:00Z'],
    ['非法月日', 'from=2026-04-31T00:00:00Z&to=2026-05-02T00:00:00Z'],
    ['非法小时', 'from=2026-11-18T24:00:00Z&to=2026-11-19T01:00:00Z'],
    ['6位输入微秒', 'from=2026-11-18T00:00:00.000001Z&to=2026-11-19T00:00:00Z'],
    ['倒置', `from=${to}&to=${from}`], ['相等', `from=${from}&to=${from}`],
    ['超过31天1毫秒', 'from=2026-10-18T23:59:59.999Z&to=2026-11-19T00:00:00Z'],
    ['SQL注入', `from=%27%3BDROP+TABLE+users&to=${to}`],
];
for (const [name, query] of invalidQueries) test(`非法窗口${name}在数据库工厂前拒绝，零SQL`, async () => {
    let factories = 0;
    const read = createAdminAnalyticsReadService({ database: () => { factories += 1; throw new Error('不应触发'); } });
    await assert.rejects(() => read.read(new URLSearchParams(query)), error => error.code === 'INVALID_ADMIN_ANALYTICS_QUERY' && error.status === 400);
    assert.equal(factories, 0);
});

test('拒绝非URLSearchParams输入，不隐式丢弃重复/未知字段', async () => {
    const stub = databaseStub();
    for (const input of [null, {}, { from, to }, 'from=x']) {
        await assert.rejects(() => service(stub).read(input), error => error.code === 'INVALID_ADMIN_ANALYTICS_QUERY');
    }
    assert.equal(stub.calls.length, 0);
});

test('未来to采样数据库时钟后拒绝，零排名SQL并回滚', async () => {
    const stub = databaseStub();
    await assert.rejects(() => service(stub).read(new URLSearchParams({ from, to: '2026-11-19T12:00:00.124Z' })),
        error => error.code === 'INVALID_ADMIN_ANALYTICS_QUERY');
    assert.equal(stub.calls.length, 2);
    assert.equal(aggregateCall(stub), undefined);
    assert.deepEqual(stub.outcomes, ['rollback']);
});

test('空数据只返回空榜、字符串零和明确未开放attempt能力', async () => {
    const result = await service(databaseStub()).read();
    assert.deepEqual(result.models, []);
    assert.deepEqual(result.users, []);
    assert.deepEqual(result.totals, { taskCount: '0', succeededTaskCount: '0', settledTenths: '0', modelCount: '0', userCount: '0' });
    assert.equal(result.unclassified.taskCount, '0');
    assert.equal(result.capabilities.attemptsAvailable, false);
    assert.equal(result.capabilities.attemptCount, null);
    assert.equal(result.unitVersion, 'credit_tenths_v1');
    assert.match(result.scope, /includes local mock/);
    assert.match(result.modelAttribution, /structure_only/);
    assert.match(result.timeBasis.succeededTaskCount, /current status=succeeded/);
});

test('SQL分别聚合任务与settle后FULL JOIN用户维度，同一语句返回榜与全量总计', async () => {
    const stub = databaseStub();
    await service(stub).read(params());
    const query = aggregateCall(stub);
    assert.deepEqual(query.params, [from, to, from, to]);
    assert.match(query.sql, /user_tasks AS \([\s\S]*FROM task_batch GROUP BY owner_id/);
    assert.match(query.sql, /user_settles AS \([\s\S]*sum\(e.credit_tenths\)[\s\S]*GROUP BY e.user_id/);
    assert.match(query.sql, /FROM user_tasks t FULL OUTER JOIN user_settles e ON e.user_id=t.user_id/);
    assert.match(query.sql, /t.id=e.task_id AND t.owner_id=e.user_id/);
    assert.match(query.sql, /FROM top_users a LEFT JOIN users u ON u.id=a.user_id/);
    assert.match(query.sql, /count\(\*\) FILTER \(WHERE status='succeeded'\)/);
    assert.equal((query.sql.match(/t.task_type IN \('image.generate','video.generate'\)/g) ?? []).length, 2);
    assert.match(query.sql, /e.kind='settle'/);
    assert.match(query.sql, /SELECT count\(\*\)::text FROM task_batch/);
    assert.match(query.sql, /SELECT count\(\*\)::text FROM model_tasks/);
    assert.match(query.sql, /SELECT count\(\*\)::text FROM user_usage/);
    assert.doesNotMatch(query.sql, /SUM\(DISTINCT|sum\(distinct|::bigint|provider_calls|logical_models|model_catalog_public|payload|attempts|updated_at|completed_at|credit_settlements/i);
    assert.equal(stub.calls.filter(call => call.sql.startsWith('WITH')).length, 1);
});

test('SQL严格半开窗口，settle独立事件时间不限制任务创建/完成时间', async () => {
    const stub = databaseStub();
    await service(stub).read(params());
    const query = aggregateCall(stub).sql;
    assert.match(query, /t.created_at >= \$1::timestamptz AND t.created_at < \$2::timestamptz/);
    const settle = query.slice(query.indexOf('user_settles AS ('), query.indexOf('user_usage AS ('));
    assert.match(settle, /e.created_at >= \$3::timestamptz AND e.created_at < \$4::timestamptz/);
    assert.doesNotMatch(settle, /t.created_at|completed_at|status=/);
    const tasks = [task({ id: uuid(201), created_at: from }), task({ id: uuid(202), created_at: to }),
        task({ id: uuid(203), created_at: '2026-11-17T00:00:00.000Z' })];
    const { result } = await fixture(tasks, [event(uuid(201), { created_at: to }), event(uuid(202)), event(uuid(203))]);
    assert.equal(result.totals.taskCount, '1');
    assert.equal(result.totals.settledTenths, '14');
});

test('关系夹具：微秒from前排除、from含、to前含、to不含', async () => {
    const times = ['2026-11-17T23:59:59.999999Z', '2026-11-18T00:00:00.000000Z',
        '2026-11-18T23:59:59.999999Z', '2026-11-19T00:00:00.000000Z'];
    const tasks = times.map((created_at, index) => task({ id: uuid(500 + index), created_at }));
    const { result } = await fixture(tasks, times.map((created_at, index) => event(uuid(500 + index), { created_at })));
    assert.equal(result.totals.taskCount, '2');
    assert.equal(result.totals.settledTenths, '14');
});

test('视频生成按原快照分类，同PK不同业务ID仍分组，最终投影不依赖UNION输出顺序', async () => {
    const base = task();
    const video = task({ id: uuid(201), task_type: 'video.generate',
        route_snapshot: { ...base.route_snapshot, logicalModelId: 'mock.video',
            capabilitySnapshot: { operation: 'video.generate', mediaType: 'video' } } });
    const rows = fixtureRows([base, video], [event(video.id)]).reverse();
    const result = await service(databaseStub(rows)).read(params());
    assert.deepEqual(result.models.map(model => model.logicalModelId), ['mock.image', 'mock.video']);
    assert.equal(result.totals.modelCount, '2');
    assert.equal(result.users[0].settledTenths, '7');
});

test('关系夹具：任务关联多settle不乘法，两task同额7仍合计14', async () => {
    const first = task();
    const second = task({ id: uuid(201) });
    // 正常DB约束每task只一settle；这里额外用多事件探针防分析层暗含该假设。
    const { result } = await fixture([first, second], [event(first.id, { credit_tenths: '3' }),
        event(first.id, { credit_tenths: '4' }), event(second.id), event(first.id, { kind: 'reserve', credit_tenths: '99' })]);
    assert.equal(result.models[0].taskCount, '2');
    assert.equal(result.users[0].taskCount, '2');
    assert.equal(result.users[0].settledTenths, '14');
    const equal = await fixture([first, second], [event(first.id), event(second.id)]);
    assert.equal(equal.result.totals.settledTenths, '14');
});

test('关系夹具：失败/取消及release/grant/reserve不消费，成功未settle为零', async () => {
    const tasks = [task({ id: uuid(201), status: 'failed' }), task({ id: uuid(202), status: 'cancelled' }), task({ id: uuid(203) })];
    const { result } = await fixture(tasks, [event(uuid(201), { kind: 'release' }), event(uuid(202), { kind: 'reserve' }), event(null, { kind: 'grant' })]);
    assert.equal(result.totals.taskCount, '3');
    assert.equal(result.totals.succeededTaskCount, '1');
    assert.equal(result.totals.settledTenths, '0');
});

test('关系夹具：owner无users仍保留UUID/null邮箱，仅settle的旧task用户进入并集', async () => {
    const { result } = await fixture([task(), task({ id: uuid(201), owner_id: uuid(2), created_at: '2026-10-01T00:00:00.000Z' })],
        [event(uuid(201), { user_id: uuid(2) })]);
    assert.equal(result.users.length, 2);
    assert.deepEqual(result.users[0], { userId, email: null, profileAvailable: false, taskCount: '1', succeededTaskCount: '1', settledTenths: '0' });
    assert.equal(result.users[1].taskCount, '0');
    assert.equal(result.users[1].settledTenths, '7');
    assert.equal(result.totals.userCount, '2');
});

test('关系夹具：未知task_type在任务与消费两边排除，owner不匹配事件不归入', async () => {
    const tasks = [task(), task({ id: uuid(201), task_type: 'fixture.generate' })];
    const { result } = await fixture(tasks, [event(uuid(201)), event(tasks[0].id, { user_id: uuid(2) })]);
    assert.equal(result.totals.taskCount, '1');
    assert.equal(result.totals.settledTenths, '0');
    assert.equal(result.totals.userCount, '1');
});

test('历史模型结构SQL先检查JSON类型并用嵌套CASE保护numeric转换，不读当前目录', async () => {
    const stub = databaseStub();
    await service(stub).read(params());
    const query = aggregateCall(stub).sql;
    assert.match(query, /jsonb_typeof\(t.route_snapshot\) <> 'object'/);
    assert.match(query, /jsonb_typeof\(t.route_snapshot->'snapshotVersion'\) = 'number'/);
    assert.match(query, /jsonb_typeof\(t.route_snapshot->'logicalModelId'\) = 'string'/);
    assert.match(query, /CASE WHEN jsonb_typeof\(t.route_snapshot->'logicalModelVersion'\) = 'number'\s+THEN CASE WHEN[\s\S]*THEN \(t.route_snapshot->>'logicalModelVersion'\)::numeric <= 9007199254740991\s+ELSE false END ELSE false END/);
    assert.match(query, /capabilitySnapshot'->>'operation' = t.task_type/);
    assert.match(query, /capabilitySnapshot'->>'mediaType'/);
    assert.match(query, /route_snapshot_hash ~ '\^\[0-9a-f\]\{64\}\$'/);
    assert.match(query, /GROUP BY logical_model_pk,model_id/);
    assert.match(query, /WHERE reason IS NULL/);
    assert.match(query, /WHERE reason IS NOT NULL GROUP BY reason/);
});

test('关系夹具：NULL/部分路由、未知版本、类型恶意JSON及矛盾身份全部未归类', async () => {
    const base = task();
    const invalid = [
        { logical_model_pk: null }, { route_snapshot: null }, { route_snapshot_hash: null }, { route_snapshot_version: null },
        { route_snapshot_version: 2 }, { route_snapshot: { ...base.route_snapshot, snapshotVersion: 2 } },
        { route_snapshot: [] }, { route_snapshot: '伪快照' },
        { route_snapshot: { ...base.route_snapshot, logicalModelVersion: {} } },
        { route_snapshot: { ...base.route_snapshot, logicalModelVersion: '1' } },
        { route_snapshot: { ...base.route_snapshot, logicalModelVersion: -1 } },
        { route_snapshot: { ...base.route_snapshot, logicalModelId: 'INVALID ID' } },
        { route_snapshot: { ...base.route_snapshot, capabilitySnapshot: { operation: 'video.generate', mediaType: 'image' } } },
        { route_snapshot: { ...base.route_snapshot, capabilitySnapshot: { operation: 'image.generate', mediaType: 'video' } } },
        { route_snapshot_hash: 'A'.repeat(64) },
    ];
    const { result } = await fixture(invalid.map((override, index) => task({ id: uuid(300 + index), ...override })), [], [{ id: userId, email: 'fixture@example.test' }]);
    assert.deepEqual(result.models, []);
    assert.equal(result.unclassified.taskCount, '15');
    assert.deepEqual(result.unclassified.reasons, {
        missing_route: { taskCount: '4', succeededTaskCount: '4' },
        unsupported_version: { taskCount: '2', succeededTaskCount: '2' },
        invalid_identity: { taskCount: '9', succeededTaskCount: '9' },
    });
    assert.equal(result.users[0].taskCount, '15');
    assert.equal(result.users[0].email, 'fixture@example.test');
});

test('关系夹具：同原模型不同catalog版本合并，不从payload/当前目录补历史', async () => {
    const base = task();
    const { result } = await fixture([base, task({ id: uuid(201), route_snapshot: { ...base.route_snapshot, logicalModelVersion: 9 } }),
        task({ id: uuid(202), logical_model_pk: null, payload: { logicalModelId: 'mock.image' } })]);
    assert.equal(result.models.length, 1);
    assert.equal(result.models[0].taskCount, '2');
    assert.equal(result.unclassified.taskCount, '1');
});

test('固定Top10按任务数/身份稳定排序，总计包含榜外和未归类', async () => {
    const tasks = Array.from({ length: 12 }, (_, index) => task({ id: uuid(300 + index), owner_id: uuid(index + 1), logical_model_pk: uuid(index + 100) }));
    tasks.push(task({ id: uuid(399), logical_model_pk: null }));
    const { result, stub } = await fixture(tasks);
    assert.equal(result.models.length, 10);
    assert.equal(result.users.length, 10);
    assert.equal(result.totals.taskCount, '13');
    assert.equal(result.totals.modelCount, '12');
    assert.equal(result.totals.userCount, '12');
    assert.equal(result.unclassified.taskCount, '1');
    assert.equal(result.users[0].userId, userId);
    assert.deepEqual(result.models.map(model => model.logicalModelPk), tasks.slice(0, 10).map(item => item.logical_model_pk));
    const query = aggregateCall(stub).sql;
    assert.match(query, /ORDER BY task_count DESC,logical_model_pk ASC,model_id COLLATE "C" ASC LIMIT 10/);
    assert.match(query, /ORDER BY task_count DESC,user_id ASC LIMIT 10/);
});

test('所有计数/消费BigInt与numeric转精确字符串，总额可超过bigint上限', async () => {
    const huge = '18446744073709551614';
    const result = await service(databaseStub([modelRow({ task_count: 9007199254740993n }),
        userRow({ task_count: '9007199254740993', settled_tenths: huge }),
        totalRow({ task_count: '9007199254740993', succeeded_task_count: '1', settled_tenths: huge, model_count: '1', user_count: '1' })])).read(params());
    assert.equal(result.models[0].taskCount, '9007199254740993');
    assert.equal(result.users[0].settledTenths, huge);
    assert.equal(result.totals.settledTenths, huge);
    assert.doesNotThrow(() => JSON.stringify(result));
    const first = task();
    const second = task({ id: uuid(201) });
    const summed = await fixture([first, second], [event(first.id, { credit_tenths: '9223372036854775807' }), event(second.id, { credit_tenths: '9223372036854775807' })]);
    assert.equal(summed.result.totals.settledTenths, huge);
});

test('不可信聚合值、缺总计或未知结果区段报错，不降级空榜或错误零', async () => {
    const invalid = [[], [totalRow({ task_count: 9007199254740992 })], [totalRow({ settled_tenths: '1.5' })],
        [totalRow({ settled_tenths: '-1' })], [totalRow({ succeeded_task_count: '1' })],
        [totalRow(), totalRow()], [totalRow(), { ...modelRow(), section: 'secret' }],
        [totalRow(), modelRow({ id: 'not-uuid' })]];
    for (const rows of invalid) {
        const stub = databaseStub(rows);
        await assert.rejects(() => service(stub).read(), /ADMIN_ANALYTICS_DATA_INVALID/);
        assert.deepEqual(stub.outcomes, ['rollback']);
    }
});

test('数据库权限/超时原错误上抛给未来HTTP脱敏层，事务失败不返回部分结果', async () => {
    for (const code of ['42501', '57014']) {
        const error = Object.assign(new Error('测试数据库错误'), { code });
        const stub = databaseStub([], { error });
        await assert.rejects(() => service(stub).read(), cause => cause === error);
        assert.deepEqual(stub.outcomes, ['rollback']);
    }
});

test('注入时钟仍在同一只读事务运行，非法时钟不执行排名SQL', async () => {
    const stub = databaseStub();
    let sampled = 0;
    await service(stub, { clock: async tx => { assert.equal(typeof tx.execute, 'function'); sampled += 1; return asOf; } }).read();
    assert.equal(sampled, 1);
    assert.equal(stub.calls.length, 2);
    const invalid = databaseStub();
    await assert.rejects(() => service(invalid, { clock: async () => 'invalid' }).read(), /ADMIN_ANALYTICS_DATA_INVALID/);
    assert.equal(aggregateCall(invalid), undefined);
});
