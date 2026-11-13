'use strict';

const { ProviderError } = require('./mockProvider');

const notStartedErrors = new WeakSet();

function isProviderInvocationNotStarted(error) {
    return notStartedErrors.has(error);
}
const STATES = Object.freeze({ ACTIVE: 'active', DRAINING: 'draining', REVOKED: 'revoked', CLOSED: 'closed' });
const OPERATIONS = Object.freeze(['submit', 'query', 'cancel']);

function gateError(code, message, { notStarted = false } = {}) {
    const error = new ProviderError('PROVIDER_UNKNOWN', message);
    error.code = code;
    error.retryable = false;
    error.submissionUnknown = false;
    if (notStarted) notStartedErrors.add(error);
    return error;
}

function createProviderInvocationGate(adapter, { setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout,
    now = Date.now } = {}) {
    if (!adapter || typeof adapter !== 'object' || OPERATIONS.some((operation) => typeof adapter[operation] !== 'function')) {
        throw new TypeError('adapter must implement submit, query, and cancel');
    }
    let state = STATES.ACTIVE;
    let deadlineAt = null;
    let deadlineTimer = null;
    const inFlight = new Set();
    let closePromise = null;

    function abortAll(reason) {
        for (const controller of inFlight) controller.abort(reason);
    }

    function expireDrain() {
        if (state !== STATES.DRAINING) return;
        const remaining = deadlineAt - now();
        if (remaining > 0) return;
        state = STATES.CLOSED;
        clearTimeoutImpl(deadlineTimer);
        deadlineTimer = null;
        abortAll(gateError('PROVIDER_GATE_CLOSED', 'Provider invocation gate is closed'));
    }

    function rejectForState(operation) {
        if (state === STATES.REVOKED) return gateError('PROVIDER_GATE_REVOKED', 'Provider invocation gate was revoked', { notStarted: operation === 'submit' });
        if (state === STATES.CLOSED) return gateError('PROVIDER_GATE_CLOSED', 'Provider invocation gate is closed', { notStarted: operation === 'submit' });
        if (state === STATES.DRAINING && operation === 'submit') return gateError('PROVIDER_GATE_DRAINING', 'Provider invocation gate is draining', { notStarted: true });
        return null;
    }

    async function invoke(operation, request, options = {}) {
        expireDrain();
        const denied = rejectForState(operation);
        if (denied) throw denied;
        const controller = new AbortController();
        const callerSignal = options && options.signal;
        const abortFromCaller = () => controller.abort(callerSignal.reason);
        if (callerSignal?.aborted) abortFromCaller();
        else callerSignal?.addEventListener('abort', abortFromCaller, { once: true });
        inFlight.add(controller);

        let dispatchedToAdapter = false;
        const invocationError = () => {
            if (operation === 'submit' && dispatchedToAdapter) {
                return new ProviderError('PROVIDER_UNKNOWN', 'Provider submission result is unknown', { submissionUnknown: true });
            }
            const code = state === STATES.REVOKED ? 'PROVIDER_GATE_REVOKED'
                : state === STATES.CLOSED ? 'PROVIDER_GATE_CLOSED'
                    : state === STATES.DRAINING && !controller.signal.aborted ? 'PROVIDER_GATE_DRAINING'
                        : 'PROVIDER_GATE_ABORTED';
            return gateError(code, 'Provider invocation was stopped', { notStarted: operation === 'submit' });
        };
        let removeAbort;
        const aborted = new Promise((_, reject) => {
            removeAbort = () => reject(invocationError());
            if (controller.signal.aborted) removeAbort();
            else controller.signal.addEventListener('abort', removeAbort, { once: true });
        });
        try {
            const dispatched = Promise.resolve().then(() => {
                expireDrain();
                if (controller.signal.aborted || rejectForState(operation)) throw invocationError();
                dispatchedToAdapter = true;
                return adapter[operation](request, { ...options, signal: controller.signal });
            });
            const result = await Promise.race([dispatched, aborted]);
            expireDrain();
            if (controller.signal.aborted) throw invocationError();
            return result;
        } catch (error) {
            expireDrain();
            if (controller.signal.aborted || !dispatchedToAdapter) throw invocationError();
            // 适配器可能重抛另一次调用的 gate 错误，不能沿用它的未发送凭据。
            if (operation === 'submit' && isProviderInvocationNotStarted(error)) throw invocationError();
            throw error;
        } finally {
            controller.signal.removeEventListener('abort', removeAbort);
            callerSignal?.removeEventListener('abort', abortFromCaller);
            inFlight.delete(controller);
        }
    }

    const provider = Object.freeze({
        name: adapter.name,
        version: adapter.version,
        capabilities: adapter.capabilities,
        submit: (request, options) => invoke('submit', request, options),
        query: (request, options) => invoke('query', request, options),
        cancel: (request, options) => invoke('cancel', request, options),
        toString: () => '[provider invocation gate]',
    });

    const control = Object.freeze({
        getState() { expireDrain(); return state; },
        drain(deadline) {
            expireDrain();
            if (state === STATES.REVOKED || state === STATES.CLOSED) return false;
            if (state === STATES.DRAINING) return false;
            const at = deadline instanceof Date ? deadline.getTime() : deadline;
            if (!Number.isFinite(at) || at <= now()) {
                state = STATES.CLOSED;
                abortAll(gateError('PROVIDER_GATE_CLOSED', 'Provider invocation gate is closed'));
                return true;
            }
            state = STATES.DRAINING;
            deadlineAt = at;
            function scheduleDeadline() {
                deadlineTimer = setTimeoutImpl(() => {
                    deadlineTimer = null;
                    expireDrain();
                    if (state === STATES.DRAINING) scheduleDeadline();
                }, Math.max(0, at - now()));
            }
            scheduleDeadline();
            return true;
        },
        revoke() {
            if (state === STATES.REVOKED || state === STATES.CLOSED) return false;
            clearTimeoutImpl(deadlineTimer);
            deadlineTimer = null;
            state = STATES.REVOKED;
            abortAll(gateError('PROVIDER_GATE_REVOKED', 'Provider invocation gate was revoked'));
            return true;
        },
        close() {
            if (closePromise) return closePromise;
            clearTimeoutImpl(deadlineTimer);
            deadlineTimer = null;
            if (state !== STATES.REVOKED) state = STATES.CLOSED;
            abortAll(gateError(state === STATES.REVOKED ? 'PROVIDER_GATE_REVOKED' : 'PROVIDER_GATE_CLOSED', 'Provider invocation gate is closed'));
            closePromise = Promise.resolve();
            return closePromise;
        },
    });

    return Object.freeze({ provider, control });
}

module.exports = { createProviderInvocationGate, STATES, isProviderInvocationNotStarted };
