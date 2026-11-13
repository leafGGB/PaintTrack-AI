'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const { setTimeout: delay } = require('node:timers/promises');
const test = require('node:test');
const { createNextEnvironment, copySystemEnvironment } = require('../scripts/local-registration');

const root = path.resolve(__dirname, '..');
const scratchRoot = path.join(root, '.workbuddy');
const logFile = path.join(scratchRoot, 'secret-boundary-next-integration.log');
const envNames = ['.env.development.local', '.env.local', '.env.development', '.env'];

function insideRoot(file) {
    const relative = path.relative(fs.realpathSync(root), fs.realpathSync(file));
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), '依赖与临时目录必须位于项目内');
}

async function freePort() {
    const server = net.createServer();
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    return port;
}

function request(port) {
    return new Promise((resolve, reject) => {
        const req = http.get({ hostname: '127.0.0.1', port, path: '/probe', agent: false }, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, body }));
            res.on('error', reject);
        });
        req.setTimeout(10000, () => req.destroy(new Error('本地请求超时')));
        req.on('error', reject);
    });
}

async function stopTree(child, closed, note) {
    if (child.exitCode === null && child.signalCode === null && child.pid) {
        note(`停止本次创建的 Next 子进程树 PID=${child.pid}`);
        if (process.platform === 'win32') {
            const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
                cwd: root, env: copySystemEnvironment(process.env), windowsHide: true,
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            let output = '';
            killer.stdout.on('data', (chunk) => { output += chunk; });
            killer.stderr.on('data', (chunk) => { output += chunk; });
            await new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('精确终止子进程树超时')), 15000);
                killer.once('error', (error) => { clearTimeout(timer); reject(error); });
                killer.once('close', (code) => {
                    clearTimeout(timer);
                    note(`taskkill exit=${code}\n${output.trim()}`);
                    if (code !== 0 && child.exitCode === null && child.signalCode === null) {
                        reject(new Error('本次 Next 子进程树终止失败'));
                    } else resolve();
                });
            });
        } else {
            process.kill(-child.pid, 'SIGKILL');
        }
    }
    let timer;
    try {
        await Promise.race([closed, new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('Next 子进程管道关闭超时')), 15000);
        })]);
    } finally { clearTimeout(timer); }
}

test('真实 Next CLI 在环境文件创建及变更触发 watcher 重编译后仍隔离合成 canary', { timeout: 180000 }, async (t) => {
    assert.equal(process.cwd(), root, '请从嵌套项目根运行测试');
    assert.ok(fs.statSync(scratchRoot).isDirectory());
    const directory = fs.mkdtempSync(path.join(scratchRoot, 'next-env-integration-'));
    insideRoot(directory);
    const run = path.basename(directory);
    const note = (message) => fs.appendFileSync(logFile, `[${new Date().toISOString()}] [${run}] ${message}\n`);
    const evidenceFile = path.join(directory, 'evidence.jsonl');
    const cli = require.resolve('next/dist/bin/next');
    const nextRequire = createRequire(cli);
    const modules = path.join(root, 'node_modules');
    for (const file of [cli, modules, nextRequire.resolve('@next/env')]) insideRoot(file);
    // 本地原生 SWC 缺失就失败，避免 Next 尝试下载编译器。
    const swc = require.resolve(`@next/swc-${process.platform}-${process.arch}-${process.platform === 'win32' ? 'msvc' : process.platform === 'darwin' ? '' : 'gnu'}`.replace(/-$/, ''));
    insideRoot(swc);
    const token = crypto.randomBytes(12).toString('hex').toUpperCase();
    const keys = envNames.flatMap((_, index) => [
        `PT_SYNTHETIC_${token}_${index}`, `NEXT_PUBLIC_PT_SYNTHETIC_${token}_${index}`,
    ]);
    const canaries = [];
    const writeEnv = (indexes, phase, create) => {
        for (const index of indexes) {
            const lines = keys.slice(index * 2, index * 2 + 2).map((key) => {
                const value = `synthetic_canary_${crypto.randomBytes(24).toString('hex')}`;
                canaries.push(value);
                return `${key}=${value}`;
            });
            fs.writeFileSync(path.join(directory, envNames[index]), `${lines.join('\n')}\n`, { flag: create ? 'wx' : 'w' });
        }
        note(`${phase}：${indexes.map((index) => envNames[index]).join(', ')}（仅合成数据）`);
    };
    const writeNew = (name, content) => fs.writeFileSync(path.join(directory, name), content, { flag: 'wx' });
    const evidence = () => fs.existsSync(evidenceFile)
        ? fs.readFileSync(evidenceFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
    fs.mkdirSync(path.join(directory, 'app', 'probe'), { recursive: true });
    fs.symlinkSync(modules, path.join(directory, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal(fs.realpathSync(path.join(directory, 'node_modules')), fs.realpathSync(modules));
    writeNew('package.json', JSON.stringify({ name: run, private: true, dependencies: {
        next: require('next/package.json').version,
        react: require('react/package.json').version,
        'react-dom': require('react-dom/package.json').version,
    } }));
    writeNew('postcss.config.json', '{"plugins":{}}\n');
    writeNew('app/layout.js', 'export default function Layout({ children }) { return <html><body>{children}</body></html>; }\n');
    writeNew('app/probe/route.js', `export const dynamic = 'force-dynamic';
export function GET() {
    const keys = ${JSON.stringify(keys)};
    const inlined = [${keys.map((key) => `typeof process.env.${key} !== 'undefined'`).join(', ')}];
    const visible = inlined.some(Boolean) || keys.some((key) => Object.prototype.hasOwnProperty.call(process.env, key));
    return Response.json({ canaryPresent: visible }, { headers: { 'Cache-Control': 'no-store' } });
}\n`);
    writeNew('next.config.js', `const fs = require('node:fs');
const record = (event) => fs.appendFileSync(${JSON.stringify(evidenceFile)}, JSON.stringify({ ...event, pid: process.pid, time: Date.now() }) + '\\n');
module.exports = {
    distDir: '.next', outputFileTracingRoot: __dirname, devIndicators: false,
    webpack(config, { isServer, nextRuntime }) {
        config.plugins.push({ apply(compiler) {
            compiler.hooks.done.tap('SyntheticBoundaryEvidence', (stats) => {
                record({ kind: 'compiled', server: isServer, runtime: nextRuntime || 'client', errors: stats.hasErrors(), hash: stats.hash });
            });
        } });
        return config;
    },
};\n`);
    // 仅观察真实 loader 调用并阻断外连，不修改 loader 返回值或 watcher 行为。
    writeNew('observe-and-block-network.cjs', `const fs = require('node:fs');
const net = require('node:net');
const record = (event) => fs.appendFileSync(${JSON.stringify(evidenceFile)}, JSON.stringify({ ...event, pid: process.pid, time: Date.now() }) + '\\n');
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
    const options = net._normalizeArgs(args)[0];
    const local = options.path || ['127.0.0.1', '::1', 'localhost'].includes(options.host || 'localhost');
    if (!local) {
        record({ kind: 'network-blocked' });
        throw new Error('集成测试禁止非 loopback 网络');
    }
    return connect.apply(this, args);
};
const env = require(${JSON.stringify(nextRequire.resolve('@next/env'))});
const load = env.loadEnvConfig;
env.loadEnvConfig = function (...args) {
    const watcher = args[3] === true && new Error().stack.includes('setup-dev-bundler');
    const result = load.apply(this, args);
    if (watcher) record({ kind: 'watcher-reload', empty: result.loadedEnvFiles.length === 0 });
    return result;
};\n`);
    writeEnv([0, 3], '启动前创建', true);
    writeEnv([0, 3], '启动前变更', false);
    const port = await freePort();
    const environment = createNextEnvironment({
        runtimeUrl: 'synthetic-unused', internalPort: port, origin: `http://127.0.0.1:${port}`,
        secret: 'synthetic-unused', mfaEncryptionKey: 'synthetic-unused', suffix: run, heapMb: 3072,
    });
    environment.NEXT_TELEMETRY_DISABLED = '1';
    environment.NEXT_DISABLE_SWC_WASM = '1';
    environment.NODE_OPTIONS += ` --import ${JSON.stringify(pathToFileURL(path.join(directory, 'observe-and-block-network.cjs')).href)}`;
    keys.forEach((key) => assert.equal(environment[key], undefined));
    note(`开始 Next=${require('next/package.json').version} Node=${process.version} fixture=${directory} host=127.0.0.1 port=${port} telemetry=disabled`);
    const child = spawn(process.execPath, [cli, 'dev', directory, '--hostname', '127.0.0.1', '--port', String(port)], {
        cwd: directory, env: environment, windowsHide: true, detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let spawnError;
    let exited = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => { spawnError = error; });
    const closed = new Promise((resolve) => child.once('close', (code, signal) => {
        exited = true;
        note(`Next close code=${code} signal=${signal}`);
        resolve();
    }));
    const deadline = Date.now() + 130000;
    const until = async (label, check, timeout = 35000) => {
        const end = Math.min(deadline, Date.now() + timeout);
        while (Date.now() < end && !t.signal.aborted) {
            assert.ifError(spawnError);
            assert.equal(exited, false, `Next 在${label}前提前退出；见日志`);
            const result = await check();
            if (result) return result;
            await delay(150, undefined, { signal: t.signal });
        }
        throw new Error(`${label}超时；未完成验收`);
    };
    const checkResponse = async (phase) => {
        const response = await request(port);
        assert.equal(response.status, 200, `${phase}必须返回 HTTP 200`);
        // 精确比较，防止测试路由意外输出环境变量或其他敏感信息。
        assert.deepEqual(JSON.parse(response.body), { canaryPresent: false });
        assert.equal(response.body.includes('synthetic_canary_'), false);
        note(`${phase}：HTTP ${response.status} ${response.body}`);
    };
    try {
        note(`Next CLI PID=${child.pid}`);
        await until('Next Ready', () => /Ready in/.test(stdout), 60000);
        note('真实 Next CLI Ready 已确认');
        await checkResponse('启动后');
        for (const [phase, indexes, create] of [
            ['运行中创建', [1, 2], true],
            ['运行中变更', [0, 1, 2, 3], false],
        ]) {
            const offset = evidence().length;
            writeEnv(indexes, phase, create);
            await until(`${phase}的真实 watcher 与重编译`, () => {
                const records = evidence().slice(offset);
                const reloadIndex = records.findIndex((entry) => entry.kind === 'watcher-reload' && entry.empty);
                if (reloadIndex < 0) return false;
                return records.slice(reloadIndex + 1).some((entry) => entry.kind === 'compiled' && entry.server && !entry.errors);
            });
            const records = evidence().slice(offset);
            note(`${phase}真实证据：${JSON.stringify(records)}`);
            await checkResponse(`${phase}并完成 watcher 重编译后`);
        }
        assert.equal(exited, false);
    } catch (error) {
        note(`未验收：${error.message}`);
        throw error;
    } finally {
        try {
            await stopTree(child, closed, note);
            await assert.rejects(request(port), '清理后本次 Next 端口必须不可访问');
            note('本次 Next 子进程树已退出且 loopback 端口关闭');
        } finally {
            note(`Next stdout 开始\n${stdout}\nNext stdout 结束`);
            note(`Next stderr 开始\n${stderr}\nNext stderr 结束`);
            for (const value of canaries) {
                assert.equal(stdout.includes(value), false, 'stdout 泄露合成 canary');
                assert.equal(stderr.includes(value), false, 'stderr 泄露合成 canary');
            }
            for (const key of keys) {
                assert.equal(stdout.includes(key), false, 'stdout 泄露合成 canary 名称');
                assert.equal(stderr.includes(key), false, 'stderr 泄露合成 canary 名称');
            }
            note(`stdout/stderr 检查通过：${canaries.length} 个合成值与 ${keys.length} 个合成键均未出现；保留随机目录`);
        }
    }
    note(`验收通过；网络阻断事件=${evidence().filter((entry) => entry.kind === 'network-blocked').length}`);
    t.diagnostic(`真实 Next 集成验收通过；证据日志 ${logFile}；临时目录 ${directory}`);
});
