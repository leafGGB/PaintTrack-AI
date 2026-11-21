'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { addTenths, createAccountCreditsService, normalizeTenths, parseCreditQuery } = require('../lib/server/accountCredits');

const userId = '11111111-1111-4111-8111-111111111111';

test('credit amounts use integer tenths and never floating point arithmetic', () => {
    assert.equal(addTenths('7', '14'), '21');
    assert.equal(addTenths('9007199254740991', '8'), '9007199254740999');
    assert.equal(normalizeTenths('0'), '0');
    assert.throws(() => normalizeTenths('0.1'), /CREDIT_DATA_INVALID/);
    assert.deepEqual(parseCreditQuery({ limit: '20', kind: 'settle' }, userId), { limit: 20, kind: 'settle', after: null });
    assert.throws(() => parseCreditQuery({ limit: '51' }, userId), error => error.code === 'INVALID_CREDIT_QUERY');
    assert.throws(() => parseCreditQuery({ kind: 'unknown' }, userId), error => error.code === 'INVALID_CREDIT_QUERY');
});

test('account credits service returns balance totals and normalized ledger events', async () => {
    const calls = [];
    const database = { async execute(query) {
        calls.push(String(query));
        if (calls.length === 1) return { rows: [{ user_id: '11111111-1111-4111-8111-111111111111', available_tenths: '14', reserved_tenths: '7', unit_version: 'credit_tenths_v1' }] };
        return { rows: [{ id: '22222222-2222-4222-8222-222222222222', user_id: '11111111-1111-4111-8111-111111111111', task_id: null, kind: 'grant', credit_tenths: '14', source_type: 'manual', created_at: '2026-11-18 10:00:00+08' }] };
    } };
    const result = await createAccountCreditsService({ database }).read('11111111-1111-4111-8111-111111111111');
    assert.deepEqual(result, {
        availableTenths: '14', reservedTenths: '7', totalTenths: '21', unitVersion: 'credit_tenths_v1', nextCursor: null,
        events: [{ id: '22222222-2222-4222-8222-222222222222', kind: 'grant', amountTenths: '14', taskId: null, task: null, sourceType: 'manual', createdAt: '2026-11-18T02:00:00.000Z' }],
    });
    assert.equal(calls.length, 2);
});

test('account credits service fails closed on invalid identity or ledger rows', async () => {
    const database = { async execute() { return { rows: [] }; } };
    await assert.rejects(() => createAccountCreditsService({ database }).read('not-a-user'), error => error.code === 'UNAUTHENTICATED');
    const invalid = { async execute() { return { rows: [{ user_id: '11111111-1111-4111-8111-111111111111', available_tenths: '1.5', reserved_tenths: '0', unit_version: 'credit_tenths_v1' }] }; } };
    await assert.rejects(() => createAccountCreditsService({ database: invalid }).read('11111111-1111-4111-8111-111111111111'), /CREDIT_DATA_INVALID/);
});
