'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { transformSync } = require('esbuild');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const adapter = require('../lib/adminModelsData');
const { readAdminModelsMock } = require('../lib/adminModelsMock');
const root = path.resolve(__dirname, '..');

function load(overrides = {}) {
  const source = fs.readFileSync(path.join(root, 'components/AdminModels.js'), 'utf8');
  const code = transformSync(source, { loader: 'jsx', format: 'cjs', jsx: 'automatic' }).code;
  const loaded = { exports: {} };
  vm.runInNewContext('(function(require,module,exports){' + code + '\n})', { AbortController, URLSearchParams })((id) => {
    if (overrides[id]) return overrides[id];
    if (id === '@/lib/adminModelsData') return adapter;
    return require(id);
  }, loaded, loaded.exports);
  return loaded.exports;
}

function elements(tree, predicate) {
  if (!tree || typeof tree !== 'object') return [];
  return [...(predicate(tree) ? [tree] : []), ...React.Children.toArray(tree.props?.children).flatMap(child => elements(child, predicate))];
}

function buttonText(element) {
  return React.Children.toArray(element.props.children).map(child => typeof child === 'string' ? child : '').join('');
}

function apiModel(overrides = {}) {
  return {
    id: 'image.standard.v1',
    name: '标准图像模型',
    type: 'image',
    enabled: true,
    catalogVersion: 3,
    logicalModelPk: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    capabilities: ['image.generate'],
    capabilitiesState: 'known',
    parameterSchemaVersion: 2,
    capabilityTemplate: { key: 'image-default', version: 1 },
    bindings: [{
      providerInstanceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      providerModelId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      routeRole: 'primary',
      routeOrder: 1,
      bindingVersion: 4,
      active: true,
    }],
    ...overrides,
  };
}

function apiData(overrides = {}) {
  return {
    source: 'api',
    mock: false,
    writesAvailable: false,
    models: [apiModel(), apiModel({
      id: 'video.motion.v2', name: '动态视频模型', type: 'video', enabled: false,
      logicalModelPk: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', capabilities: ['video.generate'],
      parameterSchemaVersion: null, capabilityTemplate: null, bindings: [],
    })],
    nextCursor: 'next-page-token',
    meta: { requestId: 'request-1', asOf: '2026-11-20T01:30:00.123Z', timeZone: 'UTC' },
    ...overrides,
  };
}

function readyState(data = apiData(), overrides = {}) {
  return {
    status: 'ready',
    data,
    filters: { search: '', type: 'all', enabled: 'all' },
    selectedId: null,
    query: { q: '', type: 'all', enabled: 'all', limit: 20 },
    cursors: [null],
    page: 0,
    ...overrides,
  };
}

function viewHarness(initialState) {
  const { AdminModelsView } = load({ react: React });
  let state = initialState;
  const setState = next => { state = typeof next === 'function' ? next(state) : next; };
  return {
    render() {
      const tree = AdminModelsView({ state, setState });
      return { tree, html: renderToStaticMarkup(tree) };
    },
    click(label, at = 0) {
      const match = elements(this.render().tree, element => element.type === 'button' && renderToStaticMarkup(element).includes(label))[at];
      assert.ok(match, label);
      assert.notEqual(match.props.disabled, true, label);
      match.props.onClick();
    },
    change(type, at, value) {
      const match = elements(this.render().tree, element => element.type === type)[at];
      assert.ok(match, `${type}[${at}]`);
      match.props.onChange({ target: { value } });
    },
    submit() {
      const form = elements(this.render().tree, element => element.type === 'form')[0];
      assert.ok(form);
      form.props.onSubmit({ preventDefault() {} });
    },
    get state() { return state; },
  };
}

function lifecycleHarness(gateway) {
  const slots = [];
  const effects = [];
  let index = 0;
  let writes = 0;
  let mounted = false;
  const hooks = {
    ...React,
    useState(initial) {
      const slot = index++;
      if (!(slot in slots)) slots[slot] = typeof initial === 'function' ? initial() : initial;
      return [slots[slot], next => {
        writes += 1;
        slots[slot] = typeof next === 'function' ? next(slots[slot]) : next;
      }];
    },
    useEffect(run, dependencies) {
      const slot = index++;
      const previous = slots[slot];
      const changed = !mounted || !previous || dependencies?.some((value, item) => !Object.is(value, previous[item]));
      slots[slot] = dependencies;
      if (changed) effects.push(run);
    },
  };
  const components = load({ react: hooks });
  const api = {
    render() {
      index = 0;
      const element = components.default({ gateway });
      const tree = element.type(element.props);
      return { tree, html: renderToStaticMarkup(tree) };
    },
    mount() {
      mounted = true;
      for (const run of effects.splice(0)) api.cleanup = run();
    },
    unmount() { api.cleanup?.(); },
    get state() { return slots[0]; },
    get writes() { return writes; },
  };
  return api;
}

const tick = () => new Promise(resolve => setImmediate(resolve));

// 这些测试保留 Mock 适配器的纯函数契约，不把 Mock DTO 当作 API 页面数据。
test('独立 Mock 覆盖两类型、启停、档位/绑定/价格配置差异，每次读取重新复制', async () => {
  const initial = await adapter.loadAdminModels();
  assert.equal(initial.source, 'mock');
  assert.deepEqual(new Set(initial.models.map(row => row.type)), new Set(['image', 'video']));
  assert.ok(initial.models.some(row => row.enabled));
  assert.ok(initial.models.some(row => !row.enabled));
  assert.deepEqual(new Set(initial.models.map(row => row.pricingStatus)), new Set(['configured', 'draft', 'unconfigured']));
  const raw = readAdminModelsMock();
  raw.models[0].tiers.push('改动'); raw.models[0].capabilities.length = 0; raw.models[0].providerBindings.length = 0;
  assert.deepEqual(await adapter.loadAdminModels(), initial);
});

test('Mock 适配仅投影安全字段、来源必须明确，真实来源不再复用旧 Mock 读取路径', async () => {
  const raw = readAdminModelsMock();
  raw.models[0].secret = '不得传入组件';
  const data = await adapter.loadAdminModels({ read: async () => raw, source: 'mock' });
  assert.equal(data.source, 'mock');
  assert.equal(data.models[0].secret, undefined);
  assert.throws(() => adapter.adaptAdminModels(raw), /来源必须明确/);
  assert.throws(() => adapter.adaptAdminModels({ models: [...raw.models, raw.models[0]] }, 'mock'), /条目无效/);
  assert.throws(() => adapter.adaptAdminModels({ models: [{ ...raw.models[0], enabled: 'true' }] }, 'mock'), /条目无效/);
  assert.throws(() => adapter.addMockModel({ ...data, source: 'api' }, { id: 'demo-new-model', name: '新增演示模型', type: 'image', capabilities: ['text-to-image'] }), /仅允许/);
  assert.throws(() => adapter.setMockModelEnabled({ ...data, source: 'api' }, data.models[0].id, false), /仅允许/);
  const error = new Error('读取失败');
  await assert.rejects(adapter.loadAdminModels({ source: 'mock', read: async () => { throw error; } }), value => value === error);
});

test('名称/稳定 ID 大小写无关搜索、类型和启停组合过滤不修改原列表', async () => {
  const { models } = await adapter.loadAdminModels();
  assert.equal(adapter.filterAdminModels(models, { search: ' 标准 ' })[0].id, 'demo-image-standard');
  assert.equal(adapter.filterAdminModels(models, { search: 'DEMO-VIDEO-MOTION' })[0].type, 'video');
  assert.equal(adapter.filterAdminModels(models, { type: 'image' }).length, 2);
  assert.equal(adapter.filterAdminModels(models, { enabled: 'false' }).length, 2);
  assert.deepEqual(adapter.filterAdminModels(models, { search: '演示', type: 'video', enabled: 'true' }).map(row => row.id), ['demo-video-motion']);
  assert.equal(adapter.filterAdminModels(models, { type: 'image', search: 'video' }).length, 0);
  assert.equal(models.length, 4);
});

test('添加校验稳定 ID、非空名称、合法类型、至少一项且同类型能力', () => {
  const draft = { id: 'demo-new-model', name: '新增演示模型', type: 'image', capabilities: ['text-to-image'] };
  for (const id of ['', 'a', 'UpperCase', '-bad', '含中文', 'a/b', 'a b', 'a'.repeat(129)]) assert.ok(adapter.validateModelDraft({ ...draft, id }).errors.id, id);
  for (const id of ['a0', '9demo._-v1', 'a'.repeat(128)]) assert.equal(adapter.validateModelDraft({ ...draft, id }).errors.id, undefined);
  for (const name of ['', '  ', 'a'.repeat(81)]) assert.ok(adapter.validateModelDraft({ ...draft, name }).errors.name);
  for (const type of ['', 'audio', 'toString', '__proto__']) assert.ok(adapter.validateModelDraft({ ...draft, type }).errors.type);
  for (const capabilities of [[], null, ['text-to-video'], ['invalid']]) assert.ok(adapter.validateModelDraft({ ...draft, capabilities }).errors.capabilities);
  assert.deepEqual(adapter.validateModelDraft({ ...draft, type: 'video', capabilities: ['image-to-video'] }).errors, {});
  assert.deepEqual(adapter.validateModelDraft({ ...draft, id: ' demo-new-model ', name: ' 新模型 ' }).value, { ...draft, name: '新模型' });
});

test('重复 ID 拒绝；合法添加仅生成禁用无绑定/价格的内存条目，不修改初始目录', async () => {
  const draft = { id: 'demo-new-model', name: '新增演示模型', type: 'image', capabilities: ['text-to-image'] };
  const initial = await adapter.loadAdminModels();
  const duplicate = adapter.addMockModel(initial, { ...draft, id: ` ${initial.models[0].id} ` });
  assert.match(duplicate.errors.id, /已存在/);
  assert.equal(duplicate.data, initial);
  const added = adapter.addMockModel(initial, draft);
  assert.equal(added.data.models.length, 5);
  assert.deepEqual(added.model, { ...draft, enabled: false, tiers: [], providerBindings: [], pricingStatus: 'unconfigured' });
  assert.equal(initial.models.length, 4);
  assert.match(adapter.addMockModel(added.data, draft).errors.id, /已存在/);
  assert.deepEqual(await adapter.loadAdminModels(), initial);
});

test('启停只更换对应模型内存状态，读回初始化恢复，不改能力/绑定/定价', async () => {
  const initial = await adapter.loadAdminModels();
  const original = initial.models[0];
  const disabled = adapter.setMockModelEnabled(initial, original.id, false);
  assert.deepEqual(disabled.models[0], { ...original, enabled: false });
  assert.equal(initial.models[0].enabled, true);
  assert.equal(disabled.models[1], initial.models[1]);
  assert.deepEqual(adapter.setMockModelEnabled(disabled, original.id, true), initial);
  assert.throws(() => adapter.setMockModelEnabled(initial, 'unknown', true), /无效/);
  assert.throws(() => adapter.setMockModelEnabled(initial, original.id, 'false'), /无效/);
  assert.deepEqual(await adapter.loadAdminModels(), initial);
});

test('真实 API 模型页显示只读目录、详情和安全字段，不显示 Mock 写入口', () => {
  const ui = viewHarness(readyState());
  const initial = ui.render().html;
  assert.match(initial, /标准图像模型/);
  assert.match(initial, /image\.standard\.v1/);
  assert.match(initial, /视频模型/);
  assert.doesNotMatch(initial, /Mock|演示添加|启用模型|禁用模型|保存/);
  ui.click('查看详情');
  assert.equal(ui.state.selectedId, 'image.standard.v1');
  const detail = renderToStaticMarkup(elements(ui.render().tree, element => element.type === 'aside')[0]);
  assert.match(detail, /标准图像模型|image\.standard\.v1|image\.generate|image-default/);
  ui.click('关闭详情');
  assert.equal(ui.state.selectedId, null);
});

test('应用筛选保留筛选条件并清空分页游标，分页按钮追踪 cursors 和 page', () => {
  const ui = viewHarness(readyState(apiData(), { filters: { search: '', type: 'all', enabled: 'all' }, page: 0, cursors: [null] }));
  ui.change('input', 0, '标准');
  ui.change('select', 0, 'image');
  ui.change('select', 1, 'true');
  ui.submit();
  assert.equal(ui.state.filters.search, '标准');
  assert.equal(ui.state.filters.type, 'image');
  assert.equal(ui.state.filters.enabled, 'true');
  assert.equal(ui.state.query.q, '标准');
  assert.equal(ui.state.query.type, 'image');
  assert.equal(ui.state.query.enabled, 'true');
  assert.equal(ui.state.query.limit, 20);
  assert.deepEqual([...ui.state.cursors], [null]);
  assert.equal(ui.state.page, 0);

  assert.equal(ui.state.status, 'loading');
  assert.equal(ui.state.data, null);
  const pageUi = viewHarness(readyState(apiData(), { ...ui.state, status: 'ready', data: apiData() }));
  pageUi.click('下一页');
  assert.equal(pageUi.state.page, 1);
  assert.equal(pageUi.state.cursors[0], null);
  assert.equal(pageUi.state.cursors[1], 'next-page-token');
  assert.equal(pageUi.state.query.q, '标准');
  assert.equal(pageUi.state.query.type, 'image');
  assert.equal(pageUi.state.query.enabled, 'true');
  assert.equal(pageUi.state.query.limit, 20);
  assert.equal(pageUi.state.status, 'loading');
  assert.equal(pageUi.state.data, null);
  const previousUi = viewHarness(readyState(apiData({ nextCursor: null }), { ...pageUi.state, status: 'ready', data: apiData({ nextCursor: null }) }));
  previousUi.click('上一页');
  assert.equal(previousUi.state.page, 0);
  assert.equal(previousUi.state.cursors[0], null);
  assert.equal(previousUi.state.cursors[1], 'next-page-token');
  assert.deepEqual(previousUi.state.query, pageUi.state.query);
  assert.equal(previousUi.state.status, 'loading');
  assert.equal(previousUi.state.data, null);
});

test('加载生命周期不提前显示、成功显示真实数据、失败清除旧数据并拒绝泄露异常', async () => {
  let resolve;
  const pending = new Promise(yes => { resolve = yes; });
  const gateway = { read: async () => pending };
  const ui = lifecycleHarness(gateway);
  assert.match(ui.render().html, /正在加载真实模型目录/);
  assert.doesNotMatch(ui.render().html, /标准图像模型/);
  ui.mount();
  resolve(apiData());
  await tick();
  ui.render();
  assert.equal(ui.state.status, 'ready');
  assert.match(ui.render().html, /标准图像模型/);

  let reject;
  const failed = new Promise((yes, no) => { resolve = yes; reject = no; });
  const failing = lifecycleHarness({ read: async () => failed });
  failing.render();
  failing.mount();
  reject(Object.assign(new Error('内部秘密异常'), { status: 503 }));
  await tick();
  const failedHtml = failing.render().html;
  assert.match(failedHtml, /真实模型目录暂时不可用/);
  assert.doesNotMatch(failedHtml, /标准图像模型|内部秘密异常/);
});

test('卸载后忽略延迟网关响应，不写入状态', async () => {
  let resolve;
  const pending = new Promise(yes => { resolve = yes; });
  const ui = lifecycleHarness({ read: async () => pending });
  ui.render();
  ui.mount();
  const writes = ui.writes;
  ui.unmount();
  resolve(apiData());
  await tick();
  assert.equal(ui.writes, writes);
});

test('401/403 模型读取错误提示管理员登录与 MFA', async () => {
  for (const status of [401, 403]) {
    const gateway = { read: async () => { throw Object.assign(new Error('拒绝原因不应展示'), { status }); } };
    const ui = lifecycleHarness(gateway);
    ui.render();
    ui.mount();
    await tick();
    const html = ui.render().html;
    assert.match(html, /管理员登录与 MFA/);
    assert.doesNotMatch(html, /拒绝原因不应展示|标准图像模型/);
  }
});
