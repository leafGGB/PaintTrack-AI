'use strict';

const { main } = require('../lib/server/tasks/creditGrantCli');

// 额度发放的唯一人工入口：向某个账户加额，或只读查看余额。
//   node scripts/grant-credit.js grant --user-id <uuid> --amount 1000 --source-id <uuid>
//   node scripts/grant-credit.js grant --user-id <uuid> --amount 500 --source-id <uuid> --source-type signup
//   node scripts/grant-credit.js balance --user-id <uuid>
// 金额单位是 credit_tenths（0.1 额度），只接受正整数；--source-id 是一次发放的来由标识，
// 同一来由只会成功一次（重复执行按重放返回原事件），因此它必须每次发放都不同。
// 需要 LEDGER_DATABASE_URL（或 PUBLISH_DATABASE_URL）作为管理员身份，以及 DATABASE_URL 做目标确认。
if (require.main === module) {
    main().catch(() => {
        process.stderr.write('CREDIT_GRANT_FAILED\n');
        process.exitCode = 1;
    });
}

module.exports = { main };
