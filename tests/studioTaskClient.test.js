import test from 'node:test';
import assert from 'node:assert/strict';
import { createVideoTask, createImageTask, getImageTaskCatalog, getVideoTaskCatalog, getImageTaskModel, getStudioHistory, waitForImageTask, waitForVideoTask, isTaskResultImage, deleteAsset, assetIdFromResultUrl } from '../packages/studio/src/taskClient.js';

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { transformSync } = require('esbuild');

// 执行真实组件及模型辅助模块；只替换 React 调度、浏览器边界和网络。
function studioHarness(name, { draft = {}, catalog = null, props = {} } = {}) {
    const slots = [];
    const requests = [];
    const submissions = [];
    const alerts = [];
    const modules = new Map();
    let index = 0;
    let tree;
    let dirty = false;
    const sameDeps = (left, right) => left && right && left.length === right.length && left.every((value, i) => Object.is(value, right[i]));
    const hooks = {
        useState(initial) {
            const slot = index++;
            slots[slot] ??= { value: typeof initial === 'function' ? initial() : initial };
            return [slots[slot].value, (next) => {
                const value = typeof next === 'function' ? next(slots[slot].value) : next;
                if (!Object.is(value, slots[slot].value)) { slots[slot].value = value; dirty = true; }
            }];
        },
        useRef(initial) { const slot = index++; return slots[slot] ??= { current: initial }; },
        useMemo(callback, deps) {
            const slot = index++;
            if (!sameDeps(slots[slot]?.deps, deps)) slots[slot] = { value: callback(), deps };
            return slots[slot].value;
        },
        useCallback(callback, deps) { return hooks.useMemo(() => callback, deps); },
        useId() { return hooks.useMemo(() => `studio-${index}`, []); },
        useEffect(effect, deps) {
            const slot = index++;
            if (!sameDeps(slots[slot]?.deps, deps)) slots[slot] = { ...slots[slot], effect, deps, pending: true };
        },
    };
    const prompt = new Proxy({}, { get: (_, key) => key.endsWith('ClassName') ? () => '' : key });
    const catalogRequest = (options) => new Promise((resolve, reject) => requests.push({ options, resolve, reject }));
    const submit = async (input) => { submissions.push(input); return { id: taskId }; };
    const taskClient = {
        getImageTaskCatalog: catalogRequest, getVideoTaskCatalog: catalogRequest,
        createImageTask: submit, createVideoTask: submit,
        waitForImageTask: async () => ({ id: taskId, result: { resultUrl: `/api/assets/${assetId}/content` } }),
        waitForVideoTask: async () => ({ id: taskId, result: { resultUrl: `/api/assets/${assetId}/content` } }),
        IMAGE_TASK_ASPECT_RATIOS: ['auto', '1:1', '16:9', '9:16', '4:3', '3:4'],
        assetIdFromResultUrl: () => assetId,
    };
    function load(filename) {
        if (modules.has(filename)) return modules.get(filename).exports;
        if (filename.endsWith('.json')) return JSON.parse(readFileSync(filename, 'utf8'));
        const loadedModule = { exports: {} };
        modules.set(filename, loadedModule);
        const source = transformSync(readFileSync(filename, 'utf8'), { loader: 'jsx', format: 'cjs', jsx: 'automatic' }).code;
        const localRequire = (id) => {
            if (id === 'react') return hooks;
            if (id === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: 'Fragment' };
            if (id === 'react-hot-toast') return { __esModule: true, default: { error: (message) => alerts.push(message) }, Toaster: 'Toaster' };
            if (id.endsWith('/taskClient.js')) return taskClient;
            if (id.endsWith('/muapi.js')) return { generateI2V: () => assert.fail('不得调用旧 I2V'), processV2V: () => assert.fail('不得调用旧 V2V') };
            if (id.endsWith('/useStudioHistory.js')) return { __esModule: true, default: () => ({ items: [], refresh() {}, loading: false }) };
            if (id.endsWith('/PromptComposer.jsx')) return prompt;
            if (id.endsWith('/usePromptMenu.js')) return { __esModule: true, default: () => ({}) };
            if (id.startsWith('./') && (id.endsWith('.jsx') || id.endsWith('/ConfirmDialog.jsx'))) return new Proxy({}, { get: (_, key) => key === '__esModule' ? true : key });
            const resolved = require.resolve(path.resolve(path.dirname(filename), id));
            return load(resolved);
        };
        new Function('require', 'module', 'exports', 'localStorage', 'window', 'alert', 'setTimeout', 'clearTimeout', source)(
            localRequire, loadedModule, loadedModule.exports, { getItem: () => JSON.stringify(draft), setItem() {} },
            { addEventListener() {}, removeEventListener() {} }, (message) => alerts.push(message), () => 1, () => {});
        return loadedModule.exports;
    }
    const filename = new URL(`../packages/studio/src/components/${name}.jsx`, import.meta.url);
    const Component = load(fileURLToPath(filename)).default;
    const input = { accountId: 'account-a', locale: 'zh', ...props };
    const harness = {
        requests, submissions, alerts,
        render() {
            let attempts = 0;
            do {
                dirty = false;
                index = 0;
                tree = Component(input);
                slots.filter((slot) => slot?.pending).forEach((slot) => {
                    slot.pending = false;
                    slot.cleanup?.();
                    slot.cleanup = slot.effect();
                });
                assert.ok(++attempts < 30, '组件不得循环更新');
            } while (dirty);
            return tree;
        },
        replayEffects() {
            slots.filter((slot) => slot?.effect).forEach((slot) => slot.cleanup?.());
            slots.filter((slot) => slot?.effect).forEach((slot) => { slot.cleanup = slot.effect(); });
            this.render();
        },
        nodes(predicate, root = tree) {
            const found = [];
            const visit = (node) => {
                if (Array.isArray(node)) { node.forEach(visit); return; }
                if (!node || typeof node !== 'object') return;
                if (predicate(node)) found.push(node);
                visit(node.props?.children);
            };
            visit(root);
            return found;
        },
        action() { return this.nodes((node) => node.type === 'PromptAction')[0]; },
        enterPrompt(value = '测试生成') {
            this.nodes((node) => node.type === 'PromptTextarea')[0].props.onChange({ target: { value } });
            this.render();
        },
        async settle() { await new Promise((resolve) => setImmediate(resolve)); this.render(); },
    };
    harness.render();
    if (catalog) requests[0].resolve(catalog);
    return harness;
}

const taskId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const assetId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function response(body, status = 200) {
    return { ok: status >= 200 && status < 300, status, async json() { return body; } };
}

test('图像目录只保留纯 DTO 的可生成 image 条目，并过滤 edit-only 条目且标记 local mock', async () => {
    const models = await getImageTaskCatalog({
        fetchImpl: async () => response({ models: [
            { logicalModelId: 'edit-only', displayName: '编辑', mediaType: 'image', operations: ['image.edit'] },
            { logicalModelId: 'local-mock-image', displayName: 'Local Image', mediaType: 'image', operations: ['image.generate'], secret: 'nope' },
            { logicalModelId: 'second-image', displayName: '第二模型', mediaType: 'image', operations: ['image.generate', 'image.edit'] },
        ] }),
    });
    assert.deepEqual(models.map((model) => model.logicalModelId), ['local-mock-image', 'second-image']);
    assert.equal(models[0].displayName, 'Local Image (Mock)');
    assert.deepEqual(Object.keys(models[1]), ['logicalModelId', 'displayName', 'mediaType', 'operations', 'studioModeIds']);
});

test('视频目录只保留 video.generate DTO，并标记 local mock', async () => {
    const models = await getVideoTaskCatalog({
        fetchImpl: async (url) => {
            assert.equal(url, '/api/catalog/models?media=video');
            return response({ models: [
                { logicalModelId: 'local-mock-video', displayName: 'Local Video', mediaType: 'video', operations: ['video.generate'] },
                { logicalModelId: 'image-only', displayName: 'Image', mediaType: 'image', operations: ['image.generate'] },
            ] });
        },
    });
    assert.deepEqual(models.map((model) => model.logicalModelId), ['local-mock-video']);
    assert.equal(models[0].displayName, 'Local Video (Mock)');
    assert.deepEqual(Object.keys(models[0]), ['logicalModelId', 'displayName', 'mediaType', 'operations', 'studioModeIds']);
});

test('视频目录拒绝重复 logicalModelId 和非生成模型', async () => {
    await assert.rejects(getVideoTaskCatalog({ fetchImpl: async () => response({ models: [
        { logicalModelId: 'same-video', displayName: '一', mediaType: 'video', operations: ['video.generate'] },
        { logicalModelId: 'same-video', displayName: '二', mediaType: 'video', operations: ['video.generate'] },
    ] }) }), { code: 'DUPLICATE_VIDEO_MODEL_ID' });
    assert.deepEqual(await getVideoTaskCatalog({ fetchImpl: async () => response({ models: [
        { logicalModelId: 'edit-video', displayName: '编辑', mediaType: 'video', operations: ['video.edit'] },
    ] }) }), []);
});

test('VideoStudio 文生视频只使用公共目录 logicalModelId 和 createVideoTask', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(new URL('../packages/studio/src/components/VideoStudio.jsx', import.meta.url), 'utf8');
    assert.match(source, /getVideoTaskCatalog/);
    assert.match(source, /createVideoTask\(\{/);
    assert.match(source, /logicalModelId: selectedTaskModel\.logicalModelId/);
    assert.match(source, /const selectedPickerLabel = selectedTaskModel\?\.displayName/);
    assert.match(source, /durationMs: taskDurationMs/);
    assert.match(source, /fps: Number\(taskFps\)/);
    assert.doesNotMatch(source, /generateVideo\(/);
    assert.match(source, /disabled=\{generating \|\| mediaUploading \|\| videoTaskCatalogLoading/);
});

test('getImageTaskModel 对指定目录外 ID 不回退到第一项', async () => {
    const fetchImpl = async () => response({ models: [
        { logicalModelId: 'first-image', displayName: '第一模型', mediaType: 'image', operations: ['image.generate'] },
    ] });
    assert.equal((await getImageTaskModel({ fetchImpl })).logicalModelId, 'first-image');
    assert.equal(await getImageTaskModel({ fetchImpl, logicalModelId: 'missing-image' }), null);
});

test('图像目录重复 logicalModelId 拒绝，空目录保持空而不回退', async () => {
    await assert.rejects(getImageTaskCatalog({ fetchImpl: async () => response({ models: [
        { logicalModelId: 'same-image', displayName: '一', mediaType: 'image', operations: ['image.generate'] },
        { logicalModelId: 'same-image', displayName: '二', mediaType: 'image', operations: ['image.generate'] },
    ] }) }), { code: 'DUPLICATE_IMAGE_MODEL_ID' });
    assert.deepEqual(await getImageTaskCatalog({ fetchImpl: async () => response({ models: [
        { logicalModelId: 'edit-only', displayName: '编辑', mediaType: 'image', operations: ['image.edit'] },
    ] }) }), []);
});

test('createImageTask sends same-origin request, idempotency, and exact task payload', async () => {
    let call;
    const task = { id: taskId, status: 'queued' };
    const result = await createImageTask({
        logicalModelId: 'local-mock-image',
        outputCount: 1,
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
            outputCount: 1,
        },
    });
});

test('图片与视频客户端的非法参数在 fetch 前拒绝，不补默认值', async () => {
    let calls = 0;
    const common = { logicalModelId: 'test-model', prompt: 'synthetic', idempotencyKey: 'parameter-test-key',
        fetchImpl: async () => { calls++; return response({ task: { id: taskId } }); } };
    const invalid = [undefined, null, 0, -1, 1.5, '1', true, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1];
    for (const outputCount of [...invalid, 2, Number.MAX_SAFE_INTEGER]) {
        await assert.rejects(createImageTask({ ...common, outputCount }), TypeError);
    }
    for (const key of ['durationMs', 'fps']) {
        for (const value of invalid) {
            await assert.rejects(createVideoTask({ ...common, durationMs: 1000, fps: 1, [key]: value }), TypeError);
        }
    }
    for (const logicalModelId of [undefined, '', 'Invalid Model', 'a']) {
        await assert.rejects(createImageTask({ ...common, outputCount: 1, logicalModelId }), TypeError);
        await assert.rejects(createVideoTask({ ...common, durationMs: 1000, fps: 1, logicalModelId }), TypeError);
    }
    for (const prompt of [undefined, '', '   ', 'x'.repeat(4097)]) {
        await assert.rejects(createImageTask({ ...common, outputCount: 1, prompt }), TypeError);
        await assert.rejects(createVideoTask({ ...common, durationMs: 1000, fps: 1, prompt }), TypeError);
    }
    assert.equal(calls, 0);
});

test('视频客户端只提交显式毫秒和精确帧率，并透传幂等键与取消信号', async () => {
    let call;
    const signal = new AbortController().signal;
    const task = { id: taskId, status: 'queued' };
    assert.deepEqual(await createVideoTask({ logicalModelId: 'local-mock-video', prompt: ' synthetic ', durationMs: 1000, fps: 1,
        idempotencyKey: 'studio-video-test', signal, fetchImpl: async (...args) => { call = args; return response({ task }); } }), task);
    assert.equal(call[0], '/api/tasks');
    assert.equal(call[1].method, 'POST');
    assert.equal(call[1].credentials, 'same-origin');
    assert.equal(call[1].headers['Idempotency-Key'], 'studio-video-test');
    assert.equal(call[1].signal, signal);
    assert.deepEqual(JSON.parse(call[1].body), { taskType: 'video.generate',
        payload: { logicalModelId: 'local-mock-video', prompt: 'synthetic', durationMs: 1000, fps: 1 } });
});

test('视频任务轮询只接受拥有的 video 结果 URL', async () => {
    const states = [
        { task: { id: taskId, status: 'running' } },
        { task: { id: taskId, status: 'succeeded', result: { mediaType: 'video', resultUrl: 'https://cdn.example.test/video.mp4' } } },
    ];
    const result = await waitForVideoTask(taskId, {
        fetchImpl: async (url) => {
            assert.equal(url, `/api/tasks/${taskId}`);
            return response(states.shift());
        },
        pollIntervalMs: 100,
        timeoutMs: 1000,
        now: () => 0,
        sleep: async () => {},
    });
    assert.equal(result.result.resultUrl, 'https://cdn.example.test/video.mp4');
});

test('视频 Mock 成功但没有结果 URL 时明确拒绝展示', async () => {
    await assert.rejects(waitForVideoTask(taskId, {
        fetchImpl: async () => response({ task: { id: taskId, status: 'succeeded', result: { kind: 'mock-asset', mediaType: 'video/mp4', resultUrl: null } } }),
        pollIntervalMs: 100,
        timeoutMs: 1000,
    }), { code: 'VIDEO_RESULT_NOT_AVAILABLE' });
});

test('VideoStudio 等待视频任务完成后才归档可播放历史', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(new URL('../packages/studio/src/components/VideoStudio.jsx', import.meta.url), 'utf8');
    assert.match(source, /waitForVideoTask\(task\.id/);
    assert.match(source, /const resultUrl = completedTask\.result\.resultUrl/);
    assert.match(source, /addToLocalHistory\(entry\)/);
    assert.match(source, /signal: taskController\.signal/);
});

test('视频客户端不把能力拒绝或无效响应伪装为成功', async () => {
    const input = { logicalModelId: 'test-video', prompt: 'synthetic', durationMs: 1000, fps: 1, idempotencyKey: 'video-error-test' };
    await assert.rejects(createVideoTask({ ...input, fetchImpl: async () => response({ error: { code: 'MODEL_PARAMETERS_UNSUPPORTED' } }, 409) }),
        { code: 'MODEL_PARAMETERS_UNSUPPORTED', status: 409 });
    await assert.rejects(createVideoTask({ ...input, fetchImpl: async () => response({ task: {} }) }), /INVALID_TASK_RESPONSE/);
});

test('ImageStudio 按账号隔离持久化状态，并避免迁移共享旧 key', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(new URL('../packages/studio/src/components/ImageStudio.jsx', import.meta.url), 'utf8');
    const persistKey = await readFile(new URL('../packages/studio/src/persistKey.js', import.meta.url), 'utf8');
    assert.match(source, /accountId = null/);
    assert.match(source, /const persistIdentity = accountId \\|\\| apiKey \\|\\| null/);
    assert.match(source, /scopedPersistKey\(LEGACY_PERSIST_KEY, persistIdentity\)/);
    assert.doesNotMatch(source, /migrateLegacyPersistKey/);
    assert.match(persistKey, /if \(!identity\) return/);
});

test('ImageStudio 使用目录选择的 logicalModelId，显式单张，并不调用旧供应商生成函数', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(new URL('../packages/studio/src/components/ImageStudio.jsx', import.meta.url), 'utf8');
    assert.match(source, /createImageTask\(\{\s*logicalModelId: selectedModelId,\s*outputCount: 1,/);
    assert.doesNotMatch(source, /generateImage\(|generateI2I\(/);
    assert.match(source, /getImageTaskCatalog\(\{ signal: controller\.signal \}\)/);
    assert.match(source, /controller\.abort\(\)/);
    assert.match(source, /CatalogModelSelect/);
    assert.doesNotMatch(source, /setSelectedModelId\(data\.selectedModelId\)/);
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

const historyItem = {
    id: taskId, assetId, resultUrl: `/api/assets/${assetId}/content`,
    logicalModelId: 'local-mock-image', prompt: '历史提示词', createdAt: '2026-11-21T00:00:00.000Z',
};

test('账号历史客户端保留原始 DTO，并透传分页及取消信号', async () => {
    for (const media of ['image', 'video']) {
        const signal = new AbortController().signal;
        const page = { accountId: 'account-a', items: [historyItem], nextCursor: '下一页+/=' };
        const result = await getStudioHistory({ accountId: 'account-a', media, limit: 7, cursor: '游标+/=', signal,
            fetchImpl: async (url, options) => {
                const query = new URL(url, 'http://localhost').searchParams;
                assert.equal(query.get('view'), 'studio-history');
                assert.equal(query.get('media'), media);
                assert.equal(query.get('limit'), '7');
                assert.equal(query.get('cursor'), '游标+/=');
                assert.equal(query.has('accountId'), false);
                assert.equal(options.method, 'GET');
                assert.equal(options.credentials, 'same-origin');
                assert.equal(options.cache, 'no-store');
                assert.equal(options.signal, signal);
                return response(page);
            } });
        assert.deepEqual(result, page);
        assert.equal(result.items[0].url, undefined);
        assert.equal(result.items[0].model, undefined);
        assert.equal(result.items[0].timestamp, undefined);
    }
});

test('账号历史拒绝身份错配、非法 DTO 和错误分页响应', async () => {
    const base = { accountId: 'account-a', items: [historyItem], nextCursor: null };
    await assert.rejects(getStudioHistory({ accountId: 'account-b', media: 'image', fetchImpl: async () => response(base) }),
        { code: 'STUDIO_HISTORY_ACCOUNT_MISMATCH' });
    for (const body of [
        { ...base, items: null }, { ...base, nextCursor: '' }, { ...base, nextCursor: 'same' },
        { ...base, nextCursor: undefined },
        ...[{ resultUrl: 'https://cdn.example.test/image.png' }, { assetId: taskId }, { createdAt: 'invalid' },
            { logicalModelId: 1 }, { prompt: {} }].map((change) => ({ ...base, items: [{ ...historyItem, ...change }] })),
    ]) {
        await assert.rejects(getStudioHistory({ accountId: 'account-a', media: 'image', cursor: 'same',
            fetchImpl: async () => response(body) }), { code: 'INVALID_STUDIO_HISTORY_RESPONSE' });
    }
    assert.deepEqual(await getStudioHistory({ accountId: 'account-a', media: 'video',
        fetchImpl: async () => response({ ...base, items: [], nextCursor: null }) }), { ...base, items: [] });
});

test('账号历史失败明确上抛，取消前后均不接受响应', async () => {
    let calls = 0;
    const fetchImpl = async () => { calls++; return response({}); };
    await assert.rejects(getStudioHistory({ media: 'image', fetchImpl }), { code: 'STUDIO_HISTORY_ACCOUNT_REQUIRED' });
    await assert.rejects(getStudioHistory({ accountId: 'account-a', media: 'audio', fetchImpl }), TypeError);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(getStudioHistory({ accountId: 'account-a', media: 'image', signal: controller.signal, fetchImpl }), { name: 'AbortError' });
    assert.equal(calls, 0);
    const lateController = new AbortController();
    await assert.rejects(getStudioHistory({ accountId: 'account-a', media: 'image', signal: lateController.signal,
        fetchImpl: async () => { lateController.abort(); return response({ accountId: 'account-a', items: [historyItem], nextCursor: null }); } }), { name: 'AbortError' });
    for (const status of [401, 403, 500]) {
        await assert.rejects(getStudioHistory({ accountId: 'account-a', media: 'image',
            fetchImpl: async () => response({ error: { code: 'HISTORY_UNAVAILABLE' } }, status) }), { code: 'HISTORY_UNAVAILABLE', status });
    }
});

test('两个工作室只从 Hook 读取账号历史，并隔离草稿和旧嵌入模式', async () => {
    const { readFile } = await import('node:fs/promises');
    for (const [name, media] of [['ImageStudio', 'image'], ['VideoStudio', 'video']]) {
        const source = await readFile(new URL(`../packages/studio/src/components/${name}.jsx`, import.meta.url), 'utf8');
        assert.match(source, new RegExp(`useStudioHistory\\(accountId, "${media}"\\)`));
        assert.match(source, /const useAccountHistory = Boolean\(accountId\);/);
        assert.match(source, /const \[localHistory, setLocalHistory\] = useState\(\[\]\)/);
        assert.doesNotMatch(source, /getStudioHistory|migrateLegacyPersistKey|const \[history, setHistory\]/);
        assert.match(source, /if \(!accountId && data.localHistory\) setLocalHistory\(data.localHistory\)/);
        assert.match(source, /\.\.\.\(!accountId \? \{ localHistory \} : \{\}\)/);
        assert.match(source, /scopedPersistKey\(LEGACY_PERSIST_KEY, persistIdentity\)/);
        assert.match(source, /if \(assetId\) await deleteAsset\(assetId\);\s*if \(useAccountHistory\) \{\s*await studioHistory.refresh\(\)/);
        assert.match(source, /void studioHistory.refresh\(\)/);
        assert.match(source, /studioHistory.retry\(\)/);
        assert.match(source, /studioHistory.loadMore\(\)/);
        assert.match(source, /generateError &&/);
    }
    const shell = await readFile(new URL('../components/StandaloneShell.js', import.meta.url), 'utf8');
    for (const name of ['ImageStudio', 'VideoStudio']) {
        assert.match(shell, new RegExp(`<${name} key=.+accountId=\\{currentUser\\?\\.id \\|\\| null\\}`));
    }
});

// 使用最小 Hook 调度器测试真实 Hook 函数，不新增 DOM 或测试框架依赖。
async function historyHarness({ assets = false } = {}) {
    const { readFile } = await import('node:fs/promises');
    const filename = assets ? 'useAssets.js' : 'useStudioHistory.js';
    const source = await readFile(new URL(`../packages/studio/src/${filename}`, import.meta.url), 'utf8');
    const slots = [];
    const pendingEffects = [];
    const requests = [];
    let index = 0;
    const sameDeps = (left, right) => left && right && left.length === right.length && left.every((value, i) => Object.is(value, right[i]));
    const useState = (initial) => {
        const slot = index++;
        if (!slots[slot]) slots[slot] = { value: initial };
        return [slots[slot].value, (next) => { slots[slot].value = typeof next === 'function' ? next(slots[slot].value) : next; }];
    };
    const useRef = (initial) => {
        const slot = index++;
        if (!slots[slot]) slots[slot] = { current: initial };
        return slots[slot];
    };
    const useCallback = (callback, deps) => {
        const slot = index++;
        if (!sameDeps(slots[slot]?.deps, deps)) slots[slot] = { callback, deps };
        return slots[slot].callback;
    };
    const useEffect = (effect, deps) => {
        const slot = index++;
        if (!sameDeps(slots[slot]?.deps, deps)) {
            pendingEffects.push(() => {
                slots[slot]?.cleanup?.();
                slots[slot] = { deps, cleanup: effect() };
            });
        }
    };
    const getHistory = (options) => new Promise((resolve, reject) => requests.push({ options, resolve, reject }));
    const hook = new Function('useCallback', 'useEffect', 'useRef', 'useState', assets ? 'getAssets' : 'getStudioHistory', 'subscribeAssetInvalidations',
        source.replace(/^import .*;\r?\n/gm, '').replace('export default function', 'return function'))(
        useCallback, useEffect, useRef, useState, getHistory, () => () => {});
    return {
        requests,
        render(accountId = 'account-a', media = 'image', commit = true) {
            index = 0;
            const result = hook(accountId, media, true);
            if (commit) this.commit();
            return result;
        },
        commit() { pendingEffects.splice(0).forEach((effect) => effect()); },
        unmount() { slots.forEach((slot) => slot?.cleanup?.()); },
        async settle() { await new Promise((resolve) => setImmediate(resolve)); },
    };
}

test('资产 Hook 切换全部/单类与账号时丢弃旧游标和迟到响应', async () => {
    const harness = await historyHarness({ assets: true });
    harness.render('account-a', 'all');
    harness.requests[0].resolve({ items: [{ id: 'a-image' }, { id: 'a-video' }], nextCursor: 'mixed-page-2' });
    await harness.settle();
    const first = harness.render('account-a', 'all');
    assert.equal(first.items.length, 2);
    const latePage = first.loadMore();
    assert.equal(harness.requests[1].options.cursor, 'mixed-page-2');
    const switched = harness.render('account-a', 'video');
    assert.deepEqual(switched.items, []);
    assert.equal(switched.nextCursor, null);
    assert.equal(harness.requests[1].options.signal.aborted, true);
    assert.equal(harness.requests[2].options.media, 'video');
    assert.equal(harness.requests[2].options.cursor, null);
    harness.render('account-b', 'all');
    assert.equal(harness.requests[2].options.signal.aborted, true);
    harness.requests[3].resolve({ items: [{ id: 'b-video' }], nextCursor: null });
    harness.requests[2].resolve({ items: [{ id: 'a-video' }], nextCursor: null });
    harness.requests[1].resolve({ items: [{ id: 'a-old-page' }], nextCursor: null });
    await latePage;
    await harness.settle();
    assert.deepEqual(harness.render('account-b', 'all').items, [{ id: 'b-video' }]);
    harness.unmount();
});

test('历史 Hook 映射组件字段、分页去重、失败保留当前页并重试原游标', async () => {
    const harness = await historyHarness();
    harness.render();
    assert.equal(harness.requests[0].options.limit, 20);
    harness.requests[0].resolve({ items: [historyItem], nextCursor: 'page-2' });
    await harness.settle();
    let result = harness.render();
    assert.deepEqual(result.items, [{ id: taskId, assetId, url: historyItem.resultUrl, model: historyItem.logicalModelId,
        prompt: historyItem.prompt, timestamp: historyItem.createdAt }]);
    const failedLoad = result.loadMore();
    assert.equal(harness.requests[0].options.signal.aborted, true);
    harness.requests[1].reject(new Error('分页失败'));
    await failedLoad;
    result = harness.render();
    assert.equal(result.items.length, 1);
    assert.equal(result.nextCursor, 'page-2');
    assert.equal(result.error.message, '分页失败');
    const retry = result.retry();
    assert.equal(harness.requests[2].options.cursor, 'page-2');
    harness.requests[2].resolve({ items: [historyItem, { ...historyItem, id: 'second-task' }], nextCursor: null });
    await retry;
    result = harness.render();
    assert.deepEqual(result.items.map((item) => item.id), [taskId, 'second-task']);
    assert.equal(result.error, null);
    assert.equal(result.loading, false);
    assert.equal(result.loadMore(), undefined);
    harness.unmount();
});

test('历史 Hook 刷新、账号切换和卸载取消旧请求，晚到响应不得污染新账号', async () => {
    const harness = await historyHarness();
    let result = harness.render();
    const refresh = result.refresh();
    assert.equal(harness.requests[0].options.signal.aborted, true);
    harness.requests[0].resolve({ items: [historyItem], nextCursor: 'stale' });
    harness.requests[1].resolve({ items: [{ ...historyItem, id: 'fresh' }], nextCursor: null });
    await refresh;
    result = harness.render();
    assert.equal(result.items[0].id, 'fresh');
    const pendingRefresh = result.refresh();
    result = harness.render('account-b', 'image', false);
    assert.deepEqual(result.items, []);
    assert.equal(result.loading, true);
    harness.commit();
    assert.equal(harness.requests[2].options.signal.aborted, true);
    assert.equal(harness.requests[3].options.accountId, 'account-b');
    harness.requests[2].resolve({ items: [historyItem], nextCursor: null });
    await pendingRefresh;
    harness.requests[3].reject(new Error('账号历史失败'));
    await harness.settle();
    result = harness.render('account-b');
    assert.deepEqual(result.items, []);
    assert.equal(result.error.message, '账号历史失败');
    const retry = result.retry();
    harness.unmount();
    assert.equal(harness.requests[4].options.signal.aborted, true);
    harness.requests[4].resolve({ items: [historyItem], nextCursor: null });
    await retry;
    assert.deepEqual(harness.render(null).items, []);
    assert.equal(harness.requests.length, 5);
});

test('历史 Hook 未登录不请求，媒体切换立即清空', async () => {
    const harness = await historyHarness();
    assert.deepEqual(harness.render(null).items, []);
    assert.equal(harness.requests.length, 0);
    harness.render();
    harness.requests[0].resolve({ items: [historyItem], nextCursor: null });
    await harness.settle();
    assert.equal(harness.render().items.length, 1);
    assert.deepEqual(harness.render('account-a', 'video').items, []);
    assert.equal(harness.requests[1].options.media, 'video');
    harness.unmount();
});

const imageCatalog = [{ logicalModelId: 'local-mock-image', displayName: '图片 Mock', mediaType: 'image', operations: ['image.generate'] }];
const videoCatalog = [{ logicalModelId: 'local-mock-video', displayName: '视频 Mock', mediaType: 'video', operations: ['video.generate'] }];

test('两个工作室在 StrictMode effect 清理重放后重新加载目录并允许提交', async () => {
    for (const [name, models] of [['ImageStudio', imageCatalog], ['VideoStudio', videoCatalog]]) {
        const harness = studioHarness(name);
        harness.replayEffects();
        assert.equal(harness.requests.length, 2);
        assert.equal(harness.requests[0].options.signal.aborted, true);
        harness.requests[0].reject(new DOMException('已取消', 'AbortError'));
        harness.requests[1].resolve(models);
        await harness.settle();
        harness.enterPrompt();
        assert.equal(Boolean(harness.action().props.disabled), false);
        await harness.action().props.onClick();
        assert.equal(harness.submissions.length, 1);
        assert.equal(harness.submissions[0].logicalModelId, models[0].logicalModelId);
    }
});

test('图片旧参考图草稿及清除动作不得覆盖公共目录模型或阻断文生图', async () => {
    const harness = studioHarness('ImageStudio', {
        draft: { imageMode: true, selectedModelId: 'legacy-provider', uploadedImageUrls: ['legacy.png'], prompt: '旧提示词' },
        catalog: imageCatalog,
    });
    await harness.settle();
    const previews = harness.nodes((node) => node.type === 'img' && node.props.src === 'legacy.png');
    for (const preview of previews) {
        const parent = harness.nodes((node) => Array.isArray(node.props?.children) && node.props.children.includes(preview))[0];
        parent.props.children.find((node) => node?.type === 'button').props.onClick();
    }
    harness.render();
    await harness.action().props.onClick();
    assert.deepEqual(harness.alerts, []);
    assert.equal(harness.submissions.length, 1);
    assert.equal(harness.submissions[0].logicalModelId, 'local-mock-image');
});

test('视频旧续写模式不应控制公共目录按钮、提示词及任务提交', async () => {
    const harness = studioHarness('VideoStudio', {
        draft: { selectedModel: 'seedance-2-extend', selectedWorkflowId: null, prompt: '旧视频提示词' },
        catalog: videoCatalog,
    });
    await harness.settle();
    assert.equal(harness.nodes((node) => node.type === 'PromptTextarea')[0].props.disabled, false);
    assert.equal(Boolean(harness.action().props.disabled), false);
    await harness.action().props.onClick();
    assert.deepEqual(harness.alerts, []);
    assert.equal(harness.submissions.length, 1);
    assert.equal(harness.submissions[0].logicalModelId, 'local-mock-video');
});

test('公共目录模型可实际切换且提交对应 ID，图片目录指定 ID 失效仍可重新选择', async () => {
    for (const [name, models, props] of [
        ['ImageStudio', [...imageCatalog, { ...imageCatalog[0], logicalModelId: 'second-image' }], { taskModelId: 'removed-image' }],
        ['VideoStudio', [...videoCatalog, { ...videoCatalog[0], logicalModelId: 'second-video' }], {}],
    ]) {
        const harness = studioHarness(name, { catalog: models, props });
        await harness.settle();
        harness.nodes((node) => node.type === 'PromptControls')[0].props.children[0].props.children[0].props.onClick({ stopPropagation() {} });
        harness.render();
        const selector = name === 'ImageStudio'
            ? harness.nodes((node) => typeof node.type === 'function' && node.type.name === 'CatalogModelSelect')[0]
            : harness.nodes((node) => node.type === 'select' && node.props['aria-label'] === '模型')[0];
        assert.equal(Boolean(selector.props.disabled), false);
        if (name === 'ImageStudio') selector.props.onSelect('second-image');
        else selector.props.onChange({ target: { value: 'second-video' } });
        harness.enterPrompt();
        assert.equal(Boolean(harness.action().props.disabled), false);
        await harness.action().props.onClick();
        assert.equal(harness.submissions[0].logicalModelId, models[1].logicalModelId);
    }
});

test('两个目录均忽略取消请求的迟到成功，避免已选模型被覆盖', async () => {
    for (const [name, models] of [['ImageStudio', imageCatalog], ['VideoStudio', videoCatalog]]) {
        const harness = studioHarness(name);
        harness.replayEffects();
        harness.requests[1].resolve(models);
        await harness.settle();
        harness.requests[0].resolve([{ ...models[0], logicalModelId: 'stale-model' }]);
        await harness.settle();
        harness.enterPrompt();
        await harness.action().props.onClick();
        assert.equal(harness.submissions.length, 1);
        assert.equal(harness.submissions[0].logicalModelId, models[0].logicalModelId);
    }
});

test('目录为空或失败时两个工作室保持禁用且不提交旧供应商任务', async () => {
    for (const name of ['ImageStudio', 'VideoStudio']) {
        for (const failure of [false, true]) {
            const harness = studioHarness(name);
            if (failure) harness.requests[0].reject(Object.assign(new Error('加载失败'), { code: 'CATALOG_UNAVAILABLE' }));
            else harness.requests[0].resolve([]);
            await harness.settle();
            harness.enterPrompt();
            assert.equal(Boolean(harness.action().props.disabled), true);
            await harness.action().props.onClick();
            assert.equal(harness.submissions.length, 0);
        }
    }
});

test('视频旧 I2V/V2V 媒体草稿不触发旧供应商路径，文生视频提示词保持可编辑', async () => {
    for (const draft of [
        { selectedModel: 'seedance-2-extend', imageMode: true, selectedWorkflowId: 'keyframes', uploadedImageUrls: ['old-image.png'] },
        { selectedModel: 'seedance-2-extend', v2vMode: true, selectedWorkflowId: 'edit_video', uploadedVideoUrls: ['old-video.mp4'] },
    ]) {
        const harness = studioHarness('VideoStudio', { draft, catalog: videoCatalog });
        await harness.settle();
        harness.enterPrompt();
        assert.equal(harness.nodes((node) => node.type === 'PromptTextarea')[0].props.disabled, false);
        assert.equal(Boolean(harness.action().props.disabled), false);
        await harness.action().props.onClick();
        assert.equal(harness.submissions.length, 1);
        assert.equal(harness.submissions[0].durationMs, 1000);
        assert.deepEqual(harness.alerts, []);
    }
});

test('视频目录重放时拒绝取消请求的迟到失败，不得覆盖成功目录', async () => {
    const harness = studioHarness('VideoStudio');
    harness.replayEffects();
    harness.requests[1].resolve(videoCatalog);
    await harness.settle();
    harness.requests[0].reject(Object.assign(new Error('旧请求失败'), { code: 'OLD_REQUEST_ERROR' }));
    await harness.settle();
    harness.enterPrompt();
    assert.equal(Boolean(harness.action().props.disabled), false);
});

function studioText(node) {
    if (Array.isArray(node)) return node.map(studioText).join(' ');
    if (node && typeof node === 'object') return studioText(node.props?.children);
    return typeof node === 'string' || typeof node === 'number' ? String(node) : '';
}

function videoParameterButton(harness, label) {
    const controls = harness.nodes((node) => node.type === 'PromptControls')[0];
    const button = harness.nodes((node) => node.type === 'button' && node.props['aria-label'] === label, controls)[0];
    assert.ok(button, `底部工具栏应展示${label}按钮`);
    return button;
}

function videoParameterInput(harness, label) {
    const button = videoParameterButton(harness, label);
    if (!button.props['aria-expanded']) {
        button.props.onClick({ stopPropagation() {} });
        harness.render();
    }
    const popover = harness.nodes((node) => node.type === 'PromptPopover' && node.props['aria-label'] === label)[0];
    assert.ok(popover, `打开${label}按钮后应展示对应弹窗`);
    return harness.nodes((node) => node.type === 'input', popover)[0];
}

function selectVideoModel(harness, logicalModelId) {
    harness.nodes((node) => node.type === 'PromptControls')[0].props.children[0].props.children[0].props.onClick({ stopPropagation() {} });
    harness.render();
    harness.nodes((node) => node.type === 'select' && node.props['aria-label'] === '模型')[0].props.onChange({ target: { value: logicalModelId } });
    harness.render();
}

test('视频参数只以模型按钮后的紧凑工具栏展示，初始没有常驻大表单或说明', async () => {
    const harness = studioHarness('VideoStudio', { catalog: [{ ...videoCatalog[0], logicalModelId: 'test-video' }] });
    await harness.settle();
    const panel = harness.nodes((node) => node.type === 'PromptComposer')[0];
    const controls = harness.nodes((node) => node.type === 'PromptControls', panel)[0];
    const buttons = harness.nodes((node) => node.type === 'button', controls);
    assert.deepEqual(buttons.slice(1, 5).map((node) => node.props['aria-label']), ['时长', '帧率', '宽高比', '分辨率']);
    assert.equal(studioText(videoParameterButton(harness, '时长')).replace(/\s/g, ''), '5s');
    assert.equal(studioText(videoParameterButton(harness, '帧率')).replace(/\s/g, ''), '24fps');
    assert.equal(harness.nodes((node) => node.type === 'fieldset' || node.type === 'legend', panel).length, 0);
    assert.equal(harness.nodes((node) => node.type === 'input' && node.props.type === 'number', panel).length, 0);
    assert.equal(harness.nodes((node) => node.type === 'PromptPopover', panel).length, 0);
    assert.doesNotMatch(studioText(panel), /文生视频参数|服务端校验|Mock 固定限制|未接入宽高比和分辨率参数/);
    for (const label of ['宽高比', '分辨率']) {
        const button = videoParameterButton(harness, label);
        assert.equal(button.props.disabled, true);
        assert.match(button.props.title, /未接入宽高比和分辨率参数/);
    }
    assert.equal(videoParameterInput(harness, '时长').props.value, 5);
    assert.match(studioText(harness.render()), /服务端校验/);
    assert.equal(videoParameterButton(harness, '时长').props['aria-expanded'], true);
    videoParameterInput(harness, '帧率');
    assert.equal(videoParameterButton(harness, '时长').props['aria-expanded'], false);
    assert.equal(harness.nodes((node) => node.type === 'PromptPopover').length, 1);
    videoParameterButton(harness, '帧率').props.onClick({ stopPropagation() {} });
    harness.render();
    assert.equal(harness.nodes((node) => node.type === 'PromptPopover').length, 0);
});

test('视频 Mock 工具栏展示固定 1 秒和 1 fps，旧草稿不能使弹窗控件与提交不一致', async () => {
    const harness = studioHarness('VideoStudio', { draft: { selectedDuration: 10 }, catalog: videoCatalog });
    await harness.settle();
    assert.equal(studioText(videoParameterButton(harness, '时长')).replace(/\s/g, ''), 'Mock1s');
    assert.equal(studioText(videoParameterButton(harness, '帧率')).replace(/\s/g, ''), 'Mock1fps');
    assert.doesNotMatch(studioText(harness.render()), /Mock 固定限制/);
    const duration = videoParameterInput(harness, '时长');
    assert.match(studioText(harness.render()), /Mock 固定限制：1 秒、1 fps，不可调整/);
    const fps = videoParameterInput(harness, '帧率');
    assert.equal(duration.props.value, 1);
    assert.equal(duration.props.disabled, true);
    assert.equal(fps.props.value, 1);
    assert.equal(fps.props.disabled, true);
    assert.match(studioText(harness.render()), /Mock 固定限制：1 秒、1 fps，不可调整/);
    assert.ok(duration.props['aria-describedby']);
    assert.ok(fps.props['aria-describedby']);
    for (const label of ['宽高比', '分辨率']) {
        const button = videoParameterButton(harness, label);
        assert.equal(button.props.disabled, true);
        assert.match(button.props.title, /未接入宽高比和分辨率参数/);
    }
    harness.enterPrompt();
    await harness.action().props.onClick();
    assert.equal(harness.submissions[0].durationMs, duration.props.value * 1000);
    assert.equal(harness.submissions[0].fps, fps.props.value);
    assert.equal(Object.hasOwn(harness.submissions[0], 'aspectRatio'), false);
    assert.equal(Object.hasOwn(harness.submissions[0], 'resolution'), false);
});

test('视频非 Mock 参数交互精确提交毫秒和整数帧率，切换 Mock 后恢复固定限制', async () => {
    const harness = studioHarness('VideoStudio', { catalog: [...videoCatalog, { ...videoCatalog[0], logicalModelId: 'test-video', displayName: '测试视频' }] });
    await harness.settle();
    selectVideoModel(harness, 'test-video');
    assert.equal(videoParameterInput(harness, '时长').props.disabled, false);
    assert.equal(videoParameterInput(harness, '帧率').props.disabled, false);
    videoParameterInput(harness, '时长').props.onChange({ target: { value: '2.125' } });
    videoParameterInput(harness, '帧率').props.onChange({ target: { value: '30' } });
    harness.enterPrompt();
    assert.equal(studioText(videoParameterButton(harness, '时长')).replace(/\s/g, ''), '2.125s');
    assert.equal(studioText(videoParameterButton(harness, '帧率')).replace(/\s/g, ''), '30fps');
    await harness.action().props.onClick();
    harness.render();
    assert.equal(harness.submissions[0].durationMs, 2125);
    assert.equal(harness.submissions[0].fps, 30);
    selectVideoModel(harness, 'local-mock-video');
    assert.equal(videoParameterInput(harness, '时长').props.value, 1);
    assert.equal(videoParameterInput(harness, '帧率').props.value, 1);
    await harness.action().props.onClick();
    harness.render();
    assert.equal(harness.submissions[1].durationMs, 1000);
    assert.equal(harness.submissions[1].fps, 1);
    selectVideoModel(harness, 'test-video');
    assert.equal(videoParameterInput(harness, '时长').props.value, '2.125');
    assert.equal(videoParameterInput(harness, '帧率').props.value, '30');
});

test('视频非法时长和帧率禁用生成且不静默取整提交', async () => {
    const harness = studioHarness('VideoStudio', { catalog: [{ ...videoCatalog[0], logicalModelId: 'test-video' }] });
    await harness.settle();
    harness.enterPrompt();
    for (const [label, value] of [['时长', ''], ['时长', '0'], ['时长', '1.0001'], ['帧率', '1.5'], ['帧率', '-1']]) {
        videoParameterInput(harness, '时长').props.onChange({ target: { value: '2' } });
        videoParameterInput(harness, '帧率').props.onChange({ target: { value: '24' } });
        videoParameterInput(harness, label).props.onChange({ target: { value } });
        harness.render();
        assert.equal(Boolean(harness.action().props.disabled), true);
        await harness.action().props.onClick();
        assert.equal(harness.submissions.length, 0);
    }
});

test('图片目录四态及重试始终位于 PromptComposer 内，不受图库滚动或模型菜单影响', async () => {
    const historyItems = Array.from({ length: 30 }, (_, index) => ({ id: `history-${index}`, url: `history-${index}.png` }));
    const harness = studioHarness('ImageStudio', { props: { accountId: null, historyItems } });
    const panel = () => harness.nodes((node) => node.type === 'PromptComposer')[0];
    const status = () => harness.nodes((node) => node.props?.['data-image-catalog-status'] !== undefined, panel())[0];
    const retry = () => harness.nodes((node) => node.type === 'button' && studioText(node) === '重试加载图片模型', panel())[0];
    assert.equal(status().props['data-image-catalog-status'], 'loading');
    assert.match(studioText(status()), /正在加载图片模型目录/);
    assert.match(studioText(status()), /IMAGE_MODEL_CATALOG_LOADING/);
    assert.equal(retry().props.disabled, true);
    harness.enterPrompt();
    assert.equal(Boolean(harness.action().props.disabled), true);
    harness.requests[0].reject(Object.assign(new Error('内部连接信息不得展示'), { code: 'CATALOG_UNAVAILABLE' }));
    await harness.settle();
    assert.equal(status().props['data-image-catalog-status'], 'error');
    assert.equal(status().props.role, 'alert');
    assert.match(studioText(status()), /CATALOG_UNAVAILABLE/);
    assert.doesNotMatch(studioText(panel()), /内部连接信息不得展示|PAINTTRACK_LOCAL_MOCK_ROUTING/);
    assert.equal(retry().props.disabled, false);
    await harness.action().props.onClick();
    assert.equal(harness.submissions.length, 0);
    retry().props.onClick();
    harness.render();
    assert.equal(harness.requests.length, 2);
    assert.equal(harness.requests[0].options.signal.aborted, true);
    assert.equal(status().props['data-image-catalog-status'], 'loading');
    harness.requests[1].resolve([]);
    await harness.settle();
    assert.equal(status().props['data-image-catalog-status'], 'empty');
    assert.match(studioText(status()), /NO_IMAGE_TASK_MODEL/);
    assert.match(studioText(status()), /若用于本地 Mock 测试且尚未开启 Mock/);
    assert.match(studioText(status()), /启动器显式设置 PAINTTRACK_LOCAL_MOCK_ROUTING=1 并完整重启启动器/);
    assert.match(studioText(status()), /不会自动回退到 Mock/);
    assert.equal(Boolean(harness.action().props.disabled), true);
    retry().props.onClick();
    harness.render();
    harness.requests[2].resolve(imageCatalog);
    await harness.settle();
    assert.equal(status().props['data-image-catalog-status'], 'loaded');
    assert.equal(status().props.role, 'status');
    assert.match(studioText(status()), /已加载 1 个文生图模型/);
    assert.doesNotMatch(studioText(panel()), /PAINTTRACK_LOCAL_MOCK_ROUTING|NO_IMAGE_TASK_MODEL/);
    assert.equal(retry().props.disabled, false);
    assert.equal(Boolean(harness.action().props.disabled), false);
    assert.equal(harness.nodes((node) => node.props?.['data-image-catalog-status'] !== undefined).length, 1);
    await harness.action().props.onClick();
    assert.equal(harness.submissions[0].logicalModelId, 'local-mock-image');
    assert.equal(harness.submissions[0].outputCount, 1);
});

test('图片目录只展示安全错误码，认证拒绝与未知错误都不回退 Mock', async () => {
    for (const code of ['UNAUTHENTICATED', 'FORBIDDEN', 'MFA_REQUIRED', 'INVALID_IMAGE_CATALOG', 'DUPLICATE_IMAGE_MODEL_ID',
        'postgres://internal-secret', 'INTERNAL_SECRET_TOKEN', { secret: '内部信息' }, undefined]) {
        const harness = studioHarness('ImageStudio');
        harness.requests[0].reject(Object.assign(new Error('内部错误详情'), { code }));
        await harness.settle();
        const panel = harness.nodes((node) => node.type === 'PromptComposer')[0];
        const status = harness.nodes((node) => node.props?.['data-image-catalog-status'] === 'error', panel)[0];
        const safeCode = ['UNAUTHENTICATED', 'FORBIDDEN', 'MFA_REQUIRED', 'INVALID_IMAGE_CATALOG', 'DUPLICATE_IMAGE_MODEL_ID'].includes(code)
            ? code : 'CATALOG_QUERY_FAILED';
        assert.equal(studioText(harness.nodes((node) => node.type === 'code', status)[0]), safeCode);
        assert.doesNotMatch(studioText(panel), /internal-secret|INTERNAL_SECRET_TOKEN|内部信息|内部错误详情|PAINTTRACK_LOCAL_MOCK_ROUTING/);
        harness.enterPrompt();
        assert.equal(Boolean(harness.action().props.disabled), true);
        await harness.action().props.onClick();
        assert.equal(harness.submissions.length, 0);
    }
});

test('图片目录指定模型失效展示诊断，而不是误报空目录或提示开启 Mock', async () => {
    const harness = studioHarness('ImageStudio', { catalog: imageCatalog, props: { taskModelId: 'removed-image' } });
    await harness.settle();
    const panel = harness.nodes((node) => node.type === 'PromptComposer')[0];
    const status = harness.nodes((node) => node.props?.['data-image-catalog-status'] === 'error', panel)[0];
    assert.match(studioText(status), /TASK_MODEL_NOT_IN_CATALOG/);
    assert.doesNotMatch(studioText(panel), /目录为空|PAINTTRACK_LOCAL_MOCK_ROUTING/);
    assert.equal(Boolean(harness.action().props.disabled), true);
});

test('视频目录加载、空态及错误码和刷新始终位于 PromptComposer 内，失败不造 Mock', async () => {
    const harness = studioHarness('VideoStudio');
    const panel = () => harness.nodes((node) => node.type === 'PromptComposer')[0];
    const status = () => harness.nodes((node) => node.props?.['data-video-catalog-status'] !== undefined, panel())[0];
    const refresh = () => harness.nodes((node) => node.type === 'button' && studioText(node) === '刷新视频模型', panel())[0];
    assert.match(studioText(status()), /正在加载视频模型目录/);
    assert.match(studioText(status()), /VIDEO_CATALOG_LOADING/);
    assert.equal(refresh().props.disabled, true);
    assert.equal(videoParameterInput(harness, '时长').props.disabled, true);
    harness.requests[0].reject(Object.assign(new Error('加载失败'), { code: 'CATALOG_QUERY_FAILED' }));
    await harness.settle();
    assert.equal(status().props.role, 'alert');
    assert.match(studioText(status()), /CATALOG_QUERY_FAILED/);
    assert.equal(refresh().props.disabled, false);
    harness.enterPrompt();
    await harness.action().props.onClick();
    assert.equal(harness.submissions.length, 0);
    assert.doesNotMatch(studioText(panel()), /Mock 固定限制/);
    refresh().props.onClick();
    harness.render();
    assert.equal(harness.requests.length, 2);
    assert.match(studioText(status()), /VIDEO_CATALOG_LOADING/);
    harness.requests[1].resolve([]);
    await harness.settle();
    assert.match(studioText(status()), /VIDEO_CATALOG_EMPTY/);
    assert.equal(Boolean(harness.action().props.disabled), true);
    refresh().props.onClick();
    harness.render();
    harness.requests[2].resolve(videoCatalog);
    await harness.settle();
    assert.match(studioText(status()), /已加载 1 个文生视频模型/);
    assert.equal(refresh().props.disabled, false);
    assert.equal(Boolean(harness.action().props.disabled), false);
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
