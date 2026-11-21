'use strict';

const { main } = require('../lib/server/tasks/pricingPublishCli');

// 价格版本发布的唯一人工入口。
//   node scripts/publish-pricing.js publish --config ./price.json --effective-from 2026-11-18T00:00:00+08:00
//   node scripts/publish-pricing.js publish --config ./price.json --effective-from @1794931200 --dry-run
//   node scripts/publish-pricing.js cancel --model-id <id> --pricing-version <name>
//   node scripts/publish-pricing.js revoke --model-id <id> --pricing-version <name>
//   node scripts/publish-pricing.js timeline --model-id <id>
// 需要 PUBLISH_DATABASE_URL（管理员身份，指向业务库）与 DATABASE_URL（目标确认）。
if (require.main === module) {
    main().catch(() => {
        process.stderr.write('PRICING_PUBLISH_FAILED\n');
        process.exitCode = 1;
    });
}

module.exports = { main };
