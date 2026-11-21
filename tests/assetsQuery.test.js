const test = require('node:test');
const assert = require('node:assert/strict');
const { createAssetsQueryService, parseAssetsQuery, decodeCursor } = require('../lib/server/assetsQuery');
const owner = '10000000-0000-4000-8000-000000000001';
const id = '20000000-0000-4000-8000-000000000001';

test('asset collection only queries owner ready undeleted media and projects safe fields with microsecond cursor', async () => {
  const row = { id, media_type: 'image', mime_type: 'image/png', size_bytes: '123', cursor_time: '2026-11-21T01:00:00.123456Z', storage_key: 'private' };
  const service = createAssetsQueryService({ pool: { query: async (sql, args) => {
    assert.match(sql, /owner_id = \$1::uuid/); assert.match(sql, /status = 'ready'/);
    assert.match(sql, /deleted_at IS NULL/); assert.match(sql, /ORDER BY created_at DESC, id DESC/);
    assert.deepEqual(args, [owner, 'image', null, null, 2]);
    return { rows: [row, { ...row, id: '20000000-0000-4000-8000-000000000002' }] };
  } } });
  const page = await service.list({ ownerId: owner, media: 'image', limit: '1' });
  assert.deepEqual(page.items[0], { id, mediaType: 'image', mimeType: 'image/png', sizeBytes: 123, createdAt: row.cursor_time, resultUrl: `/api/assets/${id}/content` });
  assert.deepEqual(decodeCursor(page.nextCursor), { id, createdAt: row.cursor_time });
  assert.ok(!JSON.stringify(page).includes('private'));
});

test('asset filters reject unknown duplicate and invalid pagination', () => {
  for (const query of ['', 'media=audio', 'media=image&limit=0', 'media=image&limit=51', 'media=image&cursor=x', 'media=image&ownerId=x', 'media=image&media=video']) {
    assert.throws(() => parseAssetsQuery(new URLSearchParams(query)));
  }
  assert.deepEqual(parseAssetsQuery(new URLSearchParams('media=video')), { media: 'video', limit: undefined, cursor: undefined });
});

test('all assets use one mixed-media keyset across pages, including equal timestamps', async () => {
  const time = '2026-11-21T01:00:00.123456Z';
  const make = (suffix, media, cursor_time = time) => ({ id: `20000000-0000-4000-8000-00000000000${suffix}`, media_type: media, mime_type: media === 'image' ? 'image/png' : 'video/mp4', size_bytes: '2', cursor_time });
  const [newest, boundary, tied, oldest] = [make(4, 'image', '2026-11-21T01:00:00.382919Z'), make(3, 'video'), make(2, 'image'), make(1, 'video')];
  const calls = [];
  const service = createAssetsQueryService({ pool: { query: async (sql, args) => {
    assert.match(sql, /owner_id = \$1::uuid/);
    assert.match(sql, /media_type IN \('image', 'video'\)/);
    assert.match(sql, /\$2::text = 'all' OR media_type = \$2::text/);
    assert.match(sql, /\(created_at, id\) < \(\$3::timestamptz, \$4::uuid\)/);
    assert.match(sql, /ORDER BY created_at DESC, id DESC/);
    calls.push(args);
    return { rows: calls.length === 1 ? [newest, boundary, tied] : [tied, oldest] };
  } } });
  const input = parseAssetsQuery(new URLSearchParams('media=all&limit=2'));
  const first = await service.list({ ...input, ownerId: owner });
  const second = await service.list({ ...input, ownerId: owner, cursor: first.nextCursor });
  assert.deepEqual([...first.items, ...second.items].map(({ id, mediaType }) => [id, mediaType]), [[newest.id, 'image'], [boundary.id, 'video'], [tied.id, 'image'], [oldest.id, 'video']]);
  assert.deepEqual(calls, [[owner, 'all', null, null, 3], [owner, 'all', time, boundary.id, 3]]);
  assert.equal(second.nextCursor, null);
});

test('unsafe bigint never silently rounds in asset DTO', async () => {
  const service = createAssetsQueryService({ pool: { query: async () => ({ rows: [{ id, size_bytes: '9007199254740993' }] }) } });
  await assert.rejects(service.list({ ownerId: owner, media: 'image' }), /INVALID_ASSET_SIZE/);
});
