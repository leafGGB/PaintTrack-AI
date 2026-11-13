'use strict';

const { createHash } = require('node:crypto');
const { createProviderError } = require('./mockProvider');

const PROVIDER_NAME = 'myvigna-image';
const LOGICAL_MODEL = 'gpt-image-2';
const DEFAULT_BASE_URL = 'https://www.myvigna.top/v1';
const MAX_JSON_BYTES = 70 * 1024 * 1024;
const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
const POLL_FALLBACK_MS = 2000;

function providerError(code, details = {}) {
    return createProviderError(code, {
        message: details.message || 'MyVigna image provider operation failed',
        retryable: details.retryable,
        submissionUnknown: details.submissionUnknown,
    });
}

function normalizeBaseUrl(value = DEFAULT_BASE_URL, { allowInsecureLoopback = false, nodeEnv = process.env.NODE_ENV } = {}) {
    if (typeof value !== 'string' || value.trim() === '') throw new TypeError('baseUrl is required');
    let parsed;
    try {
        parsed = new URL(value.trim());
    } catch {
        throw new TypeError('baseUrl must be an absolute URL');
    }
    const isLoopback = ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(parsed.hostname.toLowerCase());
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
        throw new TypeError('baseUrl must not include userinfo, query, or fragment');
    }
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && allowInsecureLoopback && nodeEnv !== 'production' && isLoopback)) {
        throw new TypeError('baseUrl must use HTTPS; HTTP is allowed only for explicit non-production loopback tests');
    }
    if (parsed.port && !['443', '80'].includes(parsed.port) && !(allowInsecureLoopback && nodeEnv !== 'production' && isLoopback)) {
        throw new TypeError('baseUrl port is not allowed');
    }
    if (parsed.pathname !== '' && parsed.pathname !== '/' && parsed.pathname.replace(/\/+$/, '') !== '/v1') {
        throw new TypeError('baseUrl path must be empty or end at /v1');
    }
    parsed.pathname = '/v1';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().replace(/\/$/, '');
}

function abortError(signal) {
    return Boolean(signal?.aborted);
}

function requestSignal(signal, timeoutMs) {
    const controller = new AbortController();
    let timedOut = false;
    const abortFromCaller = () => controller.abort(signal?.reason);
    if (signal?.aborted) abortFromCaller();
    else signal?.addEventListener('abort', abortFromCaller, { once: true });
    const timer = setTimeout(() => {
        timedOut = true;
        controller.abort(new Error('Provider request timed out'));
    }, timeoutMs);
    return {
        signal: controller.signal,
        timedOut: () => timedOut,
        cleanup() {
            clearTimeout(timer);
            signal?.removeEventListener('abort', abortFromCaller);
        },
    };
}

async function readJson(response, { maxBytes = MAX_JSON_BYTES, phase = 'query' } = {}) {
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        throw providerError('RESULT_INVALID', { message: 'Provider response exceeded the configured size limit' });
    }
    let text;
    try {
        const reader = response.body?.getReader();
        if (!reader) throw new Error('Provider response body is missing');
        const chunks = [];
        let size = 0;
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > maxBytes) {
                await reader.cancel();
                throw providerError('RESULT_INVALID', { message: 'Provider response exceeded the configured size limit' });
            }
            chunks.push(Buffer.from(value));
        }
        text = Buffer.concat(chunks, size).toString('utf8');
    } catch (error) {
        if (error?.code) throw error;
        throw providerError('NETWORK_UNAVAILABLE', {
            message: 'Provider response could not be read',
            submissionUnknown: phase === 'submit',
        });
    }
    try {
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid json object');
        return parsed;
    } catch {
        throw providerError('PROVIDER_UNKNOWN', {
            message: 'Provider returned an invalid JSON response',
            submissionUnknown: phase === 'submit',
        });
    }
}

function mapHttpError(status, phase) {
    if (status === 401) return providerError('AUTH_CONFIGURATION');
    if (status === 403) return providerError('FORBIDDEN');
    if (status === 404 && phase !== 'submit') return providerError('REMOTE_JOB_NOT_FOUND');
    if (status === 408 || status >= 500) {
        return providerError(status === 408 ? 'NETWORK_TIMEOUT' : 'TEMPORARY_PROVIDER', {
            retryable: true,
            submissionUnknown: phase === 'submit',
        });
    }
    if (status === 429) return providerError('RATE_LIMITED', { retryable: true });
    if (status === 400 || status === 413 || status === 422) return providerError('INVALID_REQUEST');
    return providerError('PROVIDER_UNKNOWN');
}

function taskPath(providerJobId) {
    if (typeof providerJobId !== 'string' || !/^[-A-Za-z0-9_]{1,200}$/.test(providerJobId)) {
        throw providerError('INVALID_REQUEST', { message: 'Provider task id is invalid' });
    }
    return `/v1/images/tasks/${encodeURIComponent(providerJobId)}`;
}

function validateAdvertisedUrl(value, expectedPath, baseUrl) {
    if (value === undefined || value === null) return;
    if (typeof value !== 'string' || value.trim() === '') {
        throw providerError('PROVIDER_UNKNOWN', { message: 'Provider task URL is invalid', submissionUnknown: true });
    }
    let parsed;
    try {
        parsed = new URL(value, `${baseUrl}/`);
    } catch {
        throw providerError('PROVIDER_UNKNOWN', { message: 'Provider task URL is invalid', submissionUnknown: true });
    }
    const base = new URL(baseUrl);
    if (parsed.origin !== base.origin || parsed.pathname !== expectedPath || parsed.search || parsed.hash || parsed.username || parsed.password) {
        throw providerError('PROVIDER_UNKNOWN', { message: 'Provider task URL did not match the submitted task', submissionUnknown: true });
    }
}

function normalizePollAfterMs(body, response, fallback = POLL_FALLBACK_MS) {
    const bodyDelay = body?.poll_after_ms;
    if (typeof bodyDelay === 'number' && Number.isFinite(bodyDelay) && bodyDelay >= 0) return Math.floor(bodyDelay);
    const retryAfter = Number(response?.headers?.get('retry-after'));
    return Number.isFinite(retryAfter) && retryAfter >= 0 ? Math.floor(retryAfter * 1000) : fallback;
}

function parseResult(body) {
    const data = body?.data;
    if (!Array.isArray(data) || data.length !== 1 || !data[0] || typeof data[0] !== 'object') {
        throw providerError('RESULT_INVALID', { message: 'Provider result must contain exactly one image' });
    }
    const image = data[0];
    if (typeof image.url === 'string' && image.url.trim() !== '') {
        return { mediaType: 'image', resultUrl: image.url };
    }
    if (typeof image.b64_json === 'string' && image.b64_json.length > 0) {
        const encoded = image.b64_json;
        if (encoded.length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
            throw providerError('RESULT_INVALID', { message: 'Provider returned invalid or oversized base64 image data' });
        }
        const bytes = Buffer.from(encoded, 'base64');
        if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES || bytes.toString('base64') !== encoded) {
            throw providerError('RESULT_INVALID', { message: 'Provider returned invalid or oversized base64 image data' });
        }
        return { mediaType: 'image', bytes, sizeBytes: bytes.length };
    }
    throw providerError('RESULT_INVALID', { message: 'Provider result did not contain a URL or base64 image' });
}

function stableRequestKey(taskId, requestId) {
    if (typeof requestId === 'string' && requestId.trim()) return `pt_${requestId.replace(/[^A-Za-z0-9._:-]/g, '').slice(0, 96)}`;
    const digest = createHash('sha256').update(String(taskId || '')).digest('hex').slice(0, 40);
    return `pt_${digest}`;
}

function normalizeInput(input, upstreamModel) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw providerError('INVALID_REQUEST', { message: 'Image task input is required' });
    }
    if (input.logicalModelId !== LOGICAL_MODEL) {
        throw providerError('INVALID_REQUEST', { message: `Only ${LOGICAL_MODEL} is enabled in this adapter slice` });
    }
    if (typeof input.prompt !== 'string' || input.prompt.trim() === '' || input.prompt.length > 20000) {
        throw providerError('INVALID_REQUEST', { message: 'Image prompt is invalid' });
    }
    if (typeof input.size !== 'string' || !/^\d{2,4}x\d{2,4}$/.test(input.size)) {
        throw providerError('INVALID_REQUEST', { message: 'Image size must use widthxheight pixels' });
    }
    const [width, height] = input.size.split('x').map(Number);
    if (width < 256 || height < 256 || width > 1536 || height > 1536 || width * height > 1536 * 1024) {
        throw providerError('INVALID_REQUEST', { message: 'Image size exceeds the first-slice 1K bound' });
    }
    return {
        model: upstreamModel,
        prompt: input.prompt.trim(),
        n: 1,
        size: input.size,
        response_format: 'url',
        quality: 'high',
    };
}

function createMyVignaImageProvider({
    baseUrl = DEFAULT_BASE_URL,
    credential,
    upstreamModel = LOGICAL_MODEL,
    fetchImpl = globalThis.fetch,
    timeoutMs = 30000,
    allowInsecureLoopback = false,
    nodeEnv = process.env.NODE_ENV,
} = {}) {
    if (typeof credential !== 'string' || credential.trim() === '' || /\s/.test(credential)) {
        throw new TypeError('credential must be a non-empty token without whitespace');
    }
    if (typeof upstreamModel !== 'string' || upstreamModel.trim() === '') throw new TypeError('upstreamModel is required');
    if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 180000) throw new TypeError('timeoutMs must be between 1 and 180000');

    const normalizedBaseUrl = normalizeBaseUrl(baseUrl, { allowInsecureLoopback, nodeEnv });
    const base = new URL(normalizedBaseUrl);
    const allowLoopback = allowInsecureLoopback && nodeEnv !== 'production';
    const provider = {
        name: PROVIDER_NAME,
        version: '1.0.0',
        capabilities: Object.freeze({
            modes: Object.freeze(['async']),
            mediaTypes: Object.freeze(['image']),
            operations: Object.freeze({ submit: true, query: true, cancel: false }),
            idempotency: Object.freeze({ submit: 'provider-key' }),
        }),
        async submit(request, { signal } = {}) {
            const body = normalizeInput(request?.input, upstreamModel);
            if (typeof request?.idempotencyKey !== 'string' || request.idempotencyKey.trim() === '') {
                throw providerError('INVALID_REQUEST', { message: 'Idempotency key is required' });
            }
            const path = '/v1/images/tasks';
            const controller = requestSignal(signal, timeoutMs);
            try {
                const response = await fetchImpl(`${normalizedBaseUrl}${path.slice(3)}`, {
                    method: 'POST',
                    redirect: 'error',
                    headers: {
                        Authorization: `Bearer ${credential}`,
                        'Content-Type': 'application/json',
                        'Idempotency-Key': request.idempotencyKey,
                    },
                    body: JSON.stringify(body),
                    signal: controller.signal,
                });
                if (!response.ok && response.status !== 202) throw mapHttpError(response.status, 'submit');
                const payload = await readJson(response, { phase: 'submit' });
                const providerJobId = payload.task_id;
                if (typeof providerJobId !== 'string' || !/^[-A-Za-z0-9_]{1,200}$/.test(providerJobId)) {
                    throw providerError('PROVIDER_UNKNOWN', { message: 'Provider acceptance response omitted a valid task id', submissionUnknown: true });
                }
                const expectedPath = taskPath(providerJobId);
                validateAdvertisedUrl(payload.poll_url, expectedPath, normalizedBaseUrl);
                validateAdvertisedUrl(payload.result_url, `${expectedPath}/result`, normalizedBaseUrl);
                const state = payload.status;
                if (state !== 'queued' && state !== 'running') {
                    throw providerError('PROVIDER_UNKNOWN', { message: 'Provider acceptance response returned an unsupported state', submissionUnknown: true });
                }
                return {
                    kind: 'accepted',
                    providerJobId,
                    providerState: state,
                    pollAfterMs: normalizePollAfterMs(payload, response),
                };
            } catch (error) {
                if (error?.code) throw error;
                if (controller.timedOut()) {
                    throw providerError('NETWORK_TIMEOUT', { retryable: true, submissionUnknown: true });
                }
                if (abortError(signal)) throw providerError('ABORTED');
                throw providerError('NETWORK_UNAVAILABLE', { retryable: true, submissionUnknown: true });
            } finally {
                controller.cleanup();
            }
        },
        async query({ providerJobId } = {}, { signal } = {}) {
            const path = taskPath(providerJobId);
            const controller = requestSignal(signal, timeoutMs);
            try {
                const response = await fetchImpl(`${normalizedBaseUrl}${path.slice(3)}`, {
                    method: 'GET',
                    redirect: 'error',
                    headers: { Authorization: `Bearer ${credential}` },
                    signal: controller.signal,
                });
                if (response.status === 202) {
                    const pending = await readJson(response);
                    return { providerJobId, state: 'running', pollAfterMs: normalizePollAfterMs(pending, response), result: null };
                }
                if (!response.ok) throw mapHttpError(response.status, 'query');
                const payload = await readJson(response);
                const state = payload.status;
                if (state === 'queued' || state === 'running' || state === 'uncertain') {
                    return {
                        providerJobId,
                        state: state === 'uncertain' ? 'running' : state,
                        pollAfterMs: normalizePollAfterMs(payload, response),
                        result: null,
                    };
                }
                if (state === 'failed') {
                    return { providerJobId, state: 'failed', pollAfterMs: 0, result: null };
                }
                if (state !== 'success' && state !== 'succeeded') {
                    throw providerError('PROVIDER_UNKNOWN', { message: 'Provider returned an unsupported task state' });
                }
                const resultPath = `${path}/result`;
                const resultResponse = await fetchImpl(`${base.origin}${resultPath}`, {
                    method: 'GET',
                    redirect: 'error',
                    headers: { Authorization: `Bearer ${credential}` },
                    signal: controller.signal,
                });
                if (resultResponse.status === 202) {
                    const pending = await readJson(resultResponse);
                    return { providerJobId, state: 'running', pollAfterMs: normalizePollAfterMs(pending, resultResponse), result: null };
                }
                if (!resultResponse.ok) throw mapHttpError(resultResponse.status, 'result');
                const resultBody = await readJson(resultResponse, { maxBytes: MAX_JSON_BYTES, phase: 'result' });
                return {
                    providerJobId,
                    state: 'succeeded',
                    pollAfterMs: 0,
                    result: parseResult(resultBody),
                };
            } catch (error) {
                if (error?.code) throw error;
                if (controller.timedOut()) throw providerError('NETWORK_TIMEOUT', { retryable: true });
                if (abortError(signal)) throw providerError('ABORTED');
                throw providerError('NETWORK_UNAVAILABLE', { retryable: true });
            } finally {
                controller.cleanup();
            }
        },
        async cancel() {
            throw providerError('CANCEL_UNSUPPORTED');
        },
        toString() {
            return `[provider ${PROVIDER_NAME}]`;
        },
    };
    return Object.freeze(provider);
}

module.exports = {
    DEFAULT_BASE_URL,
    LOGICAL_MODEL,
    MAX_IMAGE_BYTES,
    PROVIDER_NAME,
    createMyVignaImageProvider,
    normalizeBaseUrl,
    normalizeInput,
    parseResult,
};
