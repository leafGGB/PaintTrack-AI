'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { transformSync } = require('esbuild');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const modelsAdapter = require('../lib/adminModelsData');
const modules = ['', 'users', 'models', 'providers', 'pricing', 'analytics', 'tasks', 'billing', 'audit', 'settings'];

function apiModel(overrides = {}) {
  return {
    id: 'image.standard.v1', name: '标准图像模型', type: 'image', enabled: true,
    catalogVersion: 3, logicalModelPk: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    capabilities: ['image.generate'], capabilitiesState: 'known', parameterSchemaVersion: 2,
    capabilityTemplate: { key: 'image-default', version: 1 }, bindings: [{
      providerInstanceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      providerModelId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', routeRole: 'primary',
      routeOrder: 1, bindingVersion: 4, active: true,
    }], ...overrides,
  };
}

function apiData(overrides = {}) {
  return {
    source: 'api', mock: false, writesAvailable: false,
    models: [apiModel(), apiModel({ id: 'video.motion.v2', name: '动态视频模型', type: 'video', enabled: false,
      logicalModelPk: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', capabilities: ['video.generate'],
      parameterSchemaVersion: null, capabilityTemplate: null, bindings: [] })],
    nextCursor: 'next-page-token', meta: { requestId: 'request-1', asOf: '2026-11-20T01:30:00.123Z', timeZone: 'UTC' }, ...overrides,
  };
}

function load(file, overrides = {}) {
  const source = transformSync(read(file), { loader: 'jsx', format: 'cjs', jsx: 'automatic' }).code;
  const loaded = { exports: {} };
  vm.runInNewContext('(function(require,module,exports){' + source + '\n})', { AbortController, URLSearchParams, fetch: overrides.fetch, window: {} })((id) => overrides[id] || require(id), loaded, loaded.exports);
  return loaded.exports;
}

function createHarness(pathname = '/admin') {
  const slots = [];
  const effects = [];
  const calls = [];
  let index = 0;
  let writes = 0;
  const hooks = {
    ...React,
    useState(initial) {
      const slot = index++;
      if (!(slot in slots)) slots[slot] = initial;
      return [slots[slot], (value) => { writes++; slots[slot] = typeof value === 'function' ? value(slots[slot]) : value; }];
    },
    useRef(initial) {
      const slot = index++;
      if (!(slot in slots)) slots[slot] = { current: initial };
      return slots[slot];
    },
    useEffect(run) { if (!(index++ in slots)) { slots[index - 1] = true; effects.push(run); } },
  };
  const components = load('components/AdminShell.js', {
    react: hooks,
    'next/navigation': { usePathname: () => pathname },
    fetch: (url, options) => new Promise((resolve, reject) => calls.push({ url, ...options, resolve, reject })),
  });
  return {
    ...components, calls,
    render(basePath = '/admin', children = React.createElement('p', null, '受保护子页面')) {
      index = 0;
      const tree = components.default({ basePath, children });
      return { tree, html: renderToStaticMarkup(tree) };
    },
    mount() { for (const run of effects.splice(0)) this.cleanup = run(); },
    unmount() { this.cleanup?.(); },
    get writes() { return writes; },
  };
}

async function respond(call, status, data = { counts: { users: 7, activeTasks: 2, activeAssets: 5 } }) {
  call.resolve({ ok: status === 200, status, json: async () => ({ data }) });
  await new Promise((resolve) => setImmediate(resolve));
}

function findElement(tree, predicate) {
  if (!tree || typeof tree !== 'object') return null;
  if (predicate(tree)) return tree;
  for (const child of React.Children.toArray(tree.props?.children)) {
    const result = findElement(child, predicate);
    if (result) return result;
  }
  return null;
}

for (const base of ['/admin', '/zh/admin']) {
  for (const slug of modules) {
    test(`${base}${slug ? `/${slug}` : ''} 导航真实链接、中文与唯一 active 状态`, () => {
      const pathname = `${base}${slug ? `/${slug}` : ''}`;
      const { html } = createHarness(pathname).render(base);
      assert.match(html, /管理控制台/);
      assert.match(html, /正在检查管理员会话/);
      assert.doesNotMatch(html, /受保护子页面/);
      assert.equal((html.match(/aria-current="page"/g) || []).length, 1);
      assert.ok(html.includes(`href="${pathname}" aria-current="page"`));
      for (const target of modules) assert.ok(html.includes(`href="${base}${target ? `/${target}` : ''}"`));
      assert.doesNotMatch(html, /href="#|bg-\[#08090b\]/);
    });
  }
}

test('两组路由共用布局，总览与用户页面分离且默认中文', () => {
  for (const [dir, base] of [['app/admin', '/admin'], ['app/zh/admin', '/zh/admin']]) {
    assert.ok(read(`${dir}/layout.js`).includes(`<AdminShell basePath="${base}">`));
    assert.match(read(`${dir}/layout.js`), /force-dynamic/);
    assert.match(read(`${dir}/page.js`), /<AdminOverview \/>/);
    assert.doesNotMatch(read(`${dir}/page.js`), /AdminCenter/);
    assert.match(read(`${dir}/users/page.js`), /<AdminCenter/);
  }
  assert.match(read('components/AdminCenter.js'), /locale = 'zh'/);
  assert.match(read('app/zh/admin/[module]/page.js'), /@\/app\/admin\/\[module\]\/page/);
});

test('analytics/models/providers/pricing 使用独立组件，其余四个未接模块保留占位，未知模块返回 notFound', async () => {
  const Analytics = () => null;
  const Models = () => null;
  const Providers = () => null;
  const Pricing = () => null;
  const Pending = () => null;
  const Page = load('app/admin/[module]/page.js', {
    'next/navigation': { notFound() { throw new Error('NOT_FOUND'); } },
    '@/components/AdminShell': { AdminPendingPage: Pending },
    '@/components/AdminAnalytics': { default: Analytics, __esModule: true },
    '@/components/AdminModels': { default: Models, __esModule: true },
    '@/components/AdminProviders': { default: Providers, __esModule: true },
    '@/components/AdminPricing': { default: Pricing, __esModule: true },
  }).default;
  for (const slug of modules.slice(2)) {
    const element = await Page({ params: Promise.resolve({ module: slug }) });
    if (['analytics', 'models', 'providers', 'pricing'].includes(slug)) {
      assert.equal(element.type, { analytics: Analytics, models: Models, providers: Providers, pricing: Pricing }[slug]);
      continue;
    }
    assert.equal(element.type, Pending);
    assert.equal(element.props.module, slug);
    const harness = createHarness();
    const html = renderToStaticMarkup(React.createElement(harness.AdminPendingPage, { module: slug }));
    assert.match(html, /尚未开放/);
    assert.match(html, /不提供模拟数据/);
  }
  for (const slug of ['unknown', 'operations', 'users', '']) await assert.rejects(Page({ params: Promise.resolve({ module: slug }) }), /NOT_FOUND/);
});

for (const status of [401, 403, 503, 'network-error']) {
  test(`共享门禁 ${status} 不渲染受保护数据，主状态保持浅色`, async () => {
    const harness = createHarness('/admin/users');
    harness.render();
    harness.mount();
    assert.equal(harness.calls.length, 1);
    assert.equal(harness.calls[0].url, '/api/admin/summary');
    assert.equal(harness.calls[0].cache, 'no-store');
    assert.equal(harness.calls[0].credentials, 'same-origin');
    if (status === 'network-error') {
      harness.calls[0].reject(new Error('不应展示的资料'));
      await new Promise((resolve) => setImmediate(resolve));
    } else await respond(harness.calls[0], status, { secret: '不应展示的资料' });
    const { html } = harness.render();
    assert.doesNotMatch(html, /受保护子页面|不应展示的资料/);
    assert.match(html, status === 503 || status === 'network-error' ? /后台暂时不可用/ : /必须登录管理员账户并完成 MFA/);
    assert.match(html, /bg-slate-50/);
    assert.match(html, /bg-white/);
    assert.doesNotMatch(html, /bg-\[#08090b\]/);
  });
}

for (const base of ['/admin', '/zh/admin']) {
  for (const status of [200, 401, 403, 503, 'network-error']) {
    test(`${base}/analytics 在 summary ${status} 时保留真实展示门禁，不因 mock 绕过`, async () => {
      const adapter = require('../lib/adminAnalyticsData');
      const { AdminAnalyticsView } = load('components/AdminAnalytics.js', { '@/lib/adminAnalyticsData': adapter });
      const child = React.createElement(AdminAnalyticsView, { data: await adapter.loadAdminAnalytics() });
      const harness = createHarness(`${base}/analytics`);
      assert.doesNotMatch(harness.render(base, child).html, /演示数据 \/ Mock|模型任务数排名/);
      harness.mount();
      if (status === 'network-error') {
        harness.calls[0].reject(new Error('内部数据库故障'));
        await new Promise(resolve => setImmediate(resolve));
      } else await respond(harness.calls[0], status);
      const html = harness.render(base, child).html;
      if (status === 200) assert.match(html, /演示数据 \/ Mock，非真实运营结果/);
      else assert.doesNotMatch(html, /演示数据 \/ Mock|模型任务数排名|内部数据库故障/);
      assert.equal(harness.calls.length, 1);
      assert.equal(harness.calls[0].url, '/api/admin/summary');
    });
  }
}

for (const base of ['/admin', '/zh/admin']) {
  test(`${base}/models 通过真实 API shape 注入模型页，summary 只负责后台门禁`, async () => {
    const { AdminModelsView } = load('components/AdminModels.js', { '@/lib/adminModelsData': modelsAdapter });
    const state = {
      status: 'ready', data: apiData(), filters: { search: '', type: 'all', enabled: 'all' },
      selectedId: null, query: { q: '', type: 'all', enabled: 'all', limit: 20 }, cursors: [null], page: 0,
    };
    const child = React.createElement(AdminModelsView, { state, setState() {} });
    const harness = createHarness(`${base}/models`);
    const initial = harness.render(base, child).html;
    assert.doesNotMatch(initial, /标准图像模型|image\.standard\.v1|动态视频模型|隔离演示|demo-image-standard|演示数据 \/ Mock/);
    harness.mount();
    await respond(harness.calls[0], 200, { counts: { users: 7, activeTasks: 2, activeAssets: 5 } });
    const html = harness.render(base, child).html;
    assert.match(html, /标准图像模型/);
    assert.match(html, /image\.standard\.v1/);
    assert.doesNotMatch(html, /隔离演示|demo-image-standard|演示数据 \/ Mock/);
    assert.equal(harness.calls[0].url, '/api/admin/summary');
  });
}

for (const base of ['/admin', '/zh/admin']) {
  for (const status of [200, 401, 403, 503, 'network-error']) {
    test(`${base}/providers 在 summary ${status} 时保留真实门禁，拒绝与故障不回退 Mock`, async () => {
      const adapter = require('../lib/adminProvidersData');
      const { AdminProvidersView } = load('components/AdminProviders.js', { '@/lib/adminProvidersData': adapter });
      const state = { status: 'ready', data: await adapter.loadAdminProviders(), filters: {}, priority: '', error: '' };
      const child = React.createElement(AdminProvidersView, { state, setState() {} });
      const harness = createHarness(`${base}/providers`);
      assert.doesNotMatch(harness.render(base, child).html, /隔离演示|demo-provider-a/);
      harness.mount();
      if (status === 'network-error') {
        harness.calls[0].reject(new Error('内部 Provider 故障'));
        await new Promise(resolve => setImmediate(resolve));
      } else await respond(harness.calls[0], status);
      const html = harness.render(base, child).html;
      if (status === 200) assert.match(html, /演示数据 \/ Mock，非真实Provider状态/);
      else assert.doesNotMatch(html, /隔离演示|demo-provider-a|内部 Provider 故障/);
      assert.equal(harness.calls.length, 1);
      assert.equal(harness.calls[0].url, '/api/admin/summary');
    });
  }
}

for (const base of ['/admin', '/zh/admin']) {
  for (const status of [200, 401, 403, 503, 'network-error']) {
    test(`${base}/pricing 在 summary ${status} 时保留真实门禁，拒绝与故障不回退 Mock`, async () => {
      const adapter = require('../lib/adminPricingData');
      const { AdminPricingView } = load('components/AdminPricing.js', { '@/lib/adminPricingData': adapter });
      const result = await adapter.createAdminPricingGateway().read();
      const state = { status: 'ready', data: result.data, meta: result.meta, modelId: 'all', form: {}, error: '' };
      const child = React.createElement(AdminPricingView, { state, setState() {} });
      const harness = createHarness(`${base}/pricing`);
      assert.doesNotMatch(harness.render(base, child).html, /非真实定价|demo-price-image/);
      harness.mount();
      if (status === 'network-error') {
        harness.calls[0].reject(new Error('内部定价故障'));
        await new Promise(resolve => setImmediate(resolve));
      } else await respond(harness.calls[0], status);
      const html = harness.render(base, child).html;
      if (status === 200) assert.match(html, /演示数据 \/ Mock，非真实定价/);
      else assert.doesNotMatch(html, /非真实定价|demo-price-image|内部定价故障/);
      assert.equal(harness.calls.length, 1);
      assert.equal(harness.calls[0].url, '/api/admin/summary');
    });
  }
}

test('仅汇总成功后挂载子页面，总览显示真实计数与用户链接', async () => {
  const harness = createHarness('/zh/admin');
  harness.render('/zh/admin');
  harness.mount();
  await respond(harness.calls[0], 200);
  const { html } = harness.render('/zh/admin', React.createElement(harness.AdminOverview));
  assert.match(html, /当前快照/);
  for (const count of [7, 2, 5]) assert.ok(html.includes(`>${count}</p>`));
  assert.match(html, /href="\/zh\/admin\/users"/);
  assert.match(html, /日期筛选尚未开放/);
  assert.equal(harness.calls.length, 1);
  assert.doesNotMatch(html, /person@example|精确邮箱.*<input/);
});

test('共享汇总重试清除旧数据，卸载取消请求并忽略延迟响应', async () => {
  const harness = createHarness();
  harness.render();
  harness.mount();
  await respond(harness.calls[0], 503);
  const retry = findElement(harness.render().tree, (element) => element.type === 'button' && element.props.children === '重试');
  assert.ok(retry);
  retry.props.onClick();
  assert.match(harness.render().html, /正在检查管理员会话/);
  assert.equal(harness.calls[0].signal.aborted, true);
  const writes = harness.writes;
  harness.unmount();
  assert.equal(harness.calls[1].signal.aborted, true);
  await respond(harness.calls[1], 200);
  assert.equal(harness.writes, writes);
  assert.doesNotMatch(harness.render().html, /受保护子页面/);
});

function apiEnvelope() {
  return {
    ok: true, data: { models: [{
      logicalModelId: 'image.standard.v1', logicalModelPk: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      logicalModelVersion: 3, catalogVersion: 3, displayName: '标准图像模型', type: 'image', enabled: true,
      capabilities: ['image.generate'], capabilitiesState: 'known', parameterSchemaVersion: 2,
      capabilityTemplate: { key: 'image-default', version: 1 }, bindings: { readable: true, data: [{
        providerInstanceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', providerModelId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        routeRole: 'primary', routeOrder: 1, bindingVersion: 4, active: true,
      }] }, pricing: { readable: false, reason: 'NOT_AUTHORIZED', data: null },
      unknown: '不得透传',
    }], nextCursor: null }, error: null,
    meta: { source: 'api', mock: false, writesAvailable: false, contractVersion: 'admin_models_read_v1', timeZone: 'UTC', scope: 'current_admin_catalog',
      asOf: '2026-11-20T01:30:00.123Z', requestId: 'request-1', orderBy: ['logicalModelId:C:asc', 'logicalModelPk:asc'], capabilities: { catalogRead: true, bindingsRead: true, pricingRead: false, historyRead: false } }, requestId: 'request-1',
  };
}

test('真实模型 gateway 拒绝坏 DTO 矩阵，不回退 Mock 或放宽读取契约', async () => {
  const cases = [
    ['错误来源', body => { body.meta.source = 'mock'; }],
    ['错误排序', body => { body.meta.orderBy.reverse(); }],
    ['多余排序', body => { body.meta.orderBy.push('displayName:asc'); }],
    ['请求标识不一致', body => { body.requestId = 'other-request'; }],
    ['错误元数据权限', body => { body.meta.capabilities.pricingRead = true; }],
    ['非法游标', body => { body.data.nextCursor = 'bad cursor'; }],
    ['模型 UUID 无效', body => { body.data.models[0].logicalModelPk = 'invalid'; }],
    ['版本不一致', body => { body.data.models[0].logicalModelVersion += 1; }],
    ['错误能力类型', body => { body.data.models[0].capabilities = ['video.generate']; }],
    ['能力状态不一致', body => { body.data.models[0].capabilitiesState = 'unsupported'; }],
    ['重复模型', body => { body.data.models.push(structuredClone(body.data.models[0])); }],
    ['重复模型 UUID', body => { body.data.models.push({ ...structuredClone(body.data.models[0]), logicalModelId: 'image.other.v1' }); }],
    ['非法模板版本', body => { body.data.models[0].capabilityTemplate.version = 0; }],
    ['绑定 UUID 无效', body => { body.data.models[0].bindings.data[0].providerModelId = 'invalid'; }],
    ['绑定角色无效', body => { body.data.models[0].bindings.data[0].routeRole = 'fallback'; }],
    ['绑定顺序无效', body => { body.data.models[0].bindings.data[0].routeOrder = 0; }],
    ['绑定版本无效', body => { body.data.models[0].bindings.data[0].bindingVersion = 0; }],
    ['绑定启用状态无效', body => { body.data.models[0].bindings.data[0].active = 'true'; }],
    ['价格越权数据', body => { body.data.models[0].pricing.data = {}; }],
  ];
  for (const [label, mutate] of cases) {
    const envelope = apiEnvelope();
    mutate(envelope);
    const gateway = modelsAdapter.createAdminModelsGateway({ transport: async () => envelope });
    await assert.rejects(gateway.read(), { message: 'ADMIN_MODELS_DATA_INVALID' }, label);
  }
});

test('模型 gateway 使用真实 envelope，验证元数据、版本和 UUID 绑定并克隆安全字段', async () => {
  const envelope = apiEnvelope();
  const gateway = modelsAdapter.createAdminModelsGateway({ transport: async () => envelope });
  const result = await gateway.read({ q: '标准' });
  assert.deepEqual(result, { source: 'api', mock: false, writesAvailable: false, models: [{
    id: 'image.standard.v1', name: '标准图像模型', type: 'image', enabled: true, catalogVersion: 3,
    logicalModelPk: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', capabilities: ['image.generate'], capabilitiesState: 'known', parameterSchemaVersion: 2,
    capabilityTemplate: { key: 'image-default', version: 1 }, bindings: [{ providerInstanceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', providerModelId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', routeRole: 'primary', routeOrder: 1, bindingVersion: 4, active: true }],
  }], nextCursor: null, meta: { requestId: 'request-1', asOf: '2026-11-20T01:30:00.123Z', timeZone: 'UTC' } });
  envelope.data.models[0].capabilities.push('image.edit');
  envelope.data.models[0].bindings.data[0].active = false;
  assert.equal(result.models[0].capabilities.length, 1);
  assert.equal(result.models[0].bindings[0].active, true);
});

test('模型 transport 安全序列化筛选，固定 GET credentials/cache/redirect/signal，非 2xx 不解析原始异常', async () => {
  const calls = [];
  const signal = { aborted: false };
  const body = { ok: true };
  const result = await modelsAdapter.readAdminModelsApi({ q: 'a%_ b', type: 'image', enabled: 'false', limit: 20, cursor: 'cursor-x' }, {
    signal, fetcher: async (url, options) => { calls.push({ url, options }); return { ok: true, json: async () => body }; },
  });
  assert.equal(result, body);
  assert.equal(calls[0].url, '/api/admin/models?q=a%25_+b&type=image&enabled=false&limit=20&cursor=cursor-x');
  assert.deepEqual(calls[0].options, { method: 'GET', credentials: 'same-origin', cache: 'no-store', signal, redirect: 'error' });
  await assert.rejects(modelsAdapter.readAdminModelsApi({}, { fetcher: async () => ({ ok: false, status: 503, json: async () => { throw new Error('原始秘密'); } }) }), error => error.status === 503 && error.message === 'ADMIN_MODELS_UNAVAILABLE');
});

test('用户只读组件不再拉汇总且列表错误和详情错误均为浅色', () => {
  const source = read('components/AdminCenter.js');
  assert.doesNotMatch(source, /api\/admin\/summary|bg-\[#08090b\]|text-white\//);
  assert.match(source, /users\.status === 'error'/);
  assert.match(source, /detail\.status === 'error'/);
  assert.match(source, /border-slate-200 bg-white/);
  assert.doesNotMatch(read('components/AdminShell.js'), /\/api\/admin\/(?:models|pricing|analytics|providers|tasks|billing|audit|settings)/);
});
