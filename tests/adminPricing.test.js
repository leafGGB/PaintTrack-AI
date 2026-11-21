'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { transformSync } = require('esbuild');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const data = require('../lib/adminPricingData');
const mock = require('../lib/adminPricingMock');
const { preparePricingVersion } = require('../lib/server/tasks/pricingQuote');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const draft = (changes = {}) => ({ action: 'createDraft', modelId: 'demo-price-image', pricingVersion: 'new-v1', effectiveFrom: '2026-11-22T00:00:00Z', unitPriceTenths: '17', ...changes });
const lifecycle = (action, pricingVersion, modelId = 'demo-price-image') => ({ action, modelId, pricingVersion });
const apiMeta = { source: 'api', mock: false, writesAvailable: true };
function apiResult() { const raw = mock.readAdminPricingMock(); raw.clock.fixed = false; return { ok: true, data: raw, error: null, meta: apiMeta }; }
function elements(tree, predicate) {
  if (!tree || typeof tree !== 'object') return [];
  return [...(predicate(tree) ? [tree] : []), ...React.Children.toArray(tree.props?.children).flatMap(child => elements(child, predicate))];
}
function harness(gateway) {
  const slots = []; const effects = []; let index = 0; let writes = 0;
  const hooks = { ...React,
    useState(initial) { const i = index++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], next => { writes++; slots[i] = typeof next === 'function' ? next(slots[i]) : next; }]; },
    useRef(initial) { const i = index++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; },
    useEffect(run) { const i = index++; if (!(i in slots)) { slots[i] = true; effects.push(run); } },
  };
  const loaded = { exports: {} };
  const code = transformSync(read('components/AdminPricing.js'), { loader: 'jsx', format: 'cjs', jsx: 'automatic' }).code;
  vm.runInNewContext('(function(require,module,exports){' + code + '\n})', { AbortController })(id => id === 'react' ? hooks : id === '@/lib/adminPricingData' ? data : require(id), loaded, loaded.exports);
  return {
    render() { index = 0; const child = loaded.exports.default({ gateway }); const tree = child.type(child.props); return { tree, html: renderToStaticMarkup(tree) }; },
    mount() { for (const run of effects.splice(0)) this.cleanup = run(); }, unmount() { this.cleanup?.(); },
    click(label, at = 0) { const el = elements(this.render().tree, el => el.type === 'button' && React.Children.toArray(el.props.children).join('') === label)[at]; assert.ok(el, label); assert.ok(!el.props.disabled, label); return el.props.onClick(); },
    change(type, at, value) { const el = elements(this.render().tree, el => el.type === type)[at]; el.props.onChange({ target: { value } }); },
    submit() { elements(this.render().tree, el => el.type === 'form')[0].props.onSubmit({ preventDefault() {} }); },
    get state() { return slots[1]; }, get writes() { return writes; },
  };
}
async function ready(gateway) { const ui = harness(gateway); ui.render(); ui.mount(); await tick(); return ui; }
function fill(ui, changes = {}) {
  ui.change('select', 1, changes.modelId || 'demo-price-image');
  ui.change('input', 0, changes.pricingVersion || 'new-ui');
  ui.change('input', 1, changes.amount ?? '1.7');
  ui.change('input', 2, changes.effectiveFrom || '2026-11-22T00:00:00Z');
}

test('读取与命令统一结果契约、能力元数据、独立可复制DTO及固定演示时钟', async () => {
  const gateway = data.createAdminPricingGateway();
  const initial = await gateway.read();
  assert.deepEqual(initial.meta, { source: 'mock', mock: true, writesAvailable: true, contractVersion: 'admin_pricing_v1' });
  assert.deepEqual(Object.keys(initial), ['ok', 'data', 'error', 'meta']);
  assert.equal(initial.data.clock.asOf, '2026-11-19T08:00:00Z');
  assert.equal(initial.data.clock.fixed, true);
  assert.equal(initial.data.models.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(initial)), initial);
  const changed = await gateway.command(draft());
  assert.deepEqual(Object.keys(changed), Object.keys(initial));
  assert.equal(changed.data.versions.length, initial.data.versions.length + 1);
  changed.data.versions[0].config.resolutions[0].unitPriceTenths = '0';
  assert.equal((await gateway.read()).data.versions[0].config.resolutions[0].unitPriceTenths, '7');
  assert.deepEqual((await data.createAdminPricingGateway().read()).data, initial.data);
});

test('Mock投影的真实配置与pricing校验兼容，不伪造Unix时间戳或默认商业金额', () => {
  for (const row of mock.readAdminPricingMock().versions) {
    const prepared = preparePricingVersion({ config: row.config, publishedAtUs: '0', effectiveFromUs: '1000000', cancelledAtUs: null, revokedAtUs: null });
    assert.deepEqual(prepared.config, row.config);
  }
  assert.match(read('lib/adminPricingMock.js'), /虚构测试值/);
});

test('纯异步transport可替换读取和commands，参数/返回隔离且转交AbortSignal', async () => {
  const calls = [];
  const transport = { meta: apiMeta,
    async read(input, options) { calls.push({ input, options }); return apiResult(); },
    async command(input, options) { calls.push({ input, options }); input.pricingVersion = 'transport-change'; return apiResult(); },
  };
  const gateway = data.createAdminPricingGateway({ transport }); const controller = new AbortController();
  assert.equal((await gateway.read({}, { signal: controller.signal })).meta.mock, false);
  const command = draft(); assert.equal((await gateway.command(command, { signal: controller.signal })).ok, true);
  assert.equal(command.pricingVersion, 'new-v1'); assert.equal(calls.length, 2);
  assert.equal(calls[1].options.signal, controller.signal);
});

test('错误统一脱敏不fallback，非法契约/来源拒绝，不隐式构造Mock', async () => {
  for (const [readFn, code] of [
    [async () => { throw new Error('合成内部秘密'); }, 'TRANSPORT_FAILED'],
    [async () => ({ ...apiResult(), data: {} }), 'CONTRACT_INVALID'],
    [async () => ({ ...apiResult(), meta: { source: 'mock', mock: true, writesAvailable: true } }), 'SOURCE_MISMATCH'],
    [async () => ({ ...apiResult(), ok: false, data: null, error: { code: 'VERSION_CONFLICT', message: '内部秘密' } }), 'VERSION_CONFLICT'],
  ]) {
    const result = await data.createAdminPricingGateway({ transport: { meta: apiMeta, read: readFn } }).read();
    assert.equal(result.ok, false); assert.equal(result.data, null); assert.equal(result.error.code, code);
    assert.doesNotMatch(JSON.stringify(result), /内部秘密|demo-price-image/);
  }
  assert.throws(() => data.createAdminPricingGateway({ transport: null }), /契约无效/);
});

test('只读能力阻止命令；Mock命令不能作为api transport调用或包装后调用', async () => {
  let calls = 0;
  const readonly = data.createAdminPricingGateway({ transport: { meta: { ...apiMeta, writesAvailable: false }, read: async () => ({ ...apiResult(), meta: { ...apiMeta, writesAvailable: false } }), command() { calls++; } } });
  assert.equal((await readonly.command(draft())).error.code, 'WRITES_UNAVAILABLE'); assert.equal(calls, 0);
  const transport = mock.createAdminPricingMockTransport(); const before = await transport.read({});
  const api = data.createAdminPricingGateway({ transport: { ...transport, meta: apiMeta } });
  assert.equal((await api.command(draft())).error.code, 'SOURCE_MISMATCH');
  assert.deepEqual(await transport.read({}), before);
});

test('AbortSignal提前取消零调用，延迟读取取消拒绝结果，Mock取消命令零变更', async () => {
  let calls = 0; let resolve;
  const gateway = data.createAdminPricingGateway({ transport: { meta: apiMeta, read() { calls++; return new Promise(yes => { resolve = yes; }); } } });
  const first = new AbortController(); first.abort();
  assert.equal((await gateway.read({}, { signal: first.signal })).error.code, 'ABORTED'); assert.equal(calls, 0);
  const second = new AbortController(); const pending = gateway.read({}, { signal: second.signal }); second.abort(); resolve(apiResult());
  assert.equal((await pending).error.code, 'ABORTED');
  const local = data.createAdminPricingGateway(); const before = await local.read();
  assert.equal((await local.command(draft(), { signal: first.signal })).error.code, 'ABORTED'); assert.deepEqual(await local.read(), before);
});

test('金额只接受最多一位小数，用BigInt精确转换，含零/上限与超界', () => {
  for (const [raw, expected] of [['0', '0'], ['0.1', '1'], ['1.0', '10'], [' 12.3 ', '123'], ['900719925474099.1', '9007199254740991']]) {
    assert.equal(data.parsePricingAmount(raw), expected);
    assert.equal(data.formatPricingTenths(expected), `${BigInt(expected) / 10n}.${BigInt(expected) % 10n}`);
  }
  for (const raw of ['', ' ', null, 1, true, '-0', '-1', '+1', '01', '.1', '1.', '1.01', '1e2', 'Infinity', '900719925474099.2']) assert.throws(() => data.parsePricingAmount(raw), /金额/);
  for (const raw of ['01', '-1', '1.1', 7, '9007199254740992']) assert.throws(() => data.formatPricingTenths(raw), /金额/);
});

test('草稿/发布/取消追加历史且取消未来版不影响当前头，新gateway恢复', async () => {
  const gateway = data.createAdminPricingGateway(); const before = (await gateway.read()).data;
  const created = await gateway.command(draft()); assert.equal(created.ok, true);
  assert.equal(data.versionStatus(created.data.versions.at(-1), created.data.clock.asOf), 'draft');
  assert.equal(data.selectPricingHead(created.data, 'demo-price-image').head.config.pricingVersion, 'demo-v2');
  const published = await gateway.command(lifecycle('publish', 'new-v1')); assert.equal(published.ok, true);
  assert.equal(data.versionStatus(published.data.versions.at(-1), published.data.clock.asOf), 'scheduled');
  const cancelled = await gateway.command(lifecycle('cancel', 'new-v1')); assert.equal(cancelled.ok, true);
  assert.equal(data.versionStatus(cancelled.data.versions.at(-1), cancelled.data.clock.asOf), 'cancelled');
  assert.deepEqual(cancelled.data.versions.slice(0, before.versions.length), before.versions);
  assert.equal(data.selectPricingHead(cancelled.data, 'demo-price-image').head.config.pricingVersion, 'demo-v2');
  assert.deepEqual((await data.createAdminPricingGateway().read()).data, before);
});

test('撤销最新已生效头不回退旧价，已撤销演示模型无可用头', async () => {
  const gateway = data.createAdminPricingGateway(); const before = (await gateway.read()).data;
  assert.equal(data.selectPricingHead(before, 'demo-price-video').available, false);
  const result = await gateway.command(lifecycle('revoke', 'demo-v2'));
  assert.equal(result.ok, true);
  const head = data.selectPricingHead(result.data, 'demo-price-image');
  assert.equal(head.head.config.pricingVersion, 'demo-v2'); assert.equal(head.available, false);
  assert.deepEqual(result.data.versions[0], before.versions[0]);
});

test('未来生效点以固定演示时钟校验、严格整秒与日期、重名/同秒及失败均不变更', async () => {
  const gateway = data.createAdminPricingGateway();
  for (const command of [draft({ effectiveFrom: '2026-11-19T08:00:00Z' }), draft({ effectiveFrom: '2026-11-18T00:00:00Z' }),
    draft({ effectiveFrom: '2026-11-30T00:00:00.001Z' }), draft({ effectiveFrom: '2026-11-31T00:00:00Z' }),
    draft({ unitPriceTenths: '1.2' }), draft({ modelId: 'unknown' }), draft({ pricingVersion: 'demo-v1' }),
    lifecycle('cancel', 'demo-v2'), lifecycle('revoke', 'demo-v3'), lifecycle('publish', 'demo-v1'), lifecycle('revoke', 'demo-cancelled'), lifecycle('restore', 'demo-v1')]) {
    const before = await gateway.read(); assert.equal((await gateway.command(command)).ok, false); assert.deepEqual(await gateway.read(), before);
  }
  assert.equal((await gateway.command(draft({ effectiveFrom: '2026-11-20T00:00:00Z' }))).ok, true);
  const before = await gateway.read(); assert.equal((await gateway.command(lifecycle('publish', 'new-v1'))).error.code, 'VERSION_CONFLICT'); assert.deepEqual(await gateway.read(), before);
});

test('未来整秒等号边界只用固定时钟，草稿命令拒绝伪造clock/source和额外配置', async () => {
  const gateway = data.createAdminPricingGateway(); const snapshot = (await gateway.read()).data;
  const form = { modelId: 'demo-price-image', pricingVersion: 'next-second', amount: '0.1', effectiveFrom: '2026-11-19T08:00:01Z' };
  assert.equal(data.preparePricingDraft(snapshot, form).unitPriceTenths, '1');
  assert.throws(() => data.preparePricingDraft(snapshot, { ...form, effectiveFrom: snapshot.clock.asOf }), /时钟/);
  assert.equal((await gateway.command(draft({ effectiveFrom: form.effectiveFrom }))).ok, true);
  for (const extra of [{ source: 'api' }, { clock: { asOf: '2026-01-01T00:00:00Z' } }, { config: {} }]) {
    const before = await gateway.read(); assert.equal((await gateway.command({ ...draft({ pricingVersion: 'extra' }), ...extra })).error.code, 'INPUT_INVALID'); assert.deepEqual(await gateway.read(), before);
  }
});

test('API命令业务失败/结构失败不回退或改现有快照，失败码与读取使用同一契约', async () => {
  for (const response of [
    { ...apiResult(), ok: false, data: null, error: { code: 'LIFECYCLE_INVALID', message: '合成内部秘密' } },
    { ...apiResult(), data: {} },
  ]) {
    const gateway = data.createAdminPricingGateway({ transport: { meta: apiMeta, read: async () => apiResult(), command: async () => response } });
    const before = await gateway.read(); const result = await gateway.command(lifecycle('revoke', 'demo-v2'));
    assert.equal(result.ok, false); assert.equal(result.data, null); assert.deepEqual(result.meta, before.meta);
    assert.doesNotMatch(JSON.stringify(result), /合成内部秘密|demo-price/); assert.deepEqual(await gateway.read(), before);
  }
});

test('纯投影不读取额外秘密字段，拒绝非法模型/模板/金额/生命周期', () => {
  const raw = mock.readAdminPricingMock();
  for (const row of [raw, raw.clock, ...raw.models, ...raw.versions, raw.versions[0].config, raw.versions[0].config.resolutions[0]]) Object.defineProperty(row, 'secret', { enumerable: true, get() { throw new Error('不得访问'); } });
  assert.doesNotMatch(JSON.stringify(data.adaptSnapshot(raw)), /secret/);
  for (const mutate of [raw => { raw.models.push(raw.models[0]); }, raw => { raw.versions.push(raw.versions[0]); }, raw => { raw.versions[0].config.quantityMode = 'tiered_total'; }, raw => { raw.versions[0].config.resolutions[0].unitPriceTenths = '1.1'; }, raw => { raw.versions[0].publishedAt = undefined; }, raw => { raw.versions[0].cancelledAt = '2026-11-19T08:00:00Z'; }]) {
    const input = mock.readAdminPricingMock(); mutate(input); assert.throws(() => data.adaptSnapshot(input));
  }
});

test('实际JSX中文浅色Mock、固定时钟、影响范围、图片/视频详情与组合模型筛选', async () => {
  const ui = await ready(); const html = ui.render().html;
  for (const text of ['演示数据 / Mock，非真实定价', '固定演示时钟（永不推进，非实时）', '2026-11-19T08:00:00Z', '不改历史报价、不收费', '版本列表 / 时间轴', '不自动回退旧版', 'step-up', '未实现这些安全门禁', 'bg-white']) assert.ok(html.includes(text), text);
  assert.equal(ui.state.form.amount, '');
  ui.change('select', 0, 'demo-price-video'); ui.click('查看价格与单位', 0);
  for (const text of ['video_duration_fps', 'credit / 秒', '[1, 3000) ms', '30 fps：系数 3/2', '最终向上取整']) assert.ok(ui.render().html.includes(text), text);
  assert.doesNotMatch(renderToStaticMarkup(elements(ui.render().tree, el => el.props['aria-label'] === '定价版本时间轴')[0]), /demo-price-image/);
  ui.change('select', 0, 'demo-price-image'); ui.click('查看价格与单位', 0);
  assert.match(ui.render().html, /credit \/ 张/); assert.match(ui.render().html, /maxOutputCount=1/);
  ui.click('关闭详情'); assert.equal(ui.state.selected, '');
  ui.change('select', 0, 'unknown'); assert.match(ui.render().html, /没有匹配的定价版本/);
});

test('实际草稿表单校验/预览取消/确认发布，重复确认只执行一次，重新挂载恢复', async () => {
  const ui = await ready(); const before = ui.state.data;
  fill(ui, { amount: '1.01' }); ui.submit(); assert.match(ui.render().html, /最多一位小数/); assert.equal(ui.state.pending, null);
  fill(ui); ui.submit(); assert.equal(ui.state.data, before); assert.match(ui.render().html, /统一档位单价：1.7 credit/);
  ui.click('取消预览'); assert.equal(ui.state.data, before);
  ui.submit(); const confirm = elements(ui.render().tree, el => el.type === 'button' && el.props.children === '确认操作')[0];
  await Promise.all([confirm.props.onClick(), confirm.props.onClick()]);
  assert.equal(ui.state.data.versions.length, before.versions.length + 1);
  await confirm.props.onClick(); assert.equal(ui.state.data.versions.length, before.versions.length + 1);
  ui.click('发布版本'); assert.equal(ui.state.data.versions.at(-1).publishedAt, null); await ui.click('确认操作');
  assert.equal(ui.state.data.versions.at(-1).publishedAt, before.clock.asOf);
  assert.match(ui.render().html, /仅演示：本页内存已更新/);
  ui.unmount(); assert.deepEqual((await ready()).state.data, before);
});

test('实际取消未生效/撤销已生效均预览可取消，撤销最新头无回退', async () => {
  const ui = await ready(); ui.change('select', 0, 'demo-price-image'); const before = ui.state.data;
  ui.click('取消未生效版本'); ui.click('取消预览'); assert.equal(ui.state.data, before);
  ui.click('取消未生效版本'); await ui.click('确认操作');
  assert.equal(ui.state.data.versions.find(row => row.config.pricingVersion === 'demo-v3').cancelledAt, before.clock.asOf);
  ui.click('撤销已生效版本', 0); ui.click('取消预览'); assert.equal(data.selectPricingHead(ui.state.data, 'demo-price-image').available, true);
  ui.click('撤销已生效版本', 0); await ui.click('确认操作');
  assert.equal(data.selectPricingHead(ui.state.data, 'demo-price-image').available, false);
  assert.match(ui.render().html, /无可用版本（不回退旧版）/);
});

test('实际UI通过注入API gateway执行，不绑定Mock；命令失败不改数据且不显示内部错误', async () => {
  let commands = 0;
  const gateway = data.createAdminPricingGateway({ transport: { meta: apiMeta, read: async () => apiResult(), command: async () => { commands++; throw new Error('内部秘密'); } } });
  const ui = await ready(gateway); assert.match(ui.render().html, /API 数据源/); assert.doesNotMatch(ui.render().html, /演示数据 \/ Mock，非真实定价/);
  const before = ui.state.data; fill(ui); ui.submit(); ui.click('取消预览'); assert.equal(commands, 0);
  ui.submit(); await ui.click('确认操作'); assert.equal(commands, 1); assert.equal(ui.state.data, before);
  assert.match(ui.render().html, /TRANSPORT_FAILED/); assert.doesNotMatch(ui.render().html, /内部秘密|本页内存已更新/);
});

test('异步UI只读能力隐藏写入、读取失败无fallback、卸载中止并忽略迟到响应', async () => {
  const readonly = data.createAdminPricingGateway({ transport: { meta: { ...apiMeta, writesAvailable: false }, read: async () => ({ ...apiResult(), meta: { ...apiMeta, writesAvailable: false } }) } });
  const ui = await ready(readonly); assert.match(ui.render().html, /此数据源未开放命令/);
  const write = elements(ui.render().tree, el => el.type === 'button' && el.props.children === '预览新增草稿')[0]; assert.equal(write.props.disabled, true);
  const failed = await ready(data.createAdminPricingGateway({ transport: { meta: apiMeta, read: async () => { throw new Error('内部秘密'); } } }));
  assert.match(failed.render().html, /未回退到 Mock/); assert.doesNotMatch(failed.render().html, /demo-price|内部秘密/);
  let resolve; let signal;
  const pending = data.createAdminPricingGateway({ transport: { meta: apiMeta, read(input, options) { signal = options.signal; return new Promise(yes => { resolve = yes; }); } } });
  const late = harness(pending); assert.match(late.render().html, /正在加载/); late.mount(); const writes = late.writes; late.unmount(); assert.equal(signal.aborted, true); resolve(apiResult()); await tick(); assert.equal(late.writes, writes);
});

test('命令在途重复点击阻止、卸载后迟到命令不写UI状态', async () => {
  let resolve; let signal; let calls = 0;
  const gateway = data.createAdminPricingGateway({ transport: { meta: apiMeta, read: async () => apiResult(), command(input, options) { calls++; signal = options.signal; return new Promise(yes => { resolve = yes; }); } } });
  const ui = await ready(gateway); fill(ui); ui.submit();
  const confirm = elements(ui.render().tree, el => el.type === 'button' && el.props.children === '确认操作')[0];
  const waiting = confirm.props.onClick(); confirm.props.onClick(); assert.equal(calls, 1);
  const writes = ui.writes; ui.unmount(); assert.equal(signal.aborted, true); resolve(apiResult()); await waiting; assert.equal(ui.writes, writes);
});

test('跨模块隔离，无真实网络、存储、owner凭据或金额浮点运算，UI不直接导入Mock', async () => {
  const models = require('../lib/adminModelsData'); const providers = require('../lib/adminProvidersData'); const analytics = require('../lib/adminAnalyticsData');
  const before = [await models.loadAdminModels(), await providers.loadAdminProviders(), await analytics.loadAdminAnalytics()];
  const gateway = data.createAdminPricingGateway(); await gateway.command(draft()); await gateway.command(lifecycle('revoke', 'demo-v2'));
  assert.deepEqual([await models.loadAdminModels(), await providers.loadAdminProviders(), await analytics.loadAdminAnalytics()], before);
  for (const file of ['components/AdminPricing.js', 'lib/adminPricingData.js', 'lib/adminPricingMock.js']) assert.doesNotMatch(read(file), /fetch\s*\(|axios|localStorage|sessionStorage|indexedDB|process\.env|lib\/server|Date\.now|setInterval|parseFloat|toFixed|effectiveFromUs/);
  assert.doesNotMatch(read('components/AdminPricing.js'), /adminPricingMock|demo-price-image|\.versions\.(?:push|splice)|unitPriceTenths\s*=/);
});
