'use strict';

/**
 * 资产对象清理入口（CLI）。
 *
 * 用法：
 *   PAINTTRACK_CLEANUP_DATABASE_URL=... PAINTTRACK_ASSET_STORAGE_ROOT=/abs/dir \
 *     node scripts/asset-cleanup.js [--dry-run] [--retention-hours 24] [--orphan-hours 6]
 *                                   [--no-orphans] [--batch-size 50]
 *                                   [--max-attempts 5] [--interval 60]
 *
 * 一轮会跑两段互不重叠的清理：
 *   1. `deleted` 行：用户已软删除，按行上登记的 storage_key 删除对象（asset_cleanup 事件）。
 *   2. `pending`/`uploading` 行：归档中途被强杀留下的孤儿，键由 (owner_id,id) 推导
 *      （asset_orphan_reclaim 事件）。
 *
 * 该进程只使用 cleanup 角色：能读定位键与生命周期时间、能写清理进度列，不能读用户/任务表，
 * 也不能改 status 或 storage_key。退出码：0 无失败；1 有条目失败（可重试）；2 配置或用法错误。
 */

const path = require('node:path');
const { Pool } = require('pg');
const { MAX_BATCH_SIZE, MAX_RETENTION_MS, purgeDeletedAssets } = require('../lib/server/assetPurge');
const { MAX_ABANDONMENT_MS, reclaimAbandonedAssets } = require('../lib/server/orphanReclaim');
const { createFileObjectStore } = require('../lib/server/storage/fileObjectStore');

const USAGE = `asset-cleanup: purge objects of soft-deleted assets, reclaim abandoned uploads

  --dry-run              只列出将被清理的资产，不删除对象、不写库
  --retention-hours <n>  deleted_at 需早于 n 小时前才清理（默认 24，0 表示立即）
  --orphan-hours <n>     pending/uploading 需早于 n 小时前才判定为孤儿（默认 6，0 表示立即）
  --no-orphans           跳过孤儿回收，只清理已软删除的资产
  --batch-size <n>       单次最多认领多少条（1-${MAX_BATCH_SIZE}，默认 50）
  --max-attempts <n>     同一资产最多尝试次数（1-100，默认 5）
  --interval <seconds>   常驻模式：首次立即执行，之后按间隔重复（默认 0 仅执行一次）
  --help                 输出本帮助

环境变量：
  PAINTTRACK_CLEANUP_DATABASE_URL   必填，cleanup 角色的连接串
  PAINTTRACK_ASSET_STORAGE_ROOT     必填，与 Web/Worker 相同的私有对象根目录（绝对路径）`;

class UsageError extends Error {
    constructor(message) {
        super(message);
        this.name = 'UsageError';
    }
}

function integerArgument(name, raw, { min, max }) {
    if (!/^\d+$/.test(String(raw))) throw new UsageError(`${name} must be a non-negative integer`);
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < min || value > max) {
        throw new UsageError(`${name} must be between ${min} and ${max}`);
    }
    return value;
}

function parseArguments(argv) {
    const options = {
        dryRun: false,
        retentionHours: 24,
        orphanHours: 6,
        orphans: true,
        batchSize: 50,
        maxAttempts: 5,
        intervalSeconds: 0,
        help: false,
    };
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === '--help' || argument === '-h') { options.help = true; continue; }
        if (argument === '--dry-run') { options.dryRun = true; continue; }
        if (argument === '--no-orphans') { options.orphans = false; continue; }
        const withValue = ['--retention-hours', '--orphan-hours', '--batch-size', '--max-attempts', '--interval'];
        const equals = withValue.find((flag) => argument.startsWith(`${flag}=`));
        const flag = equals || argument;
        if (!withValue.includes(flag)) throw new UsageError(`unknown option: ${argument}`);
        const raw = equals ? argument.slice(flag.length + 1) : argv[index + 1];
        if (raw === undefined || raw === '') throw new UsageError(`${flag} requires a value`);
        if (!equals) index += 1;
        if (flag === '--retention-hours') {
            // 上限用运行期允许的最大保留期换算，避免出现「配了 10000 小时」这种无效语义。
            options.retentionHours = integerArgument(flag, raw, { min: 0, max: Math.floor(MAX_RETENTION_MS / 3600000) });
        } else if (flag === '--orphan-hours') {
            options.orphanHours = integerArgument(flag, raw, { min: 0, max: Math.floor(MAX_ABANDONMENT_MS / 3600000) });
        } else if (flag === '--batch-size') {
            options.batchSize = integerArgument(flag, raw, { min: 1, max: MAX_BATCH_SIZE });
        } else if (flag === '--max-attempts') {
            options.maxAttempts = integerArgument(flag, raw, { min: 1, max: 100 });
        } else {
            options.intervalSeconds = integerArgument(flag, raw, { min: 0, max: 86400 });
        }
    }
    return options;
}

function assertStorageRoot(value) {
    if (typeof value !== 'string' || !value.trim()) throw new UsageError('PAINTTRACK_ASSET_STORAGE_ROOT_REQUIRED');
    if (!path.isAbsolute(value)) throw new UsageError('PAINTTRACK_ASSET_STORAGE_ROOT_INVALID');
    const resolved = path.resolve(value);
    // 拒绝文件系统根：对象键会拼在根下，根目录意味着清理范围失去约束。
    if (path.parse(resolved).root === resolved) throw new UsageError('PAINTTRACK_ASSET_STORAGE_ROOT_INVALID');
    return resolved;
}

function readConfiguration(environment) {
    const url = typeof environment.PAINTTRACK_CLEANUP_DATABASE_URL === 'string'
        ? environment.PAINTTRACK_CLEANUP_DATABASE_URL.trim() : '';
    if (!url) throw new UsageError('PAINTTRACK_CLEANUP_DATABASE_URL_REQUIRED');
    let parsed;
    try { parsed = new URL(url); } catch { throw new UsageError('PAINTTRACK_CLEANUP_DATABASE_URL_INVALID'); }
    if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
        throw new UsageError('PAINTTRACK_CLEANUP_DATABASE_URL_INVALID');
    }
    return { url, storageRoot: assertStorageRoot(environment.PAINTTRACK_ASSET_STORAGE_ROOT) };
}

/** 只暴露主机与库名，绝不回显连接串里的口令。 */
function describeTarget(url) {
    try {
        const parsed = new URL(url);
        return `${parsed.hostname}:${parsed.port || '5432'}/${parsed.pathname.replace(/^\//, '')}`;
    } catch {
        return 'unparseable';
    }
}

function summarize(summary) {
    return {
        event: 'asset_cleanup',
        dryRun: summary.dryRun,
        retentionCutoff: summary.retentionCutoff,
        claimed: summary.claimed,
        purgedCount: summary.purged.length,
        failedCount: summary.failed.length,
        failedIds: summary.failed.map((item) => item.id),
        failedCodes: [...new Set(summary.failed.map((item) => item.code))],
        pending: summary.pending,
        exhausted: summary.exhausted,
    };
}

function summarizeReclaim(summary) {
    return {
        event: 'asset_orphan_reclaim',
        dryRun: summary.dryRun,
        abandonmentCutoff: summary.abandonmentCutoff,
        claimed: summary.claimed,
        reclaimedCount: summary.reclaimed.length,
        failedCount: summary.failed.length,
        failedIds: summary.failed.map((item) => item.id),
        failedCodes: [...new Set(summary.failed.map((item) => item.code))],
        pending: summary.pending,
        exhausted: summary.exhausted,
    };
}

async function main({
    argv = process.argv.slice(2), environment = process.env, sink = console, clientFactory,
} = {}) {
    let options;
    let configuration;
    try {
        options = parseArguments(argv);
        if (options.help) { sink.log(USAGE); return 0; }
        configuration = readConfiguration(environment);
    } catch (error) {
        sink.error(`ASSET_CLEANUP_INVALID: ${error.message}`);
        return 2;
    }

    const objectStore = createFileObjectStore({ rootDirectory: configuration.storageRoot });
    // 用 Pool（max 1）而非单连接：常驻模式下连接被回收或中断后能自愈，
    // 不会因为一次空闲断开就让后续每轮都失败。
    const client = clientFactory
        ? clientFactory(configuration.url)
        : new Pool({
            connectionString: configuration.url,
            application_name: 'painttrack-asset-cleanup',
            connectionTimeoutMillis: 3000,
            max: 1,
            idleTimeoutMillis: 10000,
        });
    // Pool 的空闲连接报错会以 error 事件抛出；不处理会直接打崩进程。
    if (typeof client.on === 'function') {
        client.on('error', (error) => {
            sink.error(JSON.stringify({ event: 'asset_cleanup_connection_error', code: error.code || error.name || 'CONNECTION_ERROR' }));
        });
    }

    const runOnce = async () => {
        const summary = await purgeDeletedAssets({
            pool: client,
            objectStore,
            retentionMs: options.retentionHours * 3600000,
            batchSize: options.batchSize,
            maxAttempts: options.maxAttempts,
            dryRun: options.dryRun,
        });
        sink.log(JSON.stringify(summarize(summary)));
        let reclaim = null;
        if (options.orphans) {
            // 两段互不重叠：上一段只认 status='deleted'，这一段只认 pending/uploading。
            reclaim = await reclaimAbandonedAssets({
                pool: client,
                objectStore,
                abandonmentMs: options.orphanHours * 3600000,
                batchSize: options.batchSize,
                maxAttempts: options.maxAttempts,
                dryRun: options.dryRun,
            });
            sink.log(JSON.stringify(summarizeReclaim(reclaim)));
        }
        return { summary, reclaim };
    };

    let timer = null;
    let stopping = false;
    const shutdown = async () => {
        if (stopping) return;
        stopping = true;
        if (timer) clearInterval(timer);
        await client.end().catch(() => {});
        process.exit(0);
    };
    const onSignal = () => { void shutdown(); };

    try {
        await client.connect();
        sink.log(JSON.stringify({ event: 'asset_cleanup_start', target: describeTarget(configuration.url), dryRun: options.dryRun }));
        if (options.intervalSeconds > 0) {
            process.once('SIGINT', onSignal);
            process.once('SIGTERM', onSignal);
            // 常驻模式下首轮失败不能带走整个进程：连接抖动与存储瞬时故障都应靠下一轮恢复。
            const tick = () => {
                if (stopping) return;
                runOnce().catch((error) => {
                    sink.error(JSON.stringify({ event: 'asset_cleanup_error', code: error.code || error.name || 'PURGE_FAILED' }));
                });
            };
            await tick();
            timer = setInterval(tick, options.intervalSeconds * 1000);
            return 0;
        }
        const result = await runOnce();
        const failed = result.summary.failed.length > 0
            || (result.reclaim ? result.reclaim.failed.length > 0 : false);
        await client.end().catch(() => {});
        return failed ? 1 : 0;
    } catch (error) {
        // 连接或 SQL 级失败：只报错误码，不打印连接串。
        sink.error(JSON.stringify({ event: 'asset_cleanup_failed', code: error.code || error.name || 'PURGE_FAILED' }));
        await client.end().catch(() => {});
        return 1;
    }
}

if (require.main === module) {
    main().then((code) => { process.exitCode = code; }, () => { process.exitCode = 1; });
}

module.exports = { USAGE, UsageError, describeTarget, main, parseArguments, readConfiguration, summarize, summarizeReclaim };
