'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { inspect } = require('node:util');
const {
    STATUS, REASON, ENV_NAME, ENV_CREDENTIAL, ProviderConfigError, loadProviderConfig, requireProviderConfig,
} = require('../lib/server/providers/providerConfig');

const SECRET = 'synthetic-retired-environment-canary';
const retired = (config) => {
    assert.equal(config.ok, false);
    assert.equal(config.status, STATUS.NOT_CONFIGURED);
    assert.equal(config.reason, REASON.ENV_CREDENTIAL_RETIRED);
    assert.equal(config.providerName, null);
    assert.equal(Object.hasOwn(config, 'credential'), false);
};
const retiredError = (error) => {
    assert.ok(error instanceof ProviderConfigError);
    assert.equal(error.code, REASON.ENV_CREDENTIAL_RETIRED);
    assert.equal(error.cause, undefined);
    for (const value of [String(error), error.stack, JSON.stringify(error), inspect(error)]) {
        assert.ok(!value.includes(SECRET));
    }
    return true;
};

test('空配置、单边配置和完整旧配置统一返回退役状态，不再区分可用性', () => {
    for (const environment of [undefined, null, {}, { [ENV_NAME]: '   ', [ENV_CREDENTIAL]: '' },
        { [ENV_NAME]: 'muapi' }, { [ENV_CREDENTIAL]: SECRET },
        { [ENV_NAME]: 'muapi', [ENV_CREDENTIAL]: SECRET }]) {
        retired(loadProviderConfig(environment));
        assert.throws(() => requireProviderConfig(environment), retiredError);
    }
});

test('旧名称及凭据校验矩阵全部退役，合法输入也不能恢复凭据访问', () => {
    for (const patch of [{ [ENV_NAME]: 'Muapi' }, { [ENV_NAME]: 'mu' }, { [ENV_NAME]: 'muapi_prod' },
        ...[`${SECRET}\n`, ` ${SECRET}`, 'synthetic token', 'short', 'x'.repeat(513), 'CHANGEME']
            .map((value) => ({ [ENV_CREDENTIAL]: value }))]) {
        const environment = { [ENV_NAME]: 'muapi', [ENV_CREDENTIAL]: SECRET, ...patch };
        retired(loadProviderConfig(environment));
        assert.throws(() => requireProviderConfig(environment), retiredError);
    }
});

test('退役结果冻结且没有隐藏凭据，所有原序列化入口均不泄漏', () => {
    const config = loadProviderConfig({ [ENV_NAME]: 'muapi', [ENV_CREDENTIAL]: SECRET });
    retired(config);
    assert.equal(config.credential, undefined);
    assert.ok(Object.isFrozen(config));
    for (const value of [JSON.stringify(config), JSON.stringify(config.describe()), String(config), `${config}`,
        JSON.stringify(config.toJSON()), inspect(config, { showHidden: true }), JSON.stringify({ ...config })]) {
        assert.ok(!value.includes(SECRET));
        assert.ok(!value.includes('[credential len='));
    }
});

test('兼容函数不访问传入环境的任何属性或枚举入口', () => {
    let reads = 0;
    const environment = Object.defineProperties({}, {
        [ENV_NAME]: { enumerable: true, get() { reads++; throw new Error(SECRET); } },
        [ENV_CREDENTIAL]: { enumerable: true, get() { reads++; throw new Error(SECRET); } },
    });
    const source = new Proxy(environment, {
        ownKeys() { reads++; throw new Error(SECRET); },
    });
    retired(loadProviderConfig(source));
    assert.throws(() => requireProviderConfig(source), retiredError);
    assert.equal(reads, 0);
});

test('默认调用不读取 process.env credential canary，也不回退其他密钥变量', () => {
    const original = process.env;
    const previous = original[ENV_CREDENTIAL];
    original[ENV_CREDENTIAL] = SECRET;
    let credentialReads = 0;
    process.env = new Proxy(original, {
        get(target, key) {
            if (key === ENV_CREDENTIAL) { credentialReads++; throw new Error(SECRET); }
            return Reflect.get(target, key);
        },
    });
    try {
        retired(loadProviderConfig());
        assert.throws(() => requireProviderConfig(), retiredError);
        retired(loadProviderConfig({ MUAPI_KEY: SECRET, MUAPI_API_KEY: SECRET, apiKey: SECRET }));
        assert.equal(credentialReads, 0);
    } finally {
        process.env = original;
        if (previous === undefined) delete original[ENV_CREDENTIAL];
        else original[ENV_CREDENTIAL] = previous;
    }
});
