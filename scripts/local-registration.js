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
function localDatabasePlan({ environment = process.env, fresh = false, randomSuffix, controlledImage = false } = {}) {
    const suffix = randomSuffix || crypto.randomBytes(6).toString('hex');
    if (fresh || controlledImage) {
        const slug = controlledImage ? `ci_${suffix}` : suffix;
        return {
            database: `pt_local_auth_${slug}`,
            migrationRole: `pt_local_migrate_${slug}`,
            runtimeRole: `pt_local_runtime_${slug}`,
            workerRole: `pt_local_worker_${slug}`,
            cleanupRole: `pt_local_cleanup_${slug}`,
            slug,
            distSuffix: suffix,
            reuse: false,
        };
    }
    const configured = typeof environment.PAINTTRACK_LOCAL_DATABASE === 'string'
        ? environment.PAINTTRACK_LOCAL_DATABASE.trim() : '';
    const database = configured || DEFAULT_LOCAL_DATABASE;
    if (!LOCAL_DATABASE_PATTERN.test(database) || database.startsWith('pt_local_auth_ci_')) throw new Error('LOCAL_DATABASE_NAME_INVALID');
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

function controlledImageEnvironment(ownerId) {
    return { PAINTTRACK_LOCAL_CONTROLLED_IMAGE: '1', PAINTTRACK_CONTROLLED_IMAGE_OWNER: ownerId, PAINTTRACK_LOCAL_INTERNAL_GUARD: '1' };
}

function createNextEnvironment({ runtimeUrl, internalPort, origin, secret, mfaEncryptionKey, suffix, heapMb, mockRouting = false, chargedSubmission = false, authorizationFixtures = false, fixtureEmail = '', assetStorageRoot = null, controlledOwnerId }, source = process.env) {
    const preloadPath = path.join(__dirname, 'local-next-env-preload.cjs').replace(/\\/g, '/');
    const storageRoot = localAssetStorageRoot(assetStorageRoot);
    return {
        ...copySystemEnvironment(source),
        ...(storageRoot ? { PAINTTRACK_ASSET_STORAGE_ROOT: storageRoot } : {}),
        NODE_ENV: 'development', DATABASE_URL: runtimeUrl, PORT: String(internalPort),
        ...(controlledOwnerId ? controlledImageEnvironment(controlledOwnerId) : {}),
        ...(mockRouting ? { PAINTTRACK_LOCAL_MOCK_ROUTING: '1' } : {}),
        ...(chargedSubmission ? { PAINTTRACK_CHARGED_SUBMISSION: '1' } : {}),
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

// 结算宿主只拿到独立账务连接与目标确认，不把账务连接传给 Next/Worker。
function createSettlementEnvironment(ledgerUrl, targetUrl, source = process.env) {
    if (typeof ledgerUrl !== 'string' || !ledgerUrl) throw new TypeError('ledgerUrl is required');
    if (typeof targetUrl !== 'string' || !targetUrl) throw new TypeError('targetUrl is required');
    return {
        ...copySystemEnvironment(source),
        NODE_ENV: 'development',
        LEDGER_DATABASE_URL: ledgerUrl,
        DATABASE_URL: targetUrl,
        PAINTTRACK_SETTLEMENT_INTERVAL_MS: source.PAINTTRACK_SETTLEMENT_INTERVAL_MS || '30000',
        PAINTTRACK_SETTLEMENT_LIMIT: source.PAINTTRACK_SETTLEMENT_LIMIT || '50',
    };
}

function databaseUrlForTarget(adminUrl, database) {
    const url = new URL(adminUrl);
    url.pathname = `/${database}`;
    return url.href;
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
    if (role.startsWith('pt_ledger_owner_')) throw new Error('LEDGER_OWNER_RUNTIME_IDENTITY_FORBIDDEN');
    const url = new URL(localAdminUrl(adminUrl));
    url.username = role;
    url.password = password;
    url.pathname = `/${database}`;
    return url.href;
}

async function grantLocalSnapshotInsert(owner, runtimeRole) {
    if (!/^pt_local_runtime_[a-z0-9_]{1,24}$/.test(runtimeRole)) throw new Error('INVALID_LOCAL_ROUTE_ROLE');
    await owner.query(`GRANT INSERT(logical_model_pk,route_snapshot,route_snapshot_version,route_snapshot_hash) ON generation_tasks TO "${runtimeRole}"`);
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
    await grantLocalSnapshotInsert(owner, runtimeRole);
}

async function prepareControlledImage(owner, runtimeRole, fixture) {
    const { logicalModelId, modelPk, publicModel } = require('../lib/server/tasks/controlledImageDevelopment');
    const { hashPassword } = require('../lib/server/registration');
    const hash = await hashPassword(fixture.password);
    delete fixture.password;
    await owner.query('BEGIN');
    try {
        await owner.query("INSERT INTO users (id,email,password_hash,email_verified_at) VALUES ($1,$2,$3,now())", [fixture.ownerId, fixture.fixtureEmail, hash]);
        await owner.query(`INSERT INTO logical_models (id,logical_model_id,display_name,media_type,supported_operations,enabled)
            VALUES ($1,$2,$3,'image','["image.generate"]'::jsonb,false)`, [modelPk, logicalModelId, publicModel.displayName]);
        await grantLocalSnapshotInsert(owner, runtimeRole);
        await owner.query('COMMIT');
    } catch (error) {
        await owner.query('ROLLBACK');
        throw error;
    }
}

function localExecutionOptions(args = [], environment = {}) {
    return {
        mockRouting: args.includes('--mock') || environment.PAINTTRACK_LOCAL_MOCK_ROUTING === '1',
        localWorker: args.includes('--worker') || environment.PAINTTRACK_LOCAL_WORKER === '1',
    };
}

function controlledImageLaunch(args, environment) {
    const requested = args.includes('--controlled-image');
    if (environment.PAINTTRACK_LOCAL_CONTROLLED_IMAGE !== undefined) throw new Error('CONTROLLED_IMAGE_LAUNCHER_REQUIRED');
    if (!requested) return null;
    const { conflictingEnvironment, fixtureEmail } = require('../lib/server/tasks/controlledImageDevelopment');
    if (args.length !== 1 || conflictingEnvironment(environment)
        || ['PAINTTRACK_LOCAL_DATABASE', 'PAINTTRACK_ASSET_STORAGE_ROOT'].some(key => environment[key])) {
        throw new Error('CONTROLLED_IMAGE_MODE_CONFLICT');
    }
    const { validateInput } = require('../lib/server/registration');
    const { password } = validateInput('register', { email: fixtureEmail, password: environment.PAINTTRACK_CONTROLLED_IMAGE_PASSWORD });
    return { ownerId: crypto.randomUUID(), password, fixtureEmail };
}

async function provision() {
    if (process.env.NODE_ENV === 'production') throw new Error('Development only');
    const controlledImage = controlledImageLaunch(process.argv.slice(2), process.env);
    const { mockRouting, localWorker } = localExecutionOptions(process.argv.slice(2), process.env);
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
    const { migrateDatabase, ledgerOwnerRole } = require('../lib/server/db/migrate');
    // 默认复用同一个本地库：账号、登录会话、任务与资产跨重启保留。
    // 需要干净环境时加 --fresh，退回一次性随机库的原行为。
    const fresh = Boolean(controlledImage) || process.argv.includes('--fresh');
    let plan;
    try {
        plan = localDatabasePlan({ fresh, controlledImage: Boolean(controlledImage) });
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
    const ordinaryStorage = path.join(root, '.local-assets');
    const assetStorageRoot = controlledImage
        ? path.join(ordinaryStorage, `controlled-${suffix}`)
        : localAssetStorageRoot(process.env.PAINTTRACK_ASSET_STORAGE_ROOT) || ordinaryStorage;
    fs.mkdirSync(controlledImage ? ordinaryStorage : assetStorageRoot, { recursive: true, mode: 0o700 });
    if (controlledImage) fs.mkdirSync(assetStorageRoot, { mode: 0o700 });
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
        if (controlledImage && (existing || known.size)) throw new Error('CONTROLLED_IMAGE_FRESH_TARGET_REQUIRED');
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

    try {
        await migrateDatabase({ databaseUrl: runtimeUrl, migrationDatabaseUrl: migrationUrl, localDatabaseAdminUrl: adminUrl });
    } catch (error) {
        if (controlledImage) console.error('CONTROLLED_IMAGE_DATABASE_MIGRATION_FAILED');
        throw error;
    }
    const owner = new Client({ connectionString: migrationUrl });
    try {
        await owner.connect();
        await owner.query('REVOKE ALL ON SCHEMA public FROM PUBLIC');
        await owner.query(`GRANT CONNECT ON DATABASE ${database} TO ${runtimeRole}, ${workerRole}, ${cleanupRole}`);
        await owner.query(`GRANT USAGE ON SCHEMA public TO ${runtimeRole}, ${workerRole}, ${cleanupRole}`);
        const permissions = require('../lib/server/db/runtimePermissions');
        if (mockRouting) {
            await prepareLocalMockRouting(owner, runtimeRole);
            // 固定FK身份仅供合成路由，公共目录保持禁用，不冒充正式动态目录。
        }
        if (controlledImage) await prepareControlledImage(owner, runtimeRole, controlledImage);
        await permissions.grantWebRuntimePermissions(owner, runtimeRole);
        const projectionAdmin = new Client({ connectionString: databaseUrlForTarget(adminUrl, database), connectionTimeoutMillis: 3000 });
        try {
            await projectionAdmin.connect();
            await permissions.grantAdminModelsProjectionPermission(projectionAdmin, runtimeRole);
        } finally { await projectionAdmin.end(); }
        // 收费入口默认关闭；只有显式开启时才追加账务函数的执行权。
        // 函数属主是 NOLOGIN 的账本 owner，执行权必须由能切换为该 owner 的管理员身份追加。
        if (process.env.PAINTTRACK_CHARGED_SUBMISSION === '1') {
            const ledgerAdmin = new Client({ connectionString: adminUrl });
            try {
                await ledgerAdmin.connect();
                await permissions.grantChargedSubmissionPermissions(ledgerAdmin, runtimeRole, ledgerOwnerRole(database));
            } finally { await ledgerAdmin.end(); }
        }
        await permissions.grantWorkerRuntimePermissions(owner, workerRole);
        // 清理角色每次启动都重放授权：复用库时角色已存在，权限需要与当前代码一致。
        await permissions.grantCleanupRuntimePermissions(owner, cleanupRole);
    } catch (error) {
        if (controlledImage) console.error('CONTROLLED_IMAGE_DATABASE_SETUP_FAILED');
        throw error;
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
        authorizationFixtures, fixtureEmail, assetStorageRoot,
        mockRouting, controlledOwnerId: controlledImage?.ownerId,
        chargedSubmission: process.env.PAINTTRACK_CHARGED_SUBMISSION === '1',
    });

    assertNoNextEnvironmentFiles(root);
    console.log(`LOCAL_MODEL_SOURCE=${controlledImage ? 'controlled-synthetic-image' : mockRouting ? 'mock' : 'database'}`);
    console.log(`LOCAL_WORKER=${localWorker || controlledImage ? 'enabled' : 'disabled'}`);
    const nextProcess = spawn(process.execPath, [path.join(root, 'node_modules/next/dist/bin/next'), 'dev', '--hostname', '127.0.0.1', '--port', String(internalPort)], {
        cwd: root, env: nextEnv, stdio: ['ignore', 'inherit', 'inherit'],
    });
    const controlledWorker = controlledImage ? spawn(process.execPath, [path.join(root, 'scripts/local-controlled-image-worker.js')], {
        cwd: root, stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
        env: { ...copySystemEnvironment(process.env), NODE_ENV: 'development', ...controlledImageEnvironment(controlledImage.ownerId),
            PAINTTRACK_WORKER_DATABASE_URL: workerUrl, PAINTTRACK_ASSET_STORAGE_ROOT: assetStorageRoot },
    }) : null;
    const workerProcess = localWorker
        ? spawn(process.execPath, [path.join(root, 'lib/server/worker/index.js')], {
            cwd: root, env: createWorkerEnvironment(workerUrl, process.env, { mockRouting, assetStorageRoot }), stdio: ['ignore', 'inherit', 'inherit'],
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
    // 结算是独立受限宿主：只有显式开关打开时才把管理员账务连接交给它。
    // 它不继承 Worker 环境，也不改变收费提交开关。
    const settlementProcess = process.env.PAINTTRACK_LOCAL_SETTLEMENT === '1'
        ? spawn(process.execPath, [path.join(root, 'scripts/settlement-host.js')], {
            cwd: root,
            env: createSettlementEnvironment(databaseUrlForTarget(adminUrl, database), runtimeUrl, process.env),
            stdio: ['ignore', 'inherit', 'inherit'],
        })
        : null;
    let stopping = false;
    let nextReady = false;
    let workerReady = false;
    controlledWorker?.on('message', message => {
        if (!stopping && message === 'controlled-image-ready') workerReady = true;
    });
    const setProxyCapability = (req) => {
        delete req.headers['x-painttrack-controlled-image-ready'];
        req.headers['x-painttrack-local-capability'] = secret;
        if (controlledImage && nextReady && workerReady && controlledWorker.connected && !stopping) {
            req.headers['x-painttrack-controlled-image-ready'] = secret;
        }
    };
    const server = http.createServer((req, res) => {
        if (!validRequest(req, port)) {
            res.writeHead(403, { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
            res.end('Local development access only');
            return;
        }
        delete req.headers['x-painttrack-local-capability'];
        delete req.headers['x-forwarded-host'];
        delete req.headers['x-forwarded-for'];
        setProxyCapability(req);
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
        setProxyCapability(req);
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

    let checkingReady = false;
    const readyPoll = setInterval(async () => {
        if (stopping || nextReady || checkingReady || (controlledImage && !workerReady)) return;
        checkingReady = true;
        try {
            const readyPath = controlledImage ? '/api/health/database' : '/_next/static/development/_buildManifest.js';
            const response = await fetch(`http://127.0.0.1:${internalPort}${readyPath}`, {
                headers: controlledImage ? { 'x-painttrack-local-capability': secret } : {}, signal: AbortSignal.timeout(1000),
            });
            const ready = controlledImage ? response.status === 200 && (await response.json()).database === 'ok' : response.status < 500;
            if (ready && !stopping && (!controlledImage || controlledWorker.connected)) {
                nextReady = true;
                clearInterval(readyPoll);
                clearTimeout(startupDeadline);
                console.log(`LOCAL_ASSET_STORAGE_ROOT ${assetStorageRoot}`);
                // 只输出路径与来源，绝不输出密钥本身。
                console.log(mfaKey.source === 'ephemeral'
                    ? 'LOCAL_MFA_KEY_EPHEMERAL (--fresh: throwaway database, throwaway key)'
                    : `LOCAL_MFA_KEY_PERSISTED ${mfaKeyPath(localStateDir)} (${mfaKey.source})`);
                if (cleanupProcess) console.log('LOCAL_ASSET_CLEANUP_ENABLED (deleted assets are purged by a separate role)');
                if (settlementProcess) console.log('LOCAL_SETTLEMENT_ENABLED (ledger host runs independently from Worker)');
                console.log(`LOCAL_REGISTRATION_READY ${origin}/register`);
                if (controlledImage) console.log(`CONTROLLED_IMAGE_READY ${origin}/login (fixture email: ${controlledImage.fixtureEmail})`);
            }
        } catch { /* Next 尚未就绪。 */ }
        finally { checkingReady = false; }
    }, 500);
    const startupDeadline = controlledImage ? setTimeout(() => failControlledImage('CONTROLLED_IMAGE_STARTUP_TIMEOUT'), 120000) : null;
    const upgradedSockets = new Set();
    server.on('upgrade', (_req, socket) => {
        upgradedSockets.add(socket);
        socket.once('close', () => upgradedSockets.delete(socket));
    });
    const stopChildren = (signal) => {
        if (controlledWorker && controlledWorker.exitCode === null && controlledWorker.signalCode === null) {
            if (controlledWorker.connected) controlledWorker.send('controlled-image-stop', () => {});
            const deadline = setTimeout(() => controlledWorker.kill('SIGKILL'), 8000);
            controlledWorker.once('exit', () => clearTimeout(deadline));
        }
        if (nextProcess.exitCode === null && nextProcess.signalCode === null) nextProcess.kill(signal);
        if (workerProcess && workerProcess.exitCode === null && workerProcess.signalCode === null) workerProcess.kill(signal);
        if (cleanupProcess && cleanupProcess.exitCode === null && cleanupProcess.signalCode === null) cleanupProcess.kill(signal);
        if (settlementProcess && settlementProcess.exitCode === null && settlementProcess.signalCode === null) settlementProcess.kill(signal);
    };
    function failControlledImage(code) {
        if (stopping) return;
        process.exitCode = 1;
        console.error(code);
        stop();
    }
    if (controlledWorker) {
        controlledWorker.once('error', () => failControlledImage('CONTROLLED_IMAGE_WORKER_FAILED'));
        controlledWorker.once('disconnect', () => failControlledImage('CONTROLLED_IMAGE_WORKER_DISCONNECTED'));
        controlledWorker.once('exit', () => failControlledImage('CONTROLLED_IMAGE_WORKER_EXITED'));
        nextProcess.once('error', () => failControlledImage('CONTROLLED_IMAGE_NEXT_FAILED'));
    }
    nextProcess.once('exit', (code) => {
        if (controlledImage) { failControlledImage('CONTROLLED_IMAGE_NEXT_EXITED'); return; }
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
    settlementProcess?.once('exit', (code) => {
        if (code && !stopping) {
            console.error(`LOCAL_SETTLEMENT_EXITED ${code} (unknown settlement errors require operator review)`);
            stopping = true;
            clearInterval(fixtureTimer);
            clearInterval(readyPoll);
            server.close();
            server.closeAllConnections();
            stopChildren('SIGTERM');
            process.exitCode = code;
        }
    });

    function stop() {
        if (stopping) return;
        stopping = true;
        clearInterval(fixtureTimer);
        clearInterval(readyPoll);
        clearTimeout(startupDeadline);
        server.close();
        server.closeAllConnections();
        for (const socket of upgradedSockets) socket.destroy();
        stopChildren('SIGTERM');
    }
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, stop);
    try {
        await listen(server, port, '127.0.0.1');
        if (stopping) server.close();
        else console.log(`LOCAL_ENTRY_BOUND http://127.0.0.1:${port}`);
    } catch (error) {
        stop();
        throw error;
    }
}

if (require.main === module) {
    provision().catch(() => {
        console.error('Local development startup failed. No credentials printed; created resources are retained.');
        process.exitCode = 1;
    });
}

module.exports = { DEFAULT_LOCAL_DATABASE, assertNoNextEnvironmentFiles, copySystemEnvironment, createCleanupEnvironment, createLocalSecrets, createNextEnvironment, createSettlementEnvironment, createWorkerEnvironment, databaseUrlForTarget, localAdminUrl, localAssetStorageRoot, localDatabasePlan, localExecutionOptions, controlledImageLaunch, localRoleUrl, localRolesFromOwner, prepareLocalMockRouting, validRequest };
