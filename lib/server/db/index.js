const { Pool } = require('pg');
const { drizzle } = require('drizzle-orm/node-postgres');
const { sql } = require('drizzle-orm');
const { getEnvironment } = require('../env');

let pool;
let database;
let closing;

function getDatabase() {
    if (closing) throw new Error('Database is closing');
    const { databaseUrl } = getEnvironment();
    if (!databaseUrl) {
        throw new Error('DATABASE_URL is required to access PostgreSQL');
    }

    if (!pool) {
        pool = new Pool({
            connectionString: databaseUrl,
            max: 5,
            connectionTimeoutMillis: 3000,
            idleTimeoutMillis: 10000,
            allowExitOnIdle: true,
        });
        database = drizzle(pool);
    }

    return database;
}

async function checkDatabaseHealth() {
    try {
        await getDatabase().execute(sql`select 1`);
        return { status: 'ok' };
    } catch {
        return { status: 'unavailable' };
    }
}

async function closeDatabase() {
    if (closing) return closing;
    if (!pool) return;
    const currentPool = pool;
    pool = undefined;
    database = undefined;
    closing = currentPool.end();
    try {
        await closing;
    } finally {
        closing = undefined;
    }
}

module.exports = { checkDatabaseHealth, closeDatabase, getDatabase };
