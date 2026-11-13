const test = require('node:test');
const assert = require('node:assert/strict');
const { MemoryObjectStore, assertObjectKey } = require('../lib/server/storage/memoryObjectStore');
const { transitionAsset } = require('../lib/server/assetService');

const key = 'owner/assets/image.png';

test('object store round-trips binary bytes, string metadata and byte size', async () => {
    const store = new MemoryObjectStore();
    const body = Buffer.from([0, 255, 128, 1]);
    const metadata = { contentType: 'image/png' };
    assert.deepEqual(await store.putObject({ key, body, metadata }), { key, sizeBytes: 4, metadata });
    const result = await store.getObject({ key });
    assert.ok(Buffer.isBuffer(result.body));
    assert.deepEqual(result, { key, body, sizeBytes: 4, metadata });
});

test('默认私有仅证明进程内隔离和无 URL 返回，不代表生产 bucket 安全', async () => {
    const store = new MemoryObjectStore();
    const other = new MemoryObjectStore();
    for (const options of [{}, { acl: 'private' }]) {
        const result = await store.putObject({ key, body: Buffer.from('private bytes'), ...options });
        assert.deepEqual(result, { key, sizeBytes: 13, metadata: {} });
        assert.deepEqual(await store.getObject({ key }), {
            key, body: Buffer.from('private bytes'), sizeBytes: 13, metadata: {},
        });
        assert.equal(await other.getObject({ key }), null);
    }
    assert.deepEqual(Object.keys(store), []);
    assert.equal(typeof store.getPublicUrl, 'undefined');
    assert.equal(typeof store.getSignedUrl, 'undefined');
});

test('公开及不支持的 ACL 在写入前拒绝且不会覆盖现有对象', async () => {
    const store = new MemoryObjectStore();
    const original = { key, body: Buffer.from('original'), metadata: { version: 'private' } };
    await store.putObject(original);
    for (const acl of ['public-read', 'public-read-write', 'authenticated-read', 'bucket-owner-read',
        'PUBLIC-READ', '', null, true, { read: 'public' }]) {
        for (const targetKey of [key, 'new-object']) {
            await assert.rejects(
                store.putObject({ key: targetKey, body: Buffer.from('replacement'), acl }),
                { name: 'TypeError', message: 'memory object store only supports private ACL' },
            );
        }
        assert.deepEqual(await store.getObject({ key }), { ...original, sizeBytes: original.body.length });
        assert.equal(await store.hasObject({ key: 'new-object' }), false);
    }
});

test('missing reads return null and repeated deletes report absence', async () => {
    const store = new MemoryObjectStore();
    assert.equal(await store.getObject({ key }), null);
    assert.equal(await store.hasObject({ key }), false);
    assert.equal(await store.deleteObject({ key }), false);
    await store.putObject({ key, body: Buffer.alloc(0) });
    assert.equal(await store.hasObject({ key }), true);
    assert.equal(await store.deleteObject({ key }), true);
    assert.equal(await store.deleteObject({ key }), false);
    assert.equal(await store.getObject({ key }), null);
});

test('puts overwrite the whole record and accept empty bodies with default metadata', async () => {
    const store = new MemoryObjectStore();
    await store.putObject({ key, body: Buffer.from('old'), metadata: { version: 'old' } });
    await store.putObject({ key, body: Buffer.alloc(0) });
    assert.deepEqual(await store.getObject({ key }), { key, body: Buffer.alloc(0), sizeBytes: 0, metadata: {} });
});

test('Buffer and Uint8Array inputs are copied, including sliced typed arrays', async () => {
    const store = new MemoryObjectStore();
    for (const body of [Buffer.from([1, 2]), new Uint8Array([9, 1, 2, 9]).subarray(1, 3)]) {
        await store.putObject({ key, body });
        body.fill(8);
        const first = await store.getObject({ key });
        assert.deepEqual(first.body, Buffer.from([1, 2]));
        first.body.fill(7);
        assert.deepEqual((await store.getObject({ key })).body, Buffer.from([1, 2]));
    }
});

test('input metadata and all returned metadata are isolated from stored values', async () => {
    const store = new MemoryObjectStore();
    const metadata = Object.assign(Object.create(null), { contentType: 'image/png' });
    const put = await store.putObject({ key, body: Buffer.from('x'), metadata });
    metadata.contentType = 'changed';
    put.metadata.contentType = 'changed again';
    const first = await store.getObject({ key });
    assert.deepEqual(first.metadata, { contentType: 'image/png' });
    first.metadata.contentType = 'changed on read';
    assert.deepEqual((await store.getObject({ key })).metadata, { contentType: 'image/png' });
});

test('instances and keys are isolated and clear only resets its own instance', async () => {
    const first = new MemoryObjectStore();
    const second = new MemoryObjectStore();
    await first.putObject({ key, body: Buffer.from('one') });
    await first.putObject({ key: 'other', body: Buffer.from('other') });
    assert.equal(await second.getObject({ key }), null);
    await second.putObject({ key, body: Buffer.from('two') });
    await first.deleteObject({ key });
    assert.equal((await first.getObject({ key: 'other' })).body.toString(), 'other');
    first.clear();
    assert.equal(await first.getObject({ key: 'other' }), null);
    assert.equal((await second.getObject({ key })).body.toString(), 'two');
});

const invalidKeys = [undefined, null, 1, {}, '', ' ', ' leading', 'trailing ', '/absolute',
    '.', '..', '../object', 'a/./b', 'a/../b', 'a//b', 'a/', 'a\\b', 'C:/object',
    'https://host/object', 'a?b', 'a#b', 'a\0b', 'a\nb', 'a\x7fb'];
const validKeys = [key, 'object', '目录/图像.png', 'folder/file name.png', 'a/.hidden', 'a/...', 'a-b_c.123'];

test('all operations reject malformed keys before touching stored data', async () => {
    const store = new MemoryObjectStore();
    await store.putObject({ key, body: Buffer.from('original') });
    for (const invalidKey of invalidKeys) {
        assert.throws(() => assertObjectKey(invalidKey), TypeError);
        for (const operation of ['putObject', 'getObject', 'deleteObject', 'hasObject']) {
            await assert.rejects(store[operation]({ key: invalidKey, body: Buffer.from('bad') }), TypeError);
        }
    }
    for (const operation of ['putObject', 'getObject', 'deleteObject', 'hasObject']) {
        await assert.rejects(store[operation](), TypeError);
        await assert.rejects(store[operation](null), TypeError);
    }
    assert.equal((await store.getObject({ key })).body.toString(), 'original');
});

test('key acceptance matches the asset service for valid and invalid examples', async () => {
    const store = new MemoryObjectStore();
    let calls = 0;
    const pool = { async query() { calls += 1; return { rowCount: 1, rows: [{}] }; } };
    const input = {
        assetId: '00000000-0000-4000-8000-000000000002',
        ownerId: '00000000-0000-4000-8000-000000000001',
        expectedStatus: 'uploading', status: 'ready',
    };
    for (const storageKey of invalidKeys) {
        await assert.rejects(transitionAsset(pool, { ...input, storageKey }), TypeError);
    }
    assert.equal(calls, 0);
    for (const storageKey of validKeys) {
        await store.putObject({ key: storageKey, body: Buffer.from('x') });
        await transitionAsset(pool, { ...input, storageKey });
        assert.equal((await store.getObject({ key: storageKey })).sizeBytes, 1);
    }
    assert.equal(calls, validKeys.length);
});

test('invalid bodies and metadata cannot destroy a previous object', async () => {
    const store = new MemoryObjectStore();
    const original = { key, body: Buffer.from('original'), metadata: { version: 'one' } };
    await store.putObject(original);
    for (const body of [undefined, null, 'string', [1, 2], new ArrayBuffer(2), new Uint16Array(2)]) {
        await assert.rejects(store.putObject({ key, body }), TypeError);
    }
    await assert.rejects(store.putObject({ key, body: Buffer.from('replacement'), acl: 'public-read' }), TypeError);
    for (const metadata of [null, [], 'text', new Date(), { nested: {} }, { size: 1 },
        { value: undefined }, { value: null }, { [Symbol('key')]: 'value' }]) {
        await assert.rejects(store.putObject({ key, body: Buffer.from('replacement'), metadata }), TypeError);
    }
    assert.deepEqual(await store.getObject({ key }), { ...original, sizeBytes: original.body.length });
});
