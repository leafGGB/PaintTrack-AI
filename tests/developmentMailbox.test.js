const test = require('node:test');
const assert = require('node:assert/strict');
const mailbox = require('../lib/server/developmentMailbox');
test('development mailbox is opt-in, capability protected, bounded and production fail-closed', async () => {
    const keys = ['NODE_ENV', 'PAINTTRACK_LOCAL_MAILBOX', 'PAINTTRACK_LOCAL_MAILBOX_SECRET', 'PAINTTRACK_LOCAL_MAILBOX_ORIGIN'];
    const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    const origin = 'http://127.0.0.1:3211';
    const request = (extra = {}) => new Request(`${origin}/api/dev/mailbox`, { headers: { host: '127.0.0.1:3211', origin,
        'x-painttrack-local-capability': 'a'.repeat(64), ...extra } });
    try {
        process.env.NODE_ENV = 'development'; delete process.env.PAINTTRACK_LOCAL_MAILBOX;
        assert.equal(mailbox.enabled(), false);
        assert.equal(mailbox.getDevelopmentMailer(), undefined);
        Object.assign(process.env, { PAINTTRACK_LOCAL_MAILBOX: '1', PAINTTRACK_LOCAL_MAILBOX_SECRET: 'a'.repeat(64), PAINTTRACK_LOCAL_MAILBOX_ORIGIN: origin });
        assert.equal(mailbox.allowed(request(), true), true);
        for (const extra of [{ host: 'evil.example' }, { origin: 'http://evil.example' }, { 'x-painttrack-local-capability': '' }, { 'sec-fetch-site': 'cross-site' }]) {
            assert.equal(mailbox.mailboxResponse(request(extra)).status, 404);
        }
        await mailbox.clearMailbox(request());
        const mailer = mailbox.getDevelopmentMailer();
        await mailer.sendVerification({ email: 'synthetic@example.test', token: 'x'.repeat(43) });
        const response = mailbox.mailboxResponse(request());
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.equal((await response.json()).messages[0].verificationPath, `/verify-email#${'x'.repeat(43)}`);
        for (let i = 1; i < 100; i++) await mailer.sendVerification({ email: 'synthetic@example.test', token: 'x'.repeat(43) });
        await assert.rejects(mailer.sendVerification({ email: 'overflow@example.test', token: 'x'.repeat(43) }));
        await mailbox.clearMailbox(request());
        assert.equal((await mailbox.mailboxResponse(request()).json()).messages.length, 0);
        process.env.NODE_ENV = 'production';
        assert.equal(mailbox.enabled(), false);
        assert.equal(mailbox.getDevelopmentMailer(), undefined);
        assert.equal(mailbox.mailboxResponse(request()).status, 404);
    } finally {
        for (const key of keys) { if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key]; }
    }
});
