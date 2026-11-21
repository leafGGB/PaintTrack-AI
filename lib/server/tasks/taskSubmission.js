const { createHash } = require('node:crypto');
const { ASPECT_RATIOS, sizeForAspectRatio } = require('./imagePayload');

// 5.2 只开放两种能力型任务；真正调用的供应商由 Worker 侧决定。
// 当前阶段由 mock Provider 承担执行，真实 Provider 适配仍按用户决定后置。
const SUPPORTED_TASK_TYPES = Object.freeze(['image.generate', 'video.generate']);

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_PAYLOAD_BYTES = 32 * 1024;
const MAX_PAYLOAD_DEPTH = 8;
const MAX_PAYLOAD_NODES = 1000;
const MAX_STRING_LENGTH = 4096;
const FORBIDDEN_KEYS = new Set([
    '__proto__', 'constructor', 'prototype',
    'providerId', 'providerInstanceId', 'providerModelId', 'providerName', 'baseUrl',
    'upstreamModel', 'upstreamModelName', 'bindingId', 'adapterType', 'operationProfile',
    'credentialRef', 'credentialVersion', 'secret', 'apiKey', 'authorization',
    'routeSnapshot', 'routeSnapshotHash', 'routeSnapshotVersion',
]);

class TaskApiError extends Error {
    constructor(code, status, message = code) {
        super(message);
        this.name = 'TaskApiError';
        this.code = code;
        this.status = status;
    }
}

function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function parseIdempotencyKey(value) {
    if (value === null || value === undefined || value === '') {
        throw new TaskApiError('IDEMPOTENCY_KEY_REQUIRED', 400);
    }
    if (typeof value !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(value)) {
        throw new TaskApiError('INVALID_IDEMPOTENCY_KEY', 400);
    }
    return value;
}

function assertBoundedJson(value, path, state, depth) {
    if (depth > MAX_PAYLOAD_DEPTH) {
        throw new TaskApiError('INVALID_TASK_PAYLOAD', 400);
    }
    state.nodes += 1;
    if (state.nodes > MAX_PAYLOAD_NODES) {
        throw new TaskApiError('INVALID_TASK_PAYLOAD', 400);
    }

    if (value === null || typeof value === 'boolean') return;
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw new TaskApiError('INVALID_TASK_PAYLOAD', 400);
        return;
    }
    if (typeof value === 'string') {
        if (value.length > MAX_STRING_LENGTH) throw new TaskApiError('INVALID_TASK_PAYLOAD', 400);
        return;
    }
    if (Array.isArray(value)) {
        for (const [index, entry] of value.entries()) {
            assertBoundedJson(entry, `${path}[${index}]`, state, depth + 1);
        }
        return;
    }
    if (!isPlainObject(value)) {
        // undefined、函数、Date、Buffer 等都不是合法 JSON 输入。
        throw new TaskApiError('INVALID_TASK_PAYLOAD', 400);
    }
    for (const [key, entry] of Object.entries(value)) {
        if (FORBIDDEN_KEYS.has(key)) throw new TaskApiError('INVALID_TASK_PAYLOAD', 400);
        if (key.length > 128) throw new TaskApiError('INVALID_TASK_PAYLOAD', 400);
        assertBoundedJson(entry, `${path}.${key}`, state, depth + 1);
    }
}

function assertPositiveSafeInteger(value, code = 'INVALID_TASK_PAYLOAD') {
    if (!Number.isSafeInteger(value) || value <= 0) throw new TaskApiError(code, 400);
}

function validatePayload(payload, taskType) {
    if (!isPlainObject(payload) || Object.keys(payload).length === 0) {
        throw new TaskApiError('INVALID_TASK_PAYLOAD', 400);
    }
    assertBoundedJson(payload, 'payload', { nodes: 0 }, 0);
    if (typeof payload.logicalModelId !== 'string'
        || !/^[a-z0-9][a-z0-9._-]{1,127}$/.test(payload.logicalModelId)) {
        throw new TaskApiError('LOGICAL_MODEL_REQUIRED', 400);
    }
    if (taskType === 'image.generate') {
        if (typeof payload.prompt !== 'string' || payload.prompt.trim() === '' || payload.prompt.length > 20000
            || typeof payload.aspectRatio !== 'string'
            || !ASPECT_RATIOS.includes(payload.aspectRatio)
            || payload.size !== sizeForAspectRatio(payload.aspectRatio)) {
            throw new TaskApiError('INVALID_TASK_PAYLOAD', 400);
        }
        assertPositiveSafeInteger(payload.outputCount);
        if (payload.outputCount !== 1) throw new TaskApiError('UNSUPPORTED_OUTPUT_COUNT', 409);
    }
    if (taskType === 'video.generate') {
        if (typeof payload.prompt !== 'string' || payload.prompt.trim() === '' || payload.prompt.length > 20000) {
            throw new TaskApiError('INVALID_TASK_PAYLOAD', 400);
        }
        assertPositiveSafeInteger(payload.durationMs);
        assertPositiveSafeInteger(payload.fps);
    }
    if (Buffer.byteLength(JSON.stringify(payload)) > MAX_PAYLOAD_BYTES) {
        throw new TaskApiError('TASK_PAYLOAD_TOO_LARGE', 413);
    }
    return payload;
}

function validateCreateTaskRequest(body) {
    if (!isPlainObject(body)) throw new TaskApiError('INVALID_TASK_REQUEST', 400);
    const keys = Object.keys(body);
    if (keys.length !== 2 || !Object.hasOwn(body, 'taskType') || !Object.hasOwn(body, 'payload')) {
        throw new TaskApiError('INVALID_TASK_REQUEST', 400);
    }
    if (typeof body.taskType !== 'string' || !SUPPORTED_TASK_TYPES.includes(body.taskType)) {
        throw new TaskApiError('UNSUPPORTED_TASK_TYPE', 400);
    }
    return Object.freeze({
        taskType: body.taskType,
        payload: validatePayload(body.payload, body.taskType),
    });
}

// 指纹只覆盖 taskType + payload：同一幂等键必须对应完全相同的请求。
// 键排序保证对象字面量顺序不同不会被误判成"同键不同请求"。
function stableStringify(value) {
    if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
    if (isPlainObject(value)) {
        return `{${Object.keys(value).sort()
            .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
            .join(',')}}`;
    }
    return JSON.stringify(value);
}

function requestFingerprint({ taskType, payload } = {}) {
    const validated = validateCreateTaskRequest({ taskType, payload });
    return createHash('sha256')
        .update(stableStringify({ taskType: validated.taskType, payload: validated.payload }))
        .digest('hex');
}

module.exports = {
    IDEMPOTENCY_KEY_PATTERN,
    MAX_BODY_BYTES,
    MAX_PAYLOAD_BYTES,
    SUPPORTED_TASK_TYPES,
    TaskApiError,
    parseIdempotencyKey,
    requestFingerprint,
    stableStringify,
    validateCreateTaskRequest,
    validatePayload,
};
