'use strict';

const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns');
const net = require('node:net');

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

// 结果媒体类型只接受可判定的 Content-Type 前缀。
// document 额外接受 octet-stream：部分对象存储不保留 PDF 的 MIME。
const CONTENT_TYPE_PREFIXES = Object.freeze({
    image: ['image/'],
    video: ['video/'],
    audio: ['audio/'],
    document: ['application/pdf', 'application/octet-stream'],
});

class ProviderResultFetchError extends Error {
    constructor(code, message, options = {}) {
        super(message || code);
        this.name = 'ProviderResultFetchError';
        this.code = code;
        if (options.cause !== undefined) this.cause = options.cause;
    }
}

function fetchError(code, message, cause) {
    return new ProviderResultFetchError(code, message, { cause });
}

// 无法解析成 IP、或者落在非公网段，一律视为不可抓取。
// 覆盖：环回、RFC1918 私网、CGNAT、链路本地、组播、保留段与 IPv6 ULA。
function isBlockedAddress(address) {
    const family = net.isIP(address);
    if (family === 4) {
        const octets = address.split('.').map(Number);
        if (octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return true;
        const [a, b] = octets;
        if (a === 0 || a === 10 || a === 127) return true;
        if (a === 169 && b === 254) return true;
        if (a === 172 && b >= 16 && b <= 31) return true;
        if (a === 192 && b === 168) return true;
        if (a === 192 && b === 0) return true;
        if (a === 198 && (b === 18 || b === 19)) return true;
        if (a === 100 && b >= 64 && b <= 127) return true;
        if (a >= 224) return true;
        return false;
    }
    if (family === 6) {
        const normalized = address.toLowerCase();
        if (normalized === '::' || normalized === '::1') return true;
        if (normalized.startsWith('fe80') || normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
        if (normalized.startsWith('ff')) return true;
        const mappedDotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
        if (mappedDotted) return isBlockedAddress(mappedDotted[1]);
        const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(normalized);
        if (mappedHex) {
            const high = parseInt(mappedHex[1], 16);
            const low = parseInt(mappedHex[2], 16);
            return isBlockedAddress([high >> 8, high & 0xff, low >> 8, low & 0xff].join('.'));
        }
        return false;
    }
    return true;
}

function isLoopbackAddress(address) {
    const family = net.isIP(address);
    if (family === 4) return address.startsWith('127.');
    if (family === 6) {
        const normalized = address.toLowerCase();
        return normalized === '::1' || /^::ffff:127\./.test(normalized) || /^::ffff:7f[0-9a-f]{2}:/.test(normalized);
    }
    return false;
}

function assertAddressAllowed(address, { allowLoopback }) {
    if (net.isIP(address) === 0) throw fetchError('RESULT_FETCH_INVALID_HOST', 'Result host did not resolve to an IP address');
    if (allowLoopback && isLoopbackAddress(address)) return address;
    if (isBlockedAddress(address)) throw fetchError('RESULT_FETCH_BLOCKED_HOST', 'Result host resolves to a non-public address');
    return address;
}

function normalizeTargetUrl(value, { allowLoopback }) {
    if (typeof value !== 'string' || value.trim() === '') {
        throw fetchError('RESULT_FETCH_INVALID_URL', 'Result URL must be a non-empty string');
    }
    let parsed;
    try {
        parsed = new URL(value);
    } catch {
        throw fetchError('RESULT_FETCH_INVALID_URL', 'Result URL must be absolute');
    }
    if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
        throw fetchError('RESULT_FETCH_INVALID_URL', 'Result URL protocol is not allowed');
    }
    if (parsed.username || parsed.password) {
        throw fetchError('RESULT_FETCH_INVALID_URL', 'Result URL must not carry credentials');
    }
    // 明文 HTTP 只在显式开启的本地测试模式下允许，避免结果内容被中间人替换。
    if (parsed.protocol === 'http:' && !allowLoopback) {
        throw fetchError('RESULT_FETCH_INVALID_URL', 'Result URL must use HTTPS');
    }
    const defaultPort = parsed.protocol === 'https:' ? '443' : '80';
    if (parsed.port && parsed.port !== defaultPort && !allowLoopback) {
        throw fetchError('RESULT_FETCH_INVALID_URL', 'Result URL port is not allowed');
    }
    parsed.hash = '';
    return parsed;
}

async function resolveVerifiedTarget(target, { resolveHost, allowLoopback }) {
    const hostname = target.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(hostname) !== 0) {
        return { address: assertAddressAllowed(hostname, { allowLoopback }), family: net.isIP(hostname) };
    }
    let records;
    try {
        records = await resolveHost(hostname, { all: true, verbatim: true });
    } catch (error) {
        throw fetchError('RESULT_FETCH_DNS_FAILED', 'Result host could not be resolved', error);
    }
    if (!Array.isArray(records) || records.length === 0) {
        throw fetchError('RESULT_FETCH_DNS_FAILED', 'Result host did not resolve');
    }
    // 只解析一次，随后把连接钉在这个地址上：解析与连接之间不再给 DNS 重绑定留窗口。
    for (const record of records) {
        const address = typeof record === 'string' ? record : record?.address;
        try {
            assertAddressAllowed(address, { allowLoopback });
            return { address, family: net.isIP(address) };
        } catch {
            continue;
        }
    }
    throw fetchError('RESULT_FETCH_BLOCKED_HOST', 'Result host resolves to a non-public address');
}

// https 的 SNI/证书校验仍按主机名进行，只有地址解析被钉死，
// 因此既防重绑定又不牺牲证书验证。
function pinnedLookup(address, family) {
    return function lookup(_hostname, options, callback) {
        const actualOptions = typeof options === 'function' ? {} : (options || {});
        const done = typeof options === 'function' ? options : callback;
        if (actualOptions.all) return done(null, [{ address, family }]);
        return done(null, address, family);
    };
}

function requestOnce(target, { address, family, timeoutMs, maxBytes, signal }) {
    return new Promise((resolve, reject) => {
        let settled = false;
        let request;
        const finish = (settle, value) => {
            if (settled) return;
            settled = true;
            if (signal) signal.removeEventListener('abort', onAbort);
            settle(value);
        };
        const fail = (error) => finish(reject, error);
        function onAbort() {
            if (request) request.destroy(fetchError('RESULT_FETCH_ABORTED', 'Result download was aborted'));
            fail(fetchError('RESULT_FETCH_ABORTED', 'Result download was aborted'));
        }
        if (signal && signal.aborted) return fail(fetchError('RESULT_FETCH_ABORTED', 'Result download was aborted'));

        const transport = target.protocol === 'https:' ? https : http;
        try {
            request = transport.request({
                protocol: target.protocol,
                hostname: target.hostname.replace(/^\[|\]$/g, ''),
                port: target.port || undefined,
                path: `${target.pathname}${target.search}`,
                method: 'GET',
                // 不复用 agent：连接一旦复用，钉住的地址就不再受本次校验约束。
                agent: false,
                headers: {
                    accept: 'image/*,video/*,audio/*,application/pdf;q=0.9,*/*;q=0.1',
                    'accept-encoding': 'identity',
                    'user-agent': 'PaintTrackWorker/1.0',
                },
                lookup: pinnedLookup(address, family),
            });
        } catch (error) {
            return fail(fetchError('RESULT_FETCH_REQUEST_FAILED', 'Result request could not be created', error));
        }
        if (signal) signal.addEventListener('abort', onAbort, { once: true });
        request.setTimeout(timeoutMs, () => {
            request.destroy(fetchError('RESULT_FETCH_TIMEOUT', 'Result download timed out'));
        });
        request.on('error', (error) => {
            if (error instanceof ProviderResultFetchError) return fail(error);
            const code = error?.code === 'ETIMEDOUT' ? 'RESULT_FETCH_TIMEOUT' : 'RESULT_FETCH_NETWORK';
            fail(fetchError(code, 'Result download failed', error));
        });
        request.on('response', (response) => {
            const status = response.statusCode || 0;
            if (REDIRECT_STATUSES.has(status)) {
                response.resume();
                return finish(resolve, { redirect: response.headers.location || null, status });
            }
            if (status < 200 || status >= 300) {
                response.resume();
                return fail(fetchError('RESULT_FETCH_HTTP_STATUS', `Result download returned status ${status}`));
            }
            const declaredLength = Number(response.headers['content-length']);
            if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
                response.destroy();
                return fail(fetchError('RESULT_FETCH_TOO_LARGE', 'Result exceeds the archive size limit'));
            }
            const chunks = [];
            let total = 0;
            response.on('data', (chunk) => {
                total += chunk.length;
                if (total > maxBytes) {
                    response.destroy();
                    request.destroy();
                    fail(fetchError('RESULT_FETCH_TOO_LARGE', 'Result exceeds the archive size limit'));
                    return;
                }
                chunks.push(chunk);
            });
            response.on('error', (error) => fail(fetchError('RESULT_FETCH_NETWORK', 'Result download failed', error)));
            response.on('end', () => finish(resolve, {
                status,
                redirect: null,
                contentType: String(response.headers['content-type'] || '').split(';')[0].trim().toLowerCase(),
                bytes: Buffer.concat(chunks),
            }));
        });
        request.end();
    });
}

function assertMediaTypeCompatible(contentType, mediaType) {
    const allowed = CONTENT_TYPE_PREFIXES[mediaType];
    if (!allowed) throw fetchError('RESULT_FETCH_UNSUPPORTED_MEDIA', 'Result media type is not supported');
    // 缺失 Content-Type 时不做猜测：宁可失败，也不把未知内容当成图片归档。
    if (!contentType) throw fetchError('RESULT_FETCH_CONTENT_TYPE_MISSING', 'Result response has no content type');
    if (!allowed.some((prefix) => contentType.startsWith(prefix))) {
        throw fetchError('RESULT_FETCH_CONTENT_TYPE_MISMATCH', 'Result content type does not match the declared media type');
    }
    return contentType;
}

async function downloadResult({ url, mediaType }, options) {
    if (!CONTENT_TYPE_PREFIXES[mediaType]) {
        throw fetchError('RESULT_FETCH_UNSUPPORTED_MEDIA', 'Result media type is not supported');
    }
    let target = normalizeTargetUrl(url, options);
    for (let hop = 0; hop <= options.maxRedirects; hop += 1) {
        const resolved = await resolveVerifiedTarget(target, options);
        // 每一跳都重新校验目标：不能因为首跳合法就信任重定向落点。
        const response = await requestOnce(target, {
            address: resolved.address,
            family: resolved.family,
            timeoutMs: options.timeoutMs,
            maxBytes: options.maxBytes,
            signal: options.signal,
        });
        if (REDIRECT_STATUSES.has(response.status)) {
            if (!response.redirect) throw fetchError('RESULT_FETCH_REDIRECT_INVALID', 'Result redirect has no location');
            if (hop === options.maxRedirects) throw fetchError('RESULT_FETCH_REDIRECT_LIMIT', 'Result redirect limit exceeded');
            let next;
            try {
                next = new URL(response.redirect, target).toString();
            } catch {
                throw fetchError('RESULT_FETCH_REDIRECT_INVALID', 'Result redirect location is invalid');
            }
            target = normalizeTargetUrl(next, options);
            continue;
        }
        const mimeType = assertMediaTypeCompatible(response.contentType, mediaType);
        return Object.freeze({
            bytes: response.bytes,
            mimeType,
            sizeBytes: response.bytes.length,
            finalUrl: target.toString(),
        });
    }
    throw fetchError('RESULT_FETCH_REDIRECT_LIMIT', 'Result redirect limit exceeded');
}

// allowInsecureLoopback 只用于本地/测试环境；生产一律强制关闭，
// 这样回环地址与明文 HTTP 不会因为配置失误进入线上路径。
function createResultFetcher({
    maxBytes = DEFAULT_MAX_BYTES,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxRedirects = DEFAULT_MAX_REDIRECTS,
    allowInsecureLoopback = false,
    nodeEnv = process.env.NODE_ENV,
    resolveHost = dns.promises.lookup,
} = {}) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new TypeError('maxBytes must be a positive safe integer');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs must be a positive safe integer');
    if (!Number.isInteger(maxRedirects) || maxRedirects < 0) throw new TypeError('maxRedirects must be a non-negative integer');
    if (typeof resolveHost !== 'function') throw new TypeError('resolveHost must be a function');

    const options = Object.freeze({
        maxBytes,
        timeoutMs,
        maxRedirects,
        allowLoopback: allowInsecureLoopback === true && nodeEnv !== 'production',
        resolveHost,
        signal: undefined,
    });

    return Object.freeze({
        maxBytes,
        async fetchResult({ url, mediaType, signal } = {}) {
            return downloadResult({ url, mediaType }, { ...options, signal });
        },
    });
}

module.exports = {
    CONTENT_TYPE_PREFIXES,
    DEFAULT_MAX_BYTES,
    ProviderResultFetchError,
    createResultFetcher,
    isBlockedAddress,
    normalizeTargetUrl,
};
