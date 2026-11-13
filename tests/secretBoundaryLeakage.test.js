'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const canary = 'SYNTHETIC_CANARY_DO_NOT_LOG_7f93b1';
const secret = canary;
const fixture = String.raw`
'use strict';
const Module = require('node:module');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const net = require('node:net');
const tls = require('node:tls');
const http = require('node:http');
const https = require('node:https');
const canary = process.env.LEAKAGE_CANARY;
const guardCounts = {
    fetch: 0, 'net.connect': 0, 'net.createConnection': 0, 'net.Socket.connect': 0,
    'tls.connect': 0, 'http.request': 0, 'http.get': 0, 'https.request': 0, 'https.get': 0,
    pg: 0, 'drizzle-orm': 0,
};
const forbidden = (name) => () => {
    guardCounts[name]++;
    throw Object.assign(new Error('offline fixture blocked network or database access'), { code: 'OFFLINE_GUARD_BLOCKED' });
};
globalThis.fetch = forbidden('fetch');
net.connect = forbidden('net.connect');
net.createConnection = forbidden('net.createConnection');
net.Socket.prototype.connect = forbidden('net.Socket.connect');
tls.connect = forbidden('tls.connect');
http.request = forbidden('http.request');
http.get = forbidden('http.get');
https.request = forbidden('https.request');
https.get = forbidden('https.get');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (/^(pg|drizzle-orm)(\/|$)/.test(request)) return forbidden(request.split('/')[0])();
    return originalLoad.call(this, request, parent, isMain);
};
if (process.env.BOUNDARY_MODE) {
    const childProcess = require('node:child_process');
    childProcess.fork = () => {
        const child = new EventEmitter();
        child.connected = true;
        child.send = (message) => {
            if (message.type === 'initialize') queueMicrotask(() => child.emit('message', { type: 'initialization', code: 'READY' }));
            else if (process.env.BOUNDARY_MODE === 'exit') queueMicrotask(() => {
                child.connected = false;
                child.emit('exit', 1);
            });
        };
        child.disconnect = () => {
            child.connected = false;
            queueMicrotask(() => child.emit('exit', 0));
        };
        child.kill = () => {
            child.connected = false;
            queueMicrotask(() => child.emit('exit', 1));
        };
        return child;
    };
}
const { createSyntheticSecretBoundary } = require('./lib/server/providers/secretBoundary');
const { resolveWorkerProviderWithSecrets } = require('./lib/server/providers/providerRegistry');
const { createMyVignaImageProvider } = require('./lib/server/providers/myvignaImageProvider');
const reference = { providerInstanceId: 'offline-instance', credentialRef: 'offline-ref', credentialVersion: 1 };
const binding = { ...reference, adapterType: 'myvigna-image', baseUrl: 'https://provider.example.test/v1', upstreamModel: 'gpt-image-2' };
const secret = canary;
let pollCount = 0;
const serializeError = (error) => ({
    name: error?.name, message: error?.message, code: error?.code,
    cause: error?.cause && typeof error.cause === 'object' ? serializeError(error.cause) : error?.cause,
    nested: error?.nested,
    stack: error?.stack,
});
const captured = { guards: guardCounts };
async function boundaryCase(name, principal, mutate) {
    const boundary = await createSyntheticSecretBoundary({
        principal, entries: [{ reference, value: secret }], allowed: [reference], ...mutate,
    });
    try {
        if (name === 'wrong-ref') await boundary.resolve({ ...reference, credentialVersion: 2 });
        else if (name === 'revoked') { await boundary.revoke(reference); await boundary.resolve(reference); }
        else await boundary.resolve(reference);
        captured[name] = { returned: true };
    } catch (error) { captured[name] = { error: serializeError(error) }; }
    finally { await boundary.close(); }
}
async function runBoundaryFailure(mode, name) {
    try {
        const boundary = await createSyntheticSecretBoundary({ principal: 'worker', entries: [{ reference, value: secret }], allowed: [reference], timeoutMs: 20 });
        if (mode === 'timeout') await boundary.resolve(reference);
        else await boundary.resolve(reference);
        captured[name] = { returned: true };
        await boundary.close();
    } catch (error) { captured[name] = { error: serializeError(error) }; }
}
async function run() {
    if (process.env.GUARD_SELF_TEST === '1') {
        const probes = {
            fetch: () => globalThis.fetch('https://provider.example.test'),
            'net.connect': () => net.connect({ host: 'provider.example.test', port: 443 }),
            'net.createConnection': () => net.createConnection({ host: 'provider.example.test', port: 443 }),
            'net.Socket.connect': () => {
                const socket = new net.Socket();
                try { socket.connect({ host: 'provider.example.test', port: 443 }); }
                finally { socket.destroy(); }
            },
            'tls.connect': () => tls.connect({ host: 'provider.example.test', port: 443 }),
            'http.request': () => http.request('http://provider.example.test'),
            'http.get': () => http.get('http://provider.example.test'),
            'https.request': () => https.request('https://provider.example.test'),
            'https.get': () => https.get('https://provider.example.test'),
            pg: () => require('pg'),
            'drizzle-orm': () => require('drizzle-orm'),
        };
        for (const [name, probe] of Object.entries(probes)) {
            await assert.rejects(async () => probe(), { code: 'OFFLINE_GUARD_BLOCKED' }, name + ' 必须被拦截');
            assert.equal(guardCounts[name], 1, name + ' 必须恰好计数一次');
        }
        process.stdout.write(JSON.stringify(captured));
        return;
    }
    if (process.env.BOUNDARY_MODE) {
        await runBoundaryFailure(process.env.BOUNDARY_MODE, process.env.BOUNDARY_MODE);
        process.stdout.write(JSON.stringify(captured));
        return;
    }
    const { loadProviderConfig, requireProviderConfig } = require('./lib/server/providers/providerConfig');
    const { resolveWorkerProvider } = require('./lib/server/providers/providerRegistry');
    const originalEnvironment = process.env;
    const previousCredential = originalEnvironment.PAINTTRACK_PROVIDER_CREDENTIAL;
    const previousMode = originalEnvironment.PAINTTRACK_WORKER_PROVIDER;
    originalEnvironment.PAINTTRACK_PROVIDER_CREDENTIAL = canary;
    originalEnvironment.PAINTTRACK_WORKER_PROVIDER = 'myvigna-image';
    captured.retirement = { reads: 0 };
    const credentialGetter = () => { captured.retirement.reads++; throw new Error(canary); };
    process.env = new Proxy(originalEnvironment, {
        get(target, key) {
            if (key === 'PAINTTRACK_PROVIDER_CREDENTIAL') return credentialGetter();
            return Reflect.get(target, key);
        },
    });
    try {
        captured.retirement.config = loadProviderConfig();
        for (const [name, invoke] of [
            ['requireDefault', () => requireProviderConfig()],
            ['requireSupplied', () => requireProviderConfig({ get PAINTTRACK_PROVIDER_CREDENTIAL() { return credentialGetter(); } })],
            ['registryDefault', () => resolveWorkerProvider()],
            ['registrySupplied', () => resolveWorkerProvider({ env: { PAINTTRACK_WORKER_PROVIDER: 'myvigna-image',
                get PAINTTRACK_PROVIDER_CREDENTIAL() { return credentialGetter(); } } })],
        ]) {
            try { invoke(); captured.retirement[name] = { returned: true }; }
            catch (error) { captured.retirement[name] = { error: serializeError(error) }; }
        }
    } finally {
        process.env = originalEnvironment;
        if (previousCredential === undefined) delete originalEnvironment.PAINTTRACK_PROVIDER_CREDENTIAL;
        else originalEnvironment.PAINTTRACK_PROVIDER_CREDENTIAL = previousCredential;
        if (previousMode === undefined) delete originalEnvironment.PAINTTRACK_WORKER_PROVIDER;
        else originalEnvironment.PAINTTRACK_WORKER_PROVIDER = previousMode;
    }
    await boundaryCase('web-denied', 'web');
    await boundaryCase('wrong-ref', 'worker');
    await boundaryCase('revoked', 'worker');

    const throwingResolver = async () => {
        const inner = Object.assign(new Error('inner ' + canary), { code: canary });
        throw Object.assign(new Error('outer ' + canary, { cause: inner }), {
            code: canary, nested: { detail: canary, cause: { message: canary } },
        });
    };
    try {
        await resolveWorkerProviderWithSecrets({ descriptor: binding, approvedBindings: [binding], secretResolver: throwingResolver });
    } catch (error) { captured.resolver = { error: serializeError(error) }; }

    try {
        await resolveWorkerProviderWithSecrets({ descriptor: binding, approvedBindings: [binding],
            secretResolver: async () => secret, adapterFactory: () => { throw Object.assign(new Error(canary), { code: canary, cause: new Error(canary) }); } });
    } catch (error) { captured.factory = { error: serializeError(error) }; }

    try {
        await resolveWorkerProviderWithSecrets({ descriptor: binding, approvedBindings: [binding], secretResolver: async () => ({ value: canary }) });
    } catch (error) { captured.invalidCredential = { error: serializeError(error) }; }

    const boundary = await createSyntheticSecretBoundary({ principal: 'worker', entries: [{ reference, value: secret }], allowed: [reference] });
    captured.transport = { requests: 0, authorizationChecks: 0 };
    try {
        const provider = await resolveWorkerProviderWithSecrets({ descriptor: binding, approvedBindings: [binding],
            secretResolver: boundary.resolve,
            adapterFactory: (configuration) => createMyVignaImageProvider({ ...configuration, fetchImpl: async (url, request) => {
                captured.transport.requests++;
                assert.ok(request.headers.Authorization === 'Bearer ' + canary, '内存请求 Authorization 必须精确匹配 Bearer canary');
                captured.transport.authorizationChecks++;
                if (request.method === 'POST') {
                    if (process.env.FAIL_SUBMIT === '1') throw new Error('submit transport ' + canary);
                    return new Response(JSON.stringify({ task_id: 'offline-job', status: 'queued' }), { status: 202 });
                }
                if (url.endsWith('/result')) {
                    if (process.env.FAIL_RESULT === '1') return new Response(JSON.stringify({ error: canary }), { status: 502 });
                    return new Response(JSON.stringify({ data: [{ url: 'https://cdn.example.test/offline.png' }] }), { status: 200 });
                }
                if (process.env.FAIL_POLL === '1') throw new Error('poll transport ' + canary);
                pollCount++;
                return new Response(JSON.stringify({ task_id: 'offline-job', status: pollCount === 1 ? 'running' : 'success' }), { status: 200 });
            } }),
        });
        const input = { logicalModelId: 'gpt-image-2', prompt: 'offline only', size: '1024x1024' };
        try { captured.submit = { returned: await provider.submit({ idempotencyKey: 'offline-key', input }) }; }
        catch (error) { captured.submit = { error: serializeError(error) }; }
        if (!process.env.FAIL_SUBMIT) {
            try { captured.poll = { returned: await provider.query({ providerJobId: 'offline-job' }) }; }
            catch (error) { captured.poll = { error: serializeError(error) }; }
            if (!process.env.FAIL_POLL) {
                try { captured.result = { returned: await provider.query({ providerJobId: 'offline-job' }) }; }
                catch (error) { captured.result = { error: serializeError(error) }; }
            }
        }
    } finally { await boundary.close(); }
    process.stdout.write(JSON.stringify(captured));
}
run().catch((error) => {
    process.stderr.write(JSON.stringify({ fatal: serializeError(error) }));
    process.exitCode = 1;
});
`;

function runFixture(extraEnv = {}) {
    const child = spawnSync(process.execPath, ['-e', fixture], {
        cwd: root,
        encoding: 'utf8',
        timeout: 10000,
        env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
            TEMP: process.env.TEMP, TMP: process.env.TMP, LEAKAGE_CANARY: canary, ...extraEnv },
    });
    const output = `${child.stdout}\n${child.stderr}`;
    assert.equal(output.includes(secret), false, '真实 secret 出现在捕获的子进程输出中');
    assert.equal(child.error, undefined, '离线 fixture 启动或执行失败');
    assert.equal(child.status, 0, '离线 fixture 必须正常退出');
    const captured = JSON.parse(child.stdout);
    assert.equal(JSON.stringify(captured).includes(secret), false, '真实 secret 出现在解析后的捕获结果中');
    if (extraEnv.GUARD_SELF_TEST !== '1') {
        for (const [name, count] of Object.entries(captured.guards)) {
            assert.equal(count, 0, `${name} 不应在业务测试中被调用`);
        }
    }
    if (captured.transport) {
        assert.ok(captured.transport.requests > 0, '必须执行内存请求');
        assert.equal(captured.transport.authorizationChecks, captured.transport.requests, '每次内存请求都必须通过 Authorization 检查');
    }
    return { captured, stdout: child.stdout, stderr: child.stderr };
}

test('offline child redacts nested resolver/factory failures and rejects unauthorized references', () => {
    const { captured } = runFixture();
    for (const name of ['resolver', 'factory', 'invalidCredential', 'web-denied', 'wrong-ref', 'revoked']) {
        assert.ok(captured[name]?.error, `${name} should be a serialized error`);
        assert.equal(JSON.stringify(captured[name]).includes(canary), false, `${name} result contains canary`);
    }
    assert.equal(captured.retirement.reads, 0);
    assert.equal(captured.retirement.config.ok, false);
    assert.equal(captured.retirement.config.reason, 'PROVIDER_ENV_CREDENTIAL_RETIRED');
    for (const name of ['requireDefault', 'requireSupplied', 'registryDefault', 'registrySupplied']) {
        assert.equal(captured.retirement[name].error.code, 'PROVIDER_ENV_CREDENTIAL_RETIRED');
    }
    assert.equal(captured.resolver.error.code, 'PROVIDER_SECRET_UNAVAILABLE');
    assert.equal(captured.factory.error.code, 'PROVIDER_CONFIG_INVALID');
    assert.equal(captured.invalidCredential.error.code, 'PROVIDER_SECRET_INVALID');
    assert.equal(captured['web-denied'].error.code, 'SECRET_ACCESS_DENIED');
    assert.equal(captured['wrong-ref'].error.code, 'SECRET_ACCESS_DENIED');
    assert.equal(captured.revoked.error.code, 'SECRET_VERSION_REVOKED');
});

test('registry and actual adapter use only in-memory submit, poll, and result transport', () => {
    const { captured } = runFixture();
    assert.equal(captured.submit.returned.providerJobId, 'offline-job');
    assert.equal(captured.poll.returned.state, 'running');
    assert.equal(captured.result.returned.state, 'succeeded');
    assert.equal(captured.result.returned.result.resultUrl, 'https://cdn.example.test/offline.png');
    assert.deepEqual(captured.transport, { requests: 4, authorizationChecks: 4 });
    assert.equal(JSON.stringify(captured).includes(secret), false);
});

test('fetch transport and supplier error bodies containing canary remain sanitized', () => {
    for (const env of [{ FAIL_SUBMIT: '1' }, { FAIL_POLL: '1' }, { FAIL_RESULT: '1' }]) {
        const { captured, stdout, stderr } = runFixture(env);
        assert.equal(`${stdout}${stderr}`.includes(canary), false);
        const phase = Object.keys(env)[0].replace('FAIL_', '').toLowerCase();
        assert.ok(captured[phase]?.error, `${phase} should serialize a sanitized error`);
        assert.equal(JSON.stringify(captured[phase]).includes(canary), false);
    }
});

test('模拟 fork 超时与模拟退出时，边界失败仅序列化稳定错误', () => {
    for (const mode of ['timeout', 'exit']) {
        const { captured, stdout, stderr } = runFixture({ BOUNDARY_MODE: mode });
        assert.ok(captured[mode]?.error);
        assert.equal(JSON.stringify(captured[mode]).includes(canary), false);
        assert.equal(`${stdout}${stderr}`.includes(canary), false);
        assert.equal(captured[mode].error.code, mode === 'timeout' ? 'SECRET_SERVICE_TIMEOUT' : 'SECRET_SERVICE_UNAVAILABLE');
    }
});

test('离线 guard 自检明确拒绝并计数 fetch/net/Socket/tls/http/https 与数据库导入', () => {
    const { captured } = runFixture({ GUARD_SELF_TEST: '1' });
    assert.deepEqual(captured.guards, {
        fetch: 1, 'net.connect': 1, 'net.createConnection': 1, 'net.Socket.connect': 1,
        'tls.connect': 1, 'http.request': 1, 'http.get': 1, 'https.request': 1, 'https.get': 1,
        pg: 1, 'drizzle-orm': 1,
    });
});
