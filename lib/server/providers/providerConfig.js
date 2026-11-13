'use strict';

// 旧同步环境凭据入口仅保留兼容导出，不再读取环境或返回凭据。
const STATUS = Object.freeze({
    CONFIGURED: 'configured',
    NOT_CONFIGURED: 'not_configured',
    INCOMPLETE: 'incomplete',
    INVALID: 'invalid',
});

const REASON = Object.freeze({
    NOT_CONFIGURED: 'PROVIDER_NOT_CONFIGURED',
    INCOMPLETE: 'PROVIDER_CONFIG_INCOMPLETE',
    INVALID: 'PROVIDER_CONFIG_INVALID',
    ENV_CREDENTIAL_RETIRED: 'PROVIDER_ENV_CREDENTIAL_RETIRED',
});

const ENV_NAME = 'PAINTTRACK_PROVIDER_NAME';
const ENV_CREDENTIAL = 'PAINTTRACK_PROVIDER_CREDENTIAL';

class ProviderConfigError extends Error {
    constructor(reason, message) {
        super(message);
        this.name = 'ProviderConfigError';
        this.code = reason;
    }
}

function unavailableResult(status, reason, detail) {
    return Object.freeze({
        status,
        ok: false,
        providerName: null,
        reason,
        detail,
        describe() {
            return { ok: false, status, providerName: null, reason, detail };
        },
        toJSON() {
            return { ok: false, status, providerName: null, reason, detail };
        },
        toString() {
            return `[provider config: ${reason}]`;
        },
    });
}

function loadProviderConfig() {
    return unavailableResult(STATUS.NOT_CONFIGURED, REASON.ENV_CREDENTIAL_RETIRED, '同步环境凭据读取已退役');
}

function requireProviderConfig() {
    const config = loadProviderConfig();
    throw new ProviderConfigError(config.reason, `Provider 不可用：${config.reason}`);
}

module.exports = {
    STATUS,
    REASON,
    ENV_NAME,
    ENV_CREDENTIAL,
    ProviderConfigError,
    loadProviderConfig,
    requireProviderConfig,
};
