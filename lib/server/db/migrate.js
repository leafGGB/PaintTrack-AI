const path = require('node:path');
const { Client } = require('pg');
const { drizzle } = require('drizzle-orm/node-postgres');
const { migrate } = require('drizzle-orm/node-postgres/migrator');
const { assertMigrationIdentity } = require('./testIsolation');

const migrationConfig = Object.freeze({
    migrationsFolder: path.resolve(__dirname, '../../../drizzle'),
    migrationsSchema: 'public',
    migrationsTable: '__drizzle_migrations',
});

async function migrateDatabase({ migrationDatabaseUrl, databaseUrl }, dependencies = {}) {
    assertMigrationIdentity(migrationDatabaseUrl, databaseUrl);
    const DatabaseClient = dependencies.Client || Client;
    const apply = dependencies.migrate || migrate;
    const client = new DatabaseClient({
        connectionString: migrationDatabaseUrl,
        connectionTimeoutMillis: 3000,
        application_name: 'painttrack-migrator',
    });
    let locked = false;
    try {
        await client.connect();
        await client.query("SET lock_timeout = '5s'");
        await client.query("SET statement_timeout = '60s'");
        await client.query('SELECT pg_advisory_lock(724196231)');
        locked = true;
        await apply(drizzle(client), migrationConfig);
    } finally {
        try {
            if (locked) await client.query('SELECT pg_advisory_unlock(724196231)');
        } finally {
            await client.end();
        }
    }
}

module.exports = { migrateDatabase, migrationConfig };
