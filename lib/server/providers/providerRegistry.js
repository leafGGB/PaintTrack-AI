'use strict';

// 阶段 5.3：Worker 进程的 Provider 选择。
// 只允许显式配置；未配置或未知模式一律 fail-closed，让 Worker 拒绝启动，
// 而不是先领取任务再因为"不会调用"把用户任务烧成失败。
const { createMockProvider } = require('./mockProvider');
const { createMyVignaImageProvider } = require('./myvignaImageProvider');

const ENV_MODE = 'PAINTTRACK_WORKER_PROVIDER';
const ENV_BASE_URL = 'PAINTTRACK_PROVIDER_BASE_URL';
const ENV_UPSTREAM_MODEL = 'PAINTTRACK_PROVIDER_MODEL';

const MODE = Object.freeze({
    NONE: 'none',
    MOCK: 'mock',
    MYVIGNA_IMAGE: 'myvigna-image',
});

class ProviderUnavailableError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'ProviderUnavailableError';
        this.code = code;
    }
}

function resolveWorkerProvider({ env = process.env, mockProviderFactory = createMockProvider } = {}) {
    const raw = env ? env[ENV_MODE] : undefined;
    const mode = typeof raw === 'string' && raw.trim() !== '' ? raw.trim().toLowerCase() : MODE.NONE;

    if (mode === MODE.NONE) {
        throw new ProviderUnavailableError(
            'PROVIDER_NOT_CONFIGURED',
            `${ENV_MODE} 未设置；Worker 不会启动，任务保持在队列中`,
        );
    }
    if (mode === MODE.MOCK) {
        // mock 只返回占位结果，不能在生产环境冒充真实生成能力。
        if (env && env.NODE_ENV === 'production') {
            throw new ProviderUnavailableError(
                'PROVIDER_MODE_FORBIDDEN',
                `${ENV_MODE}=mock 禁止在生产环境使用：mock 只会产出占位结果`,
            );
        }
        return mockProviderFactory();
    }
    if (mode === MODE.MYVIGNA_IMAGE) {
        throw new ProviderUnavailableError(
            'PROVIDER_ENV_CREDENTIAL_RETIRED',
            '同步环境凭据 Provider 路径已退役；请使用可信宿主和显式 secretResolver',
        );
    }
    throw new ProviderUnavailableError(
        'PROVIDER_MODE_UNSUPPORTED',
        '同步 Provider 选择仅支持非生产 mock；真实 Provider 需要可信宿主和显式 secretResolver',
    );
}

// 真实 Provider 仅通过可信宿主的显式绑定与 resolver 构造。
// approvedBindings 和 secretResolver 不得来自任务或客户端 payload。
async function resolveWorkerProviderWithSecrets({ descriptor, approvedBindings, secretResolver,
    adapterFactory = createMyVignaImageProvider } = {}) {
    const reject = (code) => new ProviderUnavailableError(code, code);
    const fields = ['providerInstanceId', 'credentialRef', 'credentialVersion', 'adapterType', 'baseUrl', 'upstreamModel'];
    const valid = (value) => value && Object.getPrototypeOf(value) === Object.prototype
        && Object.keys(value).sort().join(',') === [...fields].sort().join(',')
        && ['providerInstanceId', 'credentialRef'].every((field) => typeof value[field] === 'string'
            && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value[field]))
        && Number.isSafeInteger(value.credentialVersion) && value.credentialVersion > 0
        && value.adapterType === MODE.MYVIGNA_IMAGE && value.upstreamModel === 'gpt-image-2'
        && typeof value.baseUrl === 'string';
    if (!valid(descriptor) || !Array.isArray(approvedBindings) || !approvedBindings.every(valid)) {
        throw reject('PROVIDER_CONFIG_INVALID');
    }
    // Copy before awaiting: later caller mutations cannot redirect a resolved credential.
    const binding = Object.freeze({ ...descriptor });
    try {
        const url = new URL(binding.baseUrl);
        if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
            || (url.port && url.port !== '443') || url.pathname !== '/v1') throw new Error();
    } catch { throw reject('PROVIDER_CONFIG_INVALID'); }
    if (!approvedBindings.some((approved) => fields.every((field) => approved[field] === binding[field]))) {
        throw reject('PROVIDER_BINDING_DENIED');
    }
    if (typeof secretResolver !== 'function') throw reject('PROVIDER_SECRET_RESOLVER_REQUIRED');
    if (typeof adapterFactory !== 'function') throw reject('PROVIDER_CONFIG_INVALID');
    let credential;
    try {
        credential = await secretResolver(Object.freeze({ providerInstanceId: binding.providerInstanceId,
            credentialRef: binding.credentialRef, credentialVersion: binding.credentialVersion }));
    } catch { throw reject('PROVIDER_SECRET_UNAVAILABLE'); }
    if (typeof credential !== 'string' || !credential.trim() || credential.length > 4096
        || /[\r\n\x00]/.test(credential)) throw reject('PROVIDER_SECRET_INVALID');
    try {
        return adapterFactory({ credential, baseUrl: binding.baseUrl, upstreamModel: binding.upstreamModel });
    } catch { throw reject('PROVIDER_CONFIG_INVALID'); }
}

module.exports = {
    resolveWorkerProviderWithSecrets,
    ENV_MODE,
    MODE,
    ENV_BASE_URL,
    ENV_UPSTREAM_MODEL,
    ProviderUnavailableError,
    resolveWorkerProvider,
};
