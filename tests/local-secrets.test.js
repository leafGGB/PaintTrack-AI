// The local launcher used to mint a fresh MFA encryption key on every boot
// while reusing a fixed database. Every already-enrolled TOTP secret is stored
// as AES-256-GCM ciphertext, so a new key silently bricks them: the admin is
// locked out of their own local MFA with no recovery path (codes are hashed).
// These tests pin the fix: the key persists across restarts, is never silently
// overwritten, and stays out of the way for `--fresh`.

const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const {
    CORRUPT_CODE,
    MFA_KEY_FILE,
    mfaKeyPath,
    readPersistedMfaKey,
    resolveMfaEncryptionKey,
    writePersistedMfaKey,
} = require('../scripts/local-secrets');

function scratch(t) {
    const dir = mkdtempSync(join(tmpdir(), 'pt-local-secrets-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
}

test('first boot creates a 32-byte hex key and persists it', (t) => {
    const stateDir = join(scratch(t), '.local-state');

    const first = resolveMfaEncryptionKey(stateDir);

    assert.equal(first.source, 'created');
    assert.match(first.key, /^[0-9a-f]{64}$/);
    assert.equal(readFileSync(mfaKeyPath(stateDir), 'utf8').trim(), first.key);
});

test('second boot reuses the persisted key (this is the lockout fix)', (t) => {
    const stateDir = join(scratch(t), '.local-state');

    const first = resolveMfaEncryptionKey(stateDir);
    const second = resolveMfaEncryptionKey(stateDir);

    assert.equal(second.source, 'existing');
    assert.equal(second.key, first.key);
});

test('writeFile mode is 0600 on POSIX so other users cannot read the key', (t) => {
    if (process.platform === 'win32') return; // Windows ignores POSIX modes.
    const stateDir = join(scratch(t), '.local-state');

    resolveMfaEncryptionKey(stateDir);

    assert.equal(statSync(mfaKeyPath(stateDir)).mode & 0o777, 0o600);
});

test('--fresh stays ephemeral: a new key each run and nothing written', (t) => {
    const stateDir = join(scratch(t), '.local-state');

    const first = resolveMfaEncryptionKey(stateDir, { persist: false });
    const second = resolveMfaEncryptionKey(stateDir, { persist: false });

    assert.equal(first.source, 'ephemeral');
    assert.equal(second.source, 'ephemeral');
    assert.notEqual(first.key, second.key);
    assert.equal(existsSync(stateDir), false);
});

test('a corrupt key file fails loudly instead of being overwritten', (t) => {
    const stateDir = join(scratch(t), '.local-state');
    resolveMfaEncryptionKey(stateDir);
    const file = mfaKeyPath(stateDir);
    writeFileSync(file, 'not-a-key\n');

    assert.throws(() => resolveMfaEncryptionKey(stateDir), (error) => {
        assert.equal(error.code, CORRUPT_CODE);
        assert.equal(error.message, CORRUPT_CODE);
        return true;
    });
    // The bad file must survive: overwriting it would permanently orphan every
    // TOTP secret already encrypted with the real key.
    assert.equal(readFileSync(file, 'utf8'), 'not-a-key\n');
});

test('writePersistedMfaKey refuses to clobber an existing key', (t) => {
    const stateDir = join(scratch(t), '.local-state');
    const first = resolveMfaEncryptionKey(stateDir);

    assert.throws(() => writePersistedMfaKey(stateDir, 'ff'.repeat(32)), (error) => error.code === 'EEXIST');
    assert.equal(readPersistedMfaKey(stateDir), first.key);
});

test('key file name is stable and lives directly in the state dir', (t) => {
    const stateDir = scratch(t);

    assert.equal(mfaKeyPath(stateDir), join(stateDir, MFA_KEY_FILE));
    assert.equal(MFA_KEY_FILE, 'mfa-encryption.key');
});

test('a TOTP secret encrypted before a restart still decrypts after it', (t) => {
    // End-to-end version of the bug: this is what actually happened to an admin
    // who enrolled MFA, restarted the launcher, and could no longer sign in.
    const { decryptSecret, encryptSecret } = require('../lib/server/adminMfa');
    const stateDir = join(scratch(t), '.local-state');
    const totpSecret = Buffer.from('0123456789abcdefghij'); // 20 bytes

    const beforeRestart = resolveMfaEncryptionKey(stateDir);
    const stored = encryptSecret(totpSecret, beforeRestart.key);

    const afterRestart = resolveMfaEncryptionKey(stateDir);

    assert.deepEqual(decryptSecret(stored, afterRestart.key), totpSecret);
    // Guards against a "fix" that only pretends: any other key must still fail.
    assert.throws(() => decryptSecret(stored, 'ab'.repeat(32)));
});
