'use strict';

const { createRequire } = require('node:module');

// 使用 Next CLI 实际解析到的依赖；任何解析、安装错误均终止启动。
const nextRequire = createRequire(require.resolve('next/dist/bin/next'));
const envPath = nextRequire.resolve('@next/env');
nextRequire(envPath);
const envModule = require.cache[envPath];
let initialEnv;
let loaded = false;

function captureInitialEnv() {
    if (!initialEnv) initialEnv = { ...process.env };
}

function resetEnv() {
    if (!initialEnv) return;
    for (const key of Object.keys(process.env)) {
        if (!key.startsWith('__NEXT_PRIVATE') && (initialEnv[key] === undefined || initialEnv[key] === '')) {
            delete process.env[key];
        }
    }
    for (const [key, value] of Object.entries(initialEnv)) process.env[key] = value;
}

const facade = {
    get initialEnv() { return initialEnv; },
    updateInitialEnv(newEnv) { Object.assign(initialEnv || {}, newEnv); },
    resetEnv,
    processEnv(loadedEnvFiles, dir, log, forceReload = false) {
        if (!Array.isArray(loadedEnvFiles) || loadedEnvFiles.length !== 0) {
            throw new Error('Local Next environment preload refuses environment file input');
        }
        captureInitialEnv();
        if (!forceReload) return [process.env];
        process.env.__NEXT_PROCESSED_ENV = 'true';
        return [process.env, {}];
    },
    loadEnvConfig(dir, dev, log, forceReload = false) {
        captureInitialEnv();
        if (!loaded || forceReload) {
            resetEnv();
            facade.processEnv([], dir, log, forceReload);
        }
        loaded = true;
        return { combinedEnv: process.env, parsedEnv: {}, loadedEnvFiles: [] };
    },
};

// 原模块通过不可写 getter 暴露 API，因此替换整个 exports，绝不调用原 loader。
if (!envModule) throw new Error('Local Next environment preload cannot find the resolved module cache');
envModule.exports = facade;
if (nextRequire(envPath) !== facade) throw new Error('Local Next environment preload installation failed');
