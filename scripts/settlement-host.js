'use strict';

const { startSettlementHost, shortError } = require('../lib/server/tasks/settlementHost');

let host;
let stopping = false;

async function shutdown() {
    if (stopping) return;
    stopping = true;
    if (host) await host.stop().catch(() => {});
    process.exitCode = 0;
}

async function main() {
    host = await startSettlementHost({
        output: message => process.stdout.write(`${message}\n`),
        errorOutput: message => process.stderr.write(`${message}\n`),
        onFatal: () => { process.exitCode = 1; },
    });
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, shutdown);
}

if (require.main === module) {
    main().catch((error) => {
        process.stderr.write(`${shortError(error)}\n`);
        process.exitCode = 1;
    });
}

module.exports = { main, shutdown };
