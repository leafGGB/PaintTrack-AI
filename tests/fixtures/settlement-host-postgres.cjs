'use strict';

const assert = require('node:assert/strict');
const { startSettlementHost } = require('../../lib/server/tasks/settlementHost');

async function checkSettlementHost(adminUrl, runtimeUrl, database, record) {
    const ledgerUrl = new URL(adminUrl);
    ledgerUrl.pathname = `/${database}`;
    const lines = [];
    const host = await startSettlementHost({
        env: {
            LEDGER_DATABASE_URL: ledgerUrl.href,
            DATABASE_URL: runtimeUrl,
            PAINTTRACK_SETTLEMENT_INTERVAL_MS: '1000',
            PAINTTRACK_SETTLEMENT_LIMIT: '10',
        },
        output: line => lines.push(line),
        errorOutput: line => lines.push(line),
    });
    try {
        assert.ok(lines.some(line => line.startsWith('LOCAL_SETTLEMENT_SWEEP ')));
        assert.ok(lines.some(line => line === 'LOCAL_SETTLEMENT_READY intervalMs=1000 limit=10'));
        assert.ok(lines.every(line => !line.includes('admin') && !line.includes('postgres://')));
    } finally {
        await host.stop();
    }
    assert.equal(lines.at(-1), 'LOCAL_SETTLEMENT_STOPPED');
    record('独立结算宿主真实PG：账务owner会话启动恢复扫描、固定间隔配置与优雅停止通过，输出不泄露连接信息', 'passed');
}

module.exports = { checkSettlementHost };
