const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { main } = require('../../lib/server/tasks/pricingPublishCli');
const { ledgerOwnerRole } = require('../../lib/server/db/migrate');

const imageConfig = (modelId, pricingVersion, overrides = {}) => ({
    modelId, modelVersion: 1, pricingVersion, enabled: true,
    templateType: 'image_resolution_quantity', currencyUnit: 'credit_tenths', roundingMode: 'ceil_to_atom',
    precisionVersion: 'integer_rational_ms_v1', roundingModeVersion: 'ceil_to_atom_v1', quantityMode: 'per_unit',
    maxOutputCount: 1, resolutions: [{ resolutionKey: '1024x1024', enabled: true, unitPriceTenths: '7' }],
    ...overrides,
});

// 端到端跑真实 CLI 入口：管理员连接只在事务内降级到 owner，不新增任何角色授权。
async function checkPricingPublishCli(admin, adminUrl, urls, record) {
    const database = (await admin.query('SELECT current_database() AS db')).rows[0].db;
    assert.match(database, /^pt_acceptance_[a-z0-9]+_[a-f0-9]{6}$/);
    assert.equal(ledgerOwnerRole(database), `pt_ledger_owner_${require('node:crypto').createHash('md5').update(database, 'utf8').digest('hex').slice(0, 16)}`);

    const imagePk = randomUUID();
    const imageModelId = `cli-image-${imagePk}`;
    const videoPk = randomUUID();
    const videoModelId = `cli-video-${videoPk}`;
    await admin.query(`INSERT INTO public.logical_models(id,logical_model_id,display_name,media_type,supported_operations,enabled)
        VALUES ($1,$2,'CLI发布图像模型','image','["image.generate"]'::jsonb,true)`, [imagePk, imageModelId]);
    await admin.query(`INSERT INTO public.logical_models(id,logical_model_id,display_name,media_type,supported_operations,enabled)
        VALUES ($1,$2,'CLI发布视频模型','video','["video.generate"]'::jsonb,true)`, [videoPk, videoModelId]);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-pricing-accept-'));
    const writeConfig = (name, config) => {
        const file = path.join(dir, `${name}.json`);
        fs.writeFileSync(file, JSON.stringify(config));
        return file;
    };
    const env = { PUBLISH_DATABASE_URL: adminUrl, DATABASE_URL: urls.runtimeUrl };
    const run = async (argv, environment = env) => {
        let out = '';
        let err = '';
        const saved = process.exitCode;
        try {
            const result = await main({
                argv, env: environment,
                output: { write: (chunk) => { out += chunk; } },
                errorOutput: { write: (chunk) => { err += chunk; } },
            });
            return { result, out, err: err.trim() };
        } finally {
            process.exitCode = saved;
        }
    };
    const versionCount = async (modelId) => (await admin.query(`SELECT count(*)::int AS n FROM public.pricing_versions pv
        JOIN public.logical_models lm ON lm.id=pv.logical_model_pk WHERE lm.logical_model_id=$1`, [modelId])).rows[0].n;
    const versionRow = async (modelId, version) => (await admin.query(`SELECT pv.id,pv.config_hash,pv.published_at_us,pv.effective_from_us,pv.revoked_at_us,pv.cancelled_at_us
        FROM public.pricing_versions pv JOIN public.logical_models lm ON lm.id=pv.logical_model_pk
        WHERE lm.logical_model_id=$1 AND pv.pricing_version=$2`, [modelId, version])).rows[0];
    const seconds = async (offset) => (await admin.query('SELECT (floor(extract(epoch FROM clock_timestamp()))::bigint + $1)::text AS s', [offset])).rows[0].s;
    const waitUntil = async (epochSeconds) => admin.query(`SELECT pg_sleep(greatest(0, $1::numeric - extract(epoch FROM clock_timestamp()) + 0.05))`, [epochSeconds]);

    try {
        const firstAt = await seconds(2);
        const v1File = writeConfig('v1', imageConfig(imageModelId, 'cli-v1'));
        const published = await run(['publish', '--config', v1File, '--effective-from', `@${firstAt}`]);
        assert.equal(published.err, '', `发布不应失败：${published.out}`);
        assert.equal(published.result.replayed, false);
        assert.equal(published.result.modelId, imageModelId);
        assert.equal(published.result.effectiveFromUs, `${BigInt(firstAt) * 1000000n}`);
        const v1 = await versionRow(imageModelId, 'cli-v1');
        assert.match(v1.config_hash, /^[0-9a-f]{64}$/);
        assert.ok(BigInt(v1.published_at_us) < BigInt(v1.effective_from_us));
        assert.equal(v1.revoked_at_us, null);
        assert.equal(v1.cancelled_at_us, null);
        assert.equal(await versionCount(imageModelId), 1);
        record('价格CLI：管理员事务内降级owner发布未来整秒版本，落库含摘要与发布时刻', 'passed');

        const replay = await run(['publish', '--config', v1File, '--effective-from', `@${firstAt}`]);
        assert.equal(replay.result.id, published.result.id);
        assert.equal(replay.result.replayed, true);
        assert.equal(await versionCount(imageModelId), 1);
        const conflict = await run(['publish', '--config', writeConfig('v1-conflict', imageConfig(imageModelId, 'cli-v1', { maxOutputCount: 2 })), '--effective-from', `@${firstAt}`]);
        assert.equal(conflict.result, null);
        assert.equal(conflict.err, 'VERSION_CONFLICT');
        const sameSecond = await run(['publish', '--config', writeConfig('same-second', imageConfig(imageModelId, 'cli-same-second')), '--effective-from', `@${firstAt}`]);
        assert.equal(sameSecond.result, null);
        assert.equal(sameSecond.err, '23505');
        assert.equal(await versionCount(imageModelId), 1);
        record('价格CLI：同参重放回原版本、同版本名异内容拒绝覆盖、同秒第二个版本被唯一索引拒绝', 'passed');

        const past = await run(['publish', '--config', writeConfig('past', imageConfig(imageModelId, 'cli-past')), '--effective-from', '@1700000000']);
        assert.equal(past.result, null);
        assert.equal(past.err, 'EFFECTIVE_TIME_INVALID');
        const noModel = await run(['publish', '--config', writeConfig('no-model', imageConfig('cli-absent-model', 'cli-absent')), '--effective-from', `@${firstAt}`]);
        assert.equal(noModel.err, 'NO_ACTIVE_VERSION');
        const mismatch = await run(['publish', '--config', writeConfig('mismatch', imageConfig(videoModelId, 'cli-mismatch')), '--effective-from', `@${firstAt}`]);
        assert.equal(mismatch.err, 'TEMPLATE_MISMATCH');
        assert.equal(await versionCount(imageModelId), 1);
        assert.equal(await versionCount(videoModelId), 0);
        record('价格CLI：已过生效时间、未知模型、模板与媒体类型不匹配均拒绝且零残留', 'passed');

        const futureAt = await seconds(90);
        const v2 = await run(['publish', '--config', writeConfig('v2', imageConfig(imageModelId, 'cli-v2')), '--effective-from', `@${futureAt}`]);
        assert.equal(v2.err, '');
        const cancels = await run(['cancel', '--model-id', imageModelId, '--pricing-version', 'cli-v2']);
        assert.equal(cancels.result.replayed, false);
        assert.notEqual((await versionRow(imageModelId, 'cli-v2')).cancelled_at_us, null);
        const again = await run(['cancel', '--model-id', imageModelId, '--pricing-version', 'cli-v2']);
        assert.equal(again.result.replayed, true);
        const wrongOrder = await run(['revoke', '--model-id', imageModelId, '--pricing-version', 'cli-v2']);
        assert.equal(wrongOrder.err, 'LIFECYCLE_INVALID');
        record('价格CLI：未生效版本可取消且幂等，取消后不得再撤销', 'passed');

        await waitUntil(firstAt);
        const revoke = await run(['revoke', '--model-id', imageModelId, '--pricing-version', 'cli-v1']);
        assert.equal(revoke.err, '');
        assert.notEqual((await versionRow(imageModelId, 'cli-v1')).revoked_at_us, null);
        const timeline = await run(['timeline', '--model-id', imageModelId]);
        assert.equal(timeline.err, '');
        assert.deepEqual(timeline.result.versions.map((item) => item.pricingVersion), ['cli-v1', 'cli-v2']);
        assert.equal(timeline.result.versions[0].revokedAtUs !== null, true);
        assert.equal(timeline.result.versions[1].cancelledAtUs !== null, true);
        record('价格CLI：生效后撤销写入时间轴，只读时间轴按生效顺序返回两条记录', 'passed');

        // 身份边界：发布身份必须与运行身份不同；低权身份即使知道owner名字也切不过去。
        const sameIdentity = await run(['timeline', '--model-id', imageModelId], { PUBLISH_DATABASE_URL: urls.runtimeUrl, DATABASE_URL: urls.runtimeUrl });
        assert.equal(sameIdentity.err, 'PUBLISH_IDENTITY_MUST_DIFFER');
        const workerAttempt = await run(['timeline', '--model-id', imageModelId], { PUBLISH_DATABASE_URL: urls.workerUrl, DATABASE_URL: urls.runtimeUrl });
        assert.equal(workerAttempt.err, 'PUBLISH_SET_ROLE_DENIED');
        record('价格CLI：与运行身份同名被拒，Worker身份尝试事务内SET ROLE被数据库42501拒绝', 'passed');

        for (const [label, pool] of [['运行', urls.runtimeUrl], ['Worker', urls.workerUrl], ['cleanup', urls.cleanupUrl]]) {
            const { Pool } = require('pg');
            const probe = new Pool({ connectionString: pool, max: 1, connectionTimeoutMillis: 3000 });
            try {
                await assert.rejects(probe.query('SELECT * FROM public.pricing_versions'), { code: '42501' }, `${label}不应读到定价表`);
                await assert.rejects(probe.query(`INSERT INTO public.pricing_versions(logical_model_pk,pricing_version,config,config_hash,effective_from_us,published_at_us) VALUES ($1,'x','{}',repeat('a',64),1,1)`, [imagePk]), { code: '42501' }, `${label}不应写入定价表`);
            } finally {
                await probe.end();
            }
        }
        assert.equal((await admin.query('SELECT current_user AS u')).rows[0].u, (await admin.query('SELECT session_user AS u')).rows[0].u);
        record('价格CLI：发布结束后管理员会话身份复原，运行/Worker/cleanup仍对定价表零读写', 'passed');
        record('价格CLI真实PG：发布、重放、冲突、取消、撤销、时间轴与身份边界全部通过', 'passed');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

module.exports = { checkPricingPublishCli };
