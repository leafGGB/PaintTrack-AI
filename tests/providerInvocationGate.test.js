'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createProviderInvocationGate, STATES, isProviderInvocationNotStarted } = require('../lib/server/providers/providerInvocationGate');

function adapter(overrides = {}) {
    const calls = [];
    const provider = {
        name: 'memory-provider',
        capabilities: Object.freeze({ operations: Object.freeze({ submit: true, query: true, cancel: true }) }),
        async submit(request, options) { calls.push(['submit', request, options.signal]); return { kind: 'accepted', providerJobId: 'job-1' }; },
        async query(request, options) { calls.push(['query', request, options.signal]); return { state: 'running' }; },
        async cancel(request, options) { calls.push(['cancel', request, options.signal]); return { state: 'cancelled' }; },
        ...overrides,
    };
    return { provider, calls };
}

test('revoke blocks every later operation and aborts in-flight non-cooperative calls without accepting late success', async () => {
    let release;
    let observedSignal;
    const { provider, calls } = adapter({ submit: async (_request, { signal }) => {
        calls.push(['submit']); observedSignal = signal;
        return new Promise((resolve) => { release = resolve; });
    } });
    const { provider: gated, control } = createProviderInvocationGate(provider);
    const pending = gated.submit({ idempotencyKey: 'same-key' }).then(() => assert.fail('late result succeeded'), (error) => error);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(control.revoke(), true);
    assert.equal(control.getState(), STATES.REVOKED);
    assert.equal(observedSignal.aborted, true);
    assert.equal((await pending).code, 'PROVIDER_UNKNOWN');
    release({ kind: 'completed' });
    for (const operation of ['submit', 'query', 'cancel']) {
        await assert.rejects(gated[operation]({}, {}), (error) => error.code === 'PROVIDER_GATE_REVOKED');
    }
    assert.deepEqual(calls.map(([name]) => name), ['submit']);
    await control.close();
    await control.close();
    assert.equal(control.getState(), STATES.REVOKED);
});

test('submit rejected before adapter dispatch has an explicit fixed code and marker', async () => {
    const { provider, calls } = adapter();
    const { provider: gated, control } = createProviderInvocationGate(provider);
    control.revoke();
    await assert.rejects(gated.submit({}), (error) => {
        assert.equal(error.code, 'PROVIDER_GATE_REVOKED');
        assert.equal(isProviderInvocationNotStarted(error), true);
        return true;
    });
    assert.equal(calls.length, 0);
});

test('drain rejects submit, permits query/cancel until deadline, then aborts in-flight work fail-closed', async () => {
    let clock = 100;
    let timer;
    const { provider, calls } = adapter({ query: async (_request, { signal }) => {
        calls.push(['query']);
        return new Promise((resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
            void resolve;
        });
    } });
    const { provider: gated, control } = createProviderInvocationGate(provider, {
        now: () => clock,
        setTimeoutImpl: (fn, delay) => { timer = { fn, delay }; return timer; },
        clearTimeoutImpl: (handle) => { if (timer === handle) timer = null; },
    });
    assert.equal(control.drain(150), true);
    assert.equal(control.getState(), STATES.DRAINING);
    assert.equal(timer.delay, 50);
    await assert.rejects(gated.submit({}), (error) => error.code === 'PROVIDER_GATE_DRAINING' && isProviderInvocationNotStarted(error));
    const query = gated.query({ providerJobId: 'job-1' });
    assert.equal((await gated.cancel({ providerJobId: 'job-1' })).state, 'cancelled');
    await new Promise((resolve) => setImmediate(resolve));
    clock = 150;
    timer.fn();
    assert.equal(control.getState(), STATES.CLOSED);
    await assert.rejects(query, (error) => error.code === 'PROVIDER_GATE_CLOSED');
    assert.deepEqual(calls.map(([name]) => name), ['query', 'cancel']);
});

test('caller AbortSignal is merged and listeners/resources are cleaned up idempotently', async () => {
    let passedSignal;
    const { provider } = adapter({ query: async (_request, { signal }) => {
        passedSignal = signal;
        return 'done';
    } });
    const { provider: gated, control } = createProviderInvocationGate(provider);
    const caller = new AbortController();
    assert.equal(await gated.query({}, { signal: caller.signal }), 'done');
    assert.equal(passedSignal.aborted, false);
    assert.equal(caller.signal.listenerCount, undefined);
    const lateController = new AbortController();
    await gated.query({}, { signal: lateController.signal });
    lateController.abort(new Error('caller cancelled'));
    await control.close();
    await control.close();
    assert.equal(control.getState(), STATES.CLOSED);
    await assert.rejects(gated.cancel({}), (error) => error.code === 'PROVIDER_GATE_CLOSED');
});

test('预中止 signal 在独立进程中不产生 unhandledRejection', async () => {
    const { promisify } = require('node:util');
    const { execFile } = require('node:child_process');
    const result = await promisify(execFile)(process.execPath, ['--unhandled-rejections=strict', '-e', `
        const assert = require('node:assert/strict');
        const { createProviderInvocationGate, isProviderInvocationNotStarted } = require(${JSON.stringify(require.resolve('../lib/server/providers/providerInvocationGate'))});
        let calls = 0;
        const invoke = async () => { calls++; };
        const gate = createProviderInvocationGate({ submit: invoke, query: invoke, cancel: invoke });
        const caller = new AbortController();
        caller.abort(new Error('预中止'));
        process.on('unhandledRejection', () => { process.exitCode = 2; });
        (async () => {
            for (const operation of ['submit', 'query', 'cancel']) {
                await assert.rejects(gate.provider[operation]({}, { signal: caller.signal }), error => {
                    assert.equal(error.code, 'PROVIDER_GATE_ABORTED');
                    assert.equal(isProviderInvocationNotStarted(error), operation === 'submit');
                    return true;
                });
            }
            assert.equal(calls, 0);
            await gate.control.close();
            await new Promise(setImmediate);
        })().catch(() => { process.exitCode = 1; });
    `], { timeout: 5000 });
    assert.equal(result.stderr, '');
});

test('submit 后同步 revoke、close、drain 或 abort 都不会 dispatch，且带可信未发送凭据', async () => {
    for (const action of ['revoke', 'close', 'drain', 'abort']) {
        const { provider, calls } = adapter();
        const gate = createProviderInvocationGate(provider);
        const caller = new AbortController();
        const pending = gate.provider.submit({}, { signal: caller.signal });
        if (action === 'abort') caller.abort(new Error('同步中止'));
        else if (action === 'drain') gate.control.drain(Date.now() + 1000);
        else gate.control[action]();
        await assert.rejects(pending, (error) => {
            assert.equal(isProviderInvocationNotStarted(error), true);
            assert.equal(error.submissionUnknown, false);
            assert.equal(error.code, `PROVIDER_GATE_${({ revoke: 'REVOKED', close: 'CLOSED', drain: 'DRAINING', abort: 'ABORTED' })[action]}`);
            return true;
        });
        assert.equal(calls.length, 0, action);
        await gate.control.close();
    }
});

test('私有未发送凭据不可伪造，已 dispatch 不复用旧 gate 错误或外部 abort reason', async () => {
    const previous = createProviderInvocationGate(adapter().provider);
    previous.control.revoke();
    const oldError = await previous.provider.submit({}).catch((error) => error);
    const forged = Object.assign(new Error('伪造'), { code: 'PROVIDER_GATE_CLOSED', [Symbol('provider invocation not started')]: true });
    assert.equal(require('../lib/server/providers/providerInvocationGate').NOT_STARTED, undefined);
    assert.equal(isProviderInvocationNotStarted(forged), false);
    assert.equal(isProviderInvocationNotStarted(Object.assign(new Error(), oldError)), false);
    assert.equal(isProviderInvocationNotStarted(Object.create(oldError)), false);
    assert.equal(isProviderInvocationNotStarted(null), false);
    for (const reason of [oldError, forged, new Error('外部原因')]) {
        let entered;
        const started = new Promise((resolve) => { entered = resolve; });
        const caller = new AbortController();
        const gate = createProviderInvocationGate(adapter({ submit: () => { entered(); return new Promise(() => {}); } }).provider);
        const pending = gate.provider.submit({}, { signal: caller.signal });
        await started;
        caller.abort(reason);
        await assert.rejects(pending, (error) => error.code === 'PROVIDER_UNKNOWN'
            && error.submissionUnknown === true && !isProviderInvocationNotStarted(error));
        await gate.control.close();
    }
    const gate = createProviderInvocationGate(adapter({ submit: async () => { throw oldError; } }).provider);
    await assert.rejects(gate.provider.submit({}), (error) => error.code === 'PROVIDER_UNKNOWN'
        && error.submissionUnknown === true && !isProviderInvocationNotStarted(error));
    await gate.control.close();
    await previous.control.close();
});

function fakeClockGate(provider) {
    let clock = 100;
    const timers = new Map();
    const gate = createProviderInvocationGate(provider, {
        now: () => clock,
        setTimeoutImpl: (fn, delay) => { const handle = {}; timers.set(handle, { fn, delay }); return handle; },
        clearTimeoutImpl: (handle) => timers.delete(handle),
    });
    return { ...gate, timers, advance: (at) => { clock = at; } };
}

test('deadline 在 dispatch 微任务前检查，即使定时器尚未执行也阻止所有操作', async () => {
    for (const operation of ['submit', 'query', 'cancel']) {
        const { provider, calls } = adapter();
        const gate = fakeClockGate(provider);
        if (operation !== 'submit') gate.control.drain(150);
        const pending = gate.provider[operation]({});
        if (operation === 'submit') gate.control.drain(150);
        gate.advance(150);
        await assert.rejects(pending, (error) => error.code === 'PROVIDER_GATE_CLOSED'
            && isProviderInvocationNotStarted(error) === (operation === 'submit'));
        assert.equal(calls.length, 0);
        assert.equal(gate.control.getState(), STATES.CLOSED);
        assert.equal(gate.timers.size, 0);
        await gate.control.close();
    }
});

test('deadline 在结果接收时检查，越界成功与失败均拒绝且已发送 submit 保持 unknown', async () => {
    for (const operation of ['submit', 'query', 'cancel']) {
        for (const reject of [false, true]) {
            let settle;
            let entered;
            const started = new Promise((resolve) => { entered = resolve; });
            const gate = fakeClockGate(adapter({ [operation]: () => {
                entered();
                return new Promise((resolve, fail) => { settle = reject ? fail : resolve; });
            } }).provider);
            const pending = gate.provider[operation]({});
            await started;
            gate.control.drain(150);
            gate.advance(150);
            settle(reject ? new Error('截止后的失败') : { kind: 'accepted', state: 'succeeded' });
            await assert.rejects(pending, (error) => {
                assert.equal(error.code, operation === 'submit' ? 'PROVIDER_UNKNOWN' : 'PROVIDER_GATE_CLOSED');
                assert.equal(error.submissionUnknown, operation === 'submit');
                assert.equal(isProviderInvocationNotStarted(error), false);
                return true;
            });
            assert.equal(gate.timers.size, 0);
            await gate.control.close();
        }
    }
});

test('多次 getState/invoke 仅保留一个 drain timer，提前触发后重排且 close 清零', async () => {
    const gate = fakeClockGate(adapter().provider);
    gate.control.drain(150);
    const [first] = gate.timers.keys();
    for (let i = 0; i < 5; i++) {
        assert.equal(gate.control.getState(), STATES.DRAINING);
        await gate.provider.query({});
        await gate.provider.cancel({});
        await assert.rejects(gate.provider.submit({}), (error) => isProviderInvocationNotStarted(error));
        assert.equal(gate.timers.size, 1);
        assert.equal(gate.timers.has(first), true);
    }
    const callback = gate.timers.get(first).fn;
    gate.timers.delete(first);
    gate.advance(120);
    callback();
    assert.equal(gate.timers.size, 1);
    assert.equal([...gate.timers.values()][0].delay, 30);
    await gate.control.close();
    await gate.control.close();
    assert.equal(gate.timers.size, 0);
});
