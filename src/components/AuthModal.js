import { t } from '../lib/i18n.js';
import { getProviderUnavailableMessage } from '../lib/providerAvailability.js';

/**
 * 阶段 4.5.3：原「填写供应商 API Key」登录弹窗已改为不可用提示。
 *
 * 浏览器不再保存或转发供应商凭据，因此这里不提供输入框、不写 localStorage。
 * 保留函数签名与 onSuccess 参数，避免调用方需要同步改造；服务端 Provider
 * 接入后，此入口应改为真正的账号登录，而不是粘贴密钥。
 */
export function AuthModal() {
    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm px-6';

    const modal = document.createElement('div');
    modal.className = 'relative w-full max-w-md bg-panel-bg border border-white/10 rounded-3xl p-8 shadow-3xl animate-fade-in-up';

    modal.innerHTML = `
        <button id="auth-modal-close-btn" type="button" aria-label="Close" class="absolute top-4 right-4 w-8 h-8 rounded-md text-white/40 hover:text-white hover:bg-white/10 transition-colors flex items-center justify-center">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M18 6L6 18M6 6l12 12" />
            </svg>
        </button>
        <div class="flex flex-col items-center text-center mb-6">
            <div class="w-16 h-16 bg-primary/10 rounded-2xl flex items-center justify-center border border-primary/20 shadow-glow mb-6">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#22d3ee" stroke-width="2">
                    <rect x="3" y="11" width="18" height="10" rx="2" />
                    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
            </div>
            <h2 class="text-2xl font-black text-white uppercase tracking-wider mb-2">${t('auth.title')}</h2>
            <p class="text-secondary text-sm" id="auth-modal-message">${getProviderUnavailableMessage()}</p>
        </div>
        <p class="text-[11px] text-muted text-center leading-relaxed">${t('auth.keyNote')}</p>
    `;

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    const closeBtn = modal.querySelector('#auth-modal-close-btn');

    const close = () => {
        document.removeEventListener('keydown', onKeydown);
        if (overlay.parentNode) document.body.removeChild(overlay);
    };

    const onKeydown = (e) => {
        if (e.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKeydown);

    closeBtn.onclick = close;
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) close();
    });

    return overlay;
}
