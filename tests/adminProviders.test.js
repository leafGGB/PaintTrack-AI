'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { transformSync } = require('esbuild');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const adapter = require('../lib/adminProvidersData');
const { readAdminProvidersMock } = require('../lib/adminProvidersMock');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

function load(overrides = {}) {
  const code = transformSync(read('components/AdminProviders.js'), { loader: 'jsx', format: 'cjs', jsx: 'automatic' }).code;
  const loaded = { exports: {} };
  vm.runInNewContext('(function(require,module,exports){' + code + '\n})', {})((id) => {
    if (overrides[id]) return overrides[id];
    if (id === '@/lib/adminProvidersData') return adapter;
    return require(id);
  }, loaded, loaded.exports);
  return loaded.exports;
}

function elements(tree, predicate) {
  if (!tree || typeof tree !== 'object') return [];
  return [...(predicate(tree) ? [tree] : []), ...React.Children.toArray(tree.props?.children).flatMap(child => elements(child, predicate))];
}

function harness(overrides = {}) {
  const slots = [];
  const effects = [];
  let index = 0;
  let writes = 0;
  const hooks = {
    ...React,
    useState(initial) {
      const slot = index++;
      if (!(slot in slots)) slots[slot] = typeof initial === 'function' ? initial() : initial;
      return [slots[slot], next => { writes++; slots[slot] = typeof next === 'function' ? next(slots[slot]) : next; }];
    },
    useEffect(run) { const slot = index++; if (!(slot in slots)) { slots[slot] = true; effects.push(run); } },
  };
  const components = load({ ...overrides, react: hooks });
  return {
    render() {
      index = 0;
      const child = components.default();
      const tree = child.type(child.props);
      return { tree, html: renderToStaticMarkup(tree) };
    },
    mount() { for (const run of effects.splice(0)) this.cleanup = run(); },
    unmount() { this.cleanup?.(); },
    click(label, at = 0) {
      const found = elements(this.render().tree, el => el.type === 'button' && React.Children.toArray(el.props.children).join('') === label)[at];
      assert.ok(found, label);
      assert.ok(!found.props.disabled, label);
      found.props.onClick();
    },
    change(type, at, value) {
      const found = elements(this.render().tree, el => el.type === type)[at];
      assert.ok(found);
      found.props.onChange({ target: { value } });
    },
    submit() { elements(this.render().tree, el => el.type === 'form')[0].props.onSubmit({ preventDefault() {} }); },
    detail() { return renderToStaticMarkup(elements(this.render().tree, el => el.props['aria-label'] === 'Mock Provider 路由详情')[0]); },
    get state() { return slots[0]; },
    get writes() { return writes; },
  };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
async function ready() { const ui = harness(); ui.render(); ui.mount(); await tick(); return ui; }

function assertNoSecrets(value) {
  if (typeof value === 'string') assert.doesNotMatch(value, /https?:\/\/|postgres(?:ql)?:\/\/|Bearer\s|sk-[a-z0-9]+/i);
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assert.doesNotMatch(key, /secret|key|token|credential|password|endpoint|url|host|connection|authorization/i);
    assertNoSecrets(child);
  }
}

test('独立 Mock 结构、稳定 ID、关联及固定检查状态完整，无秘密或连接字段', async () => {
  const raw = readAdminProvidersMock();
  const data = await adapter.loadAdminProviders();
  assert.equal(data.source, 'mock');
  assert.equal(data.providers.length, 4);
  assert.equal(data.routes.length, 2);
  assert.equal(new Set(data.providers.map(row => row.id)).size, 4);
  assert.deepEqual(new Set(data.providers.map(row => row.enabled)), new Set([true, false]));
  assert.deepEqual(new Set(data.providers.map(row => row.health)), new Set(['healthy', 'degraded', 'unchecked']));
  assert.deepEqual(new Set(data.providers.map(row => row.verification)), new Set(['verified', 'pending', 'unverified']));
  assert.deepEqual(new Set(data.providers.map(row => row.lastCheckedAt)), new Set(['2026-11-19T08:00:00Z', null]));
  for (const route of data.routes) {
    assert.ok(data.models.some(row => row.id === route.modelId));
    assert.ok(data.providers.some(row => row.id === route.primaryProviderId));
    assert.ok(data.providers.some(row => row.id === route.backupProviderId));
    assert.notEqual(route.primaryProviderId, route.backupProviderId);
  }
  assertNoSecrets(raw); assertNoSecrets(data);
  raw.providers[0].enabled = false; raw.models[0].name = '修改'; raw.routes[0].primaryProviderId = '修改';
  assert.deepEqual(await adapter.loadAdminProviders(), data);
});

test('适配入口可替换且逐层白名单投影，不访问秘密 getter，错误上抛不回退', async () => {
  const raw = readAdminProvidersMock();
  for (const row of [raw, ...raw.providers, ...raw.models, ...raw.routes]) {
    Object.defineProperty(row, 'secret', { enumerable: true, get() { throw new Error('不能访问秘密'); } });
    row.apiKey = '合成字段'; row.connection = '合成连接';
  }
  const data = await adapter.loadAdminProviders({ read: async () => raw, source: 'api' });
  assert.equal(data.source, 'api');
  assertNoSecrets(data);
  assert.deepEqual(data.providers[0], readAdminProvidersMock().providers[0]);
  const error = new Error('读取失败');
  await assert.rejects(adapter.loadAdminProviders({ source: 'api', read: async () => { throw error; } }), value => value === error);
  assert.throws(() => adapter.adaptAdminProviders(raw), /来源必须明确/);
});

test('适配拒绝非法结构、重复身份、未知模型或 Provider、同主备及重复模型路由', () => {
  for (const mutate of [
    raw => { raw.providers = null; },
    raw => { raw.providers.push(raw.providers[0]); },
    raw => { raw.providers[0].id = undefined; },
    raw => { raw.providers[0].enabled = 'true'; },
    raw => { raw.providers[0].priority = 101; },
    raw => { raw.providers[0].health = 'toString'; },
    raw => { raw.providers[0].verification = '__proto__'; },
    raw => { raw.providers[0].lastCheckedAt = '不是日期'; },
    raw => { raw.models.push(raw.models[0]); },
    raw => { raw.models[0].name = ' '; },
    raw => { raw.routes[0].id = undefined; },
    raw => { raw.routes[0].modelId = 'unknown'; },
    raw => { raw.routes[0].backupProviderId = 'unknown'; },
    raw => { raw.routes[0].backupProviderId = raw.routes[0].primaryProviderId; },
    raw => { raw.routes.push(raw.routes[0]); },
    raw => { raw.routes.push({ ...raw.routes[0], id: 'demo-route-duplicate' }); },
  ]) {
    const raw = readAdminProvidersMock(); mutate(raw);
    assert.throws(() => adapter.adaptAdminProviders(raw, 'mock'), /无效/);
  }
  assert.throws(() => adapter.adaptAdminProviders(null, 'mock'), /结构无效/);
});

test('名称/ID 搜索、启停及模型关联组合筛选包含主备且不改变数据', async () => {
  const data = await adapter.loadAdminProviders();
  assert.equal(adapter.filterAdminProviders(data, { search: ' DEMO-PROVIDER-A ' })[0].id, 'demo-provider-a');
  assert.equal(adapter.filterAdminProviders(data, { search: '未关联' })[0].id, 'demo-provider-idle');
  assert.equal(adapter.filterAdminProviders(data, { enabled: 'false' }).length, 2);
  assert.deepEqual(adapter.filterAdminProviders(data, { modelId: 'demo-image-standard' }).map(row => row.id), ['demo-provider-a', 'demo-provider-b']);
  assert.deepEqual(adapter.filterAdminProviders(data, { search: '演示', modelId: 'demo-video-motion', enabled: 'false' }).map(row => row.id), ['demo-provider-c']);
  assert.equal(adapter.filterAdminProviders(data, { modelId: 'unknown' }).length, 0);
  assert.equal(adapter.filterAdminProviders(data, { search: '不存在' }).length, 0);
  assert.equal(data.providers.length, 4);
});

test('优先级只接受 1–100 整数，拒绝空、分数、指数、布尔、超范围值', () => {
  for (const value of ['', ' ', null, undefined, true, false, [], {}, '0', 0, -1, 101, '1000', '1.5', 1.5, '1e1', '0x10', '+2', 'Infinity', NaN, Infinity]) {
    assert.match(adapter.validateProviderPriority(value).error, /1–100 的整数/, String(value));
  }
  for (const value of [1, 100, '1', '100', ' 42 ']) {
    const checked = adapter.validateProviderPriority(value);
    assert.equal(checked.error, null); assert.equal(checked.value, Number(value));
  }
});

test('启停与优先级为纯内存修改，不更改固定健康/检查/验证及主备，无自动故障转移', async () => {
  const initial = await adapter.loadAdminProviders();
  const disabled = adapter.setMockProviderEnabled(initial, 'demo-provider-a', false);
  const changed = adapter.setMockProviderPriority(disabled, 'demo-provider-a', '100');
  assert.deepEqual(changed.providers[0], { ...initial.providers[0], enabled: false, priority: 100 });
  assert.equal(initial.providers[0].enabled, true);
  assert.equal(initial.providers[0].priority, 10);
  assert.equal(changed.routes, initial.routes); assert.equal(changed.models, initial.models);
  assert.equal(changed.providers[1], initial.providers[1]);
  assert.throws(() => adapter.setMockProviderPriority(initial, 'demo-provider-a', 101), /1–100/);
  assert.throws(() => adapter.setMockProviderPriority(initial, 'unknown', 1), /无效/);
  assert.throws(() => adapter.setMockProviderEnabled(initial, 'unknown', true), /无效/);
  assert.throws(() => adapter.setMockProviderEnabled(initial, 'demo-provider-a', 'false'), /无效/);
  assert.deepEqual(await adapter.loadAdminProviders(), initial);
});

test('主备互换只交换指定路由角色，保留模型/Provider 状态，重复互换恢复原值', async () => {
  const initial = await adapter.loadAdminProviders();
  const swapped = adapter.swapMockProviderRoute(initial, 'demo-route-video');
  assert.equal(swapped.providers, initial.providers); assert.equal(swapped.models, initial.models);
  assert.equal(swapped.routes[0], initial.routes[0]);
  assert.deepEqual(swapped.routes[1], { ...initial.routes[1], primaryProviderId: 'demo-provider-c', backupProviderId: 'demo-provider-b' });
  assert.equal(initial.routes[1].primaryProviderId, 'demo-provider-b');
  assert.deepEqual(adapter.swapMockProviderRoute(swapped, 'demo-route-video'), initial);
  assert.throws(() => adapter.swapMockProviderRoute(initial, 'unknown'), /无效/);
  assert.deepEqual(await adapter.loadAdminProviders(), initial);
});

test('所有内存演示动作拒绝 api 来源，不构成真实写适配', async () => {
  const data = await adapter.loadAdminProviders({ source: 'api' });
  assert.throws(() => adapter.setMockProviderEnabled(data, 'demo-provider-a', false), /仅允许/);
  assert.throws(() => adapter.setMockProviderPriority(data, 'demo-provider-a', 1), /仅允许/);
  assert.throws(() => adapter.swapMockProviderRoute(data, 'demo-route-image'), /仅允许/);
});

test('详情投影可选模型、主备实例与当前角色，未关联为空且随互换更新', async () => {
  const initial = await adapter.loadAdminProviders();
  const routes = adapter.getProviderRoutes(initial, 'demo-provider-b');
  assert.deepEqual(routes.map(row => row.role), ['备用路由', '主路由']);
  assert.equal(routes[0].model.id, 'demo-image-standard');
  assert.equal(routes[0].primary.id, 'demo-provider-a');
  assert.equal(routes[0].backup.id, 'demo-provider-b');
  assert.deepEqual(adapter.getProviderRoutes(initial, 'demo-provider-idle'), []);
  assert.equal(adapter.getProviderRoutes(adapter.swapMockProviderRoute(initial, 'demo-route-image'), 'demo-provider-b')[0].role, '主路由');
});

test('实际 JSX 中文浅色醒目 Mock、固定非实时健康、全部展示列及操作边界', async () => {
  const ui = await ready();
  const html = ui.render().html;
  for (const text of ['演示数据 / Mock，非真实Provider状态', '刷新恢复', '名称 / 稳定 ID', '主备用路由', '优先级', '健康 / 验证（固定演示）', '最近检查（非实时）', '2026-11-19 08:00:00 UTC（固定演示）', '未检查（固定演示）', '不调用真实 API', '不做真实 Provider 调用或网络健康检查', '不持久化', '不读取或展示 Secret、API key、连接信息', '不修改模型目录、任务、账务或价格', '不提供定价功能', '选择一个演示 Provider', 'bg-white']) assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, /type="password"|保存成功|真实写入成功/);
  for (const file of ['components/AdminProviders.js', 'lib/adminProvidersData.js', 'lib/adminProvidersMock.js']) {
    assert.doesNotMatch(read(file), /fetch\s*\(|axios|XMLHttpRequest|WebSocket|localStorage|sessionStorage|indexedDB|document\.cookie|process\.env|lib\/server|adminModels|adminAnalytics|Date\.now|setInterval|https?:\/\//);
  }
  assert.doesNotMatch(read('components/AdminProviders.js'), /demo-provider-a|demo-route-image|demo-image-standard/);
});

test('实际筛选事件、空态、选中详情及关闭，筛选不清除详情', async () => {
  const ui = await ready();
  ui.click('查看路由详情（演示）');
  for (const text of ['demo-provider-a', 'demo-route-image', 'demo-image-standard', '主路由：演示 Provider A', '备用路由：演示 Provider B', '最近检查（非实时）']) assert.ok(ui.detail().includes(text), text);
  ui.change('input', 0, 'DEMO-PROVIDER-C'); ui.change('select', 0, 'false'); ui.change('select', 1, 'demo-video-motion');
  assert.match(ui.render().html, /筛选结果 1 \/ 4 项/);
  assert.equal(ui.state.selectedId, 'demo-provider-a');
  ui.change('select', 1, 'demo-image-standard');
  assert.match(ui.render().html, /没有匹配的演示 Provider/);
  ui.change('input', 0, '未关联'); ui.change('select', 1, 'all');
  ui.click('查看路由详情（演示）');
  assert.match(ui.detail(), /未关联演示路由/);
  ui.click('关闭详情（演示）');
  assert.equal(ui.state.selectedId, null);
  ui.change('input', 0, ''); ui.change('select', 0, 'all');
  assert.match(ui.render().html, /筛选结果 4 \/ 4 项/);
});

test('实际启停先确认可取消，确认只改内存并同步详情，重复确认不二次执行', async () => {
  const ui = await ready(); const initial = ui.state.data;
  ui.click('查看路由详情（演示）'); ui.click('禁用 Provider（仅演示）');
  assert.match(ui.render().html, /确认禁用 Provider（仅演示）/);
  assert.equal(ui.state.data, initial);
  ui.click('取消演示（不修改）'); assert.equal(ui.state.data, initial);
  ui.click('禁用 Provider（仅演示）');
  const confirm = elements(ui.render().tree, el => el.type === 'button' && el.props.children === '确认演示（不保存）')[0];
  confirm.props.onClick(); confirm.props.onClick();
  assert.equal(ui.state.data.providers[0].enabled, false);
  assert.match(ui.detail(), /禁用（演示）/);
  assert.equal(ui.state.data.routes, initial.routes);
  assert.match(ui.render().html, /未保存到服务器；刷新恢复/);
  ui.click('启用 Provider（仅演示）'); ui.click('确认演示（不保存）');
  assert.deepEqual(ui.state.data, initial);
});

test('实际优先级表单校验、预览取消和确认同步详情，不改变主备与健康', async () => {
  const ui = await ready(); const initial = ui.state.data;
  ui.click('查看路由详情（演示）');
  const numberInput = elements(ui.render().tree, el => el.type === 'input' && el.props.type === 'number')[0];
  assert.equal(numberInput.props.min, 1); assert.equal(numberInput.props.max, 100); assert.equal(numberInput.props.step, 1);
  for (const value of ['', '0', '101', '1.5', '1e1']) {
    ui.change('input', 1, value); ui.submit();
    assert.match(ui.detail(), /1–100 的整数/); assert.equal(ui.state.pending, null); assert.equal(ui.state.data, initial);
  }
  ui.change('input', 1, '1'); ui.submit();
  assert.match(ui.render().html, /确认调整优先级（仅演示）/);
  assert.match(ui.render().html, /优先级 10 → 1/);
  assert.equal(ui.state.data, initial);
  ui.click('取消演示（不修改）'); assert.equal(ui.state.data, initial);
  ui.submit(); ui.click('确认演示（不保存）');
  assert.deepEqual(ui.state.data.providers[0], { ...initial.providers[0], priority: 1 });
  assert.match(ui.detail(), /优先级（演示）<\/dt><dd class="mt-1 font-medium">1<\/dd>/);
  assert.equal(ui.state.data.routes, initial.routes);
});

test('实际主备互换先展示影响并确认/取消，重复确认不反向切换，详情实时反映内存', async () => {
  const ui = await ready(); const initial = ui.state.data;
  ui.click('查看路由详情（演示）'); ui.click('互换主/备用（仅演示）');
  assert.match(ui.render().html, /确认主\/备用互换（仅演示）/);
  assert.match(ui.render().html, /主路由 演示 Provider A \/ demo-provider-a → 演示 Provider B \/ demo-provider-b/);
  assert.equal(ui.state.data, initial);
  ui.click('取消演示（不修改）'); assert.equal(ui.state.data, initial);
  ui.click('互换主/备用（仅演示）');
  const confirm = elements(ui.render().tree, el => el.type === 'button' && el.props.children === '确认演示（不保存）')[0];
  confirm.props.onClick(); confirm.props.onClick();
  assert.equal(ui.state.data.routes[0].primaryProviderId, 'demo-provider-b');
  assert.equal(ui.state.data.routes[0].backupProviderId, 'demo-provider-a');
  assert.equal(ui.state.data.providers, initial.providers);
  assert.match(ui.detail(), /主路由：演示 Provider B/); assert.match(ui.detail(), /备用路由：演示 Provider A/);
  assert.match(ui.detail(), /本实例为备用路由/);
  ui.click('互换主/备用（仅演示）'); ui.click('确认演示（不保存）');
  assert.deepEqual(ui.state.data, initial);
});

test('实际页面重新挂载模拟刷新恢复全部 Mock 及筛选、选择和表单状态', async () => {
  const ui = await ready(); const initial = ui.state.data;
  ui.click('查看路由详情（演示）');
  ui.change('input', 1, '99'); ui.submit(); ui.click('确认演示（不保存）');
  ui.click('禁用 Provider（仅演示）'); ui.click('确认演示（不保存）');
  ui.click('互换主/备用（仅演示）'); ui.click('确认演示（不保存）');
  ui.change('input', 0, '演示');
  assert.notDeepEqual(ui.state.data, initial);
  ui.unmount();
  const refreshed = await ready();
  assert.deepEqual(refreshed.state.data, initial);
  assert.equal(refreshed.state.filters.search, '');
  assert.equal(refreshed.state.selectedId, null); assert.equal(refreshed.state.pending, null);
  assert.equal(refreshed.state.priority, ''); assert.equal(refreshed.state.notice, '');
});

for (const outcome of ['ready', 'error', 'unmount']) {
  test(`Provider 加载生命周期 ${outcome} 不提前显示、不泄露错误、卸载后不写状态`, async () => {
    let resolve; let reject;
    const pending = new Promise((yes, no) => { resolve = yes; reject = no; });
    const ui = harness({ '@/lib/adminProvidersData': { ...adapter, loadAdminProviders: () => pending } });
    assert.match(ui.render().html, /正在加载 Mock 演示 Provider/);
    assert.doesNotMatch(ui.render().html, /demo-provider-a/);
    ui.mount();
    if (outcome === 'unmount') ui.unmount();
    if (outcome === 'error') reject(new Error('内部秘密异常'));
    else resolve(await adapter.loadAdminProviders());
    await tick();
    if (outcome === 'ready') assert.match(ui.render().html, /demo-provider-a/);
    if (outcome === 'error') {
      assert.match(ui.render().html, /目录暂时不可用/);
      assert.doesNotMatch(ui.render().html, /demo-provider-a|内部秘密异常/);
    }
    if (outcome === 'unmount') assert.equal(ui.writes, 0);
  });
}
