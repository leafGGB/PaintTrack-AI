const test = require('node:test');
const assert = require('node:assert/strict');
const { AssetServiceError, createAsset, getAsset, transitionAsset } = require('../lib/server/assetService');

const ownerId = '00000000-0000-4000-8000-000000000001';
const assetId = '00000000-0000-4000-8000-000000000002';
function scriptedPool(result = { rowCount: 1, rows: [{ id: assetId }] }) {
    const calls = [];
    return { calls, async query(text, values) { calls.push({ text, values }); return result; } };
}

test('assets are created pending without accepting caller-supplied state or keys', async () => {
    const pool = scriptedPool();
    await createAsset(pool, { ownerId, mediaType: 'image', status: 'ready', storageKey: 'ignored', metadata: { width: 20 } });
    assert.match(pool.calls[0].text, /'pending'/);
    assert.deepEqual(pool.calls[0].values, [ownerId, 'image', null, null, '{"width":20}']);
});

test('invalid creation arguments fail before querying the database', async () => {
    const pool = scriptedPool();
    const valid = { ownerId, mediaType: 'image' };
    for (const patch of [
        { ownerId: 'untrusted' }, { mediaType: 'binary' }, { mimeType: '' },
        { sizeBytes: -1 }, { sizeBytes: 1.5 }, { sizeBytes: Number.MAX_SAFE_INTEGER + 1 },
        { metadata: [] }, { metadata: null }, { metadata: new Date() },
        { metadata: { toJSON: () => 'not-an-object' } },
    ]) {
        await assert.rejects(createAsset(pool, { ...valid, ...patch }), TypeError);
    }
    await assert.rejects(createAsset(null, valid), TypeError);
    assert.equal(pool.calls.length, 0);
});

test('reads always scope by asset and owner and hide missing records', async () => {
    const pool = scriptedPool({ rowCount: 0, rows: [] });
    assert.equal(await getAsset(pool, { assetId, ownerId }), null);
    assert.match(pool.calls[0].text, /id = \$1::uuid AND owner_id = \$2::uuid/);
    assert.deepEqual(pool.calls[0].values, [assetId, ownerId]);
    await assert.rejects(getAsset(pool, { assetId: 'bad', ownerId }), TypeError);
});

const allowed = new Set(['pending:uploading', 'uploading:ready', 'uploading:failed', 'failed:uploading', 'ready:deleted']);
test('all 25 state pairs enforce exactly the allowed transition graph', async () => {
    const states = ['pending', 'uploading', 'ready', 'failed', 'deleted'];
    for (const expectedStatus of states) {
        for (const status of states) {
            const pool = scriptedPool();
            const input = { assetId, ownerId, expectedStatus, status };
            if (status === 'ready') input.storageKey = 'owner/object.png';
            if (allowed.has(`${expectedStatus}:${status}`)) {
                await transitionAsset(pool, input);
                assert.equal(pool.calls.length, 1);
                assert.match(pool.calls[0].text, /WHERE id = \$2::uuid AND owner_id = \$3::uuid AND status = \$4/);
                assert.match(pool.calls[0].text, /updated_at = now\(\)/);
                assert.deepEqual(pool.calls[0].values.slice(0, 4), [status, assetId, ownerId, expectedStatus]);
            } else {
                await assert.rejects(transitionAsset(pool, input),
                    (error) => error instanceof AssetServiceError && error.code === 'INVALID_TRANSITION');
                assert.equal(pool.calls.length, 0);
            }
        }
    }
});

test('unknown and prototype-like statuses cannot bypass the transition graph', async () => {
    for (const expectedStatus of ['constructor', '__proto__', 'unknown', undefined]) {
        await assert.rejects(transitionAsset(scriptedPool(), { assetId, ownerId, expectedStatus, status: 'ready' }),
            (error) => error.code === 'INVALID_TRANSITION');
    }
});

test('ready requires a relative storage key and validates optional object details', async () => {
    const valid = { assetId, ownerId, expectedStatus: 'uploading', status: 'ready', storageKey: 'owner/object' };
    const pool = scriptedPool();
    for (const storageKey of [undefined, '', ' ', '/absolute', '../object', 'a/../b', 'a\\b', 'https://host/object', 'a//b', 'a?b', 'a#b', 'a\n']) {
        await assert.rejects(transitionAsset(pool, { ...valid, storageKey }), TypeError);
    }
    await assert.rejects(transitionAsset(pool, { ...valid, thumbnailStorageKey: '../bad' }), TypeError);
    await assert.rejects(transitionAsset(pool, { ...valid, checksumSha256: 'A'.repeat(64) }), TypeError);
    assert.equal(pool.calls.length, 0);
    await transitionAsset(pool, { ...valid, thumbnailStorageKey: 'owner/thumb', checksumSha256: 'a'.repeat(64) });
    assert.deepEqual(pool.calls[0].values.slice(4), ['owner/object', 'owner/thumb', 'a'.repeat(64)]);
});

test('non-ready transitions cannot change object details and deletion preserves keys', async () => {
    const pool = scriptedPool();
    for (const field of ['storageKey', 'thumbnailStorageKey', 'checksumSha256']) {
        await assert.rejects(transitionAsset(pool, { assetId, ownerId, expectedStatus: 'ready', status: 'deleted', [field]: null }), TypeError);
    }
    await transitionAsset(pool, { assetId, ownerId, expectedStatus: 'ready', status: 'deleted' });
    assert.match(pool.calls[0].text, /ELSE storage_key END/);
    assert.match(pool.calls[0].text, /deleted_at = CASE WHEN \$1 = 'deleted' THEN now\(\)/);
});

test('unavailable, wrong-owner, and stale-state updates have one non-disclosing error', async () => {
    const pool = scriptedPool({ rowCount: 0, rows: [] });
    await assert.rejects(transitionAsset(pool, { assetId, ownerId, expectedStatus: 'pending', status: 'uploading' }),
        (error) => error instanceof AssetServiceError && error.code === 'ASSET_CONFLICT');
    assert.equal(pool.calls.length, 1);
});

test('database failures propagate rather than being mislabeled as conflicts', async () => {
    const failure = new Error('database unavailable');
    const pool = { async query() { throw failure; } };
    await assert.rejects(transitionAsset(pool, { assetId, ownerId, expectedStatus: 'pending', status: 'uploading' }),
        (error) => error === failure);
});
