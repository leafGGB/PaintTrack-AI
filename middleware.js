import { NextResponse } from 'next/server';
import { getLocaleFromPathname } from './lib/locales';
import { getRequestId } from './lib/server/observability.js';

function addSecurityHeaders(response) {
    // Prevent MIME type sniffing (CWE-693)
    response.headers.set('X-Content-Type-Options', 'nosniff');
    // Prevent clickjacking (CWE-1021)
    response.headers.set('X-Frame-Options', 'DENY');
    // Enable XSS filter in legacy browsers
    response.headers.set('X-XSS-Protection', '1; mode=block');
    // Referrer policy
    response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    // Web云端请求只能访问同源门禁；Electron独立Vite/IPC本地推理不经过此middleware。
    response.headers.set(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self' 'unsafe-eval' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; media-src 'self' data: blob: https:; connect-src 'self'; font-src 'self' data:;"
    );
    return response;
}

export function middleware(request) {
    const url = request.nextUrl;
    if (process.env.PAINTTRACK_LOCAL_INTERNAL_GUARD === '1'
        && request.headers.get('x-painttrack-local-capability') !== process.env.PAINTTRACK_LOCAL_MAILBOX_SECRET) {
        return new NextResponse('Local development access only', {
            status: 403,
            headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
        });
    }
    const requestId = getRequestId(request.headers.get('x-request-id'));
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set('x-request-id', requestId);

    // API 授权由 Node Route Handler 查询实时数据库执行，禁止外部 rewrite 绕过。

    // Plain response header carrying the locale derived from the URL path
    // (same "set in middleware, read via headers() in the root layout"
    // trick the main muapi client uses — see docs/localization.md).
    const response = NextResponse.next({ request: { headers: requestHeaders } });
    response.headers.set('x-locale', getLocaleFromPathname(url.pathname));
    response.headers.set('x-request-id', requestId);
    addSecurityHeaders(response);
    if (['/register', '/verify-email', '/login', '/account', '/zh/account', '/dev/mailbox', '/dev/authorization'].includes(url.pathname) || url.pathname.startsWith('/api/auth/') || url.pathname.startsWith('/api/dev/mailbox')) {
        response.headers.set('Referrer-Policy', 'no-referrer');
        response.headers.set('Cache-Control', 'no-store');
    }
    return response;
}

// Match all paths for security headers. Exclude Next.js internal paths.
export const config = {
    matcher: [
        '/api/:path*',
        '/((?!_next/static|_next/image|favicon.ico|__nextjs_original-stack-frame).*)',
    ],
};
