'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { randomBytes } = require('node:crypto');
const { createSessionService } = require('../lib/server/session');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('session me returns only the account identity projection and never queries invalid tokens', async () => {
  const createdAt = new Date('2026-11-10T00:00:00.000Z');
  let calls = 0;
  const database = { async execute() {
    calls += 1;
    return { rows: [{ id: 'user-id', email: 'verified@example.test', role: 'user', email_verified_at: createdAt, created_at: createdAt }] };
  } };
  const service = createSessionService({ database });
  assert.deepEqual(await service.me('invalid'), { user: null });
  assert.equal(calls, 0);
  const token = randomBytes(32).toString('base64url');
  assert.deepEqual(await service.me(token), { user: {
    id: 'user-id', email: 'verified@example.test', role: 'user', authLevel: 'password',
    mfaVerifiedAt: undefined, stepUpVerifiedAt: undefined, emailVerified: true, createdAt,
  } });
  assert.equal(calls, 1);
});

test('account center ledger request contract covers filters, cursors, replacement, append retry, and task projection', () => {
  const account = read('components/AccountCenter.js');
  for (const kind of ['', 'grant', 'reserve', 'settle', 'release']) {
    const query = new URLSearchParams({ limit: '20' });
    if (kind) query.set('kind', kind);
    query.set('cursor', 'cursor-1');
    assert.equal(query.get('limit'), '20');
    assert.equal(query.get('kind'), kind || null);
    assert.equal(query.get('cursor'), 'cursor-1');
  }
  assert.match(account, /if \(!append \|\| !current\) return result\.credits/);
  assert.match(account, /events: \[\.\.\.\(current\.events \|\| \[\]\),/);
  assert.match(account, /if \(append\) setCreditsMoreError\(true\)/);
  assert.match(account, /onClick=\{\(\) => loadCredits\(\{ append: true, cursor: credits\.nextCursor \}\)\}/);
  assert.match(account, /event\.task \?/);
  assert.match(account, /event\.task\.taskType/);
  assert.match(account, /event\.task\.status/);
  assert.doesNotMatch(account, /<a[^>]+event\.task|<a[^>]+event\.taskId/);
});

test('account center routes expose identity and explicit non-billing states in both locales', () => {
  const account = read('components/AccountCenter.js');
  const page = read('app/account/page.js');
  const zhPage = read('app/zh/account/page.js');
  const shell = read('components/StandaloneShell.js');
  assert.match(page, /<AccountCenter\s*\/>/);
  assert.match(zhPage, /<AccountCenter locale="zh"\s*\/>/);
  for (const field of ['user.email', 'user.id', 'user.role', 'user.emailVerified', 'user.createdAt']) assert.ok(account.includes(field));
  assert.match(account, /Loading live credit data/);
  assert.match(account, /额度与账单/);
  assert.match(account, /fetch\(`\/api\/account\/credits\?\$\{query\}`/);
  assert.match(account, /availableTenths/);
  assert.match(account, /reservedTenths/);
  assert.match(account, /totalTenths/);
  assert.match(account, /limit: '20'/);
  assert.match(account, /query\.set\('kind', kind\)/);
  assert.match(account, /query\.set\('cursor', cursor\)/);
  assert.match(account, /creditKind/);
  assert.match(account, /option value="grant"/);
  assert.match(account, /option value="reserve"/);
  assert.match(account, /option value="settle"/);
  assert.match(account, /option value="release"/);
  assert.match(account, /freezeHint/);
  assert.match(account, /nextCursor/);
  assert.match(account, /creditsLoadingMore/);
  assert.match(account, /creditsMoreError/);
  assert.match(account, /AbortController/);
  assert.match(account, /request\.sequence/);
  assert.match(account, /event\.task \?/);
  assert.doesNotMatch(account, /href=.*taskId|href=.*event\.task/);
  assert.match(account, /backToStudio: 'Back to studio'/);
  assert.match(account, /backToStudio: '返回工作室'/);
  assert.ok(account.includes("href={isZh ? '/zh/studio' : '/studio'}"));
  assert.match(account, /正在读取真实额度/);
  assert.match(account, /fetch\('\/api\/auth\/logout'/);
  assert.match(account, /fetch\('\/api\/auth\/me'/);
  assert.match(account, /mfaRequest\('status'\)/);
  assert.match(account, /mfaRequest\(action, \{ code \}\)/);
  assert.match(account, /'session\/elevate' : 'recovery\/consume'/);
  assert.match(account, /refreshedUser\.authLevel !== 'mfa'/);
  assert.match(account, /user\.authLevel !== 'mfa'/);
  assert.match(account, /user\.authLevel === 'mfa'/);
  assert.match(account, /mfaRequest\('enrollment\/begin'\)/);
  assert.match(account, /mfaRequest\('enrollment\/verify'/);
  assert.match(account, /mfaRequest\('recovery\/issue', \{ code: managementCode \}\)/);
  assert.match(account, /mfaRequest\('factor\/revoke', \{ code: managementCode \}\)/);
  assert.match(account, /setTimeout\(\(\) => window\.location\.replace\('\/login'\), 700\)/);
  assert.match(shell, /const accountPath = locale === 'zh' \? '\/zh\/account' : '\/account'/);
  assert.match(shell, /copy\.account\.openCenter/);
  assert.match(shell, /copy\.account\.signOut/);
  assert.doesNotMatch(shell, /balance !== null|\$\{balance\}|\$\{balance[}]|\? '\-\-\-'/);
});
