const { ProviderError } = require('./mockProvider');

const RETRYABLE_CODES = new Set([
    'RATE_LIMITED',
    'TEMPORARY_PROVIDER',
    'NETWORK_TIMEOUT',
    'NETWORK_UNAVAILABLE',
]);

const UNKNOWN_SUBMISSION_CODES = new Set([
    'NETWORK_TIMEOUT',
    'NETWORK_UNAVAILABLE',
    'REMOTE_JOB_NOT_FOUND',
    'PROVIDER_UNKNOWN',
]);

const PUBLIC_MESSAGES = Object.freeze({
    INVALID_REQUEST: 'Provider request is invalid',
    AUTH_CONFIGURATION: 'Provider configuration is unavailable',
    FORBIDDEN: 'Provider rejected the request',
    RATE_LIMITED: 'Provider rate limit reached',
    TEMPORARY_PROVIDER: 'Provider is temporarily unavailable',
    NETWORK_TIMEOUT: 'Provider request timed out',
    NETWORK_UNAVAILABLE: 'Provider network is unavailable',
    REMOTE_JOB_NOT_FOUND: 'Provider job could not be found',
    CANCEL_UNSUPPORTED: 'Provider does not support cancellation',
    CANCEL_REJECTED: 'Provider rejected cancellation',
    RESULT_INVALID: 'Provider result is invalid',
    PROVIDER_UNKNOWN: 'Provider error could not be classified',
    ABORTED: 'Provider operation was cancelled',
});

function assertNonNegativeInteger(value, name) {
    if (!Number.isInteger(value) || value < 0) {
        throw new TypeError(`${name} must be a non-negative integer`);
    }
}

function normalizeProviderError(error) {
    if (error instanceof ProviderError) return error;
    return new ProviderError('PROVIDER_UNKNOWN', 'Provider operation failed', {
        retryable: false,
        publicMessage: PUBLIC_MESSAGES.PROVIDER_UNKNOWN,
    });
}

function mapProviderError(error, {
    phase = 'query',
    retryDelaySeconds = 0,
} = {}) {
    assertNonNegativeInteger(retryDelaySeconds, 'retryDelaySeconds');
    if (!['submit', 'query', 'cancel', 'result'].includes(phase)) {
        throw new TypeError('phase must be submit, query, cancel, or result');
    }

    const normalized = normalizeProviderError(error);
    const code = normalized.code;
    const submissionUnknown = Boolean(
        normalized.submissionUnknown
        || (phase === 'submit' && UNKNOWN_SUBMISSION_CODES.has(code)),
    );

    if (submissionUnknown) {
        return Object.freeze({
            action: 'unknown_submission',
            errorCode: code,
            retryable: false,
            retryDelaySeconds: 0,
            publicMessage: 'Provider submission result is unknown; reuse the same idempotency key before retrying',
        });
    }

    const retryable = Boolean(normalized.retryable || RETRYABLE_CODES.has(code))
        && phase !== 'cancel'
        && phase !== 'result';
    return Object.freeze({
        action: retryable ? 'retry' : 'fail',
        errorCode: code,
        retryable,
        retryDelaySeconds: retryable ? retryDelaySeconds : 0,
        publicMessage: PUBLIC_MESSAGES[code] || PUBLIC_MESSAGES.PROVIDER_UNKNOWN,
    });
}

function toTaskFailureInput(error, options = {}) {
    const decision = mapProviderError(error, options);
    if (decision.action === 'unknown_submission') {
        return decision;
    }
    return {
        errorMessage: decision.errorCode,
        retryDelaySeconds: decision.retryDelaySeconds,
        decision,
    };
}

module.exports = {
    mapProviderError,
    normalizeProviderError,
    toTaskFailureInput,
};
