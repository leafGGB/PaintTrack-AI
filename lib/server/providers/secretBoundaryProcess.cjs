'use strict';

// Local synthetic-secret slice only. The parent is a trusted supervisor, not Web.
// No environment-secret fallback, filesystem store, database, or network access.
const MAX_MESSAGE_BYTES = 65536;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
const exact = (value, keys) => value && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const validRef = (value) => exact(value, ['providerInstanceId', 'credentialRef', 'credentialVersion'])
    && typeof value.providerInstanceId === 'string' && ID.test(value.providerInstanceId)
    && typeof value.credentialRef === 'string' && ID.test(value.credentialRef)
    && Number.isSafeInteger(value.credentialVersion) && value.credentialVersion > 0;
const key = (value) => JSON.stringify([value.providerInstanceId, value.credentialRef, value.credentialVersion]);
const send = (message) => {
    if (process.connected) process.send(message, () => {});
};
let initialized = false;
let principal;
let allow = new Set();
const secrets = new Map();
const revoked = new Set();

process.on('message', (message) => {
    let bytes;
    try { bytes = Buffer.byteLength(JSON.stringify(message)); } catch { return; }
    if (bytes > MAX_MESSAGE_BYTES || !message || typeof message !== 'object') return;
    if (!initialized) {
        if (!exact(message, ['type', 'principal', 'entries', 'allowed']) || message.type !== 'initialize'
            || !['worker', 'web'].includes(message.principal) || !Array.isArray(message.entries)
            || !Array.isArray(message.allowed) || message.entries.length > 32 || message.allowed.length > 32) {
            send({ type: 'initialization', code: 'SECRET_INITIALIZATION_REJECTED' });
            return;
        }
        const entries = new Map();
        for (const entry of message.entries) {
            if (!exact(entry, ['reference', 'value']) || !validRef(entry.reference)
                || typeof entry.value !== 'string' || entry.value.length < 1 || entry.value.length > 4096
                || entries.has(key(entry.reference))) {
                send({ type: 'initialization', code: 'SECRET_INITIALIZATION_REJECTED' });
                return;
            }
            entries.set(key(entry.reference), entry.value);
        }
        if (!message.allowed.every(validRef)) {
            send({ type: 'initialization', code: 'SECRET_INITIALIZATION_REJECTED' });
            return;
        }
        principal = message.principal; // Bound once by the trusted channel creator.
        allow = new Set(message.allowed.map(key));
        for (const [ref, value] of entries) secrets.set(ref, value);
        initialized = true;
        send({ type: 'initialization', code: 'READY' });
        return;
    }
    if (typeof message.id !== 'string' || !ID.test(message.id)) return;
    const fail = (code) => send({ type: 'response', id: message.id, code });
    if (!exact(message, ['type', 'id', 'reference']) || !validRef(message.reference)
        || !['resolve', 'revoke'].includes(message.type)) {
        fail('SECRET_REQUEST_REJECTED');
        return;
    }
    const ref = key(message.reference);
    if (principal !== 'worker' || !allow.has(ref)) {
        fail('SECRET_ACCESS_DENIED');
        return;
    }
    if (message.type === 'revoke') {
        revoked.add(ref);
        secrets.delete(ref);
        send({ type: 'response', id: message.id, code: 'REVOKED' });
    } else if (revoked.has(ref)) {
        fail('SECRET_VERSION_REVOKED');
    } else if (!secrets.has(ref)) {
        fail('SECRET_NOT_FOUND');
    } else {
        send({ type: 'response', id: message.id, code: 'RESOLVED', value: secrets.get(ref) });
    }
});
process.on('disconnect', () => { secrets.clear(); allow.clear(); process.exit(0); });
process.on('uncaughtException', () => { secrets.clear(); process.exit(1); });
