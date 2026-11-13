const path = require('node:path');
const { defineConfig } = require('drizzle-kit');
const { getEnvironment } = require('./lib/server/env');

const { assertMigrationIdentity } = require('./lib/server/db/testIsolation');
const { migrationDatabaseUrl, databaseUrl } = getEnvironment();
if (migrationDatabaseUrl) assertMigrationIdentity(migrationDatabaseUrl, databaseUrl);

module.exports = defineConfig({
    dialect: 'postgresql',
    schema: path.join(__dirname, 'lib/server/db/schema.js').replaceAll('\\', '/'),
    out: path.relative(process.cwd(), path.join(__dirname, 'drizzle')).replaceAll('\\', '/') || './drizzle',
    dbCredentials: { url: migrationDatabaseUrl || 'postgresql://invalid:invalid@127.0.0.1:1/painttrack' },
    migrations: { table: '__drizzle_migrations', schema: 'public', migrationsSchema: 'public' },
});
