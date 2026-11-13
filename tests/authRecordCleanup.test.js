const test = require('node:test');
const assert = require('node:assert/strict');
const { createAuthRecordCleanupService } = require('../lib/server/authRecordCleanup');
const { assertCleanupTarget, parseArgs } = require('../scripts/cleanup-auth-records');

function makePool({ candidateCounts = [2, 3, 4], deleteCounts = [] } = {}) {
    const calls = [];
    const client = {
        async query(query, params) {
            calls.push({ query: String(query), params });
            if (/SELECT\s+\(SELECT count\(\*\)::integer FROM email_verification_tokens/s.test(String(query))) {
                return { rows: [{ email_verification_tokens: candidateCounts[0], password_reset_tokens: candidateCounts[1], auth_sessions: candidateCounts[2] }] };
            }
            if (/DELETE FROM (email_verification_tokens|password_reset_tokens|auth_sessions)/.test(String(query))) {
                const rowCount = deleteCounts.length > 0 ? deleteCounts.shift() : 0;
                return { rowCount, rows: [] };
            }
            return { rows: [], rowCount: 0 };
        },
        release() { calls.push({ release: true }); },
    };
    return { calls, async connect() { return client; } };
}

test('cleaner is dry-run by default and reports only aggregate counts', async () => {
    const pool = makePool();
    const events = [];
    const service = createAuthRecordCleanupService({ pool, sink: { info: (event) => events.push(event) } });
    const result = await service.cleanup();
    assert.equal(result.dryRun, true);
    assert.deepEqual(result.candidates, { emailVerificationTokens: 2, passwordResetTokens: 3, authSessions: 4 });
    assert.deepEqual(result.deleted, { emailVerificationTokens: 0, passwordResetTokens: 0, authSessions: 0 });
    assert.equal(pool.calls.some((call) => /DELETE FROM/.test(call.query || '')), false);
    assert.equal(events[0].outcome, 'dry_run');
    assert.equal(pool.calls.some((call) => call.release), true);
});

test('apply uses bounded batches, database time, row locks, and separate retention windows', async () => {
    const pool = makePool({ deleteCounts: [2, 0, 0] });
    const service = createAuthRecordCleanupService({ pool, sink: { info() {} } });
    const result = await service.cleanup({ dryRun: false, batchSize: 2, maxBatches: 3 });
    assert.equal(result.dryRun, false);
    assert.equal(result.deleted.emailVerificationTokens, 2);
    const deleteCalls = pool.calls.filter((call) => /DELETE FROM/.test(call.query || ''));
    assert.equal(deleteCalls.length, 4);
    assert.match(deleteCalls[0].query, /FOR UPDATE SKIP LOCKED/);
    assert.match(deleteCalls[0].query, /consumed_at IS NULL AND expires_at <= now\(\)/);
    assert.match(deleteCalls[3].query, /revoked_at IS NULL AND expires_at <= now\(\)/);
    assert.deepEqual(deleteCalls[0].params, [7, 2]);
    assert.deepEqual(deleteCalls[3].params, [30, 2]);
    assert.equal(result.truncated, false);
});

test('invalid cleanup limits and non-boolean dryRun are rejected', async () => {
    const service = createAuthRecordCleanupService({ pool: makePool(), sink: { info() {} } });
    await assert.rejects(service.cleanup({ batchSize: 0 }), /batchSize/);
    await assert.rejects(service.cleanup({ batchSize: 5001 }), /batchSize/);
    await assert.rejects(service.cleanup({ tokenRetentionDays: 0 }), /tokenRetentionDays/);
    await assert.rejects(service.cleanup({ dryRun: 'false' }), /dryRun/);
});

test('cleanup target requires separate identities and a loopback test/acceptance database', () => {
    const accepted = assertCleanupTarget({
        databaseUrl: 'postgresql://runtime:secret@127.0.0.1:5433/pt_acceptance_clean_123456',
        migrationDatabaseUrl: 'postgresql://migration:secret@127.0.0.1:5433/pt_acceptance_clean_123456',
    });
    assert.equal(accepted.database, 'pt_acceptance_clean_123456');
    assert.throws(() => assertCleanupTarget({
        databaseUrl: 'postgresql://runtime:secret@127.0.0.1:5433/painttrack_dev',
        migrationDatabaseUrl: 'postgresql://migration:secret@127.0.0.1:5433/painttrack_dev',
    }), /loopback test\/acceptance/);
    assert.throws(() => assertCleanupTarget({
        databaseUrl: 'postgresql://runtime:secret@db.example.test:5432/pt_acceptance_clean_123456',
        migrationDatabaseUrl: 'postgresql://migration:secret@db.example.test:5432/pt_acceptance_clean_123456',
    }), /loopback test\/acceptance/);
});

test('CLI is dry-run by default and parses explicit apply and bounded options', () => {
    assert.deepEqual(parseArgs([]), { dryRun: true });
    assert.deepEqual(parseArgs(['--apply', '--batch-size', '100', '--max-batches', '2']), {
        dryRun: false, batchSize: 100, maxBatches: 2,
    });
    assert.throws(() => parseArgs(['--unknown']), /Unknown option/);
    assert.throws(() => parseArgs(['--batch-size', 'not-a-number']), /batch-size/);
});
