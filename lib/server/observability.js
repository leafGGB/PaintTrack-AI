const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LOG_FIELDS = new Set([
    'service', 'event', 'requestId', 'taskId', 'status', 'errorCode',
    'durationMs', 'retryCount', 'inputTokens', 'outputTokens',
]);
const AUDIT_FIELDS = new Set([
    'action', 'actorId', 'resourceType', 'resourceId', 'outcome', 'requestId',
]);
const AUDIT_LOG_FIELDS = new Set(['event', ...AUDIT_FIELDS]);

function getRequestId(candidate) {
    return typeof candidate === 'string' && candidate.length === 36 && UUID_PATTERN.test(candidate)
        ? candidate
        : globalThis.crypto.randomUUID();
}

function pickFields(source, allowedFields) {
    const result = {};
    if (!source || typeof source !== 'object' || Array.isArray(source)) return result;

    for (const [key, value] of Object.entries(source)) {
        if (!allowedFields.has(key)) continue;
        if (typeof value === 'string' && value.length <= 200) result[key] = value;
        else if (typeof value === 'number' && Number.isFinite(value)) result[key] = value;
    }
    return result;
}

function writeLogWithFields(level, fields, sink, allowedFields) {
    if (!['info', 'warn', 'error'].includes(level)) throw new TypeError('Unsupported log level');
    const record = {
        timestamp: new Date().toISOString(),
        environment: process.env.NODE_ENV || 'development',
        ...pickFields(fields, allowedFields),
    };
    sink[level](JSON.stringify(record));
    return record;
}

function writeLog(level, fields, sink = console) {
    return writeLogWithFields(level, fields, sink, LOG_FIELDS);
}

function createErrorResponse({ code, requestId, message = 'Request failed' }) {
    if (typeof code !== 'string' || !/^[A-Z][A-Z0-9_]{1,63}$/.test(code)) {
        throw new TypeError('A stable error code is required');
    }
    const normalizedRequestId = getRequestId(requestId);
    return {
        body: { error: { code, message, requestId: normalizedRequestId } },
        headers: { 'x-request-id': normalizedRequestId, 'Cache-Control': 'no-store' },
    };
}

function emitAuditEvent(event, sink = console) {
    const fields = pickFields(event, AUDIT_FIELDS);
    if (typeof fields.action !== 'string' || typeof fields.outcome !== 'string') {
        throw new TypeError('Audit events require action and outcome');
    }
    const record = { ...fields, requestId: getRequestId(fields.requestId) };
    writeLogWithFields('info', { event: 'audit', ...record }, sink, AUDIT_LOG_FIELDS);
    return record;
}

module.exports = { createErrorResponse, emitAuditEvent, getRequestId, writeLog };
