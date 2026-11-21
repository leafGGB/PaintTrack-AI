const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const path = require('node:path');

// These fixtures are used only by the explicitly guarded local mock route.
const MOCK_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64');
const MOCK_VIDEO_PATH = path.resolve(__dirname, '../../../docs/assets/demo.mp4');
let mockVideoBytes;

function getMockVideoBytes() {
    if (!mockVideoBytes) mockVideoBytes = readFileSync(MOCK_VIDEO_PATH);
    return Buffer.from(mockVideoBytes);
}

const PROVIDER_ERROR_CODES = Object.freeze([
    'INVALID_REQUEST',
    'AUTH_CONFIGURATION',
    'FORBIDDEN',
    'RATE_LIMITED',
    'TEMPORARY_PROVIDER',
    'NETWORK_TIMEOUT',
    'NETWORK_UNAVAILABLE',
    'REMOTE_JOB_NOT_FOUND',
    'CANCEL_UNSUPPORTED',
    'CANCEL_REJECTED',
    'RESULT_INVALID',
    'PROVIDER_UNKNOWN',
    'ABORTED',
]);

const PROVIDER_STATES = Object.freeze([
    'queued',
    'running',
    'succeeded',
    'failed',
    'cancelled',
    'expired',
    'unknown',
]);

class ProviderError extends Error {
    constructor(code, message = 'Provider operation failed', details = {}) {
        super(message);
        this.name = 'ProviderError';
        this.code = code;
        this.retryable = Boolean(details.retryable);
        this.submissionUnknown = Boolean(details.submissionUnknown);
        this.publicMessage = typeof details.publicMessage === 'string'
            ? details.publicMessage
            : 'Provider operation failed';
    }
}

function assertProviderErrorCode(code) {
    if (!PROVIDER_ERROR_CODES.includes(code)) {
        throw new TypeError(`Unsupported provider error code: ${code}`);
    }
}

function createProviderError(code, details = {}) {
    assertProviderErrorCode(code);
    const retryable = details.retryable ?? [
        'RATE_LIMITED',
        'TEMPORARY_PROVIDER',
        'NETWORK_TIMEOUT',
        'NETWORK_UNAVAILABLE',
    ].includes(code);
    return new ProviderError(code, details.message || 'Mock provider failure', {
        ...details,
        retryable,
    });
}

function throwIfAborted(signal) {
    if (signal?.aborted) {
        throw createProviderError('ABORTED', {
            message: 'Mock provider operation was aborted',
            retryable: false,
        });
    }
}

function clone(value) {
    if (value === undefined) return undefined;
    if (Buffer.isBuffer(value)) return Buffer.from(value);
    if (value instanceof Uint8Array) return new Uint8Array(value);
    if (Array.isArray(value)) return value.map(clone);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, clone(entry)]));
    }
    return value;
}

function getMockOptions(request) {
    const options = request?.input?.mock;
    if (options === undefined) return {};
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
        throw createProviderError('INVALID_REQUEST', {
            message: 'Mock options must be an object',
            retryable: false,
        });
    }
    return options;
}

function assertRequest(request) {
    if (!request || typeof request !== 'object') {
        throw createProviderError('INVALID_REQUEST', { message: 'Provider request is required' });
    }
    for (const field of ['taskId', 'idempotencyKey']) {
        if (typeof request[field] !== 'string' || request[field].trim() === '') {
            throw createProviderError('INVALID_REQUEST', { message: `${field} is required` });
        }
    }
    if (!request.input || typeof request.input !== 'object' || Array.isArray(request.input)) {
        throw createProviderError('INVALID_REQUEST', { message: 'input is required' });
    }
}

function assertProviderJobId(providerJobId) {
    if (typeof providerJobId !== 'string' || providerJobId.trim() === '') {
        throw createProviderError('INVALID_REQUEST', { message: 'providerJobId is required' });
    }
}

function createResult(taskId, options, request) {
    // 媒体类型优先取显式 mock 选项，其次按任务类型推断；
    // 否则视频任务在本地 mock 下会拿到一张 PNG 并按图片归档。
    const declared = typeof options.mediaType === 'string' ? options.mediaType : '';
    const isVideo = declared ? declared.startsWith('video/') : String(request?.taskType || '').startsWith('video.');
    if (!isVideo) {
        return { mediaType: 'image', mimeType: 'image/png', bytes: Buffer.from(MOCK_PNG), source: 'local-mock-fixture' };
    }
    return {
        mediaType: 'video',
        mimeType: 'video/mp4',
        bytes: getMockVideoBytes(),
        source: 'local-mock-demo-video',
    };
}

function createMockProvider({ providerName = 'mock-provider', providerVersion = '1.0.0' } = {}) {
    if (typeof providerName !== 'string' || providerName.trim() === '') {
        throw new TypeError('providerName must be a non-empty string');
    }
    if (typeof providerVersion !== 'string' || providerVersion.trim() === '') {
        throw new TypeError('providerVersion must be a non-empty string');
    }

    const jobs = new Map();
    const idempotency = new Map();

    const capabilities = Object.freeze({
        modes: Object.freeze(['sync', 'async']),
        mediaTypes: Object.freeze(['image', 'video']),
        operations: Object.freeze({ submit: true, query: true, cancel: true }),
        idempotency: Object.freeze({ submit: 'provider-key' }),
    });

    function getJob(providerJobId) {
        assertProviderJobId(providerJobId);
        const job = jobs.get(providerJobId);
        if (!job) {
            throw createProviderError('REMOTE_JOB_NOT_FOUND', {
                message: 'Mock provider job was not found',
                retryable: false,
            });
        }
        return job;
    }

    async function submit(request, { signal } = {}) {
        assertRequest(request);
        throwIfAborted(signal);
        const options = getMockOptions(request);
        const existingId = idempotency.get(request.idempotencyKey);
        if (existingId) {
            const existing = getJob(existingId);
            if (existing.unknownSubmit && !existing.unknownRecovered) {
                existing.unknownRecovered = true;
                return clone(existing.acceptedSubmitResult);
            }
            return clone(existing.lastSubmitResult);
        }

        if (options.error) {
            throw createProviderError(options.error, {
                message: 'Mock provider configured failure',
                retryable: options.retryable,
                submissionUnknown: options.submissionUnknown,
            });
        }

        const mode = options.mode || 'async';
        if (mode !== 'sync' && mode !== 'async') {
            throw createProviderError('INVALID_REQUEST', { message: 'Mock mode must be sync or async' });
        }

        const providerJobId = `mock_${randomUUID()}`;
        const job = {
            providerJobId,
            taskId: request.taskId,
            idempotencyKey: request.idempotencyKey,
            mode,
            state: mode === 'sync' ? 'succeeded' : 'queued',
            queryCount: 0,
            cancelSupported: options.cancelSupported !== false,
            failOnQuery: options.failOnQuery || null,
            unknownSubmit: Boolean(options.unknownSubmit),
            unknownRecovered: false,
            result: createResult(request.taskId, options, request),
            usage: {
                inputUnits: 1,
                outputUnits: 1,
                providerCostMinorCny: 0,
                currency: 'CNY',
            },
        };
        jobs.set(providerJobId, job);
        idempotency.set(request.idempotencyKey, providerJobId);

        const result = mode === 'sync'
            ? {
                kind: 'completed',
                providerJobId,
                providerState: 'succeeded',
                pollAfterMs: 0,
                result: clone(job.result),
                usage: clone(job.usage),
                providerMetadata: { mock: true },
            }
            : {
                kind: 'accepted',
                providerJobId,
                providerState: 'queued',
                pollAfterMs: 1,
                result: null,
                usage: null,
                providerMetadata: { mock: true },
            };
        job.acceptedSubmitResult = clone(result);
        job.lastSubmitResult = result;

        if (options.unknownSubmit) {
            job.lastSubmitResult = {
                kind: 'unknown',
                providerJobId: null,
                providerState: 'unknown',
                pollAfterMs: 1,
                result: null,
                usage: null,
                providerMetadata: { mock: true, recovery: 'reuse-idempotency-key' },
            };
            return clone(job.lastSubmitResult);
        }
        return clone(result);
    }

    async function query({ providerJobId } = {}, { signal } = {}) {
        throwIfAborted(signal);
        const job = getJob(providerJobId);
        if (job.failOnQuery) {
            throw createProviderError(job.failOnQuery, {
                message: 'Mock provider configured query failure',
            });
        }
        if (job.state === 'queued') {
            job.queryCount += 1;
            job.state = 'running';
        } else if (job.state === 'running') {
            job.queryCount += 1;
            job.state = 'succeeded';
        }
        if (job.state === 'succeeded') {
            return {
                providerJobId,
                state: 'succeeded',
                pollAfterMs: 0,
                result: clone(job.result),
                failure: null,
                usage: clone(job.usage),
            };
        }
        return {
            providerJobId,
            state: job.state,
            pollAfterMs: 1,
            result: null,
            failure: null,
            usage: null,
        };
    }

    async function cancel({ providerJobId } = {}, { signal } = {}) {
        throwIfAborted(signal);
        const job = getJob(providerJobId);
        if (!job.cancelSupported) {
            throw createProviderError('CANCEL_UNSUPPORTED', {
                message: 'Mock provider cancellation is disabled',
            });
        }
        if (job.state === 'succeeded') {
            throw createProviderError('CANCEL_REJECTED', {
                message: 'Mock provider job has already completed',
            });
        }
        if (job.state === 'cancelled') {
            return { providerJobId, state: 'cancelled' };
        }
        job.state = 'cancelled';
        return { providerJobId, state: 'cancelled' };
    }

    return Object.freeze({
        name: providerName,
        version: providerVersion,
        capabilities,
        submit,
        query,
        cancel,
        _testing: Object.freeze({
            getJob(providerJobId) {
                return clone(getJob(providerJobId));
            },
            jobCount() {
                return jobs.size;
            },
        }),
    });
}

module.exports = {
    PROVIDER_ERROR_CODES,
    PROVIDER_STATES,
    ProviderError,
    createMockProvider,
    createProviderError,
};
