'use strict';

const assert = require('node:assert/strict');
const { randomUUID, randomBytes, createHash } = require('node:crypto');
const { mkdtemp } = require('node:fs/promises');
const path = require('node:path');
const { drizzle } = require('drizzle-orm/node-postgres');
const { hashPassword } = require('../../lib/server/registration');
const { createAuthorizationHandler } = require('../../lib/server/authorizationHttp');
const { createTaskDetailHandler } = require('../../lib/server/tasks/taskHttp');
const { createFileObjectStore } = require('../../lib/server/storage/fileObjectStore');
const { createControlledImageHost, startWorker } = require('../../lib/server/worker');
const { createSyntheticImageAdapter, syntheticPng } = require('../../lib/server/tasks/controlledImageDevelopment');
const { withAssetsHttp } = require('./assets-session-http-postgres.cjs');
const { createLocalMockCatalog, createLocalMockProviderSelector, models } = require('../../lib/server/tasks/localMockCatalog');
const { createModelRouteResolver, stableStringify } = require('../../lib/server/tasks/modelRouteResolver');
const { createTaskSubmissionService } = require('../../lib/server/tasks/taskService');
const { createMockProvider } = require('../../lib/server/providers/mockProvider');
const { executeTask } = require('../../lib/server/worker/taskExecutor');
const queue = require('../../lib/server/worker/taskQueue');

const ENVIRONMENT = Object.freeze({ NODE_ENV: 'development', PAINTTRACK_LOCAL_INTERNAL_GUARD: '1', PAINTTRACK_LOCAL_MOCK_ROUTING: '1' });
const SNAPSHOT_COLUMNS = ['logical_model_pk', 'route_snapshot', 'route_snapshot_version', 'route_snapshot_hash'];

// 回环判定与验收脚本 withClient 保持一致：::1、IPv4 映射回环、整个 127.0.0.0/8，并容忍 inet 文本里可能带的 /32、/128 掩码。
// 只放宽“回环的等价写法”，任何非回环地址仍然拒绝。
function isLoopbackAddress(value) {
    if (typeof value !== 'string') return false;
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(value);
    const candidate = (mapped ? mapped[1] : value).replace(/\/(?:32|128)$/, '');
    return candidate === '::1' || /^127(?:\.\d{1,3}){3}$/.test(candidate);
}

function assertAcceptanceIdentities({ database, runtimeRole, workerRole, migrationRole }, identities) {
    const suffix = /^pt_acceptance_([a-z0-9]+_[a-f0-9]{6})$/.exec(database || '')?.[1];
    if (!suffix || runtimeRole !== `pt_runtime_${suffix}` || workerRole !== `pt_worker_${suffix}`
        || migrationRole !== `pt_migrate_${suffix}`) throw new Error('LOCAL_MOCK_ACCEPTANCE_TARGET_REQUIRED');
    for (const [index, role] of [migrationRole, runtimeRole, workerRole].entries()) {
        const identity = identities[index];
        const mismatches = !identity ? ['missing_identity'] : [
            identity.database !== database && 'database',
            identity.role !== role && 'role',
            identity.session_role !== role && 'session_role',
            identity.database_owner !== migrationRole && 'database_owner',
            identity.port !== 5433 && 'port',
            // 地址是唯一会带出实际值的字段：它是 IP 文本，不是凭据；否则无从判断回环写法的差异。
            !isLoopbackAddress(identity.address) && `address(${String(identity.address)})`,
            identity.privileged !== false && 'privileged',
            identity.has_membership !== false && 'has_membership',
        ].filter(Boolean);
        if (mismatches.length) {
            throw new assert.AssertionError({
                message: `LOCAL_MOCK_ACCEPTANCE_IDENTITY_REQUIRED identity[${index}] fields: ${mismatches.join(',')}`,
            });
        }
    }
}

async function readIdentity(client) {
    const result = await client.query(`SELECT current_database() AS database, current_user AS role,
        session_user AS session_role, inet_server_addr()::text AS address, inet_server_port() AS port,
        pg_get_userbyid(d.datdba) AS database_owner,
        (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls) AS privileged,
        EXISTS (SELECT 1 FROM pg_auth_members WHERE member=r.oid) AS has_membership
        FROM pg_roles r JOIN pg_database d ON d.datname=current_database() WHERE r.rolname=current_user`);
    return result.rows[0];
}

async function checkControlledImage({ owner, webPool, workerUrl, storageParent, record }) {
    const accounts = Array.from({ length: 2 }, () => ({ id: randomUUID(), email: `controlled-${randomUUID()}@example.test` }));
    const password = `Synthetic-${randomBytes(18).toString('hex')}`;
    const hash = await hashPassword(password);
    for (const account of accounts) {
        await owner.query("INSERT INTO users (id,email,password_hash,email_verified_at,role) VALUES ($1,$2,$3,now(),'user')", [account.id, account.email, hash]);
    }
    const modelId = 'acceptance-controlled-image';
    const pk = randomUUID();
    await owner.query(`INSERT INTO logical_models (id,logical_model_id,display_name,media_type,supported_operations,enabled)
        VALUES ($1,$2,'Controlled acceptance fixture','image','["image.generate"]'::jsonb,false)`, [pk, modelId]);
    const descriptor = { providerInstanceId: 'acceptance-controlled', credentialRef: 'fixture-ref', credentialVersion: 1,
        adapterType: 'myvigna-image', baseUrl: 'https://provider.example.test/v1', upstreamModel: 'gpt-image-2' };
    const model = { id: pk, logicalModelId: modelId, enabled: true, mediaType: 'image', catalogVersion: 1,
        supportedOperations: ['image.generate'], bindings: [{ id: 'fixture-binding', enabled: true, isPrimary: true, bindingVersion: 1,
            providerInstance: { id: descriptor.providerInstanceId, enabled: true, configVersion: 1, credentialVersion: 1, adapterType: descriptor.adapterType },
            providerModel: { id: 'fixture-upstream-model', enabled: true, validationState: 'verified', mediaType: 'image',
                upstreamModelName: descriptor.upstreamModel, capabilities: { operations: ['image.generate'] },
                adapterVersion: '1', operationProfile: 'image.generate', requestMappingVersion: 1, responseMappingVersion: 1 },
        }] };
    const objectStore = createFileObjectStore({ rootDirectory: await mkdtemp(path.join(storageParent, 'controlled-image-')) });
    const png = Buffer.from(syntheticPng, 'base64');
    let host;
    let runOnce;
    let completeFixture;
    let ready;
    const readyPromise = new Promise(resolve => { ready = resolve; });
    const finished = new Promise(resolve => { completeFixture = resolve; });
    let calls = 0;
    await withAssetsHttp(drizzle(webPool), async (request) => {
        const running = host.run();
        try {
            await Promise.race([readyPromise, running.then(() => assert.fail('Worker exited before ready'))]);
            async function login(account) {
                const response = await request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ email: account.email, password }) });
                assert.equal(response.status, 200, 'controlled fixture login');
                const cookie = response.headers.get('set-cookie')?.split(';', 1)[0];
                assert.ok(cookie, 'controlled fixture requires session cookie');
                return cookie;
            }
            const a = await login(accounts[0]);
            const b = await login(accounts[1]);
            const key = `accept:controlled:${randomUUID()}`;
            const submit = (cookie) => request('/api/tasks', { method: 'POST', headers: {
                'content-type': 'application/json', 'idempotency-key': key, ...(cookie ? { cookie } : {}),
            }, body: JSON.stringify({ taskType: 'image.generate', payload: { logicalModelId: modelId,
                prompt: 'Synthetic fixture only', aspectRatio: '1:1', size: '1024x1024', outputCount: 1 } }) });
            assert.equal((await submit()).status, 401);
            assert.equal((await submit(b)).status, 403);
            const accepted = await submit(a);
            assert.equal(accepted.status, 201, 'controlled fixture submission');
            const { task } = await accepted.json();
            const replay = await submit(a);
            assert.equal(replay.status, 200);
            assert.equal((await replay.json()).task.id, task.id);
            assert.deepEqual(await runOnce(), { status: 'succeeded', taskId: task.id });
            assert.equal(calls, 1);
            const detail = await request(`/api/tasks/${task.id}`, { headers: { cookie: a } });
            assert.equal(detail.status, 200);
            const { task: done } = await detail.json();
            assert.equal(done.status, 'succeeded');
            assert.equal(done.result.archive, 'ready');
            assert.match(done.result.resultUrl, /^\/api\/assets\/[0-9a-f-]{36}\/content$/);
            const content = await request(done.result.resultUrl, { headers: { cookie: a } });
            assert.equal(content.status, 200);
            assert.equal(content.headers.get('content-type'), 'image/png');
            assert.deepEqual(Buffer.from(await content.arrayBuffer()), png);
            assert.equal((await request(done.result.resultUrl, { headers: { cookie: b } })).status, 404);
            assert.equal((await request(done.result.resultUrl)).status, 401);
            record('受控单图 HTTP：真实会话、限账号提交及幂等重放、Worker 单次执行、文件归档与授权读取', 'passed');
        } finally {
            host.stop();
            completeFixture();
            await running;
        }
    }, async ({ database, environment, sink }) => {
        host = await createControlledImageHost({ database, databaseUrl: workerUrl, environment: { ...environment, PAINTTRACK_LOCAL_INTERNAL_GUARD: '1' },
            sink, ownerId: accounts[0].id, logicalModelId: modelId, catalog: { async getLogicalModel() { return model; } },
            descriptor, approvedBindings: [descriptor], secretResolver: async () => 'synthetic-fixture-only', objectStore }, {
            adapterFactory: () => {
                const adapter = createSyntheticImageAdapter();
                return { ...adapter, submit(...args) { calls++; return adapter.submit(...args); } };
            },
            run: async (options) => {
                const { worker, pool } = await startWorker(options);
                try {
                    runOnce = () => worker.runOnce();
                    options.onHostLifecycle({ getState: () => 'running', revoke() { options.providerGateControl.revoke(); worker.stop(); } });
                    ready();
                    await finished;
                } finally { worker.stop(); await pool.end(); }
            },
        });
        const detail = createTaskDetailHandler({ database, environment, sink });
        const content = createAuthorizationHandler('asset.content', { database, environment, sink, objectStore });
        return (request) => {
            const pathname = new URL(request.url).pathname;
            if (pathname === '/api/tasks') return host.submit(request);
            const task = /^\/api\/tasks\/([0-9a-f-]{36})$/.exec(pathname);
            if (task) return detail(request, { params: { taskId: task[1] } });
            const asset = /^\/api\/assets\/([0-9a-f-]{36})\/content$/.exec(pathname);
            if (asset) return content(request, { params: { id: asset[1] } });
            return new Response(null, { status: 404 });
        };
    });
}

async function checkLocalMockRoute(workerPool, record, { webPool, owner, database, runtimeRole, workerRole, migrationRole, objectStore, workerUrl, storageParent }) {
    const target = { database, runtimeRole, workerRole, migrationRole };
    // 所有授权/写入前验证实际连接身份，不接受 SET ROLE 伪装或角色名拼接。
    assertAcceptanceIdentities(target, await Promise.all([readIdentity(owner), readIdentity(webPool), readIdentity(workerPool)]));
    const original = await owner.query(`SELECT column_name, privilege_type FROM information_schema.column_privileges
        WHERE grantee=$1 AND table_schema='public' AND table_name='generation_tasks'
        AND column_name=ANY($2::text[]) AND privilege_type IN ('INSERT','UPDATE')`, [runtimeRole, SNAPSHOT_COLUMNS]);
    assert.deepEqual(original.rows, [], 'fixture 必须从未授权快照写入的 Web 身份开始');

    const ownerId = randomUUID();
    const keys = [];
    const insertedModels = [];
    let granted = false;
    const workerId = `local-mock-route-${ownerId}`;
    const resolver = createModelRouteResolver({ catalog: createLocalMockCatalog(ENVIRONMENT) });
    const service = createTaskSubmissionService({ pool: webPool, routeResolver: resolver });
    const mock = createMockProvider();
    const invocations = { submit: [], query: [], fallback: 0 };
    if (!objectStore) throw new Error('LOCAL_MOCK_ASSET_STORE_REQUIRED');
    const provider = {
        name: mock.name,
        submit(input, context) { invocations.submit.push({ taskId: input.taskId, key: input.idempotencyKey }); return mock.submit(input, context); },
        query(input, context) { invocations.query.push(input.taskId); return mock.query(input, context); },
    };
    const fallback = {
        name: 'forbidden-fallback',
        submit() { invocations.fallback += 1; throw new Error('FALLBACK_FORBIDDEN'); },
        query() { invocations.fallback += 1; throw new Error('FALLBACK_FORBIDDEN'); },
    };
    const selector = await createLocalMockProviderSelector({ environment: ENVIRONMENT, provider });
    const options = { provider: fallback, providerSelector: selector, workerId, poll: { minDelayMs: 1, maxDelayMs: 2 }, objectStore, assetPool: workerPool };
    const execute = (task, extra = {}) => executeTask(workerPool, task, { ...options, ...extra });
    const getTask = async (id) => (await workerPool.query('SELECT * FROM generation_tasks WHERE id=$1', [id])).rows[0];
    const calls = async (id) => (await workerPool.query('SELECT * FROM provider_calls WHERE task_id=$1 ORDER BY attempt_no', [id])).rows;
    const claim = async (task) => {
        const claimed = await queue.claimNextTask(workerPool, { workerId, leaseSeconds: 60, taskType: task.task_type, taskId: task.id });
        assert.equal(claimed?.id, task.id, '领取必须命中本轮刚创建的精确任务');
        return claimed;
    };
    const request = (media, mockOptions = {}) => {
        const idempotencyKey = `accept:local-mock:${randomUUID()}`;
        keys.push(idempotencyKey);
        return { ownerId, idempotencyKey, taskType: `${media}.generate`, payload: {
            logicalModelId: `local-mock-${media}`, prompt: 'Synthetic local fixture',
            ...(media === 'image' ? { aspectRatio: '1:1', size: '1024x1024', outputCount: 1 } : { durationMs: 1000, fps: 1 }),
            mock: { mediaType: media === 'image' ? 'image/png' : 'video/mp4', ...mockOptions },
        } };
    };
    const assertSnapshot = async (task, input) => {
        const expected = await resolver.resolve(input);
        assert.equal(task.logical_model_pk, expected.logicalModelPk);
        assert.deepEqual(task.route_snapshot, expected.routeSnapshot);
        assert.equal(task.route_snapshot_version, expected.routeSnapshotVersion);
        assert.equal(task.route_snapshot_hash, expected.routeSnapshotHash);
    };
    try {
        for (const model of models) {
            await owner.query(`INSERT INTO logical_models (id,logical_model_id,display_name,media_type,supported_operations,enabled)
                VALUES ($1::uuid,$2,$3,$4,$5::jsonb,false)`,
            [model.id, model.logicalModelId, `Synthetic ${model.mediaType} fixture`, model.mediaType, JSON.stringify([model.operation])]);
            insertedModels.push(model.id);
        }
        // 通用 runtimePermissions 保持原样；只给已验证的本轮 Web 身份四列 INSERT。
        await owner.query(`GRANT INSERT(logical_model_pk,route_snapshot,route_snapshot_version,route_snapshot_hash) ON generation_tasks TO "${runtimeRole}"`);
        granted = true;
        const publicModels = await webPool.query('SELECT logical_model_id FROM model_catalog_public WHERE logical_model_id=ANY($1::text[])', [models.map(model => model.logicalModelId)]);
        assert.equal(publicModels.rowCount, 0, '合成 FK 不应进入公共目录');
        record('本地mock快照准备：精确验收身份、禁用合成FK、仅四列INSERT授权', 'passed');

        for (const media of ['image', 'video']) {
            const input = request(media, { mode: media === 'image' ? 'sync' : 'async' });
            const created = await service.submit(input);
            assert.equal(created.replayed, false);
            const task = await getTask(created.task.id);
            await assertSnapshot(task, input);
            // 重放必须跳过 resolver，不能重新选择路由。
            const replayService = createTaskSubmissionService({ pool: webPool, routeResolver: { resolve() { assert.fail('重放不得重新解析路由'); } } });
            const replay = await replayService.submit(input);
            assert.equal(replay.replayed, true);
            assert.equal(replay.task.id, task.id);
            await assert.rejects(service.submit({ ...input, payload: { ...input.payload, prompt: 'Changed fixture' } }), error => error.code === 'IDEMPOTENCY_KEY_REUSED');

            for (const pool of [webPool, workerPool]) {
                for (const column of SNAPSHOT_COLUMNS) {
                    await assert.rejects(pool.query(`UPDATE generation_tasks SET ${column}=${column} WHERE id=$1`, [task.id]), error => error.code === '42501');
                }
            }
            let claimed;
            if (media === 'image') {
                const approved = { model_pk: task.logical_model_pk, snapshot_version: task.route_snapshot_version,
                    snapshot_hash: task.route_snapshot_hash, snapshot: task.route_snapshot, owner_id: ownerId };
                const scope = { workerId, taskType: task.task_type, taskId: task.id };
                for (const rejected of [
                    { ...approved, snapshot_hash: '0'.repeat(64) },
                    { ...approved, owner_id: randomUUID() },
                    { ...approved, snapshot: { ...approved.snapshot, logicalModelVersion: 999 } },
                ]) assert.equal(await queue.claimNextTask(workerPool, { ...scope, approvedRoutes: [rejected] }), null);
                assert.equal((await getTask(task.id)).attempts, 0);
                claimed = await queue.claimNextTask(workerPool, { ...scope, approvedRoutes: [approved] });
                assert.equal(claimed?.id, task.id);
                assert.equal(claimed.attempts, 1);
                const originalLease = claimed.lease_token;
                await owner.query('UPDATE generation_tasks SET lease_expires_at = now() WHERE id=$1', [task.id]);
                assert.equal(await queue.claimNextTask(workerPool, { ...scope, approvedRoutes: [{ ...approved, snapshot_hash: '0'.repeat(64) }] }), null);
                const untouched = await getTask(task.id);
                assert.equal(untouched.status, 'running');
                assert.equal(untouched.attempts, 1);
                assert.equal(untouched.lease_token, originalLease);
                claimed = await queue.claimNextTask(workerPool, { ...scope, approvedRoutes: [approved] });
                assert.equal(claimed?.id, task.id);
                assert.equal(claimed.attempts, 2);
                assert.notEqual(claimed.lease_token, originalLease);
                record('可信队列领取/租约恢复：不匹配不消耗尝试，不回收他人租约，匹配才重新领取', 'passed');
            } else {
                claimed = await claim(task);
            }
            if (media === 'image') {
                const before = { submit: invocations.submit.length, query: invocations.query.length };
                await assert.rejects(execute(claimed, { providerSelector: undefined }), error => error.code === 'TASK_ROUTE_SELECTOR_REQUIRED');
                for (const mutation of [
                    { logical_model_pk: models[1].id }, { route_snapshot_version: 2 },
                    { route_snapshot_hash: '0'.repeat(64) }, { route_snapshot: { ...claimed.route_snapshot, adapterType: 'external' } },
                    ...SNAPSHOT_COLUMNS.map(column => ({ [column]: null })),
                ]) {
                    await assert.rejects(execute({ ...claimed, ...mutation }), error => error.code === 'TASK_ROUTE_REJECTED');
                }
                // migration 模拟落库篡改，并重算哈希：selector 仍必须拒绝非精确批准快照。
                const tampered = { ...claimed.route_snapshot, upstreamModelName: 'unapproved-model' };
                await owner.query('UPDATE generation_tasks SET route_snapshot=$2::jsonb,route_snapshot_hash=$3 WHERE id=$1',
                    [task.id, JSON.stringify(tampered), createHash('sha256').update(stableStringify(tampered)).digest('hex')]);
                await assert.rejects(execute(await getTask(task.id)), error => error.code === 'TASK_ROUTE_REJECTED');
                assert.equal(invocations.submit.length, before.submit);
                assert.equal(invocations.query.length, before.query);
                assert.equal(invocations.fallback, 0);
                assert.equal((await calls(task.id)).length, 0);
                await owner.query('UPDATE generation_tasks SET route_snapshot=$2::jsonb,route_snapshot_hash=$3 WHERE id=$1',
                    [task.id, JSON.stringify(claimed.route_snapshot), claimed.route_snapshot_hash]);
                record('快照篡改/缺selector：零Provider调用、零账本；Web及Worker快照UPDATE均为42501', 'passed');
            }
            assert.equal((await execute(await getTask(task.id))).status, 'succeeded');
            const completed = await getTask(task.id);
            await assertSnapshot(completed, input);
            assert.equal(completed.status, 'succeeded');
            assert.equal(completed.result.mediaType, media);
            assert.equal(completed.result.kind, 'asset');
            assert.equal(completed.result.archive, 'ready');
            assert.equal(completed.result.provider, 'mock-provider');
            assert.ok(completed.result.assetId);
            assert.match(completed.result.resultUrl, new RegExp(`/api/assets/${completed.result.assetId}/content$`));
            // Worker 无 storage_key 读取权，使用隔离库迁移身份检查归档内容。
            const asset = await owner.query('SELECT owner_id,status,mime_type,storage_key FROM assets WHERE id=$1', [completed.result.assetId]);
            assert.equal(asset.rowCount, 1);
            assert.equal(asset.rows[0].owner_id, ownerId);
            assert.equal(asset.rows[0].status, 'ready');
            assert.equal(asset.rows[0].mime_type, media === 'image' ? 'image/png' : 'video/mp4');
            const stored = await objectStore.getObject({ key: asset.rows[0].storage_key });
            if (media === 'image') assert.equal(stored.body.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
            else assert.equal(stored.body.subarray(4, 8).toString('ascii'), 'ftyp');
            assert.equal(completed.lease_token, null);
            const [call] = await calls(task.id);
            assert.equal(call.status, 'succeeded');
            assert.equal(call.provider_name, 'mock-provider');
            assert.ok(call.provider_job_id);
            assert.equal((await calls(task.id)).length, 1);
            record(`本地mock ${media}：Web真实提交/重放/同键冲突，Worker领取后按selector执行成功`, 'passed');
        }

        // resolver 屏障确保两个真实 Web 事务均走到首次 INSERT，而非仅顺序重放。
        const concurrentInput = request('video', { mode: 'sync' });
        let resolving = 0;
        let release;
        let barrierTimer;
        const barrier = new Promise((resolve, reject) => {
            release = resolve;
            barrierTimer = setTimeout(() => reject(new Error('LOCAL_MOCK_CONCURRENCY_BARRIER_TIMEOUT')), 5000);
        });
        const concurrentService = createTaskSubmissionService({ pool: webPool, routeResolver: { async resolve(input) {
            if (++resolving === 2) release();
            await barrier;
            return resolver.resolve(input);
        } } });
        let settled;
        try {
            settled = await Promise.allSettled([concurrentService.submit(concurrentInput), concurrentService.submit(concurrentInput)]);
        } finally {
            clearTimeout(barrierTimer);
        }
        for (const result of settled) assert.equal(result.status, 'fulfilled');
        const results = settled.map(result => result.value);
        assert.equal(resolving, 2);
        assert.equal(results[0].task.id, results[1].task.id);
        assert.deepEqual(results.map(result => result.replayed).sort(), [false, true]);
        const concurrentRows = await webPool.query('SELECT * FROM generation_tasks WHERE owner_id=$1 AND idempotency_key=$2', [ownerId, concurrentInput.idempotencyKey]);
        assert.equal(concurrentRows.rowCount, 1);
        await assertSnapshot(concurrentRows.rows[0], concurrentInput);
        assert.equal((await execute(await claim(concurrentRows.rows[0]))).status, 'succeeded');
        record('本地mock同键并发：两个Web事务竞争只产生一个任务并保留原快照', 'passed');

        const unknownInput = request('video', { unknownSubmit: true });
        const unknown = await service.submit(unknownInput);
        const firstClaim = await claim(await getTask(unknown.task.id));
        await assert.rejects(execute(firstClaim), error => error.code === 'PROVIDER_SUBMISSION_UNKNOWN' && error.taskFailure.terminal === false);
        const [firstCall] = await calls(unknown.task.id);
        assert.equal(firstCall.status, 'unknown');
        assert.equal(firstCall.provider_job_id, null);
        const jobsBeforeRecovery = mock._testing.jobCount();
        await queue.failTask(workerPool, { taskId: firstClaim.id, leaseToken: firstClaim.lease_token, errorMessage: 'PROVIDER_SUBMISSION_UNKNOWN', retryDelaySeconds: 0 });
        const recoveredClaim = await claim(await getTask(firstClaim.id));
        assert.equal(recoveredClaim.attempts, 2);
        assert.equal((await execute(recoveredClaim)).status, 'succeeded');
        const recoveredCalls = await calls(firstClaim.id);
        assert.equal(recoveredCalls.length, 1);
        assert.equal(recoveredCalls[0].id, firstCall.id);
        assert.equal(recoveredCalls[0].idempotency_key, firstCall.idempotency_key);
        assert.equal(recoveredCalls[0].attempt_no, 1);
        assert.equal(recoveredCalls[0].status, 'succeeded');
        assert.equal(recoveredCalls[0].recovery_attempts, 1);
        assert.deepEqual(invocations.submit.filter(entry => entry.taskId === firstClaim.id).map(entry => entry.key), [firstCall.idempotency_key, firstCall.idempotency_key]);
        assert.equal(mock._testing.jobCount(), jobsBeforeRecovery);
        await assertSnapshot(await getTask(firstClaim.id), unknownInput);
        record('本地mock未知提交恢复：保留调用ID、轮次和原幂等键，mock不新增上游任务', 'passed');

        const conflictInput = request('image', { mode: 'sync' });
        const conflict = await service.submit(conflictInput);
        const conflictClaim = await claim(await getTask(conflict.task.id));
        const historicalKey = `historical:${randomUUID()}`;
        await owner.query(`INSERT INTO provider_calls (task_id,attempt_no,provider_name,idempotency_key,status)
            VALUES ($1,1,'historical-provider',$2,'unknown')`, [conflictClaim.id, historicalKey]);
        const invocationCount = invocations.submit.length + invocations.query.length;
        await assert.rejects(execute(conflictClaim), error => error.code === 'PROVIDER_ROUTE_MISMATCH' && error.taskFailure.terminal === false);
        const conflictCalls = await calls(conflictClaim.id);
        assert.equal(conflictCalls.length, 1);
        assert.equal(conflictCalls[0].status, 'unknown');
        assert.equal(conflictCalls[0].provider_name, 'historical-provider');
        assert.equal(conflictCalls[0].idempotency_key, historicalKey);
        assert.equal(invocations.submit.length + invocations.query.length, invocationCount);
        assert.equal(invocations.fallback, 0);
        record('本地mock历史provider_name冲突：保留unknown及原键，零Provider调用', 'passed');
        assert.ok(workerUrl && storageParent, 'controlled image fixture requires isolated worker and storage');
        await checkControlledImage({ owner, webPool, workerUrl, storageParent, record });
    } finally {
        // 即使并发提交部分失败，也从登记的精确 owner+key 找回本轮 ID，再由 migration 清理。
        try {
            const created = await owner.query('SELECT id FROM generation_tasks WHERE owner_id=$1 AND idempotency_key=ANY($2::text[])', [ownerId, keys]);
            const taskIds = created.rows.map(task => task.id);
            await owner.query('DELETE FROM provider_calls WHERE task_id=ANY($1::uuid[])', [taskIds]);
            const removedTasks = await owner.query('DELETE FROM generation_tasks WHERE id=ANY($1::uuid[])', [taskIds]);
            const removedModels = await owner.query('DELETE FROM logical_models WHERE id=ANY($1::uuid[])', [insertedModels]);
            assert.equal(removedTasks.rowCount, taskIds.length);
            assert.equal(removedModels.rowCount, insertedModels.length);
            for (const sql of ['SELECT id FROM generation_tasks WHERE id=ANY($1::uuid[])', 'SELECT id FROM provider_calls WHERE task_id=ANY($1::uuid[])']) {
                assert.equal((await owner.query(sql, [taskIds])).rowCount, 0);
            }
        } finally {
            if (granted) await owner.query(`REVOKE INSERT(logical_model_pk,route_snapshot,route_snapshot_version,route_snapshot_hash) ON generation_tasks FROM "${runtimeRole}"`);
        }
        record('本地mock fixture由migration按精确ID清理任务/调用/FK并撤销四列INSERT', 'passed');
    }
}

module.exports = { assertAcceptanceIdentities, checkLocalMockRoute };
