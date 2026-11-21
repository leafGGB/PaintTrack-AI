'use strict';

// 受限账务结算宿主：独立于 Web/Worker，仅在显式本地开关下启动。
const { Pool } = require('pg');
const { parseDatabaseTarget, sameDatabaseTarget } = require('../db/testIsolation');
const { ledgerOwnerRole } = require('../db/migrate');
const { createOwnerSessionPool } = require('./pricingPublishCli');
const { createCreditSettlementStore } = require('./creditSettlement');

const DEFAULT_INTERVAL_MS = 30_000;
const MAX_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

class SettlementHostError extends Error {
    constructor(reason) {
        super(reason);
        this.name = 'SettlementHostError';
        this.reason = reason;
    }
}

function fail(reason) { throw new SettlementHostError(reason); }

function assertSettlementEnvironment(env = process.env) {
    const ledgerUrl = env.LEDGER_DATABASE_URL;
    const targetUrl = env.DATABASE_URL;
    if (!ledgerUrl) fail('LEDGER_DATABASE_URL_REQUIRED');
    if (!targetUrl) fail('SETTLEMENT_TARGET_CONFIRMATION_REQUIRED');
    let ledgerTarget;
    try { ledgerTarget = parseDatabaseTarget(ledgerUrl); } catch { fail('LEDGER_DATABASE_URL_INVALID'); }
    if (!ledgerTarget.loopback) fail('SETTLEMENT_TARGET_NOT_LOOPBACK');
    if (!sameDatabaseTarget(ledgerUrl, targetUrl)) fail('SETTLEMENT_TARGET_MUST_MATCH');
    const role = ledgerOwnerRole(ledgerTarget.database);
    if (!/^pt_ledger_owner_[a-z0-9_]{1,32}$/.test(role)) fail('OWNER_ROLE_INVALID');
    const intervalMs = Number(env.PAINTTRACK_SETTLEMENT_INTERVAL_MS || DEFAULT_INTERVAL_MS);
    const limit = Number(env.PAINTTRACK_SETTLEMENT_LIMIT || DEFAULT_LIMIT);
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 1000 || intervalMs > MAX_INTERVAL_MS) fail('SETTLEMENT_INTERVAL_INVALID');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) fail('SETTLEMENT_LIMIT_INVALID');
    return Object.freeze({ connectionString: ledgerUrl, database: ledgerTarget.database, role, intervalMs, limit });
}

function shortError(error) {
    if (error instanceof SettlementHostError) return error.reason;
    if (error?.code === '42501') return 'SETTLEMENT_PERMISSION_DENIED';
    if (error?.code === '28P01') return 'SETTLEMENT_AUTH_FAILED';
    if (error?.code === '3D000') return 'SETTLEMENT_DATABASE_NOT_FOUND';
    return 'SETTLEMENT_UNKNOWN_ERROR';
}

async function runSettlementOnce({ store, limit = DEFAULT_LIMIT, output = console.log } = {}) {
    if (!store || typeof store.sweep !== 'function') throw new TypeError('store is required');
    const result = await store.sweep({ limit });
    output(`LOCAL_SETTLEMENT_SWEEP examined=${result.examined} finalized=${result.finalized.length} failed=${result.failed.length}`);
    return result;
}

async function startSettlementHost({ env = process.env, PoolImpl = Pool, output = console.log, errorOutput = console.error, onFatal = () => {} } = {}) {
    const environment = assertSettlementEnvironment(env);
    const pool = createOwnerSessionPool({
        connectionString: environment.connectionString,
        role: environment.role,
        PoolImpl,
    });
    const store = createCreditSettlementStore({ pool });
    let stopping = false;
    let running = null;
    let timer = null;

    const run = async () => {
        if (stopping || running) return running;
        running = runSettlementOnce({ store, limit: environment.limit, output })
            .catch((error) => {
                errorOutput(`LOCAL_SETTLEMENT_FAILED ${shortError(error)}`);
                throw error;
            })
            .finally(() => { running = null; });
        return running;
    };
    const schedule = () => {
        if (!stopping) timer = setTimeout(async () => {
            try {
                await run();
                if (!stopping) schedule();
            } catch (error) {
                // 未知错误终止宿主，避免继续轮询并假装结算已完成。
                await stop();
                onFatal(error);
            }
        }, environment.intervalMs);
    };
    const stop = async () => {
        if (stopping) return;
        stopping = true;
        if (timer) clearTimeout(timer);
        if (running) await running.catch(() => {});
        await pool.end();
        output('LOCAL_SETTLEMENT_STOPPED');
    };

    try {
        await run();
        schedule();
        output(`LOCAL_SETTLEMENT_READY intervalMs=${environment.intervalMs} limit=${environment.limit}`);
    } catch (error) {
        await pool.end().catch(() => {});
        throw error;
    }
    return Object.freeze({ stop, runOnce: run });
}

module.exports = { DEFAULT_INTERVAL_MS, DEFAULT_LIMIT, SettlementHostError, assertSettlementEnvironment, runSettlementOnce, shortError, startSettlementHost };
