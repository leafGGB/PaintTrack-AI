'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { MemoryObjectStore } = require('../lib/server/storage/memoryObjectStore');
const { createAssetArchive } = require('../lib/server/assetArchive');
const { createFileObjectStore } = require('../lib/server/storage/fileObjectStore');

function recordingPool({ failUpdate = false, insertedId = randomUUID() } = {}) {
    const calls = [];
    return {
        calls,
        async query(text, values) {
            calls.push({ text, values });
            if (text.startsWith('INSERT INTO assets')) return { rowCount: 1, rows: [{ id: insertedId }] };
            if (text.startsWith('UPDATE assets')) return { rowCount: failUpdate ? 0 : 1, rows: [{ id: values[2] }] };
            if (text.startsWith('DELETE FROM assets')) return { rowCount: 1, rows: [] };
            throw new Error('unexpected query');
        },
    };
}

test('asset archive inserts pending, writes private object, then transitions to ready with narrow columns', async () => {
    const pool = recordingPool();
    const store = new MemoryObjectStore();
    const archive = createAssetArchive({ pool, objectStore: store });
    const ownerId = randomUUID();
    const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const result = await archive.archive({ ownerId, mediaType: 'image', mimeType: 'image/png', bytes, metadata: { taskId: randomUUID() } });
    assert.equal(result.archive, 'ready');
    assert.equal(result.resultUrl, `/api/assets/${result.assetId}/content`);
    assert.equal(result.sizeBytes, bytes.length);
    assert.match(result.checksumSha256, /^[a-f0-9]{64}$/);
    assert.doesNotMatch(pool.calls[0].text, /storage_key|checksum_sha256|updated_at/);
    assert.match(pool.calls[1].text, /SET status='ready',storage_key=\$1,checksum_sha256=\$2,updated_at=now\(\)/);
    const stored = await store.getObject({ key: `users/${ownerId}/assets/${result.assetId}` });
    assert.deepEqual(stored.body, bytes);
    await archive.discard({ storageKey: result.storageKey });
    assert.equal(await store.getObject({ key: `users/${ownerId}/assets/${result.assetId}` }), null);
});

test('asset archive uses caller transaction client and removes object if SQL transition fails', async () => {
    const pool = recordingPool();
    const assetId = randomUUID();
    const tx = recordingPool({ failUpdate: true, insertedId: assetId });
    const store = new MemoryObjectStore();
    const archive = createAssetArchive({ pool, objectStore: store });
    const ownerId = randomUUID();
    await assert.rejects(archive.archive({ ownerId, mediaType: 'image', bytes: Buffer.from('data'), client: tx }));
    assert.equal(pool.calls.length, 0);
    assert.equal(tx.calls.length, 2);
    assert.equal(await store.hasObject({ key: `users/${ownerId}/assets/${assetId}` }), false);
});

test('file object store round-trips bytes under the configured private root', async (t) => {
    const fs = require('node:fs/promises');
    const os = require('node:os');
    const path = require('node:path');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'painttrack-assets-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const store = createFileObjectStore({ rootDirectory: root });
    const key = 'users/owner/assets/one';
    const bytes = Buffer.from([0, 255, 1, 128]);
    await store.putObject({ key, body: bytes, acl: 'private' });
    assert.deepEqual((await store.getObject({ key })).body, bytes);
    await assert.rejects(store.getObject({ key: '../escape' }), /relative object key/);
});
