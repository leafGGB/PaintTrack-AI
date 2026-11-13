import test from 'node:test';
import assert from 'node:assert/strict';
import { createImageTask, getImageTaskModel, waitForImageTask, isTaskResultImage, deleteAsset, assetIdFromResultUrl } from '../packages/studio/src/taskClient.js';

const taskId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const assetId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function response(body, status = 200) {
    return { ok: status >= 200 && status < 300, status, async json() { return body; } };
}

test('getImageTaskModel reads the authenticated same-origin catalog and selects only image generation models', async () => {
    let call;
    const model = await getImageTaskModel({
        fetchImpl: async (...args) => {
            call = args;
            return response({ models: [
                { logicalModelId: 'local-mock-video', mediaType: 'video', operations: ['video.generate'] },
                { logicalModelId: 'local-mock-image', mediaType: 'image', operations: ['image.generate'] },
            ] });
        },
    });
    assert.equal(model.logicalModelId, 'local-mock-image');
    assert.equal(call[0], '/api/catalog/models?media=image');
    assert.equal(call[1].credentials, 'same-origin');
    assert.equal(call[1].cache, 'no-store');
});

test('createImageTask sends same-origin request, idempotency, and exact task payload', async () => {
    let call;
    const task = { id: taskId, status: 'queued' };
    const result = await createImageTask({
        logicalModelId: 'local-mock-image',
        prompt: '  a blue bird  ',
        aspectRatio: '16:9',
        idempotencyKey: 'studio_test_key_123',
        fetchImpl: async (...args) => {
            call = args;
            return response({ task });
        },
    });
    assert.deepEqual(result, task);
    assert.equal(call[0], '/api/tasks');
    assert.equal(call[1].method, 'POST');
    assert.equal(call[1].credentials, 'same-origin');
    assert.equal(call[1].headers['Idempotency-Key'], 'studio_test_key_123');
    assert.deepEqual(JSON.parse(call[1].body), {
        taskType: 'image.generate',
        payload: {
            logicalModelId: 'local-mock-image',
            prompt: 'a blue bird',
            aspectRatio: '16:9',
            size: '1536x864',
        },
    });
});

test('waitForImageTask polls only the owned task and returns URL-backed image result', async () => {
    const calls = [];
    const states = [
        { task: { id: taskId, status: 'running' } },
        { task: { id: taskId, status: 'succeeded', result: { mediaType: 'image', resultUrl: 'https://cdn.example.test/image.png' } } },
    ];
    const result = await waitForImageTask(taskId, {
        fetchImpl: async (...args) => {
            calls.push(args);
            return response(states.shift());
        },
        pollIntervalMs: 100,
        timeoutMs: 1000,
        now: () => 0,
        sleep: async () => {},
    });
    assert.equal(result.status, 'succeeded');
    assert.equal(calls.length, 2);
    assert.equal(calls[0][0], `/api/tasks/${taskId}`);
    assert.equal(calls[0][1].credentials, 'same-origin');
    assert.equal(calls[0][1].cache, 'no-store');
});

test('succeeded synthetic mock asset without result URL is not treated as a displayable image', async () => {
    const task = { id: taskId, status: 'succeeded', result: {
        kind: 'mock-asset', mediaType: 'image/png', resultUrl: null, archive: 'not_configured',
    } };
    assert.equal(isTaskResultImage(task), false);
    await assert.rejects(waitForImageTask(taskId, {
        fetchImpl: async () => response({ task }),
        pollIntervalMs: 100,
        timeoutMs: 1000,
    }), (error) => error.code === 'IMAGE_RESULT_NOT_AVAILABLE');
});

test('failed task exposes only its public error code', async () => {
    const task = { id: taskId, status: 'failed', errorCode: 'PROVIDER_FAILED' };
    await assert.rejects(waitForImageTask(taskId, {
        fetchImpl: async () => response({ task }),
        pollIntervalMs: 100,
        timeoutMs: 1000,
    }), (error) => error.code === 'PROVIDER_FAILED');
});

test('assetIdFromResultUrl only accepts archived asset content paths', () => {
    assert.equal(assetIdFromResultUrl(`/api/assets/${assetId}/content`), assetId);
    assert.equal(assetIdFromResultUrl(`/api/assets/${assetId}/content/`), assetId);
    // 外部供应商 CDN 与本服务的其它路径都不属于可删除资产。
    assert.equal(assetIdFromResultUrl('https://cdn.example.test/image.png'), null);
    assert.equal(assetIdFromResultUrl(`/api/assets/${assetId}`), null);
    assert.equal(assetIdFromResultUrl(`/api/assets/${assetId}/content?x=1`), null);
    assert.equal(assetIdFromResultUrl('/api/assets/not-a-uuid/content'), null);
    assert.equal(assetIdFromResultUrl(null), null);
    assert.equal(assetIdFromResultUrl(undefined), null);
});

test('deleteAsset issues exactly one same-origin DELETE and normalizes the asset response', async () => {
    let call;
    const result = await deleteAsset(assetId, {
        fetchImpl: async (...args) => {
            call = args;
            return response({ asset: { id: assetId, status: 'deleted', deletedAt: '2026-11-13T00:00:00.000Z', alreadyDeleted: false } });
        },
    });
    assert.deepEqual(result, { id: assetId, status: 'deleted', deletedAt: '2026-11-13T00:00:00.000Z', alreadyDeleted: false });
    assert.equal(call[0], `/api/assets/${assetId}`);
    assert.equal(call[1].method, 'DELETE');
    assert.equal(call[1].credentials, 'same-origin');
    assert.equal(call[1].body, undefined);
});

test('deleteAsset treats 404 as already gone so repeated deletes stay idempotent', async () => {
    const result = await deleteAsset(assetId, {
        fetchImpl: async () => response({ error: { code: 'NOT_FOUND' } }, 404),
    });
    assert.equal(result.status, 'deleted');
    assert.equal(result.alreadyDeleted, true);
});

test('deleteAsset surfaces non-deletable and transport failures without faking success', async () => {
    await assert.rejects(deleteAsset(assetId, {
        fetchImpl: async () => response({ error: { code: 'ASSET_NOT_DELETABLE' } }, 409),
    }), (error) => error.code === 'ASSET_NOT_DELETABLE' && error.status === 409);
    await assert.rejects(deleteAsset('not-a-uuid', { fetchImpl: async () => response({}) }), TypeError);
});
