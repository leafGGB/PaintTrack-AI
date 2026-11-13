// Persistent local secrets for the scratch development launcher.
//
// Why this exists: `scripts/local-registration.js` reuses a FIXED database
// (`pt_local_auth_000000000000`) so accounts, sessions, tasks and assets
// survive a restart — but it used to mint a brand-new 32-byte MFA encryption
// key on every boot. TOTP secrets are stored ENCRYPTED (AES-256-GCM) in
// `admin_mfa_factors`, so a new key means every already-enrolled factor fails
// to decrypt after restart: `decryptSecret` throws during `decipher.final()`,
// and the admin is locked out of their own local MFA with no UI to recover
// (recovery codes are hashed, the TOTP secret is unreadable).
//
// So the MFA key must be stable for as long as the database is. It is written
// to `.local-state/mfa-encryption.key` (gitignored, mode 0600) next to the
// nested repo root.
//
// Deliberately NOT persisted: `mailboxSecret`. Mail is in-memory, so every
// pending verification link is already gone after a restart; rotating that key
// in lockstep is the consistent behaviour, not a bug.
//
// Scope: this is a LOCAL DEVELOPMENT convenience only. Production must supply
// `PAINTTRACK_MFA_ENCRYPTION_KEY` itself (see lib/server/adminMfa.js), and a
// real deployment needs a secret manager plus a rotation plan — losing this key
// is equivalent to losing every enrolled factor.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const MFA_KEY_FILE = 'mfa-encryption.key';
const MFA_KEY_PATTERN = /^[0-9a-f]{64}$/;
const CORRUPT_CODE = 'LOCAL_MFA_KEY_CORRUPT';

function mfaKeyPath(stateDir) {
    return path.join(stateDir, MFA_KEY_FILE);
}

function readPersistedMfaKey(stateDir) {
    let raw;
    try {
        raw = fs.readFileSync(mfaKeyPath(stateDir), 'utf8');
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
    }
    const value = raw.trim();
    // Never silently replace a corrupt key: overwriting it would permanently
    // orphan every TOTP secret already encrypted in the database. Failing here
    // leaves the decision (restore the file / wipe the factors) to the user.
    if (!MFA_KEY_PATTERN.test(value)) {
        const error = new Error(CORRUPT_CODE);
        error.code = CORRUPT_CODE;
        error.path = mfaKeyPath(stateDir);
        throw error;
    }
    return value;
}

function writePersistedMfaKey(stateDir, value) {
    // `wx` refuses to clobber: two launchers starting at once must converge on
    // one key, so the loser re-reads instead of overwriting (see caller).
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(mfaKeyPath(stateDir), `${value}\n`, { mode: 0o600, flag: 'wx' });
}

// Returns { key, source } where source is 'existing' | 'created' | 'ephemeral'.
//
// `persist: false` is used by `--fresh`, which builds a throwaway database: a
// fresh key keeps that ephemeral database self-contained and avoids writing
// local state for a run that is meant to leave no trace.
function resolveMfaEncryptionKey(stateDir, { persist = true, randomBytes = crypto.randomBytes } = {}) {
    if (!persist) return { key: randomBytes(32).toString('hex'), source: 'ephemeral' };

    const existing = readPersistedMfaKey(stateDir);
    if (existing) return { key: existing, source: 'existing' };

    const created = randomBytes(32).toString('hex');
    try {
        writePersistedMfaKey(stateDir, created);
    } catch (error) {
        // Lost the create race: the winner's key is the real one.
        if (error.code === 'EEXIST') return { key: readPersistedMfaKey(stateDir), source: 'existing' };
        throw error;
    }
    return { key: created, source: 'created' };
}

function defaultLocalStateDir(root) {
    return path.join(root, '.local-state');
}

module.exports = {
    MFA_KEY_FILE,
    MFA_KEY_PATTERN,
    CORRUPT_CODE,
    defaultLocalStateDir,
    mfaKeyPath,
    readPersistedMfaKey,
    resolveMfaEncryptionKey,
    writePersistedMfaKey,
    // Re-exported so callers/tests do not need a second import just to build a
    // temp dir.
    tmpdir: os.tmpdir,
};
