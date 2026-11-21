const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { transformSync } = require('esbuild');
function load(name) {
  const source = transformSync(fs.readFileSync(path.join(__dirname, '../packages/studio/src', name), 'utf8'), { format: 'cjs' }).code;
  const output = { exports: {} };
  new Function('module', 'exports', source)(output, output.exports);
  return output.exports;
}
const { getAssets } = load('assetsClient.js');
const accountId = '10000000-0000-4000-8000-000000000001';
const id = '20000000-0000-4000-8000-000000000001';
const item = { id, mediaType: 'image', mimeType: 'image/png', sizeBytes: 123, createdAt: '2026-11-21T01:00:00.123456Z', resultUrl: `/api/assets/${id}/content` };
const response = (body) => ({ ok: true, json: async () => body });
test('assets client only reads same-origin authenticated safe DTO', async () => {
  const page = await getAssets({ accountId, media: 'image', fetchImpl: async (url, options) => {
    assert.equal(url, '/api/assets?media=image&limit=20');
    assert.equal(options.credentials, 'same-origin'); assert.equal(options.cache, 'no-store');
    return response({ accountId, items: [{ ...item, storageKey: 'must-not-copy' }], nextCursor: null });
  } });
  assert.deepEqual(page.items, [item]);
});
test('all assets preserve mixed server order and validate MIME for each item', async () => {
  const videoId = '20000000-0000-4000-8000-000000000002';
  const video = { ...item, id: videoId, mediaType: 'video', mimeType: 'video/mp4', resultUrl: `/api/assets/${videoId}/content` };
  const mixed = { accountId, items: [video, item], nextCursor: 'next' };
  assert.deepEqual(await getAssets({ accountId, media: 'all', cursor: 'previous', fetchImpl: async (url) => {
    assert.equal(url, '/api/assets?media=all&limit=20&cursor=previous');
    return response(mixed);
  } }), mixed);
  for (const [media, candidate] of [['image', video], ['all', { ...video, mimeType: 'image/png' }], ['all', { ...video, mediaType: 'audio' }]]) {
    await assert.rejects(getAssets({ accountId, media, fetchImpl: async () => response({ ...mixed, items: [candidate] }) }), { code: 'INVALID_ASSETS_RESPONSE' });
  }
});
test('assets client rejects account mismatch and external content without fallback', async () => {
  await assert.rejects(getAssets({ accountId, media: 'image', fetchImpl: async () => response({ accountId: 'other', items: [], nextCursor: null }) }), { code: 'ASSETS_ACCOUNT_MISMATCH' });
  await assert.rejects(getAssets({ accountId, media: 'image', fetchImpl: async () => response({ accountId, items: [{ ...item, resultUrl: 'https://external.invalid/file' }], nextCursor: null }) }), { code: 'INVALID_ASSETS_RESPONSE' });
  await assert.rejects(getAssets({ accountId, media: 'image', fetchImpl: async () => ({ ok: false, status: 401 }) }), { code: 'ASSETS_QUERY_FAILED', status: 401 });
});
test('Studio declares one Assets entry outside all media categories', () => {
  const shell = fs.readFileSync(path.join(__dirname, '../components/StandaloneShell.js'), 'utf8');
  const categories = shell.match(/const NAVIGATION_CATEGORIES = \[([\s\S]+?)\n\];/)[1];
  assert.doesNotMatch(categories, /['"]assets['"]/);
  assert.match(shell, /const TOP_LEVEL_TABS = \['assets', 'apps'\]/);
  const navigation = shell.match(/<nav aria-label=\{copy\.shell\.studioNavigation\}[\s\S]*?<\/nav>/)[0];
  assert.equal(navigation.match(/TOP_LEVEL_TABS\.map/g)?.length, 1);
  assert.match(navigation, /TOP_LEVEL_TABS\.map[\s\S]*?href=\{studioPath\(tab\.id\)\}[\s\S]*?handleNavigationItemClick\(event, tab\.id\)/);
  transformSync(shell, { loader: 'jsx' });
});
test('Studio loads per-tool entries and defers panels until visited without discarding them on return', () => {
  const shell = fs.readFileSync(path.join(__dirname, '../components/StandaloneShell.js'), 'utf8');
  const studioRoot = path.join(__dirname, '../packages/studio');
  const pkg = require('../packages/studio/package.json');
  assert.doesNotMatch(shell, /(?:from |import\()['"]studio['"]/);
  const entries = [...shell.matchAll(/const (\w+Studio) = dynamic\(\(\) => import\('studio\/(\w+)'\)/g)];
  assert.equal(entries.length, 17);
  for (const [, component, entry] of entries) {
    assert.equal(component, entry);
    assert.match(fs.readFileSync(path.join(studioRoot, pkg.exports[`./${entry}`]), 'utf8'), /export\s+default/);
  }
  assert.equal([...shell.matchAll(/<StudioPanel active=\{activeTab === '/g)].length, 15);
  assert.match(shell, /activeTab === 'assets' && <AssetsStudio/);
  assert.match(shell, /activeTab === 'design-agent' && \(\s*<DesignAgentStudio/);
  const panel = shell.match(/function StudioPanel\([\s\S]+?\n\}/)[0];
  const compiled = transformSync(panel, { loader: 'jsx' }).code;
  let visited;
  const useState = (initial) => [visited ??= initial, (value) => { visited = value; }];
  const React = { createElement: (type, props, children) => ({ type, props, children }) };
  const render = new Function('useState', 'React', `${compiled}\nreturn StudioPanel;`)(useState, React);
  const child = { tool: 'video' };
  assert.equal(render({ active: false, children: child }), null);
  assert.equal(render({ active: true, children: child }).children, child);
  assert.deepEqual(render({ active: false, children: child }), { type: 'div', props: { className: 'hidden' }, children: child });
  assert.equal(render({ active: true, children: child }).props.className, 'h-full w-full');
});
test('asset invalidation only notifies same account and unsubscribe removes listener', () => {
  const { subscribeAssetInvalidations, invalidateAssets } = load('assetInvalidations.js');
  let calls = 0;
  const stop = subscribeAssetInvalidations(accountId, () => { calls++; });
  invalidateAssets('other'); assert.equal(calls, 0);
  invalidateAssets(accountId); assert.equal(calls, 1);
  stop(); invalidateAssets(accountId); assert.equal(calls, 1);
});
