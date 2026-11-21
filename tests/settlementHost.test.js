'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { assertSettlementEnvironment, runSettlementOnce, shortError, SettlementHostError } = require('../lib/server/tasks/settlementHost');

const valid = {
    LEDGER_DATABASE_URL: 'postgres://ledger:secret@127.0.0.1:5433/pt_local_auth_test',
    DATABASE_URL: 'postgres://web:secret@127.0.0.1:5433/pt_local_auth_test',
};

test('settlement environment requires same loopback target and bounded scheduler settings', () => {
    const result = assertSettlementEnvironment(valid);
    assert.equal(result.database, 'pt_local_auth_test');
    assert.match(result.role, /^pt_ledger_owner_[a-f0-9]{16}$/);
    assert.equal(result.intervalMs, 30000);
    assert.equal(result.limit, 50);
    assert.throws(() => assertSettlementEnvironment({ DATABASE_URL: valid.DATABASE_URL }), (error) => error.reason === 'LEDGER_DATABASE_URL_REQUIRED');
    assert.throws(() => assertSettlementEnvironment({ ...valid, LEDGER_DATABASE_URL: 'postgres://ledger@10.0.0.5:5433/pt_local_auth_test' }), (error) => error.reason === 'SETTLEMENT_TARGET_NOT_LOOPBACK');
    assert.throws(() => assertSettlementEnvironment({ ...valid, DATABASE_URL: 'postgres://web@127.0.0.1:5433/other' }), (error) => error.reason === 'SETTLEMENT_TARGET_MUST_MATCH');
    assert.throws(() => assertSettlementEnvironment({ ...valid, PAINTTRACK_SETTLEMENT_INTERVAL_MS: '999' }), (error) => error.reason === 'SETTLEMENT_INTERVAL_INVALID');
    assert.throws(() => assertSettlementEnvironment({ ...valid, PAINTTRACK_SETTLEMENT_LIMIT: '501' }), (error) => error.reason === 'SETTLEMENT_LIMIT_INVALID');
});

test('settlement sweep runs once and exposes only aggregate safe output', async () => {
    const lines = [];
    const result = await runSettlementOnce({
        store: { sweep: async ({ limit }) => ({ examined: 2, finalized: [{ taskId: 'a' }], failed: [{ taskId: 'b' }] , limit }) },
        limit: 7,
        output: line => lines.push(line),
    });
    assert.equal(result.examined, 2);
    assert.deepEqual(lines, ['LOCAL_SETTLEMENT_SWEEP examined=2 finalized=1 failed=1']);
});

test('unknown errors map to a stable operator-facing code', () => {
    assert.equal(shortError(new Error('connection secret should not escape')), 'SETTLEMENT_UNKNOWN_ERROR');
    assert.equal(shortError(Object.assign(new Error(), { code: '42501' })), 'SETTLEMENT_PERMISSION_DENIED');
    assert.ok(new SettlementHostError('X') instanceof Error);
});
