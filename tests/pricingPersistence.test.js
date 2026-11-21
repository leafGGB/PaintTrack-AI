'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createInternalPricingStore } = require('../lib/server/tasks/pricingPersistence');
const { preparePricingVersion, createTrustedQuoteService } = require('../lib/server/tasks/pricingQuote');
const { requestFingerprint } = require('../lib/server/tasks/taskSubmission');
const root = path.resolve(__dirname, '..');
const ownerId = '00000000-0000-4000-8000-000000000001';
const config = () => ({ modelId: 'persist-image', modelVersion: 1, pricingVersion: 'v1', enabled: true,
    templateType: 'image_resolution_quantity', currencyUnit: 'credit_tenths', roundingMode: 'ceil_to_atom',
    precisionVersion: 'integer_rational_ms_v1', roundingModeVersion: 'ceil_to_atom_v1', quantityMode: 'per_unit',
    maxOutputCount: 1, resolutions: [{ resolutionKey: '1024x1024', enabled: true, unitPriceTenths: '7' }] });
const request = () => ({ taskType: 'image.generate', payload: { logicalModelId: 'persist-image', prompt: '持久化合成测试', aspectRatio: '1:1', size: '1024x1024', outputCount: 1 } });
const record = () => ({ id: 'version-id', config: config(), config_hash: preparePricingVersion({ config: config(), publishedAtUs: '0', effectiveFromUs: '1000000', revokedAtUs: null, cancelledAtUs: null }).configHash,
    pricing_version: 'v1', published_at_us: '0', effective_from_us: '1000000', revoked_at_us: null, cancelled_at_us: null });
function harness({ versions = [record()], prior, allowed = true, fault, modelChanges = {}, now = '2000000' } = {}) {
    const calls = [];
    const client = { async query(sql, values) {
        calls.push({ sql, values });
        if (fault && sql.startsWith(fault)) throw new Error('合成故障');
        if (sql.includes('AS allowed')) return { rows: [{ allowed }] };
        if (sql.includes('FROM public.pricing_quotes')) return { rows: prior ? [prior] : [] };
        if (sql.includes('FROM public.logical_models')) return { rows: [{ id: 'model-id', logical_model_id: 'persist-image', enabled: true, catalog_version: 1, media_type: 'image', supported_operations: ['image.generate'], ...modelChanges }] };
        if (sql.includes('FROM public.pricing_versions')) return { rows: versions };
        if (sql.includes('clock_timestamp')) return { rows: [{ us: now }] };
        if (sql.startsWith('INSERT')) return { rows: [{ id: 'inserted-id' }] };
        return { rows: [] };
    }, release() { calls.push({ sql: 'RELEASE' }); } };
    return { calls, store: createInternalPricingStore({ pool: { connect: async () => client } }) };
}
const submit = h => h.store.quote({ ownerId, idempotencyKey: 'persist-key-1', request: request() });

test('事务严格按身份、幂等锁、模型advisory锁、完整时间轴、实时采样、纯计算、INSERT、COMMIT顺序', async () => {
    const h = harness();
    const result = await submit(h);
    assert.equal(result.snapshot.credit_tenths, '7');
    assert.equal(result.replayed, false);
    const sql = h.calls.map(c => c.sql);
    const position = text => sql.findIndex(s => s.includes(text));
    assert.ok(position('AS allowed') < position('pg_advisory_xact_lock'));
    assert.ok(position('hashtextextended($1, 626)') < position('SELECT * FROM public.pricing_versions'));
    assert.ok(position('SELECT * FROM public.pricing_versions') < position('clock_timestamp'));
    assert.ok(position('clock_timestamp') < position('INSERT INTO public.pricing_quotes'));
    assert.equal(sql[0], 'BEGIN ISOLATION LEVEL READ COMMITTED');
    assert.deepEqual(sql.slice(-2), ['COMMIT', 'RELEASE']);
    assert.doesNotMatch(sql.join('\n'), /now\(|statement_timestamp|INSERT INTO .*generation_tasks|credit_reservations|credit_accounts/);
    const inserted = h.calls.find(c => c.sql.startsWith('INSERT'));
    assert.equal(inserted.values[6], '7');
    assert.equal(inserted.values[7], '2000000');
    assert.equal(inserted.values[8], '1802000000');
});

test('相同请求重放只回原凭证，不读取当前价格/时钟、不延长有效期', async () => {
    const snapshot = { createdAtUs: '1', expiresAtUs: '2' };
    const h = harness({ prior: { id: 'old-id', request_fingerprint: requestFingerprint(request()), snapshot } });
    const result = await submit(h);
    assert.deepEqual(result, { id: 'old-id', snapshot, replayed: true });
    assert.doesNotMatch(h.calls.map(c => c.sql).join('\n'), /FOR UPDATE|clock_timestamp|INSERT/);
});

test('UUID大小写统一为小写后生成同一幂等锁、查询和插入身份', async () => {
    const lower = 'abcdefab-cdef-4abc-8def-abcdefabcdef';
    const histories = [];
    for (const value of [lower, lower.toUpperCase()]) {
        const h = harness();
        await h.store.quote({ ownerId: value, idempotencyKey: 'persist-case-key', request: request() });
        const lock = h.calls.find(c => c.sql.includes('hashtextextended($1, 625)'));
        const query = h.calls.find(c => c.sql.includes('FROM public.pricing_quotes'));
        const insert = h.calls.find(c => c.sql.startsWith('INSERT'));
        assert.deepEqual(lock.values, [`${lower}:persist-case-key`]);
        assert.equal(query.values[0], lower);
        assert.equal(insert.values[0], lower);
        histories.push(h.calls);
    }
    assert.deepEqual(histories[0], histories[1]);
});

test('新建与重放返回快照均深冻结，且重放复制不冻结或引用数据库原对象', async () => {
    const fresh = await submit(harness());
    const stored = JSON.parse(JSON.stringify(fresh.snapshot));
    const replay = await submit(harness({ prior: { id: fresh.id, request_fingerprint: requestFingerprint(request()), snapshot: stored } }));
    const assertFrozen = value => {
        if (value && typeof value === 'object') {
            assert.ok(Object.isFrozen(value));
            Object.values(value).forEach(assertFrozen);
        }
    };
    assertFrozen(fresh);
    assertFrozen(replay);
    assert.deepEqual(replay.snapshot, fresh.snapshot);
    assert.notEqual(replay.snapshot, stored);
    assert.ok(!Object.isFrozen(stored));
    assert.throws(() => { replay.snapshot.pricingConfig.resolutions[0].unitPriceTenths = '0'; }, TypeError);
    stored.pricingConfig.resolutions[0].unitPriceTenths = '99';
    assert.equal(replay.snapshot.pricingConfig.resolutions[0].unitPriceTenths, '7');
});

test('完整257版本持久化路径选最新头，撤销最新头仍拒绝而不回退', async () => {
    const versions = Array.from({ length: 257 }, (_, index) => {
        const c = { ...config(), pricingVersion: `history-${index}` };
        return { ...record(), id: `id-${index}`, pricing_version: c.pricingVersion, config: c,
            config_hash: preparePricingVersion({ config: c, publishedAtUs: '0', effectiveFromUs: `${(index + 1) * 1000000}`, revokedAtUs: null, cancelledAtUs: null }).configHash,
            effective_from_us: `${(index + 1) * 1000000}` };
    });
    const h = harness({ versions, now: '257000000' });
    assert.equal((await submit(h)).snapshot.pricingVersion, 'history-256');
    versions.at(-1).revoked_at_us = '257000000';
    const revoked = harness({ versions, now: '257000000' });
    await assert.rejects(submit(revoked), error => error.reason === 'NO_ACTIVE_VERSION');
    assert.ok(!revoked.calls.some(c => c.sql.startsWith('INSERT')));
    assert.doesNotMatch(h.calls.find(c => c.sql.includes('SELECT * FROM public.pricing_versions')).sql, /LIMIT|revoked_at_us|cancelled_at_us/);
});

test('PG锁等待夹具每轮先清理统计快照再检查活动后端', () => {
    const fixture = fs.readFileSync(path.join(root, 'tests/fixtures/pricing-persistence-postgres.cjs'), 'utf8');
    assert.match(fixture, /for \(let i = 0; i < 500; i\+\+\) \{\s*\/\/[^\n]*\n\s*await admin.query\('SELECT pg_catalog.pg_stat_clear_snapshot\(\)'\);\s*waiting = \(await admin.query\(`SELECT EXISTS\(SELECT 1 FROM pg_stat_activity/);
});

test('同键不同请求拒绝并回滚，不重报价', async () => {
    const h = harness({ prior: { request_fingerprint: 'b'.repeat(64) } });
    await assert.rejects(submit(h), error => error.reason === 'QUOTE_REPLAY_CONFLICT');
    assert.deepEqual(h.calls.slice(-2).map(c => c.sql), ['ROLLBACK', 'RELEASE']);
});

for (const [name, options] of [
    ['身份不是专用owner', { allowed: false }],
    ['模型禁用', { modelChanges: { enabled: false } }],
    ['模型版本变更', { modelChanges: { catalog_version: 2 } }],
    ['操作不支持', { modelChanges: { supported_operations: [] } }],
    ['最新价格撤销不能回退', { versions: [record(), { ...record(), id: 'v2', pricing_version: 'v2', config: { ...config(), pricingVersion: 'v2' }, effective_from_us: '2000000', revoked_at_us: '2000000' }] }],
    ['持久配置hash不匹配', { versions: [{ ...record(), config_hash: 'b'.repeat(64) }] }],
    ['采样失败', { fault: 'SELECT trunc' }],
    ['写入失败', { fault: 'INSERT' }],
    ['提交失败', { fault: 'COMMIT' }],
]) test(`${name}均失败回滚并释放连接`, async () => {
    const h = harness(options);
    await assert.rejects(submit(h));
    assert.deepEqual(h.calls.slice(-2).map(c => c.sql), ['ROLLBACK', 'RELEASE']);
    assert.equal(h.calls.filter(c => c.sql === 'COMMIT').length, options.fault === 'COMMIT' ? 1 : 0);
});

test('取消未来预约后仍选当前价，完整时间轴不可预筛撤销或取消', async () => {
    const h = harness({ versions: [record(), { ...record(), config: { ...config(), pricingVersion: 'v2' }, effective_from_us: '3000000', cancelled_at_us: '1000000' }] });
    assert.equal((await submit(h)).snapshot.pricingVersion, 'v1');
    assert.doesNotMatch(h.calls.find(c => c.sql.includes('SELECT * FROM public.pricing_versions')).sql, /revoked_at_us|cancelled_at_us|LIMIT|published_at_us/);
});

test('发布复用配置规范化且拒绝过去/非整秒时点，不偷偷移动时间', async () => {
    const h = harness({ versions: [] });
    await assert.rejects(h.store.publishScheduled({ config: config(), effectiveFromUs: '1000000' }));
    await assert.rejects(h.store.publishScheduled({ config: config(), effectiveFromUs: '3000001' }));
    assert.ok(!h.calls.some(c => c.sql.startsWith('INSERT')));
    const good = harness({ versions: [] });
    assert.deepEqual(await good.store.publishScheduled({ config: config(), effectiveFromUs: '3000000' }), { id: 'inserted-id', replayed: false });
    assert.equal(good.calls.find(c => c.sql.startsWith('INSERT')).values[4], '3000000');
});

test('发布同版本同内容幂等，异内容冲突，不能覆写历史', async () => {
    const h = harness();
    assert.equal((await h.store.publishScheduled({ config: config(), effectiveFromUs: '1000000' })).replayed, true);
    await assert.rejects(h.store.publishScheduled({ config: { ...config(), enabled: false }, effectiveFromUs: '1000000' }));
    assert.ok(!h.calls.some(c => c.sql.startsWith('INSERT') || c.sql.startsWith('UPDATE')));
});

test('取消等号到点拒绝，已取消重复幂等且不能撤销或恢复', async () => {
    const h = harness({ now: '1000000' });
    await assert.rejects(h.store.changeLifecycle({ modelId: 'persist-image', pricingVersion: 'v1', action: 'cancel' }));
    const cancelled = harness({ versions: [{ ...record(), cancelled_at_us: '500000' }] });
    assert.equal((await cancelled.store.changeLifecycle({ modelId: 'persist-image', pricingVersion: 'v1', action: 'cancel' })).replayed, true);
    await assert.rejects(cancelled.store.changeLifecycle({ modelId: 'persist-image', pricingVersion: 'v1', action: 'revoke' }));
    await assert.rejects(cancelled.store.changeLifecycle({ modelId: 'persist-image', pricingVersion: 'v1', action: 'restore' }));
});

test('撤销按模型锁后DB时钟更新，金额和时钟不从报价请求装配', async () => {
    const h = harness();
    await h.store.changeLifecycle({ modelId: 'persist-image', pricingVersion: 'v1', action: 'revoke' });
    assert.deepEqual(h.calls.find(c => c.sql.startsWith('UPDATE')).values, ['version-id', '2000000']);
    const args = request(); args.payload.credit_tenths = '1';
    await assert.rejects(h.store.quote({ ownerId, idempotencyKey: 'persist-key-1', request: args }));
    const result = await h.store.quote({ ownerId, idempotencyKey: 'persist-key-2', request: request(), databaseTime: { epochMicroseconds: '0' }, credit_tenths: '0' });
    assert.equal(result.snapshot.createdAtUs, '2000000');
    assert.equal(result.snapshot.credit_tenths, '7');
});

test('0025 LF、前驱和安全扩展棘轮：无LOGIN/运行角色扩权，生命周期及快照不可改', () => {
    const source = fs.readFileSync(path.join(root, 'drizzle/0025_pricing_persistence.sql'), 'utf8');
    assert.ok(!source.includes('\r'));
    const journal = require('../drizzle/meta/_journal.json');
    assert.equal(journal.entries.find(entry => entry.tag === '0025_pricing_persistence')?.tag, '0025_pricing_persistence');
    assert.equal(require('../drizzle/meta/0025_snapshot.json').prevId, require('../drizzle/meta/0024_snapshot.json').id);
    assert.doesNotMatch(source, /CREATE ROLE|GRANT EXECUTE|TO (?:pt_runtime|pt_worker|pt_cleanup)|ALTER TABLE.*(?:credit_|generation_tasks)/);
    assert.match(source, /BEFORE UPDATE OR DELETE OR TRUNCATE ON public.pricing_quotes/);
    assert.match(source, /OLD.revoked_at_us IS NOT NULL OR OLD.cancelled_at_us IS NOT NULL/);
    assert.match(source, /sampled >= OLD.effective_from_us/);
    assert.match(source, /ORDER BY effective_from_us DESC LIMIT 1/);
    assert.match(source, /REVOKE ALL ON FUNCTION public.pricing_reject_mutation\(\) FROM PUBLIC/);
    assert.match(source, /ALTER FUNCTION public\.pricing_reject_mutation\(\) OWNER TO %I/);
    assert.match(source, /FOR EACH STATEMENT EXECUTE FUNCTION public\.pricing_reject_mutation\(\)/);
    assert.doesNotMatch(source, /EXECUTE FUNCTION public\.credit_reject_mutation\(\)/);
    assert.match(source, /REVOKE ALL ON FUNCTION public.pricing_guard_version\(\), public.pricing_guard_quote\(\), public.pricing_lock_model_mutation\(\) FROM PUBLIC/);
    assert.match(source, /CREATE FUNCTION public.pricing_reject_mutation\(\)[\s\S]*?REVOKE ALL ON FUNCTION public\.pricing_reject_mutation\(\) FROM PUBLIC/);
    assert.equal((source.match(/SECURITY DEFINER SET search_path = pg_catalog, pg_temp/g) || []).length, 4);
    assert.doesNotMatch(source, /UPDATE\(id\)/);
    assert.match(source, /logical_models_pricing_lock BEFORE UPDATE OR DELETE/);
    assert.match(source, /hashtextextended\(OLD.id::text, 626\)/);
    assert.equal(typeof require('./fixtures/pricing-persistence-postgres.cjs').checkPricingPersistence, 'function');
    const acceptance = fs.readFileSync(path.join(root, 'scripts/accept-database-local.js'), 'utf8');
    assert.match(acceptance, /runFixture\('pricing-persistence-postgres'/);
    assert.match(acceptance, /before0021.length \+ 11/);
    const expected = createTrustedQuoteService({ versions: [{ config: config(), publishedAtUs: '0', effectiveFromUs: '1000000', revokedAtUs: null, cancelledAtUs: null }] }).quote({ request: request(), databaseTime: { source: 'postgresql.clock_timestamp', epochMicroseconds: '2000000' } });
    assert.equal(expected.credit_tenths, '7');
});
