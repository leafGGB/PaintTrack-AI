// 阶段 4.5.3：客户端供应商凭据撤除后的统一 fail-closed 出口。
//
// 设计约束（对应 PHASE4_STEP1_PROVIDER_CONTRACT.md）：
// - 生成能力只能由服务端 Provider 调用，浏览器不得持有供应商凭据；
// - 服务端 Provider 尚未接入，因此客户端远程生成入口一律不可用；
// - 不可用必须显式告知用户，不允许静默失败或回退到「让用户粘贴 key」。
//
// 本模块不读取 localStorage、cookie 或任何全局密钥变量，也不发起网络请求。
// 服务端 Provider 接入后，由服务端返回的能力声明替换 isClientProviderConfigured()，
// 而不是在这里重新引入凭据。

export const PROVIDER_UNAVAILABLE_CODE = 'PROVIDER_NOT_CONFIGURED';

const MESSAGES = {
    zh: '本机未配置服务端生成 Provider，生成功能暂不可用。浏览器不再保存或转发供应商密钥。',
    en: 'No server-side generation provider is configured. Generation is unavailable, and this browser no longer stores or forwards provider keys.',
};

export class ProviderUnavailableError extends Error {
    constructor(code = PROVIDER_UNAVAILABLE_CODE) {
        super(`${code}: generation requires a server-side provider`);
        this.name = 'ProviderUnavailableError';
        this.code = code;
    }
}

/**
 * 客户端是否具备可用的生成能力。
 * 恒为 false：服务端 Provider 未接入前，浏览器侧没有任何可用凭据来源。
 */
export function isClientProviderConfigured() {
    return false;
}

export function getProviderUnavailableMessage(locale = 'en') {
    return MESSAGES[locale] || MESSAGES.en;
}

/**
 * 统一抛出 ProviderUnavailableError，供 SDK 与调用方共用。
 */
export function throwProviderUnavailable() {
    throw new ProviderUnavailableError();
}

/**
 * 在页面上显式提示不可用，并广播事件供宿主应用接管展示。
 * 只做 UI 提示，不涉及凭据与网络。
 */
export function notifyProviderUnavailable(locale = 'en') {
    const message = getProviderUnavailableMessage(locale);

    if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('paintrack:provider-unavailable', {
            detail: { code: PROVIDER_UNAVAILABLE_CODE, message },
        }));
    }

    if (typeof document === 'undefined' || !document.body) return message;

    const existing = document.getElementById('provider-unavailable-notice');
    if (existing) {
        existing.textContent = message;
        existing.style.opacity = '1';
        return message;
    }

    const notice = document.createElement('div');
    notice.id = 'provider-unavailable-notice';
    notice.textContent = message;
    notice.style.cssText = [
        'position:fixed',
        'left:50%',
        'bottom:1.5rem',
        'transform:translateX(-50%)',
        'z-index:9999',
        'max-width:min(90vw,32rem)',
        'padding:0.75rem 1rem',
        'border-radius:0.75rem',
        'background:#111',
        'border:1px solid rgba(255,255,255,0.12)',
        'color:#fff',
        'font-size:0.8125rem',
        'line-height:1.5',
        'box-shadow:0 10px 30px rgba(0,0,0,0.45)',
        'text-align:center',
    ].join(';');

    document.body.appendChild(notice);
    window.setTimeout(() => {
        if (notice.parentNode) notice.parentNode.removeChild(notice);
    }, 6000);

    return message;
}
