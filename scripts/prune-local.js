// `--prune` for the local development launcher.
//
// Two kinds of leftovers accumulate on a dev machine:
//
//   1. `.next_local_<suffix>` build dirs. `localDatabasePlan()` mints a fresh
//      suffix per run when `--fresh` is used, and Next is pointed at
//      `PAINTTRACK_DIST_DIR=.next_local_<suffix>`. They are gitignored, never
//      reused, and each one is a full Next build tree.
//   2. Historical local databases `pt_local_auth_<suffix>` plus their four
//      `pt_local_{migrate,runtime,worker,cleanup}_<suffix>` roles, left behind
//      by every `--fresh` run. The default reused database
//      (`pt_local_auth_000000000000`) must never be touched.
//
// Safety rules, in the order they are applied — a prune that guesses is worse
// than no prune at all:
//
//   - Only entries matching the exact prefixes are considered. `.next/`,
//     `.local-assets/` (user data) and `.local-state/` (the persisted MFA key:
//     deleting it orphans every enrolled TOTP secret) can never match.
//   - The default database is always kept, even though it matches the pattern.
//   - A database whose owner is not `pt_local_migrate_*` is not provably ours,
//     so it is skipped and reported, never dropped.
//   - A database with live connections is skipped; we do not terminate other
//     people's sessions.
//   - `--prune` alone is a DRY RUN. Destructive work requires `--yes`, so the
//     list can be reviewed first.
//   - A build dir that a running dev server still holds open cannot be removed.
//     That is reported as PRUNE_DIST_FAILED plus a hint and exits non-zero, so a
//     partial prune can never be mistaken for a clean one.
//
// DROP DATABASE / DROP ROLE need identifier interpolation (they cannot take
// bind parameters), which is exactly why every name is re-validated against
// the patterns below and quoted before it reaches SQL.

const fs = require('node:fs');

const DIST_PREFIX = '.next_local_';
const DIST_PATTERN = /^\.next_local_[a-z0-9_]{1,24}$/;
const LOCAL_DATABASE_PATTERN = /^pt_local_auth_[a-z0-9_]{1,24}$/;
const LOCAL_ROLE_PATTERN = /^pt_local_(?:migrate|runtime|worker|cleanup)_[a-z0-9_]{1,24}$/;

function listDistDirs(root, listDir = (dir) => fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)) {
    return listDir(root).filter((name) => DIST_PATTERN.test(name)).sort();
}

// rows: [{ datname, owner, connections }]
function classifyLocalDatabases({ rows = [], keepDatabase, deriveRoles }) {
    const removable = [];
    const skipped = [];
    for (const row of rows) {
        const name = row.datname;
        if (name === keepDatabase) {
            skipped.push({ name, reason: 'kept: default local database' });
            continue;
        }
        if (!LOCAL_DATABASE_PATTERN.test(name)) {
            skipped.push({ name, reason: 'not a local launcher database' });
            continue;
        }
        const roles = typeof deriveRoles === 'function' ? deriveRoles(row.owner) : null;
        if (!roles) {
            skipped.push({ name, reason: `owner is not pt_local_migrate_* (${row.owner})` });
            continue;
        }
        const connections = Number(row.connections || 0);
        if (connections > 0) {
            skipped.push({ name, reason: `${connections} active connection(s)` });
            continue;
        }
        removable.push({ name, owner: row.owner, roles: Object.values(roles) });
    }
    return { removable, skipped };
}

async function readLocalDatabases(client) {
    const result = await client.query(`SELECT d.datname,
            pg_get_userbyid(d.datdba) AS owner,
            (SELECT count(*)::int FROM pg_stat_activity a WHERE a.datid = d.oid) AS connections
        FROM pg_database d
        WHERE d.datname LIKE 'pt_local_auth%'
        ORDER BY d.datname`);
    return result.rows;
}

async function runPrune({
    root,
    keepDatabase,
    deriveRoles,
    adminUrl = null,
    yes = false,
    createClient = null,
    listDir = undefined,
    removeDir = (dir) => fs.rmSync(dir, { recursive: true, force: true }),
    dirExists = (dir) => fs.existsSync(dir),
    log = (...args) => console.log(...args),
    error = (...args) => console.error(...args),
}) {
    if (typeof keepDatabase !== 'string') throw new Error('PRUNE_REQUIRES_KEEP_DATABASE');
    const summary = { dryRun: !yes, distDirs: [], distRemoved: [], databases: [], dropped: [], rolesDropped: [], skipped: [], failed: [] };

    summary.distDirs = listDistDirs(root, listDir);
    if (summary.distDirs.length) {
        log(`PRUNE_DIST_FOUND ${summary.distDirs.length}`);
        for (const name of summary.distDirs) log(`  ${name}`);
    } else {
        log('PRUNE_DIST_FOUND 0');
    }
    if (yes) {
        for (const name of summary.distDirs) {
            try {
                removeDir(`${root}/${name}`);
                summary.distRemoved.push(name);
                log(`PRUNE_DIST_REMOVED ${name}`);
            } catch (cause) {
                summary.failed.push({ name, reason: cause.code || cause.message });
                error(`PRUNE_DIST_FAILED ${name} ${cause.code || cause.message}`);
                // The usual cause is not a permissions problem: Windows refuses to
                // unlink or rename a directory tree that a live `next dev` (and the
                // launcher that spawned it) still holds open. Say so instead of
                // letting the operator chase a phantom fs bug.
                if (dirExists(`${root}/${name}`)) {
                    error(`PRUNE_DIST_HINT ${name} still present: a running local dev server (launcher / next dev) is probably holding this build directory open; stop it and rerun`);
                }
            }
        }
    }

    if (!adminUrl) {
        log('PRUNE_DATABASES_SKIPPED no LOCAL_DATABASE_ADMIN_URL (build dirs only)');
    } else if (typeof createClient !== 'function') {
        log('PRUNE_DATABASES_SKIPPED no database client available');
    } else {
        const client = createClient(adminUrl);
        try {
            await client.connect();
            const rows = await readLocalDatabases(client);
            const { removable, skipped } = classifyLocalDatabases({ rows, keepDatabase, deriveRoles });
            summary.databases = removable.map((entry) => entry.name);
            summary.skipped.push(...skipped);
            log(`PRUNE_DATABASE_FOUND ${removable.length}`);
            for (const entry of removable) log(`  ${entry.name} (owner ${entry.owner})`);
            for (const entry of skipped) log(`PRUNE_DATABASE_KEPT ${entry.name} ${entry.reason}`);

            if (yes) {
                for (const entry of removable) {
                    if (!LOCAL_DATABASE_PATTERN.test(entry.name)) {
                        summary.failed.push({ name: entry.name, reason: 'PRUNE_NAME_REJECTED' });
                        error(`PRUNE_DATABASE_REJECTED ${entry.name}`);
                        continue;
                    }
                    try {
                        await client.query(`DROP DATABASE "${entry.name}"`);
                        summary.dropped.push(entry.name);
                        log(`PRUNE_DATABASE_DROPPED ${entry.name}`);
                    } catch (cause) {
                        summary.failed.push({ name: entry.name, reason: cause.code || cause.message });
                        error(`PRUNE_DATABASE_FAILED ${entry.name} ${cause.code || cause.message}`);
                        continue;
                    }
                    for (const role of entry.roles) {
                        if (!LOCAL_ROLE_PATTERN.test(role)) continue;
                        try {
                            await client.query(`DROP ROLE IF EXISTS "${role}"`);
                            summary.rolesDropped.push(role);
                        } catch (cause) {
                            // 2BP01: the role still owns objects elsewhere. Keep it and say so.
                            summary.skipped.push({ name: role, reason: `role retained: ${cause.code || cause.message}` });
                        }
                    }
                }
            }
        } catch (cause) {
            summary.failed.push({ name: 'database-scan', reason: cause.code || cause.message });
            error(`PRUNE_DATABASE_SCAN_FAILED ${cause.code || cause.message}`);
        } finally {
            await client.end().catch(() => {});
        }
    }

    if (!yes) log('PRUNE_DRY_RUN (add --yes to delete the entries listed above)');
    log(`PRUNE_DONE dist=${summary.distDirs.length} databases=${summary.databases.length} dropped=${summary.dropped.length} roles=${summary.rolesDropped.length} skipped=${summary.skipped.length} failed=${summary.failed.length}`);
    return summary;
}

module.exports = {
    DIST_PATTERN,
    DIST_PREFIX,
    LOCAL_DATABASE_PATTERN,
    LOCAL_ROLE_PATTERN,
    classifyLocalDatabases,
    listDistDirs,
    readLocalDatabases,
    runPrune,
};
