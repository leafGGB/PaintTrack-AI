'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync, fork } = require('node:child_process');
const { createRequire } = require('node:module');
const { createNextEnvironment } = require('../scripts/local-registration');

const root = path.resolve(__dirname, '..');
const scratchRoot = path.join(root, '.workbuddy');
const nextRequire = createRequire(require.resolve('next/dist/bin/next'));
const envPath = nextRequire.resolve('@next/env');
const preloadPath = path.join(root, 'scripts/local-next-env-preload.cjs').replace(/\\/g, '/');
const envNames = ['.env.development.local', '.env.local', '.env.development', '.env'];
const keys = envNames.map((_, index) => `PAINTTRACK_SYNTHETIC_ENV_${index}`);

function writeSyntheticFiles(directory, value) {
    envNames.forEach((name, index) => {
        fs.writeFileSync(path.join(directory, name), `${keys[index]}=${value}_${index}\n`);
    });
}

async function probe(mode, directory) {
    assert.equal(path.dirname(directory), scratchRoot);
    assert.equal(process.cwd(), directory);
    const reads = [];
    const readFileSync = fs.readFileSync;
    fs.readFileSync = function (file, ...args) {
        const filename = String(file);
        if (path.basename(filename).startsWith('.env')) {
            assert.equal(path.dirname(path.resolve(filename)), directory, '只允许读取合成环境目录');
            reads.push(path.basename(filename));
        }
        return readFileSync.call(this, file, ...args);
    };
    const env = require(envPath);

    if (mode === 'control' || mode === 'protected' || mode === 'fork-child') {
        const protectedMode = mode !== 'control';
        let reloads = 0;
        const load = (forceReload = false) => {
            const result = env.loadEnvConfig(directory, true, console, forceReload, () => { reloads += 1; });
            assert.equal(result.combinedEnv, process.env);
            if (protectedMode) {
                assert.deepEqual(result.parsedEnv, {});
                assert.deepEqual(result.loadedEnvFiles, []);
                keys.forEach((key) => assert.equal(process.env[key], undefined));
                assert.equal(reads.length, 0);
                assert.equal(reloads, 0);
            }
            return result;
        };
        const first = load();
        if (!protectedMode) {
            assert.equal(first.loadedEnvFiles.length, 4);
            keys.forEach((key, index) => assert.equal(process.env[key], `first_${index}`));
        }
        writeSyntheticFiles(directory, 'changed');
        load();
        if (!protectedMode) keys.forEach((key, index) => assert.equal(process.env[key], `first_${index}`));
        const reloaded = load(true);
        if (!protectedMode) {
            keys.forEach((key, index) => assert.equal(process.env[key], `changed_${index}`));
            assert.equal(reloaded.loadedEnvFiles.length, 4);
            assert.equal(reads.length, 8);
        } else {
            env.loadEnvConfig(path.join(directory, 'does-not-exist'), true, console, true);
            assert.equal(reads.length, 0);
        }
        return { mode, reads: reads.length };
    }

    if (mode === 'snapshot-control' || mode === 'snapshot-protected') {
        assert.equal(env.initialEnv, undefined);
        env.updateInitialEnv({ PAINTTRACK_SNAPSHOT_EARLY: 'ignored' });
        env.resetEnv();
        assert.equal(env.initialEnv, undefined);
        process.env.PAINTTRACK_SNAPSHOT_BASE = 'initial';
        process.env.PAINTTRACK_SNAPSHOT_EMPTY = '';
        env.loadEnvConfig(directory, true);
        const initial = env.initialEnv;
        assert.notEqual(initial, process.env);
        assert.equal(initial.PAINTTRACK_SNAPSHOT_EARLY, undefined);
        process.env.PAINTTRACK_SNAPSHOT_BASE = 'temporary';
        process.env.PAINTTRACK_SNAPSHOT_ADDED = 'temporary';
        process.env.__NEXT_PRIVATE_SYNTHETIC = 'preserved';
        env.loadEnvConfig(directory, true);
        assert.equal(process.env.PAINTTRACK_SNAPSHOT_BASE, 'temporary');
        env.updateInitialEnv({ PAINTTRACK_SNAPSHOT_BASE: 'updated', PAINTTRACK_SNAPSHOT_NEW: 'configured' });
        assert.equal(env.initialEnv, initial);
        assert.equal(process.env.PAINTTRACK_SNAPSHOT_BASE, 'temporary');
        assert.equal(process.env.PAINTTRACK_SNAPSHOT_NEW, undefined);
        env.resetEnv();
        assert.equal(process.env.PAINTTRACK_SNAPSHOT_BASE, 'updated');
        assert.equal(process.env.PAINTTRACK_SNAPSHOT_NEW, 'configured');
        assert.equal(process.env.PAINTTRACK_SNAPSHOT_ADDED, undefined);
        assert.equal(process.env.PAINTTRACK_SNAPSHOT_EMPTY, '');
        assert.equal(process.env.__NEXT_PRIVATE_SYNTHETIC, 'preserved');
        process.env.PAINTTRACK_SNAPSHOT_BASE = 'temporary-again';
        env.loadEnvConfig(directory, true, console, true);
        assert.equal(process.env.PAINTTRACK_SNAPSHOT_BASE, 'updated');
        assert.equal(env.processEnv([]).length, 1);
        const forced = env.processEnv([], directory, console, true);
        assert.equal(forced[0], process.env);
        assert.deepEqual(forced[1], {});
        assert.equal(process.env.__NEXT_PROCESSED_ENV, 'true');
        assert.equal(reads.length, 0);
        return { snapshot: 'compatible' };
    }

    if (mode === 'reject-input') {
        assert.equal(env.initialEnv, undefined);
        const files = [{ path: '.env', contents: 'PAINTTRACK_SYNTHETIC_FORBIDDEN=blocked', env: {} }];
        for (const forceReload of [false, true]) {
            process.env.__NEXT_PROCESSED_ENV = 'true';
            assert.throws(() => env.processEnv(files, directory, console, forceReload), /refuses environment file input/);
            assert.equal(env.initialEnv, undefined);
            assert.equal(process.env.PAINTTRACK_SYNTHETIC_FORBIDDEN, undefined);
            assert.deepEqual(files[0].env, {});
        }
        assert.throws(() => env.processEnv(null), /refuses environment file input/);
        const empty = env.processEnv([]);
        assert.equal(empty[0], process.env);
        assert.equal(empty.length, 1);
        assert.ok(env.initialEnv);
        return { rejected: true, reads: reads.length };
    }

    if (mode === 'fork') {
        env.loadEnvConfig(directory, true);
        assert.ok(env.initialEnv.NODE_OPTIONS.includes(preloadPath));
        const { getParsedNodeOptionsWithoutInspect, formatNodeOptions } = require('next/dist/server/lib/utils');
        const parsed = getParsedNodeOptionsWithoutInspect();
        assert.equal(parsed.require, preloadPath);
        const formatted = formatNodeOptions(parsed);
        const runFork = (options) => new Promise((resolve, reject) => {
            const child = fork(__filename, ['--probe', 'fork-child', directory], {
                cwd: directory, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'], ...options,
            });
            let message;
            let stderr = '';
            child.stderr.on('data', (chunk) => { stderr += chunk; });
            child.on('message', (value) => { message = value; });
            child.on('error', reject);
            child.on('close', (code) => {
                try {
                    assert.equal(code, 0, stderr);
                    assert.deepEqual(message, { mode: 'fork-child', reads: 0 });
                    resolve(message);
                } catch (error) { reject(error); }
            });
        });
        const inherited = await runFork({});
        writeSyntheticFiles(directory, 'first');
        const formattedChild = await runFork({ env: { ...env.initialEnv, NODE_OPTIONS: formatted } });
        return { inherited, formattedChild };
    }
    throw new Error(`未知测试模式：${mode}`);
}

if (process.argv[2] === '--probe') {
    probe(process.argv[3], process.argv[4]).then((result) => {
        if (process.send) process.send(result, () => process.disconnect());
        else console.log(JSON.stringify(result));
    }).catch((error) => { console.error(error); process.exitCode = 1; });
} else {
    const test = require('node:test');
    const options = {
        runtimeUrl: 'synthetic-unused', internalPort: 3001, origin: 'http://127.0.0.1:3000',
        secret: 'synthetic-unused', mfaEncryptionKey: 'synthetic-unused', suffix: 'env-test', heapMb: 3072,
    };
    const environment = () => createNextEnvironment(options, process.env);
    const fixture = (files = false) => {
        assert.ok(fs.statSync(scratchRoot).isDirectory());
        const directory = fs.mkdtempSync(path.join(scratchRoot, 'local-next-env-test-'));
        if (files) writeSyntheticFiles(directory, 'first');
        return directory;
    };
    const run = (mode, directory, env = environment()) => {
        const result = spawnSync(process.execPath, [__filename, '--probe', mode, directory], {
            cwd: directory, env, encoding: 'utf8', timeout: 20000,
        });
        assert.ifError(result.error);
        assert.equal(result.status, 0, result.stderr);
        return JSON.parse(result.stdout);
    };

    test('真实 @next/env 对照组能够首次加载及强制回载四类合成环境文件', () => {
        const env = environment();
        delete env.NODE_OPTIONS;
        assert.deepEqual(run('control', fixture(true), env), { mode: 'control', reads: 8 });
    });

    test('可信 preload 在首次加载及文件变更后的 forceReload 均不读取环境文件', () => {
        assert.deepEqual(run('protected', fixture(true)), { mode: 'protected', reads: 0 });
    });

    test('preload 的快照更新、缓存与重置语义匹配真实 @next/env', () => {
        const env = environment();
        delete env.NODE_OPTIONS;
        const expected = run('snapshot-control', fixture(), env);
        assert.deepEqual(run('snapshot-protected', fixture()), expected);
    });

    test('preload 拒绝非空 processEnv 输入且不产生解析副作用', () => {
        assert.deepEqual(run('reject-input', fixture()), { rejected: true, reads: 0 });
    });

    test('fork 默认继承及 Next 实际 NODE_OPTIONS 格式化链路保留带空格 preload 路径', () => {
        assert.match(preloadPath, / /);
        const result = run('fork', fixture(true));
        assert.equal(result.inherited.reads, 0);
        assert.equal(result.formattedChild.reads, 0);
    });

    test('preload 缺失或 exports 安装失败时拒绝启动主脚本', () => {
        const directory = fixture();
        const blocker = path.join(directory, 'block-install.cjs');
        fs.writeFileSync(blocker, `
            const resolved = ${JSON.stringify(envPath)};
            require(resolved);
            Object.defineProperty(require.cache[resolved], 'exports', { writable: false });
        `);
        const normalize = (file) => JSON.stringify(file.replace(/\\/g, '/'));
        for (const nodeOptions of [
            `--require ${normalize(path.join(directory, 'missing-preload.cjs'))}`,
            `--require ${normalize(blocker)} --require ${normalize(preloadPath)}`,
        ]) {
            const result = spawnSync(process.execPath, ['-e', 'console.log("MAIN_EXECUTED")'], {
                cwd: directory, env: { ...environment(), NODE_OPTIONS: nodeOptions }, encoding: 'utf8', timeout: 20000,
            });
            assert.ifError(result.error);
            assert.notEqual(result.status, 0);
            assert.equal(result.stdout.includes('MAIN_EXECUTED'), false);
            assert.match(result.stderr, /Cannot find module|Cannot assign to read only property/);
        }
    });
}
