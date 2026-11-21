'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const loginPage = fs.readFileSync(path.join(root, 'app/login/page.js'), 'utf8');
const homePage = fs.readFileSync(path.join(root, 'app/page.js'), 'utf8');
const zhHomePage = fs.readFileSync(path.join(root, 'app/zh/page.js'), 'utf8');
const shell = fs.readFileSync(path.join(root, 'components/StandaloneShell.js'), 'utf8');

function safeNextPath(requested, origin = 'http://127.0.0.1:3000') {
    if (!requested || !requested.startsWith('/') || requested.startsWith('//') || requested.includes('\\')) return '/studio';
    try {
        const target = new URL(requested, origin);
        if (target.origin !== origin || ['/login', '/register', '/reset-password'].includes(target.pathname)) return '/studio';
        return `${target.pathname}${target.search}${target.hash}`;
    } catch {
        return '/studio';
    }
}

test('home routes send users to login with the appropriate Studio destination', () => {
    assert.match(homePage, /redirect\('\/login\?next=%2Fstudio'\)/);
    assert.match(zhHomePage, /redirect\('\/login\?next=%2Fzh%2Fstudio'\)/);
});

test('login next-path policy accepts only same-origin application paths', () => {
    assert.match(loginPage, /function getSafeNextPath\(\)/);
    assert.equal(safeNextPath('/studio/video?mode=create#editor'), '/studio/video?mode=create#editor');
    assert.equal(safeNextPath('/zh/studio/image'), '/zh/studio/image');
    assert.equal(safeNextPath('https://evil.example/'), '/studio');
    assert.equal(safeNextPath('//evil.example/path'), '/studio');
    assert.equal(safeNextPath('/\\\\evil.example/path'), '/studio');
    assert.equal(safeNextPath('/login?next=/'), '/studio');
    assert.equal(safeNextPath('/register'), '/studio');
});

test('actual login redirect functions preserve deep admin destinations through MFA', () => {
    const start = loginPage.indexOf('function getSafeNextPath()');
    const end = loginPage.indexOf('export default function LoginPage()', start);
    assert.ok(start >= 0 && end > start);
    const window = {
        location: { origin: 'http://127.0.0.1:3000', pathname: '/login', search: '' },
    };
    const redirects = new Function('window', `${loginPage.slice(start, end)}; return { getSafeNextPath, getPostLoginPath };`)(window);
    for (const destination of ['/admin/users', '/zh/admin/users?email=operator%40example.test#detail', '/admin/models']) {
        window.location.search = `?next=${encodeURIComponent(destination)}`;
        assert.equal(redirects.getSafeNextPath(), destination);
        assert.equal(redirects.getPostLoginPath({ role: 'admin', authLevel: 'mfa' }), destination);
        const stepUp = new URL(redirects.getPostLoginPath({ role: 'admin', authLevel: 'password' }), window.location.origin);
        assert.ok(['/account', '/zh/account'].includes(stepUp.pathname));
        assert.equal(stepUp.searchParams.get('next'), destination);
    }
});

test('login sends password-level administrators to MFA account center and preserves safe next path', () => {
    assert.match(loginPage, /function getPostLoginPath\(user\)/);
    assert.match(loginPage, /user\?\.role !== 'admin' \|\| user\.authLevel === 'mfa'/);
    assert.match(loginPage, /window\.location\.replace\(getPostLoginPath\(result\.user\)\)/);
    assert.match(loginPage, /window\.location\.replace\(getPostLoginPath\(authenticatedUser\)\)/);
    assert.match(loginPage, /\$\{accountPath\}\?next=\$\{encodeURIComponent\(nextPath\)\}/);
});

test('Studio checks the session before rendering and preserves the requested route', () => {
    assert.match(shell, /fetch\('\/api\/auth\/me', \{ cache: 'no-store', credentials: 'same-origin' \}\)/);
    assert.match(shell, /if \(result\.user\) \{\s*if \(result\.user\.role === 'admin' && result\.user\.authLevel !== 'mfa'\)/);
    assert.match(shell, /window\.location\.replace\(`\$\{accountPath\}\?next=\$\{encodeURIComponent\(nextPath\)\}`\)/);
    assert.match(shell, /setCurrentUser\(result\.user\);\s*setAuthStatus\('authenticated'\)/);
    assert.match(shell, /window\.location\.replace\(`\/login\?next=\$\{encodeURIComponent\(nextPath\)\}`\)/);
    assert.match(shell, /!hasMounted \|\| authStatus !== 'authenticated'/);
    assert.match(shell, /暂时无法验证登录状态/);
});

test('provider-unavailable no longer replaces the Studio workspace', () => {
    assert.doesNotMatch(shell, /ProviderNotConfigured/);
    assert.doesNotMatch(shell, /if \(!apiKey\)[\s\S]{0,200}return </);
    assert.match(shell, /Provider 是否可用只影响生成调用/);
});

test('Studio header keeps account and settings actions without the Tasks panel', () => {
    assert.doesNotMatch(shell, /TaskCenter/);
    assert.match(shell, /aria-label=\{copy\.account\.menuLabel\}/);
    assert.match(shell, /onClick=\{\(\) => setShowSettings\(true\)\}/);
});

test('account menu closes on outside pointer and Escape', () => {
    assert.match(shell, /addEventListener\('pointerdown', closeAccountMenuOnOutsidePointer\)/);
    assert.match(shell, /!menu\?\.open \|\| menu\.contains\(event\.target\)/);
    assert.match(shell, /event\.key !== 'Escape'/);
    assert.match(shell, /menu\.querySelector\('summary'\)\?\.focus\(\)/);
    assert.match(shell, /<details ref=\{accountMenuRef\} className="relative">/);
});
