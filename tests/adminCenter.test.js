'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('admin center exposes bilingual read-only directory and detail states', () => {
  const component = read('components/AdminCenter.js');
  assert.match(component, /fetch\(`\/api\/admin\/users\?/);
  assert.match(component, /fetch\(`\/api\/admin\/users\/\$\{encodeURIComponent\(id\)\}`/);
  for (const text of ['Exact email', '精确邮箱', 'No users found.', '没有找到用户。', 'The user list is temporarily unavailable.', '用户列表暂时无法读取。', 'Retry', '重试', 'Load more', '加载更多']) {
    assert.ok(component.includes(text), `Missing UI state: ${text}`);
  }
  assert.match(component, /roleLabel\(user\.role, text\)/);
  assert.match(component, /activeSessionCount/);
  assert.match(component, /availableTenths/);
  assert.match(component, /frozenTenths/);
  assert.match(component, /recentLedger/);
  assert.doesNotMatch(component, /fetch\(`\/api\/admin\/users[^\n]*\{\s*method:\s*'(?:POST|PATCH|DELETE)'/);
  assert.match(read('app/admin/users/page.js'), /<AdminCenter\s*\/>/);
  assert.match(read('app/zh/admin/users/page.js'), /<AdminCenter locale="zh"\s*\/>/);
});

// 直接执行组件 JSX 之前的源码，用延迟响应验证请求时序，不复制实现。
function createHarness() {
  const component = read('components/AdminCenter.js');
  const start = component.indexOf('export default function AdminCenter');
  const end = component.indexOf('  const selected = detail.data?.user;', start);
  assert.ok(start >= 0 && end > start);
  const slots = [];
  const effects = [];
  const calls = [];
  let hook = 0;
  let writes = 0;
  const useState = (initial) => {
    const index = hook++;
    if (!(index in slots)) slots[index] = initial;
    return [slots[index], (update) => {
      writes += 1;
      slots[index] = typeof update === 'function' ? update(slots[index]) : update;
    }];
  };
  const useRef = (initial) => {
    const index = hook++;
    if (!(index in slots)) slots[index] = { current: initial };
    return slots[index];
  };
  const useEffect = (run, deps) => {
    const index = hook++;
    const previous = slots[index];
    if (!previous || deps.some((value, i) => !Object.is(value, previous.deps[i]))) {
      const effect = { run, deps, cleanup: previous?.cleanup };
      slots[index] = effect;
      effects.push(effect);
    }
  };
  const fetch = (url, options) => new Promise((resolve, reject) => {
    // 故意不响应 abort，确保请求序号也能挡住已经完成传输的旧响应。
    calls.push({ url, signal: options.signal, resolve, reject });
  });
  const renderComponent = new Function('useState', 'useRef', 'useEffect', 'fetch', 'AbortController', 'URLSearchParams', 'copy',
    `${component.slice(start, end).replace('export default ', '')}
      return { users, email, selectedId, detail, loadingMore, moreError,
        setEmail, loadUsers, loadDetail, search, clearSearch };
    }
    return AdminCenter;`)(useState, useRef, useEffect, fetch, AbortController, URLSearchParams, { en: {}, zh: {} });
  return {
    calls,
    render() { hook = 0; return renderComponent({}); },
    effects() {
      for (const effect of effects.splice(0)) {
        effect.cleanup?.();
        effect.cleanup = effect.run();
      }
    },
    unmount() { for (const slot of slots) slot?.cleanup?.(); },
    get writes() { return writes; },
  };
}

async function respond(call, data, ok = true) {
  call.resolve({ ok, json: async () => ({ data }) });
  await new Promise((resolve) => setImmediate(resolve));
}

async function fail(call) {
  call.reject(new Error('模拟网络失败'));
  await new Promise((resolve) => setImmediate(resolve));
}

const page = (id, nextCursor = null) => ({ users: [{ id, email: `${id}@example.test` }], nextCursor });
const submit = (view) => view.search({ preventDefault() {} });

for (const outcome of ['success', 'http-error', 'network-error']) {
  test(`列表搜索与清除忽略旧请求的 ${outcome}`, async () => {
    const harness = createHarness();
    let view = harness.render();
    view.setEmail('old@example.test');
    view = harness.render();
    submit(view);
    const old = harness.calls[0];
    view.clearSearch();
    const latest = harness.calls[1];
    assert.equal(old.signal.aborted, true);
    assert.equal(new URLSearchParams(latest.url.split('?')[1]).has('email'), false);
    await respond(latest, page('latest', 'cursor-latest'));
    if (outcome === 'network-error') await fail(old);
    else await respond(old, page('old'), outcome === 'success');
    view = harness.render();
    assert.equal(view.email, '');
    assert.deepEqual(view.users, { status: 'ready', items: page('latest').users, nextCursor: 'cursor-latest' });
    assert.equal(view.moreError, false);
  });

  test(`连续选择详情忽略旧请求的 ${outcome}`, async () => {
    const harness = createHarness();
    let view = harness.render();
    view.loadDetail('old/id');
    view.loadDetail('latest');
    assert.equal(harness.calls[0].signal.aborted, true);
    assert.equal(harness.calls[0].url, '/api/admin/users/old%2Fid');
    await respond(harness.calls[1], { user: { id: 'latest' } });
    if (outcome === 'network-error') await fail(harness.calls[0]);
    else await respond(harness.calls[0], { user: { id: 'old' } }, outcome === 'success');
    view = harness.render();
    assert.equal(view.selectedId, 'latest');
    assert.deepEqual(view.detail, { status: 'ready', data: { user: { id: 'latest' } } });
  });
}

for (const action of ['search', 'clearSearch']) {
  test(`${action} 取消详情并阻止旧响应恢复选择`, async () => {
    const harness = createHarness();
    let view = harness.render();
    view.loadDetail('old');
    if (action === 'search') submit(view);
    else view.clearSearch();
    assert.equal(harness.calls[0].signal.aborted, true);
    await respond(harness.calls[0], { user: { id: 'old' } });
    view = harness.render();
    assert.equal(view.selectedId, null);
    assert.deepEqual(view.detail, { status: 'idle', data: null });
  });
}

test('旧搜索响应体延迟解析完成也不能覆盖新搜索', async () => {
  const harness = createHarness();
  let view = harness.render();
  view.setEmail('old@example.test');
  submit(harness.render());
  let resolveBody;
  harness.calls[0].resolve({ ok: true, json: () => new Promise((resolve) => { resolveBody = resolve; }) });
  await new Promise((resolve) => setImmediate(resolve));
  view.setEmail('latest@example.test');
  submit(harness.render());
  assert.equal(harness.calls[0].signal.aborted, true);
  assert.equal(new URLSearchParams(harness.calls[1].url.split('?')[1]).get('email'), 'latest@example.test');
  await respond(harness.calls[1], page('latest'));
  resolveBody({ data: page('old') });
  await new Promise((resolve) => setImmediate(resolve));
  view = harness.render();
  assert.deepEqual(view.users.items, page('latest').users);
  assert.equal(view.users.status, 'ready');
});

test('分页使用已提交邮箱，同一轮重复点击只发出一次请求', async () => {
  const harness = createHarness();
  let view = harness.render();
  view.setEmail(' committed@example.test ');
  submit(harness.render());
  await respond(harness.calls[0], page('first', 'cursor-1'));
  view = harness.render();
  view.setEmail('draft@example.test');
  view = harness.render();
  const pending = view.loadUsers({ append: true, cursor: view.users.nextCursor });
  await view.loadUsers({ append: true, cursor: view.users.nextCursor });
  assert.equal(harness.calls.length, 2);
  const params = new URLSearchParams(harness.calls[1].url.split('?')[1]);
  assert.equal(params.get('email'), 'committed@example.test');
  assert.equal(params.get('cursor'), 'cursor-1');
  assert.equal(params.get('limit'), '20');
  view = harness.render();
  assert.equal(view.loadingMore, true);
  assert.equal(view.users.status, 'ready');
  await respond(harness.calls[1], page('second', 'cursor-2'));
  await pending;
  view = harness.render();
  assert.deepEqual(view.users.items, [...page('first').users, ...page('second').users]);
  assert.equal(view.users.nextCursor, 'cursor-2');
  assert.equal(view.loadingMore, false);
});

for (const outcome of ['http-error', 'network-error']) {
  test(`加载更多 ${outcome} 保留列表与游标，可按原筛选重试`, async () => {
    const harness = createHarness();
    let view = harness.render();
    view.loadUsers({ query: 'committed@example.test' });
    await respond(harness.calls[0], page('first', 'cursor-1'));
    view = harness.render();
    const previous = view.users;
    view.loadUsers({ append: true, cursor: previous.nextCursor });
    if (outcome === 'network-error') await fail(harness.calls[1]);
    else await respond(harness.calls[1], null, false);
    view = harness.render();
    assert.deepEqual(view.users, previous);
    assert.equal(view.moreError, true);
    assert.equal(view.loadingMore, false);
    view.setEmail('draft@example.test');
    view = harness.render();
    view.loadUsers({ append: true, cursor: view.users.nextCursor });
    assert.equal(harness.calls[2].url, harness.calls[1].url);
    assert.equal(harness.render().moreError, false);
    await respond(harness.calls[2], page('second'));
    view = harness.render();
    assert.deepEqual(view.users.items, [...page('first').users, ...page('second').users]);
    assert.equal(view.users.nextCursor, null);
    assert.equal(view.loadingMore, false);
  });
}

test('新搜索取消旧分页，旧 finally 不会解锁新分页', async () => {
  const harness = createHarness();
  let view = harness.render();
  view.loadUsers();
  await respond(harness.calls[0], page('first', 'cursor-1'));
  view = harness.render();
  view.loadUsers({ append: true, cursor: view.users.nextCursor });
  const old = harness.calls[1];
  view.setEmail('latest@example.test');
  submit(harness.render());
  assert.equal(old.signal.aborted, true);
  await respond(harness.calls[2], page('latest', 'cursor-latest'));
  view = harness.render();
  view.loadUsers({ append: true, cursor: view.users.nextCursor });
  await fail(old);
  view = harness.render();
  assert.equal(view.loadingMore, true);
  assert.equal(view.moreError, false);
  await view.loadUsers({ append: true, cursor: view.users.nextCursor });
  assert.equal(harness.calls.length, 4);
  await respond(harness.calls[3], page('latest-more'));
  assert.deepEqual(harness.render().users.items, [...page('latest').users, ...page('latest-more').users]);
});

test('首屏失败重试仍使用已提交筛选，未提交草稿不改变请求', async () => {
  const harness = createHarness();
  let view = harness.render();
  view.loadUsers({ query: 'committed@example.test' });
  await fail(harness.calls[0]);
  view = harness.render();
  assert.equal(view.users.status, 'error');
  view.setEmail('draft@example.test');
  harness.render().loadUsers();
  assert.equal(harness.calls[1].url, harness.calls[0].url);
  await respond(harness.calls[1], page('retried'));
  assert.equal(harness.render().users.status, 'ready');
});

for (const outcome of ['success', 'network-error']) {
  test(`卸载取消列表和详情，延迟 ${outcome} 不更新状态`, async () => {
    const harness = createHarness();
    let view = harness.render();
    harness.effects();
    view.loadDetail('selected');
    assert.equal(harness.calls.length, 2);
    const writes = harness.writes;
    harness.unmount();
    assert.ok(harness.calls.every((call) => call.signal.aborted));
    for (const call of harness.calls) {
      if (outcome === 'network-error') await fail(call);
      else await respond(call, { ...page('late'), counts: {}, user: { id: 'late' } });
    }
    assert.equal(harness.writes, writes);
    view = harness.render();
    assert.equal(view.users.status, 'loading');
    assert.equal(view.detail.status, 'loading');
  });
}

test('源码将搜索、清除和重试接入保护逻辑，加载更多有禁用和双语反馈', () => {
  const component = read('components/AdminCenter.js');
  assert.match(component, /import \{ useEffect, useRef, useState \} from 'react'/);
  assert.match(component, /onSubmit=\{search\}/);
  assert.match(component, /onClick=\{clearSearch\}/);
  assert.match(component, /onClick=\{\(\) => loadUsers\(\)\}/);
  assert.match(component, /disabled=\{loadingMore\}/);
  assert.match(component, /onClick=\{\(\) => loadUsers\(\{ append: true, cursor: users\.nextCursor \}\)\}/);
  assert.match(component, /loadingMore \? text\.loadingMore : moreError \? text\.retry : text\.loadMore/);
  assert.match(component, /moreError && <p[^>]*>\{text\.listError\}/);
  assert.match(component, /users\.status === 'ready' && users\.items\.length > 0/);
  for (const text of ["loadingMore: 'Loading…'", "loadingMore: '正在加载……'"]) assert.ok(component.includes(text));
});
