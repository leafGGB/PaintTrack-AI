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

test('account center routes expose identity and explicit non-billing states in both locales', () => {
  const account = read('components/AccountCenter.js');
  const page = read('app/account/page.js');
  const zhPage = read('app/zh/account/page.js');
  const shell = read('components/StandaloneShell.js');
  assert.match(page, /<AccountCenter\s*\/>/);
  assert.match(zhPage, /<AccountCenter locale="zh"\s*\/>/);
  for (const field of ['user.email', 'user.id', 'user.role', 'user.emailVerified', 'user.createdAt']) assert.ok(account.includes(field));
  assert.match(account, /Credit service is not enabled/);
  assert.match(account, /backToStudio: 'Back to studio'/);
  assert.match(account, /backToStudio: '返回工作室'/);
  assert.ok(account.includes("href={isZh ? '/zh/studio' : '/studio'}"));
  assert.match(account, /额度服务尚未启用/);
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
