'use strict';

const { fork } = require('node:child_process');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

class SecretBoundaryError extends Error {
    constructor(code) {
        super(code);
        this.name = 'SecretBoundaryError';
        this.code = code;
    }
}
const fail = (code) => new SecretBoundaryError(code);
const validReference = (reference) => {
    const pattern = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
    return reference && Object.getPrototypeOf(reference) === Object.prototype
        && Object.keys(reference).sort().join(',') === 'credentialRef,credentialVersion,providerInstanceId'
        && typeof reference.providerInstanceId === 'string' && pattern.test(reference.providerInstanceId)
        && typeof reference.credentialRef === 'string' && pattern.test(reference.credentialRef)
        && Number.isSafeInteger(reference.credentialVersion) && reference.credentialVersion > 0;
};
const ERROR_CODES = new Set(['SECRET_REQUEST_REJECTED', 'SECRET_ACCESS_DENIED', 'SECRET_VERSION_REVOKED', 'SECRET_NOT_FOUND']);

// Supervisor API for synthetic local fixtures. Do not hand this object or seed to Web.
// A resolver is a capability: possessing the closure grants its channel's authority.
async function createSyntheticSecretBoundary({ principal, entries, allowed, timeoutMs = 1000, maxPending = 16 } = {}) {
    if (!['worker', 'web'].includes(principal) || !Array.isArray(entries) || entries.length > 32
        || !Array.isArray(allowed) || allowed.length > 32 || !allowed.every(validReference)
        || !entries.every((entry) => entry && Object.keys(entry).sort().join(',') === 'reference,value'
            && validReference(entry.reference) && typeof entry.value === 'string'
            && entry.value.length > 0 && entry.value.length <= 4096)
        || !Number.isSafeInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 30000
        || !Number.isSafeInteger(maxPending) || maxPending < 1 || maxPending > 64) {
        throw fail('SECRET_INITIALIZATION_REJECTED');
    }
    const seed = { type: 'initialize', principal, entries, allowed };
    if (Buffer.byteLength(JSON.stringify(seed)) > 65536) throw fail('SECRET_INITIALIZATION_REJECTED');
    const env = {};
    for (const name of ['SystemRoot', 'WINDIR', 'PATH', 'TEMP', 'TMP', 'LANG']) {
        if (process.env[name]) env[name] = process.env[name];
    }
    const child = fork(path.join(__dirname, 'secretBoundaryProcess.cjs'), [], {
        env, execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    let closed = false;
    const pending = new Map();
    let readyResolve;
    let readyReject;
    const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    const closePending = () => {
        closed = true;
        readyReject(fail('SECRET_SERVICE_UNAVAILABLE'));
        for (const item of pending.values()) {
            clearTimeout(item.timer);
            item.reject(fail('SECRET_SERVICE_UNAVAILABLE'));
        }
        pending.clear();
    };
    const exited = new Promise((resolve) => {
        child.once('exit', resolve);
        child.once('error', resolve);
    });
    child.on('error', closePending);
    child.on('disconnect', closePending);
    child.on('exit', closePending);
    child.on('message', (message) => {
        if (!message || typeof message !== 'object') return;
        if (message.type === 'initialization') {
            if (message.code === 'READY') readyResolve();
            else readyReject(fail('SECRET_INITIALIZATION_REJECTED'));
            return;
        }
        const item = pending.get(message.id);
        if (!item) return;
        pending.delete(message.id);
        clearTimeout(item.timer);
        if (message.type !== 'response') { item.reject(fail('SECRET_PROTOCOL_ERROR')); return; }
        if (message.code === 'RESOLVED' && item.type === 'resolve' && typeof message.value === 'string') item.resolve(message.value);
        else if (message.code === 'REVOKED' && item.type === 'revoke') item.resolve();
        else item.reject(fail(ERROR_CODES.has(message.code) ? message.code : 'SECRET_PROTOCOL_ERROR'));
    });
    const readyTimer = setTimeout(() => readyReject(fail('SECRET_SERVICE_TIMEOUT')), timeoutMs);
    child.send(seed, (error) => { if (error) readyReject(fail('SECRET_SERVICE_UNAVAILABLE')); });
    try {
        await ready;
    } catch (error) {
        child.kill();
        await exited;
        throw error;
    } finally {
        clearTimeout(readyTimer);
    }
    function request(type, reference) {
        if (!validReference(reference)) return Promise.reject(fail('SECRET_REQUEST_REJECTED'));
        if (closed || !child.connected) return Promise.reject(fail('SECRET_SERVICE_UNAVAILABLE'));
        if (pending.size >= maxPending) return Promise.reject(fail('SECRET_REQUEST_LIMIT'));
        const id = randomUUID();
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                pending.delete(id);
                reject(fail('SECRET_SERVICE_TIMEOUT'));
            }, timeoutMs);
            pending.set(id, { resolve, reject, timer, type });
            child.send({ type, id, reference }, (error) => {
                if (!error) return;
                const item = pending.get(id);
                if (!item) return;
                pending.delete(id);
                clearTimeout(timer);
                reject(fail('SECRET_SERVICE_UNAVAILABLE'));
            });
        });
    }
    return Object.freeze({
        // Pass only this closure to an authorized adapter, never the supervisor handle.
        resolve: (reference) => request('resolve', reference),
        revoke: (reference) => request('revoke', reference),
        async close() {
            closePending();
            if (child.connected) child.disconnect();
            await exited;
        },
    });
}

module.exports = { createSyntheticSecretBoundary, SecretBoundaryError };
