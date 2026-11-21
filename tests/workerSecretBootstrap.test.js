'use strict';

// 同一文件兼作真实 CLI 的 preload；替身只存在于测试，不向启动器注入环境模块能力。
if (require.main !== module) {
    const { isMainThread } = require('node:worker_threads');
    if (isMainThread) {
        const events = [];
        const pg = require('pg');
        const registry = require('../lib/server/providers/providerRegistry');
        const legacyResolve = registry.resolveWorkerProvider;
        registry.resolveWorkerProvider = (options) => {
            events.push('legacy-resolver');
            return legacyResolve(options);
        };
        pg.Pool = class {
            constructor() { events.push('Pool'); }
            async connect() { events.push('connect'); throw new Error('测试禁止数据库连接'); }
            async end() { events.push('pool-close'); }
        };
        const queue = require('../lib/server/worker/taskQueue');
        const claim = queue.claimNextTask;
        queue.claimNextTask = (...args) => { events.push('claim'); return claim(...args); };
        process.once('exit', () => process.stdout.write(`${JSON.stringify({ events })}\n`));
    }
} else {
    const test = require('node:test');
    const assert = require('node:assert/strict');
    const path = require('node:path');
    const { fork } = require('node:child_process');
    const { bootstrapWorker, startWorker, runWorkerProcess } = require('../lib/server/worker');
    const { createSyntheticSecretBoundary } = require('../lib/server/providers/secretBoundary');

    const binding = Object.freeze({ providerInstanceId: 'synthetic-worker', credentialRef: 'synthetic-ref',
        credentialVersion: 1, adapterType: 'myvigna-image', baseUrl: 'https://provider.example.test/v1', upstreamModel: 'gpt-image-2' });
    const reference = { providerInstanceId: binding.providerInstanceId, credentialRef: binding.credentialRef, credentialVersion: 1 };
    const secret = 'synthetic-worker-secret';
    const legacySecret = 'synthetic-legacy-env-secret';
    const options = () => ({ descriptor: { ...binding }, approvedBindings: [{ ...binding }],
        databaseUrl: 'postgres://unused/offline-bootstrap', workerId: 'synthetic-worker', secretResolver: async () => secret });
    const poisoned = () => Object.assign(new Error(secret), { code: secret, cause: new Error(secret) });
    const safeError = (code) => (error) => {
        assert.equal(error.code, code);
        assert.equal(error.message, code);
        assert.equal(error.name, 'WorkerBootstrapError');
        assert.equal(error.cause, undefined);
        for (const value of [String(error), error.stack, JSON.stringify(error)]) {
            assert.ok(!value.includes(secret));
            assert.ok(!value.includes(legacySecret));
        }
        return true;
    };
    function fakePool(events, { onClaim, endError, connectError } = {}) {
        return class {
            constructor() { events.push('Pool'); }
            async query(text) {
                if (/FOR UPDATE SKIP LOCKED/.test(text)) { events.push('claim'); onClaim?.(); }
                return { rowCount: 0, rows: [] };
            }
            async connect() {
                events.push('connect');
                if (connectError) throw connectError;
                return { query: this.query.bind(this), release() { events.push('release'); } };
            }
            async end() { events.push('pool-close'); if (endError) throw endError; }
        };
    }
    function assertNoWorker(events) {
        for (const event of ['run', 'Pool', 'processor', 'connect', 'claim']) {
            assert.equal(events.filter((value) => value === event).length, 0, event);
        }
    }
    function blockedDependencies(events) {
        return {
            run: async (configuration) => { events.push('run'); return startWorker(configuration); },
            createTaskProcessor: () => { events.push('processor'); return async () => {}; },
        };
    }
    function legacyEnvironment(t) {
        const values = { PAINTTRACK_WORKER_PROVIDER: 'myvigna-image', PAINTTRACK_PROVIDER_NAME: 'myvigna-image',
            PAINTTRACK_PROVIDER_CREDENTIAL: legacySecret, PAINTTRACK_PROVIDER_BASE_URL: binding.baseUrl,
            PAINTTRACK_PROVIDER_MODEL: binding.upstreamModel };
        for (const [key, value] of Object.entries(values)) {
            const previous = process.env[key];
            process.env[key] = value;
            t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
        }
    }

    test('可信解析完成后才构造 Pool、processor 并首次 connect/claim；合法绑定仅解析一次', async () => {
        const events = [];
        let resolved;
        let continueResolve;
        const resolving = new Promise((resolve) => { resolved = resolve; });
        const gate = new Promise((resolve) => { continueResolve = resolve; });
        let worker;
        const provider = { name: 'synthetic-provider', submit: async () => ({ kind: 'unknown' }),
            query: async () => ({ state: 'running' }), cancel: async () => ({ state: 'cancelled' }) };
        const lifecycle = { async close() { assert.equal(this, lifecycle); events.push('secret-close'); } };
        let hostControl;
        const running = bootstrapWorker({ ...options(), PoolClass: fakePool(events), secretBoundaryLifecycle: lifecycle,
            onProviderGate: (control) => { hostControl = control; },
            secretResolver: async (requested) => {
                events.push('resolver');
                assert.deepEqual(requested, reference);
                resolved();
                await gate;
                events.push('resolved');
                return secret;
            } }, {
            adapterFactory: (configuration) => { assert.equal(configuration.credential, secret); events.push('adapter'); return provider; },
            createTaskProcessor: (configuration) => {
                events.push('processor');
                assert.notEqual(configuration.provider, provider);
                assert.equal(configuration.provider.name, provider.name);
                assert.equal(configuration.provider.submit instanceof Function, true);
                assert.equal(configuration.workerId, 'synthetic-worker');
                assert.equal(hostControl.getState(), 'active');
                assert.equal(configuration.provider.control, undefined);
                return async () => assert.fail('空队列不能调用处理器');
            },
            run: async (configuration) => {
                events.push('run');
                const started = await startWorker(configuration);
                worker = started.worker;
                try { return await worker.runOnce(); }
                finally { worker.stop(); await started.pool.end(); }
            },
        });
        await resolving;
        assert.deepEqual(events, ['resolver']);
        continueResolve();
        assert.deepEqual(await running, { status: 'idle' });
        assert.deepEqual(events, ['resolver', 'resolved', 'adapter', 'run', 'Pool', 'processor', 'connect', 'claim',
            'release', 'pool-close', 'secret-close']);
        assert.equal(hostControl.getState(), 'closed');
        assert.equal((await worker.runOnce()).status, 'stopped');
    });

    test('可信单图启动只向完整匹配的任务快照提供受闸门保护的适配器', async () => {
        const { createModelRouteResolver } = require('../lib/server/tasks/modelRouteResolver');
        const model = { id: 'c1111111-1111-4111-8111-111111111111', logicalModelId: 'trusted-image',
            mediaType: 'image', enabled: true, catalogVersion: 1, supportedOperations: ['image.generate'], bindings: [{
                id: 'binding-image', enabled: true, isPrimary: true, bindingVersion: 1,
                providerInstance: { id: binding.providerInstanceId, enabled: true, configVersion: 1,
                    credentialVersion: binding.credentialVersion, adapterType: binding.adapterType },
                providerModel: { id: 'upstream-image', enabled: true, validationState: 'verified', mediaType: 'image',
                    capabilities: { operations: ['image.generate'] }, upstreamModelName: binding.upstreamModel,
                    adapterVersion: '1', operationProfile: 'image.generate', requestMappingVersion: 1, responseMappingVersion: 1 },
            }] };
        const catalog = { async getLogicalModel(id) { return id === model.logicalModelId ? model : null; } };
        const payload = { logicalModelId: model.logicalModelId, prompt: 'Test image', outputCount: 1 };
        const route = await createModelRouteResolver({ catalog }).resolve({ taskType: 'image.generate', payload });
        const baseTask = { id: 'c2222222-2222-4222-8222-222222222222', lease_token: 'synthetic-lease',
            attempts: 1, task_type: 'image.generate', payload };
        const task = { ...baseTask, logical_model_pk: route.logicalModelPk,
            route_snapshot: route.routeSnapshot, route_snapshot_version: route.routeSnapshotVersion,
            route_snapshot_hash: route.routeSnapshotHash };
        let submissions = 0;
        const adapter = { name: 'synthetic-provider', async submit() { submissions++; return { kind: 'unknown' }; },
            async query() { return { state: 'running' }; },
            async cancel() { assert.fail('本测试不应取消任务'); } };
        await bootstrapWorker({ ...options(), trustedCatalog: catalog, logicalModelId: model.logicalModelId }, {
            adapterFactory: () => adapter,
            createTaskProcessor: (config) => ({ ...config, processTask: require('../lib/server/worker/taskExecutor').createTaskProcessor(config) }),
            run: async ({ createProcessor }) => {
                const pool = { query() { assert.fail('拒绝任务不应查询数据库'); }, connect() { assert.fail('拒绝任务不应连接数据库'); } };
                const { provider, providerSelector, requireTrustedRoute, processTask } = createProcessor({ pool });
                assert.equal(requireTrustedRoute, true);
                assert.equal(provider, undefined);
                await assert.rejects(processTask(baseTask), { code: 'TASK_ROUTE_REQUIRED' });
                for (const rejected of [
                    { ...task, route_snapshot_hash: 'wrong' },
                    { ...task, route_snapshot: { ...task.route_snapshot, providerInstanceId: 'other' } },
                    { ...task, task_type: 'video.generate' },
                    { ...task, payload: { ...payload, outputCount: 2 } },
                ]) await assert.rejects(processTask(rejected), { code: 'TASK_ROUTE_REJECTED' });
                assert.equal(submissions, 0);
                const selected = await providerSelector.select(task);
                assert.notEqual(selected, adapter);
                await selected.submit();
            },
        });
        assert.equal(submissions, 1);
    });

    test('所有配置、绑定与秘密预检失败均无 run/Pool/processor/connect/claim，且释放委派资源', async (t) => {
        legacyEnvironment(t);
        const cases = [
            [{ descriptor: undefined }, 'PROVIDER_CONFIG_INVALID', 0],
            [{ approvedBindings: undefined }, 'PROVIDER_CONFIG_INVALID', 0],
            [{ approvedBindings: [] }, 'PROVIDER_BINDING_DENIED', 0],
            [{ secretResolver: undefined }, 'PROVIDER_SECRET_RESOLVER_REQUIRED', 0],
            [{ secretResolver: async () => { throw poisoned(); } }, 'PROVIDER_SECRET_UNAVAILABLE', 1],
            ...[null, '', ' ', 'bad\r\nheader', 'x'.repeat(4097)].map((value) => [
                { secretResolver: async () => value }, 'PROVIDER_SECRET_INVALID', 1,
            ]),
            ...[{ providerInstanceId: 'other' }, { credentialRef: 'other' }, { credentialVersion: 2 },
                { adapterType: 'other' }, { upstreamModel: 'other' }, { role: 'worker' },
                { baseUrl: 'https://unapproved.example.test/v1' }].map((patch) => [
                { descriptor: { ...binding, ...patch } }, patch.baseUrl || patch.providerInstanceId || patch.credentialRef || patch.credentialVersion
                    ? 'PROVIDER_BINDING_DENIED' : 'PROVIDER_CONFIG_INVALID', 0,
            ]),
            ...['http://127.0.0.1/v1', 'https://provider.example.test/v1?token=x'].map((baseUrl) => [
                { descriptor: { ...binding, baseUrl } }, 'PROVIDER_CONFIG_INVALID', 0,
            ]),
        ];
        for (const [patch, code, expectedReads] of cases) {
            const events = [];
            let reads = 0;
            const configuration = { ...options(), ...patch };
            const resolver = configuration.secretResolver;
            if (resolver) configuration.secretResolver = async (...args) => { reads++; return resolver(...args); };
            await assert.rejects(bootstrapWorker({ ...configuration, PoolClass: fakePool(events),
                secretBoundaryLifecycle: { async close() { events.push('secret-close'); } } }, blockedDependencies(events)), safeError(code));
            assert.equal(reads, expectedReads, code);
            assert.deepEqual(events, ['secret-close']);
            assertNoWorker(events);
        }
    });

    test('适配器构造失败脱敏且不进入 Worker；关闭异常不覆盖原预检错误', async () => {
        const events = [];
        await assert.rejects(bootstrapWorker({ ...options(), PoolClass: fakePool(events),
            secretBoundaryLifecycle: { async close() { events.push('secret-close'); throw poisoned(); } } }, {
            ...blockedDependencies(events), adapterFactory: () => { throw poisoned(); },
        }), safeError('PROVIDER_CONFIG_INVALID'));
        assert.deepEqual(events, ['secret-close']);
        assertNoWorker(events);
    });

    test('onProviderGate 抛错时关闭已创建 gate 与 drain timer，并恰好释放一次秘密资源', async (t) => {
        const events = [];
        const timers = new Set();
        const originalSetTimeout = global.setTimeout;
        const originalClearTimeout = global.clearTimeout;
        t.mock.method(global, 'setTimeout', (...args) => {
            const handle = originalSetTimeout(...args);
            timers.add(handle);
            return handle;
        });
        t.mock.method(global, 'clearTimeout', (handle) => {
            timers.delete(handle);
            return originalClearTimeout(handle);
        });
        let hostControl;
        await assert.rejects(bootstrapWorker({ ...options(), PoolClass: fakePool(events),
            onProviderGate(control) {
                hostControl = control;
                control.drain(Date.now() + 60000);
                assert.equal(timers.size, 1);
                events.push('onProviderGate');
                throw poisoned();
            },
            secretBoundaryLifecycle: { async close() {
                assert.equal(hostControl.getState(), 'closed');
                events.push('secret-close');
            } },
        }, blockedDependencies(events)), safeError('WORKER_START_FAILED'));
        assert.equal(hostControl.getState(), 'closed');
        await hostControl.close();
        assert.deepEqual(events, ['onProviderGate', 'secret-close']);
        assert.equal(timers.size, 0);
        assertNoWorker(events);
    });

    test('仅传 resolver 不委派资源；显式生命周期句柄只关闭一次', async () => {
        for (const delegated of [false, true]) {
            let closes = 0;
            const boundary = { resolve: async () => secret, async close() { closes++; } };
            const configuration = { ...options(), secretResolver: boundary.resolve };
            if (delegated) configuration.secretBoundaryLifecycle = boundary;
            const marker = {};
            assert.equal(await bootstrapWorker(configuration, { run: async () => marker }), marker);
            assert.equal(closes, delegated ? 1 : 0);
        }
    });

    test('无效生命周期句柄在读取 secret 和进入 Worker 前拒绝', async () => {
        let reads = 0;
        const events = [];
        await assert.rejects(bootstrapWorker({ ...options(), PoolClass: fakePool(events), secretBoundaryLifecycle: {},
            secretResolver: async () => { reads++; return secret; } }, blockedDependencies(events)), safeError('WORKER_BOOTSTRAP_CONFIG_INVALID'));
        assert.equal(reads, 0);
        assertNoWorker(events);
    });

    test('建池、processor、运行与关池异常均释放委派资源并返回固定码', async () => {
        for (const phase of ['Pool', 'processor', 'run', 'pool-close']) {
            const events = [];
            const PoolClass = phase === 'Pool' ? class { constructor() { events.push('Pool'); throw poisoned(); } }
                : fakePool(events, { endError: phase === 'pool-close' ? poisoned() : undefined });
            await assert.rejects(bootstrapWorker({ ...options(), PoolClass,
                secretBoundaryLifecycle: { async close() { events.push('secret-close'); } } }, {
                createTaskProcessor: () => { events.push('processor'); if (phase === 'processor') throw poisoned(); return async () => {}; },
                run: async (configuration) => {
                    if (phase === 'run') throw poisoned();
                    const { pool } = await startWorker(configuration);
                    await pool.end();
                },
            }), safeError('WORKER_START_FAILED'));
            assert.equal(events.filter((event) => event === 'secret-close').length, 1);
            assert.equal(events.at(-1), 'secret-close');
            if (['processor', 'pool-close'].includes(phase)) assert.ok(events.includes('pool-close'));
            assert.ok(!events.includes('connect'));
            assert.ok(!events.includes('claim'));
        }
    });

    test('正常运行后 close 失败返回固定错误；伪造异常字段和原因不透传', async () => {
        await assert.rejects(bootstrapWorker({ ...options(), secretBoundaryLifecycle: { async close() { throw poisoned(); } } },
            { run: async () => {} }), safeError('WORKER_SECRET_CLOSE_FAILED'));
        await assert.rejects(bootstrapWorker(options(), { run: async () => {
            throw Object.assign(poisoned(), { name: 'WorkerBootstrapError' });
        } }), safeError('WORKER_START_FAILED'));
    });

    test('默认 processor 和实际 runWorkerProcess 正常退出后关闭 Pool 与委派资源', async (t) => {
        const events = [];
        const previousExitCode = process.exitCode;
        t.after(() => { process.exitCode = previousExitCode; });
        const PoolClass = fakePool(events, { onClaim: () => setImmediate(() => process.emit('SIGTERM')) });
        await bootstrapWorker({ ...options(), PoolClass, pollIntervalMs: 10000,
            secretBoundaryLifecycle: { async close() { events.push('secret-close'); } } });
        assert.deepEqual(events, ['Pool', 'connect', 'claim', 'release', 'pool-close', 'secret-close']);
        assert.equal(process.exitCode, 0);
    });

    test('真实运行边界 connect 异常脱敏并依次关闭 Pool 和秘密句柄', async () => {
        const events = [];
        await assert.rejects(bootstrapWorker({ ...options(), PoolClass: fakePool(events, { connectError: poisoned() }),
            secretBoundaryLifecycle: { async close() { events.push('secret-close'); } } }, { run: runWorkerProcess }),
        safeError('WORKER_START_FAILED'));
        assert.deepEqual(events, ['Pool', 'connect', 'pool-close', 'secret-close']);
    });

    test('IPC 秘密撤销或已关闭均无 env 回退，且未构造 Pool 或领取任务', async (t) => {
        legacyEnvironment(t);
        for (const mode of ['revoked', 'closed']) {
            const boundary = await createSyntheticSecretBoundary({ principal: 'worker', entries: [{ reference, value: secret }], allowed: [reference] });
            t.after(() => boundary.close());
            if (mode === 'revoked') await boundary.revoke(reference);
            else await boundary.close();
            const events = [];
            let closes = 0;
            await assert.rejects(bootstrapWorker({ ...options(), secretResolver: boundary.resolve, PoolClass: fakePool(events),
                secretBoundaryLifecycle: { async close() { closes++; await boundary.close(); } } }, blockedDependencies(events)),
            safeError('PROVIDER_SECRET_UNAVAILABLE'));
            assert.equal(closes, 1);
            assertNoWorker(events);
        }
    });

    for (const operation of ['rotate', 'revoke']) {
        test(`可信宿主 ${operation} 实际运行：只领取一次、闸门先执行、资源恰好关闭一次`, { timeout: 5000 }, async (t) => {
            const queue = require('../lib/server/worker/taskQueue');
            const originals = {};
            let claims = 0;
            let poolCloses = 0;
            let secretCloses = 0;
            let adapterCalls = 0;
            let completed = 0;
            let failed = 0;
            let host;
            let gate;
            let sent;
            const dispatched = new Promise((resolve) => { sent = resolve; });
            let release;
            const response = new Promise((resolve) => { release = resolve; });
            for (const name of ['claimNextTask', 'heartbeatTask', 'completeTask', 'failTask', 'cancelClaimedTask']) originals[name] = queue[name];
            Object.assign(queue, {
                claimNextTask: async () => { claims++; return { id: 'host-task', lease_token: 'host-lease', payload: {} }; },
                heartbeatTask: async () => {}, completeTask: async () => { completed++; },
                failTask: async () => { failed++; }, cancelClaimedTask: async () => {},
            });
            t.after(() => { Object.assign(queue, originals); });
            const running = bootstrapWorker({
                ...options(), shutdownGraceMs: 1000,
                PoolClass: class { async end() { poolCloses++; } },
                secretBoundaryLifecycle: { async close() { secretCloses++; } },
                onProviderGate: (control) => { gate = control; },
                onHostLifecycle: (control) => { host = control; assert.equal(control.finish, undefined); },
            }, {
                adapterFactory: () => ({ name: 'synthetic', version: '1',
                    submit: async () => { adapterCalls++; sent(); return response; },
                    query: async () => { adapterCalls++; return { state: 'running' }; },
                    cancel: async () => { adapterCalls++; return {}; },
                }),
                createTaskProcessor: ({ provider }) => async () => {
                    if (operation === 'revoke') {
                        await assert.rejects(provider.submit({}), (error) => error.submissionUnknown === true);
                        await assert.rejects(provider.query({}), { code: 'PROVIDER_GATE_REVOKED' });
                    } else {
                        await provider.submit({});
                        await assert.rejects(provider.submit({}), { code: 'PROVIDER_GATE_DRAINING' });
                        await provider.query({});
                    }
                },
            });
            await dispatched;
            assert.equal(host[operation](Date.now() + 5000), true);
            assert.equal(host[operation](Date.now() + 5000), false);
            assert.equal(gate.getState(), operation === 'rotate' ? 'draining' : 'revoked');
            if (operation === 'rotate') release({ kind: 'accepted', providerJobId: 'synthetic-job' });
            await running;
            release({ kind: 'accepted', providerJobId: 'late-job' });
            assert.equal(host.getState(), 'closed');
            assert.equal(host.revoke(), false);
            assert.equal(claims, 1);
            assert.equal(completed, 1, '测试处理器内的断言必须实际完成');
            assert.equal(failed, 0);
            assert.equal(adapterCalls, operation === 'rotate' ? 2 : 1);
            assert.equal(poolCloses, 1);
            assert.equal(secretCloses, 1);
            assert.equal(gate.getState(), 'revoked');
        });
    }

    test('启动即轮换可升级紧急撤销，零领取且重复控制无副作用', async () => {
        const events = [];
        let host;
        let gate;
        let closes = 0;
        await bootstrapWorker({ ...options(), PoolClass: fakePool(events),
            secretBoundaryLifecycle: { async close() { closes++; } },
            onProviderGate: (control) => { gate = control; },
            onHostLifecycle: (control) => {
                host = control;
                assert.equal(host.rotate(Date.now() + 5000), true);
                assert.equal(host.getState(), 'draining');
                assert.equal(host.revoke(), true);
                assert.equal(host.rotate(Date.now() + 5000), false);
                assert.equal(host.revoke(), false);
            },
        }, { adapterFactory: () => ({ submit() {}, query() {}, cancel() {} }) });
        assert.equal(events.includes('claim'), false);
        assert.equal(events.includes('connect'), false);
        assert.equal(events.filter((event) => event === 'pool-close').length, 1);
        assert.equal(closes, 1);
        assert.equal(host.getState(), 'closed');
        assert.equal(gate.getState(), 'revoked');
    });

    test('宿主回调异常关闭 Pool、gate 和秘密；无效轮换期限不改变状态', async () => {
        let host;
        let gate;
        let poolCloses = 0;
        let secretCloses = 0;
        await assert.rejects(bootstrapWorker({ ...options(),
            PoolClass: class { async end() { poolCloses++; } },
            secretBoundaryLifecycle: { async close() { secretCloses++; } },
            onProviderGate: (control) => { gate = control; },
            onHostLifecycle: (control) => {
                host = control;
                assert.throws(() => host.rotate(NaN), TypeError);
                assert.equal(host.getState(), 'running');
                assert.equal(gate.getState(), 'active');
                throw poisoned();
            },
        }, { adapterFactory: () => ({ submit() {}, query() {}, cancel() {} }) }), safeError('WORKER_START_FAILED'));
        assert.equal(host.getState(), 'closed');
        assert.equal(gate.getState(), 'revoked');
        assert.equal(poolCloses, 1);
        assert.equal(secretCloses, 1);
    });

    function cli(t, mode, nodeEnv = 'test') {
        const env = { ...process.env, NODE_ENV: nodeEnv, PAINTTRACK_WORKER_PROVIDER: mode,
            PAINTTRACK_PROVIDER_NAME: 'myvigna-image', PAINTTRACK_PROVIDER_CREDENTIAL: legacySecret,
            PAINTTRACK_PROVIDER_BASE_URL: binding.baseUrl, PAINTTRACK_PROVIDER_MODEL: binding.upstreamModel,
            PAINTTRACK_WORKER_DATABASE_URL: 'postgres://unused/offline-cli' };
        delete env.NODE_OPTIONS;
        const child = fork(path.join(__dirname, '../lib/server/worker/index.js'), [], {
            execArgv: ['--require', __filename], env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (data) => { stdout += data; });
        child.stderr.on('data', (data) => { stderr += data; });
        t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
        return new Promise((resolve, reject) => {
            child.once('error', reject);
            child.once('close', (code) => resolve({ code, stdout, stderr }));
        });
    }

    test('真实 CLI 在旧 env 凭据齐全时仍拒绝所有非 mock，Pool/connect/claim 均为零', { timeout: 10000 }, async (t) => {
        for (const mode of ['myvigna-image', 'unknown-mode', secret]) {
            const result = await cli(t, mode);
            assert.equal(result.code, 1);
            assert.equal(result.stderr, 'WORKER_TRUSTED_BOOTSTRAP_REQUIRED\n');
            assert.deepEqual(JSON.parse(result.stdout), { events: [] });
            assert.ok(!JSON.stringify(result).includes(legacySecret));
            assert.ok(!JSON.stringify(result).includes(secret));
        }
    });

    test('真实 CLI 未配置或 production mock 在建池前固定拒绝', { timeout: 10000 }, async (t) => {
        for (const [mode, nodeEnv, expected] of [['', 'test', 'PROVIDER_NOT_CONFIGURED'], ['none', 'test', 'PROVIDER_NOT_CONFIGURED'],
            ['mock', 'production', 'PROVIDER_MODE_FORBIDDEN']]) {
            const result = await cli(t, mode, nodeEnv);
            assert.equal(result.code, 1);
            assert.equal(result.stderr, `${expected}\n`);
            assert.deepEqual(JSON.parse(result.stdout), { events: [] });
        }
    });
}
