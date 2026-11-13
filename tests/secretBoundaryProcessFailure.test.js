'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const path = require('node:path');

const boundaryPath = require.resolve('../lib/server/providers/secretBoundary');
const processPath = path.join(path.dirname(boundaryPath), 'secretBoundaryProcess.cjs');
const reference = Object.freeze({ providerInstanceId: 'failure-test-provider', credentialRef: 'failure-test-key', credentialVersion: 1 });
const secret = 'synthetic-process-failure-secret';
const legacySecret = 'synthetic-legacy-environment-secret';
const options = () => ({ principal: 'worker', entries: [{ reference, value: secret }], allowed: [reference] });

function bounded(promise, message) {
    let timer;
    return Promise.race([
        promise,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), 3000); }),
    ]).finally(() => clearTimeout(timer));
}

function assertSanitized(error, code) {
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    for (const value of [String(error), error.stack, JSON.stringify(error)]) {
        assert.ok(!value.includes(secret));
        assert.ok(!value.includes(legacySecret));
    }
}

async function withRealChild(holdMessages, run) {
    const previousModule = require.cache[boundaryPath];
    const originalFork = childProcess.fork;
    const childRecords = [];
    const observed = [];
    const waiters = new Map();
    const observe = (key) => {
        observed.push(key);
        waiters.get(key)?.resolve();
    };
    childProcess.fork = (modulePath, args, forkOptions) => {
        assert.equal(path.resolve(modulePath), path.resolve(processPath));
        const child = originalFork(modulePath, args, {
            ...forkOptions,
            stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        });
        childRecords.push(child);
        child._failureTestOutput = '';
        child.stdout.on('data', (chunk) => { child._failureTestOutput += chunk; });
        child.stderr.on('data', (chunk) => { child._failureTestOutput += chunk; });
        const send = child.send.bind(child);
        child.send = (message, callback) => {
            const key = message?.type === 'initialize' ? 'initialize' : message?.type;
            if (holdMessages.includes(key)) {
                observe(key);
                if (callback) callback(null);
                return true;
            }
            return send(message, callback);
        };
        return child;
    };
    delete require.cache[boundaryPath];
    try {
        const { createSyntheticSecretBoundary } = require(boundaryPath);
        await run({ createSyntheticSecretBoundary, childRecords, observed, waitFor(key) {
            if (observed.includes(key)) return Promise.resolve();
            return bounded(new Promise((resolve) => waiters.set(key, { resolve })), `等待 ${key} IPC 超时`);
        } });
    } finally {
        childProcess.fork = originalFork;
        delete require.cache[boundaryPath];
        if (previousModule) require.cache[boundaryPath] = previousModule;
        for (const child of childRecords) {
            if (child.exitCode === null && child.signalCode === null) {
                child.kill('SIGKILL');
                await bounded(new Promise((resolve) => child.once('exit', resolve)), '测试子进程未退出');
            }
        }
    }
}

test('真实 secret boundary 子进程在初始化与并发请求中被杀时 fail closed', { timeout: 12000 }, async (t) => {
    const previousEnvironment = process.env.PAINTTRACK_PROVIDER_CREDENTIAL;
    process.env.PAINTTRACK_PROVIDER_CREDENTIAL = legacySecret;
    t.after(() => {
        if (previousEnvironment === undefined) delete process.env.PAINTTRACK_PROVIDER_CREDENTIAL;
        else process.env.PAINTTRACK_PROVIDER_CREDENTIAL = previousEnvironment;
    });

    await withRealChild(['initialize'], async ({ createSyntheticSecretBoundary, childRecords, waitFor }) => {
        const startup = createSyntheticSecretBoundary(options());
        assert.equal(childRecords.length, 1);
        const child = childRecords[0];
        assert.equal(child.spawnfile, process.execPath);
        await waitFor('initialize');
        assert.equal(child.kill('SIGKILL'), true);
        await bounded(new Promise((resolve) => child.once('exit', resolve)), '初始化子进程未被 SIGKILL 结束');
        assert.ok(!child._failureTestOutput.includes(secret));
        assert.ok(!child._failureTestOutput.includes(legacySecret));
        await assert.rejects(bounded(startup, '初始化故障测试超时'), (error) => {
            assertSanitized(error, 'SECRET_SERVICE_UNAVAILABLE');
            return true;
        });
    });

    await withRealChild(['resolve', 'revoke'], async ({ createSyntheticSecretBoundary, childRecords, waitFor }) => {
        const boundary = await bounded(createSyntheticSecretBoundary(options()), '真实子进程未完成初始化');
        assert.equal(childRecords.length, 1);
        const child = childRecords[0];
        assert.equal(child.spawnfile, process.execPath);

        const resolving = boundary.resolve(reference);
        const revoking = boundary.revoke(reference);
        const resolveCheck = assert.rejects(resolving, (error) => {
            assertSanitized(error, 'SECRET_SERVICE_UNAVAILABLE');
            return true;
        });
        const revokeCheck = assert.rejects(revoking, (error) => {
            assertSanitized(error, 'SECRET_SERVICE_UNAVAILABLE');
            return true;
        });
        await Promise.all([waitFor('resolve'), waitFor('revoke')]);
        assert.deepEqual(childRecords, [child]);
        assert.equal(child.kill('SIGKILL'), true);
        await bounded(new Promise((resolve) => child.once('exit', resolve)), '请求子进程未被 SIGKILL 结束');
        assert.ok(!child._failureTestOutput.includes(secret));
        assert.ok(!child._failureTestOutput.includes(legacySecret));
        await Promise.all([resolveCheck, revokeCheck]);

        await assert.rejects(boundary.resolve(reference), (error) => {
            assertSanitized(error, 'SECRET_SERVICE_UNAVAILABLE');
            return true;
        });
        await bounded(Promise.all([boundary.close(), boundary.close()]), '重复 close 未完成');
    });
});
