const test = require('node:test');
const assert = require('node:assert/strict');
const {
    ENV_MODE,
    ProviderUnavailableError,
    resolveWorkerProvider,
} = require('../lib/server/providers/providerRegistry');

const { inspect } = require('node:util');
const SECRET = 'synthetic-legacy-registry-env-canary';
const safeRetiredError = (error, ErrorClass = ProviderUnavailableError) => {
    assert.ok(error instanceof ErrorClass);
    assert.equal(error.code, 'PROVIDER_ENV_CREDENTIAL_RETIRED');
    assert.equal(error.cause, undefined);
    for (const value of [String(error), error.stack, JSON.stringify(error), inspect(error)]) {
        assert.ok(!value.includes(SECRET));
    }
    return true;
};

const errorCode = (env) => {
    try {
        resolveWorkerProvider({ env });
    } catch (error) {
        assert.ok(error instanceof ProviderUnavailableError);
        return error.code;
    }
    return null;
};

test('an unset or blank provider mode fails closed instead of starting the worker', () => {
    assert.equal(errorCode({}), 'PROVIDER_NOT_CONFIGURED');
    assert.equal(errorCode({ [ENV_MODE]: '' }), 'PROVIDER_NOT_CONFIGURED');
    assert.equal(errorCode({ [ENV_MODE]: '   ' }), 'PROVIDER_NOT_CONFIGURED');
});

test('unsupported modes are rejected rather than silently falling back', () => {
    assert.equal(errorCode({ [ENV_MODE]: 'muapi' }), 'PROVIDER_MODE_UNSUPPORTED');
    assert.equal(errorCode({ [ENV_MODE]: 'none ' }), 'PROVIDER_NOT_CONFIGURED');
});

test('mock is refused in production because it only produces placeholder results', () => {
    assert.equal(errorCode({ [ENV_MODE]: 'mock', NODE_ENV: 'production' }), 'PROVIDER_MODE_FORBIDDEN');
});

test('mock resolves to a provider with the full submit/query contract outside production', () => {
    const provider = resolveWorkerProvider({ env: { [ENV_MODE]: 'MoCk', NODE_ENV: 'test' } });
    assert.equal(provider.name, 'mock-provider');
    assert.equal(typeof provider.version, 'string');
    for (const method of ['submit', 'query', 'cancel']) {
        assert.equal(typeof provider[method], 'function');
    }
    assert.deepEqual(provider.capabilities.operations, { submit: true, query: true, cancel: true });
});

test('the provider factory is injectable so tests never depend on the env', () => {
    const marker = { name: 'stub-provider' };
    assert.equal(resolveWorkerProvider({
        env: { [ENV_MODE]: 'mock', NODE_ENV: 'test' },
        mockProviderFactory: () => marker,
    }), marker);
});

// 临时替换 Adapter 模块导出并重新加载 registry，监测真实默认工厂引用。
function observeConstructions(run) {
    const adapter = require('../lib/server/providers/myvignaImageProvider');
    const filename = require.resolve('../lib/server/providers/providerRegistry');
    const cached = require.cache[filename];
    const original = adapter.createMyVignaImageProvider;
    let constructions = 0;
    adapter.createMyVignaImageProvider = () => { constructions++; throw new Error(SECRET); };
    delete require.cache[filename];
    try {
        const registry = require(filename);
        run(registry.resolveWorkerProvider, registry.ProviderUnavailableError);
        assert.equal(constructions, 0);
    } finally {
        adapter.createMyVignaImageProvider = original;
        require.cache[filename] = cached;
    }
}

test('旧同步真实模式在读取环境 credential、目标及构造任何 Provider 前固定退役', () => {
    let reads = 0;
    let mocks = 0;
    const env = { [ENV_MODE]: ' MyVigna-Image ' };
    for (const key of ['PAINTTRACK_PROVIDER_NAME', 'PAINTTRACK_PROVIDER_CREDENTIAL',
        'PAINTTRACK_PROVIDER_BASE_URL', 'PAINTTRACK_PROVIDER_MODEL', 'NODE_ENV']) {
        Object.defineProperty(env, key, { enumerable: true, get() { reads++; throw new Error(SECRET); } });
    }
    observeConstructions((resolve, ErrorClass) => {
        const checkError = (error) => safeRetiredError(error, ErrorClass);
        assert.throws(() => resolve({ env, mockProviderFactory: () => { mocks++; } }), checkError);
        for (const value of [undefined, '', 'short', SECRET]) {
            assert.throws(() => resolve({ env: { [ENV_MODE]: 'myvigna-image',
                PAINTTRACK_PROVIDER_NAME: 'myvigna-image', PAINTTRACK_PROVIDER_CREDENTIAL: value,
                PAINTTRACK_PROVIDER_BASE_URL: 'https://provider.example.test/v1',
                PAINTTRACK_PROVIDER_MODEL: 'gpt-image-2', NODE_ENV: 'production' } }), checkError);
        }
    });
    assert.equal(reads, 0);
    assert.equal(mocks, 0);
});

test('默认旧 API 忽略 process.env canary，所有模式均不读取环境凭据或泄漏未知模式', () => {
    const original = process.env;
    const keys = [ENV_MODE, 'PAINTTRACK_PROVIDER_NAME', 'PAINTTRACK_PROVIDER_CREDENTIAL'];
    const previous = keys.map((key) => original[key]);
    original.PAINTTRACK_PROVIDER_NAME = 'myvigna-image';
    original.PAINTTRACK_PROVIDER_CREDENTIAL = SECRET;
    let reads = 0;
    process.env = new Proxy(original, {
        get(target, key) {
            if (key === 'PAINTTRACK_PROVIDER_CREDENTIAL') { reads++; throw new Error(SECRET); }
            return Reflect.get(target, key);
        },
    });
    try {
        observeConstructions((resolve) => {
            for (const mode of ['', 'none', 'myvigna-image', SECRET]) {
                original[ENV_MODE] = mode;
                assert.throws(() => resolve(), (error) => {
                    const code = mode === 'myvigna-image' ? 'PROVIDER_ENV_CREDENTIAL_RETIRED'
                        : mode === SECRET ? 'PROVIDER_MODE_UNSUPPORTED' : 'PROVIDER_NOT_CONFIGURED';
                    assert.equal(error.code, code);
                    for (const value of [String(error), error.stack, JSON.stringify(error), inspect(error)]) {
                        assert.ok(!value.includes(SECRET));
                    }
                    return true;
                });
            }
            original[ENV_MODE] = 'mock';
            assert.equal(resolve({ env: { [ENV_MODE]: 'mock', NODE_ENV: 'test',
                get PAINTTRACK_PROVIDER_CREDENTIAL() { reads++; throw new Error(SECRET); } } }).name, 'mock-provider');
        });
        assert.equal(reads, 0);
    } finally {
        process.env = original;
        keys.forEach((key, index) => {
            if (previous[index] === undefined) delete original[key];
            else original[key] = previous[index];
        });
    }
});
