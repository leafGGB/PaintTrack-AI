// Loopback-only local development with an isolated database and in-memory mail.
// Never use this entry in production or expose it through a tunnel/reverse proxy.
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { defaultLocalStateDir, mfaKeyPath, resolveMfaEncryptionKey } = require('./local-secrets');
const root = path.resolve(__dirname, '..');

function createLocalSecrets(randomBytes = crypto.randomBytes) {
    return {
        mailboxSecret: randomBytes(32).toString('hex'),
        mfaEncryptionKey: randomBytes(32).toString('hex'),
    };
}

function listen(server, port, host) {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => { server.removeListener('error', reject); resolve(); });
    });
}

function probePort(port, host) {
    return new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.once('error', reject);
        probe.listen(port, host, () => probe.close(resolve));
    });
}

function validRequest(req, port, remoteAddress = req.socket.remoteAddress) {
    const origin = `http://127.0.0.1:${port}`;
    const fetchSite = req.headers['sec-fetch-site'];
    return remoteAddress === '127.0.0.1'
        && req.headers.host === `127.0.0.1:${port}`
        && (!req.headers.origin || req.headers.origin === origin)
        && (!fetchSite || ['same-origin', 'none'].includes(fetchSite))
        && (!req.headers['x-painttrack-local-capability'] || req.headers['x-painttrack-local-capability'] === '');
}

const SYSTEM_ENV_KEYS = ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'COMSPEC', 'PATHEXT'];
const NEXT_ENV_FILES = ['.env.development.local', '.env.local', '.env.development', '.env'];

function copySystemEnvironment(source) {
    const result = {};
    for (const key of SYSTEM_ENV_KEYS) if (source[key]) result[key] = source[key];
    return result;
}

function environmentPathExists(file) {
    try { fs.lstatSync(file); return true; }
    catch (error) {
        if (error.code === 'ENOENT') return false;
        throw new Error('Cannot verify Next environment file boundary');
    }
}

function assertNoNextEnvironmentFiles(projectRoot, existsSync = environmentPathExists) {
    const found = NEXT_ENV_FILES.filter((name) => existsSync(path.join(projectRoot, name)));
    if (found.length) throw new Error(`Next environment files are not allowed by the local launcher: ${found.join(', ')}`);
}

function localAssetStorageRoot(value) {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error('LOCAL_ASSET_STORAGE_ROOT_INVALID');
    return path.resolve(value);
}

// 默认本地库：名字保持 pt_local_auth_<12位十六进制> 的既有形态，
// 因为既有 UI 验收 fixture 会从启动日志里按这个模式解析库名并派生角色名。
const DEFAULT_LOCAL_DATABASE = 'pt_local_auth_000000000000';
const LOCAL_DATABASE_PATTERN = /^pt_local_auth_[a-z0-9_]{1,24}$/;

// 复用模式下库名固定，账号与会话因此跨重启保留；--fresh 仍生成一次性随机库。
function localDatabasePlan({ environment = process.env, fresh = false, randomSuffix } = {}) {
    const suffix = randomSuffix || crypto.randomBytes(6).toString('hex');
    if (fresh) {
        return {
            database: `pt_local_auth_${suffix}`,
            migrationRole: `pt_local_migrate_${suffix}`,
            runtimeRole: `pt_local_runtime_${suffix}`,
            workerRole: `pt_local_worker_${suffix}`,
            cleanupRole: `pt_local_cleanup_${suffix}`,
            slug: suffix,
            distSuffix: suffix,
            reuse: false,
        };
    }
    const configured = typeof environment.PAINTTRACK_LOCAL_DATABASE === 'string'
        ? environment.PAINTTRACK_LOCAL_DATABASE.trim() : '';
    const database = configured || DEFAULT_LOCAL_DATABASE;
    if (!LOCAL_DATABASE_PATTERN.test(database)) throw new Error('LOCAL_DATABASE_NAME_INVALID');
    const slug = database.slice('pt_local_auth_'.length);
    return {
        database,
        migrationRole: `pt_local_migrate_${slug}`,
        runtimeRole: `pt_local_runtime_${slug}`,
        workerRole: `pt_local_worker_${slug}`,
        cleanupRole: `pt_local_cleanup_${slug}`,
        slug,
        distSuffix: suffix,
        reuse: true,
    };
}

// 复用历史随机库时，角色名要从库 owner 派生：pt_local_auth_<x> 的 owner 是 pt_local_migrate_<x>，
// 直接按库名拼会得到 pt_local_migrate_auth_<x>，与实际角色对不上。
function localRolesFromOwner(ownerRole) {
    if (typeof ownerRole !== 'string') return null;
    const match = /^pt_local_migrate_([a-z0-9_]{1,24})$/.exec(ownerRole);
    if (!match) return null;
    return {
        migrationRole: ownerRole,
        runtimeRole: `pt_local_runtime_${match[1]}`,
        workerRole: `pt_local_worker_${match[1]}`,
        cleanupRole: `pt_local_cleanup_${match[1]}`,
    };
}

function createNextEnvironment({ runtimeUrl, internalPort, origin, secret, mfaEncryptionKey, suffix, heapMb, mockRouting = false, authorizationFixtures = false, fixtureEmail = '', assetStorageRoot = null }, source = process.env) {
    const preloadPath = path.join(__dirname, 'local-next-env-preload.cjs').replace(/\\/g, '/');
    const storageRoot = localAssetStorageRoot(assetStorageRoot);
    return {
        ...copySystemEnvironment(source),
        ...(storageRoot ? { PAINTTRACK_ASSET_STORAGE_ROOT: storageRoot } : {}),
        NODE_ENV: 'development', DATABASE_URL: runtimeUrl, PORT: String(internalPort),
        ...(mockRouting ? { PAINTTRACK_LOCAL_MOCK_ROUTING: '1' } : {}),
        APP_BASE_URL: origin, AUTH_ALLOW_LOCAL_HTTP: '1', PAINTTRACK_LOCAL_MAILBOX: '1',
        ...(authorizationFixtures ? { PAINTTRACK_DEV_ADMIN_FIXTURE_EMAIL: fixtureEmail } : {}),
        PAINTTRACK_LOCAL_MAILBOX_SECRET: secret,
        PAINTTRACK_LOCAL_MAILBOX_ORIGIN: origin,
        PAINTTRACK_MFA_ENCRYPTION_KEY: mfaEncryptionKey,
        PAINTTRACK_DIST_DIR: `.next_local_${suffix}`,
        PAINTTRACK_LOCAL_INTERNAL_GUARD: '1',
        // 仅构造可信选项；绝不继承父 NODE_OPTIONS。preload 同时保护 CLI 与 fork 的运行期回载。
        NODE_OPTIONS: `--max-old-space-size=${heapMb} --require ${JSON.stringify(preloadPath)}`,
    };
}

function createWorkerEnvironment(workerUrl, source = process.env, { mockRouting = false, assetStorageRoot = null } = {}) {
    if (typeof workerUrl !== 'string' || !workerUrl) throw new TypeError('workerUrl is required');
    const storageRoot = localAssetStorageRoot(assetStorageRoot);
    const env = {
        ...copySystemEnvironment(source),
        ...(storageRoot ? { PAINTTRACK_ASSET_STORAGE_ROOT: storageRoot } : {}),
        NODE_ENV: 'development',
        PAINTTRACK_WORKER_DATABASE_URL: workerUrl,
        PAINTTRACK_WORKER_PROVIDER: 'mock',
        // 仅本地入口：失败时把脱敏诊断打到本终端，便于定位自由文本被折叠成 TASK_FAILED 的原因。
        PAINTTRACK_LOCAL_DIAGNOSTICS: '1',
        ...(mockRouting ? { PAINTTRACK_LOCAL_MOCK_ROUTING: '1', PAINTTRACK_LOCAL_INTERNAL_GUARD: '1' } : {}),
    };
    if (source.PAINTTRACK_WORKER_ID) env.PAINTTRACK_WORKER_ID = source.PAINTTRACK_WORKER_ID;
    return env;
}

// 清理子进程只拿到 cleanup 角色连接：它看不到 Web/Worker 凭据，也没有任务与用户表权限。
function createCleanupEnvironment(cleanupUrl, source = process.env, { assetStorageRoot = null } = {}) {
    if (typeof cleanupUrl !== 'string' || !cleanupUrl) throw new TypeError('cleanupUrl is required');
    const storageRoot = localAssetStorageRoot(assetStorageRoot);
    return {
        ...copySystemEnvironment(source),
        NODE_ENV: 'development',
        PAINTTRACK_CLEANUP_DATABASE_URL: cleanupUrl,
        ...(storageRoot ? { PAINTTRACK_ASSET_STORAGE_ROOT: storageRoot } : {}),
    };
}

function localAdminUrl(value) {
    if (typeof value !== 'string' || !value.trim()) throw new Error('LOCAL_DATABASE_ADMIN_URL_REQUIRED');
    try {
        const { parseDatabaseTarget } = require('../lib/server/db/testIsolation');
        const target = parseDatabaseTarget(value);
        if (!target.loopback || target.port !== 5433 || target.database !== 'postgres') throw new Error();
        const url = new URL(value);
        // 固定到数值loopback，避免localhost解析；派生运行连接复用同一端点。
        url.hostname = target.host === '::1' ? '[::1]' : '127.0.0.1';
        return url.href;
    } catch {
        throw new Error('LOCAL_DATABASE_ADMIN_URL_INVALID');
    }
}

function localRoleUrl(adminUrl, role, password, database) {
    const url = new URL(localAdminUrl(adminUrl));
    url.username = role;
    url.password = password;
    url.pathname = `/${database}`;
    return url.href;
}

async function prepareLocalMockRouting(owner, runtimeRole) {
    if (!/^pt_local_runtime_[a-z0-9_]{1,24}$/.test(runtimeRole)) throw new Error('INVALID_LOCAL_MOCK_ROLE');
    const { models } = require('../lib/server/tasks/localMockCatalog');
    for (const model of models) {
        // 复用同一本地库时这条准备会重复执行；固定 ID 必须幂等，且不覆盖已有目录配置。
        await owner.query(`INSERT INTO logical_models (id, logical_model_id, display_name, media_type, supported_operations, enabled)
            VALUES ($1::uuid, $2, $3, $4, $5::jsonb, false) ON CONFLICT (id) DO NOTHING`,
        [model.id, model.logicalModelId, `Synthetic ${model.mediaType} fixture`, model.mediaType, JSON.stringify([model.operation])]);
    }
    // 只为本次新建的本地角色补充快照 INSERT；不授予快照 UPDATE 或配置表写权限。
    await owner.query(`GRANT INSERT(logical_model_pk,route_snapshot,route_snapshot_version,route_snapshot_hash) ON generation_tasks TO "${runtimeRole}"`);
}

async function provision() {
    if (process.env.NODE_ENV === 'production') throw new Error('Development only');
    // `--prune` 是维护入口：只清理 `.next_local_*` 与历史本地库，不启动任何服务，
    // 因此也不做 Next 环境文件检查。默认 dry-run，加 `--yes` 才真删。
    if (process.argv.includes('--prune')) {
        const { runPrune } = require('./prune-local');
        const configured = typeof process.env.PAINTTRACK_LOCAL_DATABASE === 'string'
            ? process.env.PAINTTRACK_LOCAL_DATABASE.trim() : '';
        let pruneAdminUrl = null;
        try {
            pruneAdminUrl = localAdminUrl(process.env.LOCAL_DATABASE_ADMIN_URL);
        } catch {
            // 没有管理连接时只清构建目录，不猜凭据。
            pruneAdminUrl = null;
        }
        const summary = await runPrune({
            root,
            keepDatabase: configured || DEFAULT_LOCAL_DATABASE,
            deriveRoles: localRolesFromOwner,
            adminUrl: pruneAdminUrl,
            yes: process.argv.includes('--yes'),
            createClient: (connectionString) => new (require('pg').Client)({ connectionString, connectionTimeoutMillis: 3000 }),
        });
        process.exitCode = summary.failed.length ? 1 : 0;
        return;
    }
    const adminUrl = localAdminUrl(process.env.LOCAL_DATABASE_ADMIN_URL);
    assertNoNextEnvironmentFiles(root);
    const { Client } = require('pg');
    const { migrateDatabase } = require('../lib/server/db/migrate');
    // 默认复用同一个本地库：账号、登录会话、任务与资产跨重启保留。
    // 需要干净环境时加 --fresh，退回一次性随机库的原行为。
    const fresh = process.argv.includes('--fresh');
    let plan;
    try {
        plan = localDatabasePlan({ fresh });
    } catch (error) {
        // 只回显固定错误码，不回显用户输入，便于排障又不泄露值。
        if (/^[A-Z_]{4,64}$/.test(error.message)) console.error(error.message);
        throw error;
    }
    const { database } = plan;
    // 随机后缀只用于一次性资源（Next dist 目录、开发管理员 fixture 邮箱），不参与数据库命名。
    const suffix = plan.distSuffix;
    const authorizationFixtures = process.argv.includes('--authorization-fixtures');
    // 本地默认私有资产目录：与 Web/Worker 共用，避免用户漏配变量导致"任务成功但无图"。
    const assetStorageRoot = localAssetStorageRoot(process.env.PAINTTRACK_ASSET_STORAGE_ROOT)
        || path.join(root, '.local-assets');
    fs.mkdirSync(assetStorageRoot, { recursive: true, mode: 0o700 });
    const port = Number(process.env.PORT || 3000);
    const internalPort = Number(process.env.PAINTTRACK_NEXT_PORT || port + 1);
    const heapMb = Number(process.env.PAINTTRACK_DEV_HEAP_MB) || 3072;
    if (!Number.isInteger(port) || port < 1024 || port > 65534
        || !Number.isInteger(internalPort) || internalPort < 1024 || internalPort > 65535
        || internalPort === port || !Number.isInteger(heapMb) || heapMb < 2048 || heapMb > 8192) {
        throw new Error('Invalid local development port or heap configuration');
    }
    await Promise.all([probePort(port, '127.0.0.1'), probePort(internalPort, '127.0.0.1')]);

    const admin = new Client({ connectionString: adminUrl, connectionTimeoutMillis: 3000 });
    let migrationUrl;
    let runtimeUrl;
    let workerUrl;
    let cleanupUrl;
    let migrationRole;
    let runtimeRole;
    let workerRole;
    let cleanupRole;
    try {
        await admin.connect();
        const existing = (await admin.query(
            `SELECT d.datname, pg_get_userbyid(d.datdba) AS owner FROM pg_database d WHERE d.datname = $1`,
            [database],
        )).rows[0];
        // 复用既有库时沿用它的 owner 命名，兼容历史随机库 pt_local_auth_<suffix> → pt_local_migrate_<suffix>。
        const derived = existing ? localRolesFromOwner(existing.owner) : null;
        if (existing && !derived && existing.owner !== plan.migrationRole) {
            // 同名库已存在但不属于本地启动器：宁可失败也不改动别人的库。
            console.error(`LOCAL_DATABASE_OWNER_MISMATCH ${database}`);
            throw new Error('LOCAL_DATABASE_OWNER_MISMATCH');
        }
        const roles = derived || {
            migrationRole: plan.migrationRole,
            runtimeRole: plan.runtimeRole,
            workerRole: plan.workerRole,
            cleanupRole: plan.cleanupRole,
        };
        migrationRole = roles.migrationRole;
        runtimeRole = roles.runtimeRole;
        workerRole = roles.workerRole;
        cleanupRole = roles.cleanupRole;
        const passwords = {
            migration: crypto.randomBytes(32).toString('hex'),
            runtime: crypto.randomBytes(32).toString('hex'),
            worker: crypto.randomBytes(32).toString('hex'),
            cleanup: crypto.randomBytes(32).toString('hex'),
        };
        const url = (role, password) => localRoleUrl(adminUrl, role, password, database);
        migrationUrl = url(migrationRole, passwords.migration);
        runtimeUrl = url(runtimeRole, passwords.runtime);
        workerUrl = url(workerRole, passwords.worker);
        cleanupUrl = url(cleanupRole, passwords.cleanup);
        const known = new Set((await admin.query(
            'SELECT rolname FROM pg_roles WHERE rolname = ANY($1::text[])',
            [[migrationRole, runtimeRole, workerRole, cleanupRole]],
        )).rows.map((row) => row.rolname));
        for (const [role, password] of [
            [migrationRole, passwords.migration],
            [runtimeRole, passwords.runtime],
            [workerRole, passwords.worker],
            [cleanupRole, passwords.cleanup],
        ]) {
            if (known.has(role)) {
                // 复用库时密码每轮重新随机生成，必须重置；否则新进程握着旧密码连不上。
                await admin.query(`ALTER ROLE ${role} WITH PASSWORD '${password}'`);
                continue;
            }
            await admin.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
        }
        if (existing) {
            console.log(`LOCAL_DATABASE_REUSED ${database} (accounts, sessions and tasks are preserved)`);
        } else {
            await admin.query(`CREATE DATABASE ${database} OWNER ${migrationRole} TEMPLATE template0`);
            await admin.query(`REVOKE ALL ON DATABASE ${database} FROM PUBLIC`);
            console.log(`LOCAL_DATABASE_CREATED ${database}`);
        }
        // 既有验收 fixture 依赖这一行解析库名，格式必须保持稳定。
        console.log(`Retained development database: ${database}`);
    } finally { await admin.end(); }

    await migrateDatabase({ databaseUrl: runtimeUrl, migrationDatabaseUrl: migrationUrl });
    const owner = new Client({ connectionString: migrationUrl });
    try {
        await owner.connect();
        await owner.query('REVOKE ALL ON SCHEMA public FROM PUBLIC');
        await owner.query(`GRANT CONNECT ON DATABASE ${database} TO ${runtimeRole}, ${workerRole}, ${cleanupRole}`);
        await owner.query(`GRANT USAGE ON SCHEMA public TO ${runtimeRole}, ${workerRole}, ${cleanupRole}`);
        const permissions = require('../lib/server/db/runtimePermissions');
        if (process.env.PAINTTRACK_LOCAL_MOCK_ROUTING === '1') {
            await prepareLocalMockRouting(owner, runtimeRole);
            // 固定FK身份仅供合成路由，公共目录保持禁用，不冒充正式动态目录。
        }
        await permissions.grantWebRuntimePermissions(owner, runtimeRole);
        await permissions.grantWorkerRuntimePermissions(owner, workerRole);
        // 清理角色每次启动都重放授权：复用库时角色已存在，权限需要与当前代码一致。
        await permissions.grantCleanupRuntimePermissions(owner, cleanupRole);
    } finally { await owner.end(); }

    // 复用库时 fixture 邮箱按库名固定，之前注册过的管理员身份重启后仍能被提升。
    const fixtureEmail = authorizationFixtures ? `admin-${plan.slug}@example.test` : '';
    let fixtureTimer;
    let fixtureBusy = false;
    let fixtureDone = false;
    if (authorizationFixtures) {
        console.log(`DEVELOPMENT_ONLY_ADMIN_FIXTURE ${fixtureEmail}`);
        fixtureTimer = setInterval(async () => {
            if (fixtureBusy || fixtureDone) return;
            fixtureBusy = true;
            const fixtureOwner = new Client({ connectionString: migrationUrl, connectionTimeoutMillis: 3000 });
            try {
                await fixtureOwner.connect();
                const result = await fixtureOwner.query("UPDATE users SET role='admin' WHERE email=$1 AND email_verified_at IS NOT NULL AND role='user' RETURNING id", [fixtureEmail]);
                if (result.rowCount) {
                    fixtureDone = true;
                    clearInterval(fixtureTimer);
                    console.log('DEVELOPMENT_ONLY_ADMIN_FIXTURE_READY');
                }
            } catch { console.error('开发管理员fixture准备暂时失败，未输出凭据'); }
            finally { await fixtureOwner.end(); fixtureBusy = false; }
        }, 500);
    }

    // mailboxSecret 每次重启重生成是**有意的**：邮件只存在内存里，重启后旧
    // 验证链接本来就失效，签名密钥跟着换才一致。
    const { mailboxSecret: secret } = createLocalSecrets();
    // MFA 加密密钥必须与数据库同寿：TOTP 密钥以 AES-256-GCM 密文存在
    // admin_mfa_factors 里，换密钥会让重启后所有已注册 factor 解不开，管理员
    // 被锁在自己的本地 MFA 之外（恢复码是哈希，拿不回原始 TOTP）。所以复用固定
    // 库时把它持久化；--fresh 走一次性库，配一次性密钥。
    const localStateDir = defaultLocalStateDir(root);
    const mfaKey = resolveMfaEncryptionKey(localStateDir, { persist: !fresh });
    const mfaEncryptionKey = mfaKey.key;
    const origin = `http://127.0.0.1:${port}`;
    const nextEnv = createNextEnvironment({
        runtimeUrl, internalPort, origin, secret, mfaEncryptionKey, suffix, heapMb,
        authorizationFixtures, fixtureEmail, assetStorageRoot, mockRouting: process.env.PAINTTRACK_LOCAL_MOCK_ROUTING === '1',
    });

    assertNoNextEnvironmentFiles(root);
    const nextProcess = spawn(process.execPath, [path.join(root, 'node_modules/next/dist/bin/next'), 'dev', '--hostname', '127.0.0.1', '--port', String(internalPort)], {
        cwd: root, env: nextEnv, stdio: ['ignore', 'inherit', 'inherit'],
    });
    const workerProcess = process.env.PAINTTRACK_LOCAL_WORKER === '1'
        ? spawn(process.execPath, [path.join(root, 'lib/server/worker/index.js')], {
            cwd: root, env: createWorkerEnvironment(workerUrl, process.env, { mockRouting: process.env.PAINTTRACK_LOCAL_MOCK_ROUTING === '1', assetStorageRoot }), stdio: ['ignore', 'inherit', 'inherit'],
        })
        : null;
    // 资产清理默认不常驻：需要验证「删除后对象真的消失」时显式打开。
    // 本地默认保留期 0 小时，删除即可清理；生产接入对象存储前必须先定下保留政策。
    //
    // 孤儿回收（归档中途被强杀的 pending 行）刻意**不跟随**保留期归零：
    // 保留期为 0 只影响用户显式删除的行，而孤儿窗口为 0 会误删正在写入的对象。
    const cleanupProcess = process.env.PAINTTRACK_LOCAL_ASSET_CLEANUP === '1'
        ? spawn(process.execPath, [
            path.join(root, 'scripts/asset-cleanup.js'),
            '--interval', process.env.PAINTTRACK_LOCAL_ASSET_CLEANUP_INTERVAL_SECONDS || '60',
            '--retention-hours', process.env.PAINTTRACK_LOCAL_ASSET_CLEANUP_RETENTION_HOURS || '0',
            '--orphan-hours', process.env.PAINTTRACK_LOCAL_ASSET_CLEANUP_ORPHAN_HOURS || '6',
        ], { cwd: root, env: createCleanupEnvironment(cleanupUrl, process.env, { assetStorageRoot }), stdio: ['ignore', 'inherit', 'inherit'] })
        : null;
    let stopping = false;
    let nextReady = false;
    const server = http.createServer((req, res) => {
        if (!validRequest(req, port)) {
            res.writeHead(403, { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
            res.end('Local development access only');
            return;
        }
        delete req.headers['x-painttrack-local-capability'];
        delete req.headers['x-forwarded-host'];
        delete req.headers['x-forwarded-for'];
        req.headers['x-painttrack-local-capability'] = secret;
        req.headers.host = `127.0.0.1:${port}`;
        req.headers['x-forwarded-host'] = `127.0.0.1:${port}`;
        const upstream = http.request({ hostname: '127.0.0.1', port: internalPort, method: req.method, path: req.url, headers: req.headers }, (response) => {
            res.writeHead(response.statusCode || 502, response.headers);
            response.pipe(res);
        });
        upstream.on('error', () => {
            if (!res.headersSent) res.writeHead(503, { 'Cache-Control': 'no-store' });
            res.end('Local development server is starting or unavailable');
        });
        req.pipe(upstream);
    });
    server.on('upgrade', (req, socket, head) => {
        if (!validRequest(req, port)) { socket.destroy(); return; }
        delete req.headers['x-painttrack-local-capability'];
        delete req.headers['x-forwarded-host'];
        delete req.headers['x-forwarded-for'];
        req.headers['x-painttrack-local-capability'] = secret;
        req.headers.host = `127.0.0.1:${port}`;
        req.headers['x-forwarded-host'] = `127.0.0.1:${port}`;
        const upstream = net.connect(internalPort, '127.0.0.1', () => {
            const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
            for (const [name, value] of Object.entries(req.headers)) {
                if (Array.isArray(value)) value.forEach((item) => lines.push(`${name}: ${item}`));
                else if (value !== undefined) lines.push(`${name}: ${value}`);
            }
            upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
            if (head?.length) upstream.write(head);
            socket.pipe(upstream).pipe(socket);
        });
        upstream.on('error', () => socket.destroy());
        socket.on('error', () => upstream.destroy());
    });

    const readyPoll = setInterval(async () => {
        if (nextReady) return;
        try {
            const response = await fetch(`http://127.0.0.1:${internalPort}/_next/static/development/_buildManifest.js`, { signal: AbortSignal.timeout(1000) });
            if (response.status < 500) {
                nextReady = true;
                clearInterval(readyPoll);
                console.log(`LOCAL_ASSET_STORAGE_ROOT ${assetStorageRoot}`);
                // 只输出路径与来源，绝不输出密钥本身。
                console.log(mfaKey.source === 'ephemeral'
                    ? 'LOCAL_MFA_KEY_EPHEMERAL (--fresh: throwaway database, throwaway key)'
                    : `LOCAL_MFA_KEY_PERSISTED ${mfaKeyPath(localStateDir)} (${mfaKey.source})`);
                if (cleanupProcess) console.log('LOCAL_ASSET_CLEANUP_ENABLED (deleted assets are purged by a separate role)');
                console.log(`LOCAL_REGISTRATION_READY ${origin}/register`);
            }
        } catch { /* Next is still starting. */ }
    }, 500);
    const stopChildren = (signal) => {
        if (nextProcess.exitCode === null && nextProcess.signalCode === null) nextProcess.kill(signal);
        if (workerProcess && workerProcess.exitCode === null && workerProcess.signalCode === null) workerProcess.kill(signal);
        if (cleanupProcess && cleanupProcess.exitCode === null && cleanupProcess.signalCode === null) cleanupProcess.kill(signal);
    };
    nextProcess.once('exit', (code) => {
        clearInterval(fixtureTimer);
        clearInterval(readyPoll);
        if (!stopping) {
            stopping = true;
            server.close();
            server.closeAllConnections();
            stopChildren('SIGTERM');
            process.exitCode = code ?? 1;
        }
    });
    workerProcess?.once('exit', (code) => {
        if (code && !stopping) {
            stopping = true;
            clearInterval(fixtureTimer);
            clearInterval(readyPoll);
            server.close();
            server.closeAllConnections();
            stopChildren('SIGTERM');
            process.exitCode = code;
        }
    });
    // 清理失败是可重试状态，不应带走整个本地栈；只在终端留一行诊断。
    cleanupProcess?.once('exit', (code) => {
        if (code && !stopping) console.error(`LOCAL_ASSET_CLEANUP_EXITED ${code} (deleted assets keep their objects until the next run)`);
    });

    try {
        await listen(server, port, '127.0.0.1');
        console.log(`LOCAL_ENTRY_BOUND http://127.0.0.1:${port}`);
    } catch (error) {
        clearInterval(fixtureTimer);
        clearInterval(readyPoll);
        nextProcess.kill('SIGTERM');
        workerProcess?.kill('SIGTERM');
        throw error;
    }
    const stop = () => {
        if (stopping) return;
        stopping = true;
        clearInterval(fixtureTimer);
        clearInterval(readyPoll);
        server.close();
        server.closeAllConnections();
        stopChildren('SIGTERM');
    };
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, stop);
}

if (require.main === module) {
    provision().catch(() => {
        console.error('Local development startup failed. No credentials printed; created resources are retained.');
        process.exitCode = 1;
    });
}

module.exports = { DEFAULT_LOCAL_DATABASE, assertNoNextEnvironmentFiles, copySystemEnvironment, createCleanupEnvironment, createLocalSecrets, createNextEnvironment, createWorkerEnvironment, localAdminUrl, localAssetStorageRoot, localDatabasePlan, localRoleUrl, localRolesFromOwner, prepareLocalMockRouting, validRequest };
