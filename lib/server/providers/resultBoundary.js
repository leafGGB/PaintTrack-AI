const ALLOWED_MEDIA_TYPES = Object.freeze(['image', 'video', 'audio', 'document']);
const URL_PROTOCOLS = new Set(['http:', 'https:']);
const FORBIDDEN_HOST_PATTERNS = [
    /^localhost$/i,
    /^127\./,
    /^0\.0\.0\.0$/,
    /^::1$/,
    /^fc00:/i,
    /^fe80:/i,
    /^169\.254\./,
    /^10\./,
    /^192\.168\./,
    /^172\.(1[6-9]|2\d|3[0-1])\./,
];

function assertString(value, name) {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new TypeError(`${name} must be a non-empty string`);
    }
}

function isLoopbackHost(hostname) {
    const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return normalized === 'localhost' || normalized === '::1' || normalized.startsWith('127.');
}

// allowInsecureLoopback 仅用于本地/测试环境：生产一律强制严格策略。
// 它只放宽回环地址与非常规端口，私网、链路本地与云元数据地址始终拒绝。
function normalizeResultUrl(value, { allowInsecureLoopback = false, nodeEnv = process.env.NODE_ENV } = {}) {
    const allowLoopback = allowInsecureLoopback === true && nodeEnv !== 'production';
    assertString(value, 'resultUrl');
    let parsed;
    try {
        parsed = new URL(value);
    } catch {
        throw new TypeError('resultUrl must be an absolute URL');
    }
    if (!URL_PROTOCOLS.has(parsed.protocol) || parsed.username || parsed.password) {
        throw new TypeError('resultUrl protocol or credentials are not allowed');
    }
    // 先判定主机：私网与云元数据地址在任何模式下都拒绝，
    // 这样 http 回环请求报出的原因是"目标不允许"，不会掩盖地址策略本身。
    if (FORBIDDEN_HOST_PATTERNS.some((pattern) => pattern.test(parsed.hostname))) {
        if (!(allowLoopback && isLoopbackHost(parsed.hostname))) {
            throw new TypeError('resultUrl target is not allowed');
        }
    }
    if (!allowLoopback && parsed.protocol !== 'https:') {
        throw new TypeError('resultUrl must use HTTPS');
    }
    if (parsed.port && !['80', '443'].includes(parsed.port) && !allowLoopback) {
        throw new TypeError('resultUrl port is not allowed');
    }
    parsed.hash = '';
    return parsed.toString();
}

function validateProviderResult(result, {
    maxBytes = 50 * 1024 * 1024,
    allowedMediaTypes = ALLOWED_MEDIA_TYPES,
    allowInsecureLoopback = false,
    nodeEnv = process.env.NODE_ENV,
} = {}) {
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
        throw new TypeError('provider result must be an object');
    }
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
        throw new TypeError('maxBytes must be a positive safe integer');
    }
    if (!Array.isArray(allowedMediaTypes) || allowedMediaTypes.length === 0) {
        throw new TypeError('allowedMediaTypes must be a non-empty array');
    }
    if (!allowedMediaTypes.every((value) => ALLOWED_MEDIA_TYPES.includes(value))) {
        throw new TypeError('allowedMediaTypes contains an unsupported media type');
    }

    const mediaType = result.mediaType;
    if (!allowedMediaTypes.includes(mediaType)) {
        throw new TypeError('provider result mediaType is not allowed');
    }
    if (result.sizeBytes !== undefined
        && (!Number.isSafeInteger(result.sizeBytes) || result.sizeBytes < 0 || result.sizeBytes > maxBytes)) {
        throw new TypeError('provider result sizeBytes exceeds the archive limit');
    }

    const normalized = {
        mediaType,
        mimeType: typeof result.mimeType === 'string' && result.mimeType.trim() ? result.mimeType.trim() : null,
        sizeBytes: result.sizeBytes ?? null,
        resultUrl: null,
        bytes: null,
        source: 'provider',
    };
    if (result.resultUrl !== undefined && result.resultUrl !== null) {
        normalized.resultUrl = normalizeResultUrl(result.resultUrl, { allowInsecureLoopback, nodeEnv });
    }
    if (result.bytes !== undefined) {
        if (!Buffer.isBuffer(result.bytes) && !(result.bytes instanceof Uint8Array)) {
            throw new TypeError('provider result bytes must be a Buffer or Uint8Array');
        }
        if (result.bytes.byteLength > maxBytes) {
            throw new TypeError('provider result bytes exceed the archive limit');
        }
        normalized.bytes = Buffer.from(result.bytes);
        normalized.sizeBytes = result.bytes.byteLength;
    }
    if (!normalized.resultUrl && result.bytes === undefined) {
        throw new TypeError('provider result must include a URL or bytes');
    }
    return Object.freeze(normalized);
}

module.exports = {
    ALLOWED_MEDIA_TYPES,
    normalizeResultUrl,
    validateProviderResult,
};
