const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CURSOR = /^[A-Za-z0-9_-]{1,512}$/;
const MEDIA_FILTERS = new Set(['all', 'image', 'video']);
const MIME = { image: new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif']), video: new Set(['video/mp4', 'video/webm', 'video/quicktime']) };
const fail = (code, status) => Object.assign(new Error(code), { code, status });

export async function getAssets({ accountId, media, limit = 20, cursor = null, signal, fetchImpl = globalThis.fetch } = {}) {
  if (typeof accountId !== 'string' || !UUID.test(accountId)) throw fail('ASSETS_ACCOUNT_REQUIRED');
  if (!MEDIA_FILTERS.has(media) || !Number.isSafeInteger(limit) || limit < 1 || limit > 50
    || (cursor !== null && (typeof cursor !== 'string' || !CURSOR.test(cursor)))) throw fail('INVALID_ASSETS_QUERY');
  signal?.throwIfAborted();
  const query = new URLSearchParams({ media, limit: String(limit) });
  if (cursor !== null) query.set('cursor', cursor);
  const response = await fetchImpl(`/api/assets?${query}`, {
    method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal,
    headers: { Accept: 'application/json' },
  });
  signal?.throwIfAborted();
  if (!response.ok) throw fail('ASSETS_QUERY_FAILED', response.status);
  let body;
  try { body = await response.json(); } catch { throw fail('INVALID_ASSETS_RESPONSE'); }
  signal?.throwIfAborted();
  if (body?.accountId !== accountId) throw fail('ASSETS_ACCOUNT_MISMATCH');
  if (!Array.isArray(body.items) || body.items.length > limit
    || (body.nextCursor !== null && (typeof body.nextCursor !== 'string' || !CURSOR.test(body.nextCursor) || body.nextCursor === cursor))
    || (body.items.length === 0 && body.nextCursor !== null)) throw fail('INVALID_ASSETS_RESPONSE');
  const items = body.items.map((item) => {
    if (typeof item?.id !== 'string' || !UUID.test(item.id) || typeof item.mediaType !== 'string' || !Object.hasOwn(MIME, item.mediaType)
      || (media !== 'all' && item.mediaType !== media) || !MIME[item.mediaType].has(item.mimeType) || !Number.isSafeInteger(item.sizeBytes) || item.sizeBytes < 0
      || typeof item.createdAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(item.createdAt)
      || !Number.isFinite(Date.parse(item.createdAt)) || item.resultUrl !== `/api/assets/${item.id}/content`) throw fail('INVALID_ASSETS_RESPONSE');
    const { id, mediaType, mimeType, sizeBytes, createdAt, resultUrl } = item;
    return { id, mediaType, mimeType, sizeBytes, createdAt, resultUrl };
  });
  return { accountId, items, nextCursor: body.nextCursor };
}
