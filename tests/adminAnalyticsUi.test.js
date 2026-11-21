'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { transformSync } = require('esbuild');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { readAdminAnalyticsMock } = require('../lib/adminAnalyticsMock');
const { loadAdminAnalytics, adaptAdminAnalytics, formatCreditTenths } = require('../lib/adminAnalyticsData');
const { createAdminAnalyticsReadService } = require('../lib/server/adminAnalyticsRead');

const root = path.resolve(__dirname, '..');
function load(overrides = {}) {
  const source = fs.readFileSync(path.join(root, 'components/AdminAnalytics.js'), 'utf8');
  const code = transformSync(source, { loader: 'jsx', format: 'cjs', jsx: 'automatic' }).code;
  const loaded = { exports: {} };
  vm.runInNewContext('(function(require,module,exports){' + code + '\n})', {})((id) => {
    if (overrides[id]) return overrides[id];
    if (id === '@/lib/adminAnalyticsData') return { loadAdminAnalytics };
    return require(id);
  }, loaded, loaded.exports);
  return loaded.exports;
}

const sum = (rows, key) => rows.reduce((total, row) => total + BigInt(row[key]), 0n).toString();

test('固定 mock 与真实读取服务返回投影及全部元数据契约一致', async () => {
  const mock = readAdminAnalyticsMock();
  const rows = [
    ...mock.models.map(row => ({ section: 'model', id: row.logicalModelPk, label: row.logicalModelId, task_count: row.taskCount, succeeded_task_count: row.succeededTaskCount })),
    ...mock.users.map(row => ({ section: 'user', id: row.userId, label: row.email, task_count: row.taskCount, succeeded_task_count: row.succeededTaskCount, settled_tenths: row.settledTenths })),
    ...Object.entries(mock.unclassified.reasons).map(([reason, row]) => ({ section: 'unclassified', id: reason, task_count: row.taskCount, succeeded_task_count: row.succeededTaskCount })),
    { section: 'totals', task_count: mock.totals.taskCount, succeeded_task_count: mock.totals.succeededTaskCount, settled_tenths: mock.totals.settledTenths, model_count: mock.totals.modelCount, user_count: mock.totals.userCount },
  ];
  let statements = 0;
  const service = createAdminAnalyticsReadService({
    database: { transaction: async run => run({ execute: async () => ({ rows: ++statements === 1 ? [] : rows }) }) },
    clock: async () => mock.window.asOf, environment: { NODE_ENV: 'test' },
  });
  const result = await service.read(new URLSearchParams({ from: mock.window.from, to: mock.window.to }));
  assert.deepEqual(mock, result);
  assert.deepEqual(await loadAdminAnalytics(), adaptAdminAnalytics(result, 'mock'));
});

test('演示汇总自洽，包含三类未归类、零消耗、仅结算用户且不含邮箱资料', () => {
  const data = readAdminAnalyticsMock();
  for (const key of ['taskCount', 'succeededTaskCount']) {
    assert.equal((BigInt(sum(data.models, key)) + BigInt(data.unclassified[key])).toString(), data.totals[key]);
    assert.equal(sum(data.users, key), data.totals[key]);
    assert.equal(sum(Object.values(data.unclassified.reasons), key), data.unclassified[key]);
  }
  assert.equal(sum(data.users, 'settledTenths'), data.totals.settledTenths);
  assert.equal(String(data.models.length), data.totals.modelCount);
  assert.equal(String(data.users.length), data.totals.userCount);
  assert.ok(data.users.some(row => row.taskCount !== '0' && row.settledTenths === '0'));
  assert.ok(data.users.some(row => row.taskCount === '0' && row.settledTenths !== '0'));
  assert.ok(data.users.every(row => row.email === null && row.profileAvailable === false));
  assert.equal(data.capabilities.attemptsAvailable, false);
  assert.equal(data.capabilities.attemptCount, null);
  assert.equal(Date.parse(data.window.to) - Date.parse(data.window.from), 31 * 86400000);
  const first = readAdminAnalyticsMock();
  first.users[0].taskCount = '999';
  assert.deepEqual(readAdminAnalyticsMock(), data);
});

test('适配入口可直接替换异步真实读取，不改排序、不吞错误或回退 mock', async () => {
  const raw = readAdminAnalyticsMock();
  const data = await loadAdminAnalytics({ read: async () => raw, source: 'api' });
  assert.equal(data.source, 'api');
  assert.equal(data.users[1].settledCredits, '0.0');
  assert.deepEqual(data.users.map(row => row.userId), raw.users.map(row => row.userId));
  assert.ok(BigInt(data.users[2].settledTenths) > BigInt(data.users[1].settledTenths));
  const error = new Error('读取失败');
  await assert.rejects(loadAdminAnalytics({ read: async () => { throw error; }, source: 'api' }), value => value === error);
  assert.throws(() => adaptAdminAnalytics({ ...raw, unitVersion: 'unknown' }, 'mock'), /积分单位/);
  assert.throws(() => adaptAdminAnalytics(raw), /来源必须明确/);
});

test('积分超过 Number 安全范围及 bigint 上限仍精确，条形宽度仅使用 BigInt 比例', () => {
  assert.equal(formatCreditTenths('184467440737095516151'), '18446744073709551615.1');
  assert.equal(formatCreditTenths('0'), '0.0');
  assert.equal(formatCreditTenths('7'), '0.7');
  const raw = readAdminAnalyticsMock();
  raw.models[0].taskCount = '184467440737095516150';
  raw.models[1].taskCount = '92233720368547758075';
  raw.users[0].settledTenths = '184467440737095516151';
  const data = adaptAdminAnalytics(raw, 'mock');
  assert.equal(data.models[0].barWidth, '100%');
  assert.equal(data.models[1].barWidth, '50%');
  assert.equal(data.users[0].settledCredits, '18446744073709551615.1');
  raw.models.forEach(row => { row.taskCount = '0'; });
  assert.ok(adaptAdminAnalytics(raw, 'mock').models.every(row => row.barWidth === '0%'));
});

test('真实 JSX 离线渲染醒目 Mock、固定窗口、横条、用户表、未归类及口径，无假筛选入口', async () => {
  const { AdminAnalyticsView } = load();
  const html = renderToStaticMarkup(React.createElement(AdminAnalyticsView, { data: await loadAdminAnalytics() }));
  for (const text of ['演示数据 / Mock，非真实运营结果', '演示窗口', '2026-10-01', '2026-11-01', '模型任务数排名', '用户使用量排名', 'taskCount', '不按结算积分排序', '未归类汇总', '零消耗不代表免费', 'attemptCount 为 null', '252.0 credit', '180.1', '69.9', '0.0', '2.0', '用户资料不可用']) assert.ok(html.includes(text), text);
  assert.equal((html.match(/Mock · 演示数据/g) || []).length, 3);
  assert.match(html, /width:100%/);
  assert.match(html, /width:62%/);
  assert.match(html, /<table/);
  assert.match(html, /bg-white/);
  assert.doesNotMatch(html, /<input|<select|<button|@|¥|收入.*\d|成本.*\d|利润.*\d/);
});

test('空响应显示空态而非示例，API 来源不会误标成 mock', () => {
  const { AdminAnalyticsView } = load();
  const raw = readAdminAnalyticsMock();
  raw.models = [];
  raw.users = [];
  const html = renderToStaticMarkup(React.createElement(AdminAnalyticsView, { data: adaptAdminAnalytics(raw, 'api') }));
  assert.match(html, /窗口内无已归类模型任务/);
  assert.match(html, /窗口内无任务或结算用户/);
  assert.doesNotMatch(html, /演示用户|演示窗口|Mock/);
});

for (const outcome of ['ready', 'error', 'unmount']) {
  test(`实际页面加载生命周期 ${outcome}，不提前渲染或在卸载后写入`, async () => {
    let state;
    let effect;
    let writes = 0;
    let resolve;
    let reject;
    const pending = new Promise((yes, no) => { resolve = yes; reject = no; });
    const hooks = { ...React, useState(initial) { state ??= initial; return [state, next => { state = next; writes++; }]; }, useEffect(run) { effect = run; } };
    const Page = load({ react: hooks, '@/lib/adminAnalyticsData': { loadAdminAnalytics: () => pending } }).default;
    const render = () => renderToStaticMarkup(Page());
    assert.match(render(), /正在加载演示分析数据/);
    assert.doesNotMatch(render(), /模型任务数排名/);
    const cleanup = effect();
    if (outcome === 'unmount') cleanup();
    if (outcome === 'error') reject(new Error('不应显示的内部异常'));
    else resolve(await loadAdminAnalytics());
    await new Promise(done => setImmediate(done));
    if (outcome === 'ready') assert.match(render(), /演示数据 \/ Mock/);
    if (outcome === 'error') {
      assert.match(render(), /分析数据暂时不可用/);
      assert.doesNotMatch(render(), /模型任务数排名|不应显示的内部异常/);
    }
    if (outcome === 'unmount') assert.equal(writes, 0);
  });
}
