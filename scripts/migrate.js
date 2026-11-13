const { getEnvironment } = require('../lib/server/env');
const { migrateDatabase } = require('../lib/server/db/migrate');

async function main() {
    await migrateDatabase(getEnvironment());
    console.log('Database migrations completed.');
}

if (require.main === module) {
    main().catch((error) => {
        const code = /^[0-9A-Z]{5}$/.test(error.code || '') ? ` (${error.code})` : '';
        console.error(`Database migration failed${code}; verify the dedicated migration identity and target configuration.`);
        process.exitCode = 1;
    });
}

module.exports = { main };
