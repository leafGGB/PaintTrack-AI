// `--prune` deletes build dirs and databases, so the interesting tests are the
// ones that prove it refuses to delete the wrong things: the reused default
// database, a database owned by someone else, a database with live connections,
// and anything that is not `.next_local_*` (notably `.local-assets/` and
// `.local-state/`, which hold user data and the persisted MFA key).

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    DIST_PREFIX,
    classifyLocalDatabases,
    listDistDirs,
    runPrune,
} = require('../scripts/prune-local');
const { createNextEnvironment, localRolesFromOwner } = require('../scripts/local-registration');

const KEEP = 'pt_local_auth_000000000000';

function fakeClient({ rows = [], failDrop = new Set(), failRole = new Set() } = {}) {
    const queries = [];
    return {
        queries,
        async connect() {},
        async end() {},
        async query(text) {
            queries.push(text);
            if (/FROM pg_database/.test(text)) return { rows };
            const dropDatabase = /^DROP DATABASE "(.+)"$/.exec(text);
            if (dropDatabase) {
                if (failDrop.has(dropDatabase[1])) {
                    const error = new Error('database is being accessed');
                    error.code = '55006';
                    throw error;
                }
                return { rows: [] };
            }
            const dropRole = /^DROP ROLE IF EXISTS "(.+)"$/.exec(text);
            if (dropRole) {
                if (failRole.has(dropRole[1])) {
                    const error = new Error('role has dependencies');
                    error.code = '2BP01';
                    throw error;
                }
                return { rows: [] };
            }
            return { rows: [] };
        },
    };
}

test('listDistDirs only matches .next_local_* and never user-state directories', () => {
    const entries = ['.next', '.next_local_abc123', '.next_local_0f9e8d', '.local-assets', '.local-state', 'dist', 'node_modules'];

    assert.deepEqual(listDistDirs('/repo', () => entries), ['.next_local_0f9e8d', '.next_local_abc123']);
});

test('DIST_PREFIX matches what the launcher actually configures for Next', () => {
    // Guards against someone renaming the prefix in one file only, which would
    // make `--prune` silently stop finding build dirs (or worse, match `.next`).
    const environment = createNextEnvironment({
        runtimeUrl: 'postgres://pt_local_runtime_x@127.0.0.1:5433/pt_local_auth_x',
        internalPort: 3001,
        origin: 'http://127.0.0.1:3000',
        secret: 'a'.repeat(64),
        mfaEncryptionKey: 'b'.repeat(64),
        suffix: 'abc123',
        heapMb: 3072,
    });

    assert.equal(environment.PAINTTRACK_DIST_DIR, `${DIST_PREFIX}abc123`);
});

test('classifyLocalDatabases keeps the default database even though it matches the pattern', () => {
    const { removable, skipped } = classifyLocalDatabases({
        keepDatabase: KEEP,
        deriveRoles: localRolesFromOwner,
        rows: [{ datname: KEEP, owner: 'pt_local_migrate_000000000000', connections: 0 }],
    });

    assert.deepEqual(removable, []);
    assert.equal(skipped[0].reason, 'kept: default local database');
});

test('classifyLocalDatabases refuses databases it cannot prove it owns', () => {
    const { removable, skipped } = classifyLocalDatabases({
        keepDatabase: KEEP,
        deriveRoles: localRolesFromOwner,
        rows: [
            { datname: 'pt_local_auth_foreign', owner: 'postgres', connections: 0 },
            { datname: 'painttrack_dev', owner: 'pt_local_migrate_dev', connections: 0 },
        ],
    });

    assert.deepEqual(removable, []);
    assert.deepEqual(skipped.map((entry) => entry.name), ['pt_local_auth_foreign', 'painttrack_dev']);
});

test('classifyLocalDatabases skips databases with live connections', () => {
    const { removable, skipped } = classifyLocalDatabases({
        keepDatabase: KEEP,
        deriveRoles: localRolesFromOwner,
        rows: [{ datname: 'pt_local_auth_busy', owner: 'pt_local_migrate_busy', connections: 3 }],
    });

    assert.deepEqual(removable, []);
    assert.match(skipped[0].reason, /3 active connection/);
});

test('classifyLocalDatabases accepts an idle database it owns and knows its four roles', () => {
    const { removable } = classifyLocalDatabases({
        keepDatabase: KEEP,
        deriveRoles: localRolesFromOwner,
        rows: [{ datname: 'pt_local_auth_abc123', owner: 'pt_local_migrate_abc123', connections: 0 }],
    });

    assert.equal(removable.length, 1);
    assert.deepEqual(removable[0].roles.sort(), [
        'pt_local_cleanup_abc123',
        'pt_local_migrate_abc123',
        'pt_local_runtime_abc123',
        'pt_local_worker_abc123',
    ]);
});

test('dry run reports everything and deletes nothing', async () => {
    const client = fakeClient({ rows: [{ datname: 'pt_local_auth_abc123', owner: 'pt_local_migrate_abc123', connections: 0 }] });
    const removed = [];
    const lines = [];

    const summary = await runPrune({
        root: '/repo',
        keepDatabase: KEEP,
        deriveRoles: localRolesFromOwner,
        adminUrl: 'postgres://postgres@127.0.0.1:5433/postgres',
        createClient: () => client,
        listDir: () => ['.next_local_abc123'],
        removeDir: (dir) => removed.push(dir),
        log: (line) => lines.push(String(line)),
        error: () => {},
    });

    assert.equal(summary.dryRun, true);
    assert.deepEqual(removed, []);
    assert.equal(summary.distDirs.length, 1);
    assert.equal(summary.databases.length, 1);
    assert.ok(client.queries.some((sql) => /FROM pg_database/.test(sql)));
    assert.ok(!client.queries.some((sql) => /DROP /.test(sql)));
    assert.ok(lines.some((line) => line.startsWith('PRUNE_DRY_RUN')));
});

test('--yes removes build dirs, drops the database and its roles', async () => {
    const client = fakeClient({ rows: [{ datname: 'pt_local_auth_abc123', owner: 'pt_local_migrate_abc123', connections: 0 }] });
    const removed = [];
    const lines = [];

    const summary = await runPrune({
        root: '/repo',
        keepDatabase: KEEP,
        deriveRoles: localRolesFromOwner,
        adminUrl: 'postgres://postgres@127.0.0.1:5433/postgres',
        yes: true,
        createClient: () => client,
        listDir: () => ['.next_local_abc123', '.local-assets'],
        removeDir: (dir) => removed.push(dir),
        log: (line) => lines.push(String(line)),
        error: (line) => lines.push(String(line)),
    });

    assert.deepEqual(removed, ['/repo/.next_local_abc123']);
    assert.deepEqual(summary.dropped, ['pt_local_auth_abc123']);
    assert.equal(summary.rolesDropped.length, 4);
    assert.ok(client.queries.includes('DROP DATABASE "pt_local_auth_abc123"'));
    assert.ok(client.queries.includes('DROP ROLE IF EXISTS "pt_local_runtime_abc123"'));
    assert.equal(summary.failed.length, 0);
});

test('a build dir held open by a running dev server is reported with a hint', async () => {
    const errors = [];

    const summary = await runPrune({
        root: '/repo',
        keepDatabase: KEEP,
        deriveRoles: localRolesFromOwner,
        yes: true,
        listDir: () => ['.next_local_abc123'],
        removeDir: () => {
            const cause = new Error('EPERM: operation not permitted');
            cause.code = 'EPERM';
            throw cause;
        },
        // 目录仍在 = 被占用；这是 Windows 上 dev server 持有构建目录的典型表现
        dirExists: () => true,
        log: () => {},
        error: (line) => errors.push(String(line)),
    });

    assert.deepEqual(summary.distRemoved, []);
    assert.equal(summary.failed.length, 1);
    assert.equal(summary.failed[0].reason, 'EPERM');
    assert.ok(errors.some((line) => line.startsWith('PRUNE_DIST_FAILED .next_local_abc123')));
    assert.ok(
        errors.some((line) => line.startsWith('PRUNE_DIST_HINT .next_local_abc123') && /dev server/.test(line)),
        'expected an actionable hint about the running dev server',
    );
});

test('a build dir that vanished despite the error gets no misleading hint', async () => {
    const errors = [];

    await runPrune({
        root: '/repo',
        keepDatabase: KEEP,
        deriveRoles: localRolesFromOwner,
        yes: true,
        listDir: () => ['.next_local_abc123'],
        removeDir: () => {
            const cause = new Error('ENOENT: no such file or directory');
            cause.code = 'ENOENT';
            throw cause;
        },
        dirExists: () => false,
        log: () => {},
        error: (line) => errors.push(String(line)),
    });

    assert.ok(errors.some((line) => line.startsWith('PRUNE_DIST_FAILED')));
    assert.deepEqual(errors.filter((line) => line.startsWith('PRUNE_DIST_HINT')), []);
});

test('a failed DROP DATABASE is reported and its roles are left alone', async () => {
    const client = fakeClient({
        rows: [{ datname: 'pt_local_auth_busy', owner: 'pt_local_migrate_busy', connections: 0 }],
        failDrop: new Set(['pt_local_auth_busy']),
    });
    const errors = [];

    const summary = await runPrune({
        root: '/repo',
        keepDatabase: KEEP,
        deriveRoles: localRolesFromOwner,
        adminUrl: 'postgres://postgres@127.0.0.1:5433/postgres',
        yes: true,
        createClient: () => client,
        listDir: () => [],
        removeDir: () => {},
        log: () => {},
        error: (line) => errors.push(String(line)),
    });

    assert.deepEqual(summary.dropped, []);
    assert.equal(summary.failed[0].reason, '55006');
    assert.deepEqual(summary.rolesDropped, []);
    assert.ok(errors.some((line) => line.startsWith('PRUNE_DATABASE_FAILED')));
});

test('a role that is still referenced is kept and reported, not forced', async () => {
    const client = fakeClient({
        rows: [{ datname: 'pt_local_auth_abc123', owner: 'pt_local_migrate_abc123', connections: 0 }],
        failRole: new Set(['pt_local_migrate_abc123']),
    });

    const summary = await runPrune({
        root: '/repo',
        keepDatabase: KEEP,
        deriveRoles: localRolesFromOwner,
        adminUrl: 'postgres://postgres@127.0.0.1:5433/postgres',
        yes: true,
        createClient: () => client,
        listDir: () => [],
        removeDir: () => {},
        log: () => {},
        error: () => {},
    });

    assert.equal(summary.rolesDropped.length, 3);
    assert.ok(summary.skipped.some((entry) => entry.name === 'pt_local_migrate_abc123' && /2BP01/.test(entry.reason)));
    assert.equal(summary.failed.length, 0);
});

test('without an admin URL it still cleans build dirs and says databases were skipped', async () => {
    const removed = [];
    const lines = [];

    const summary = await runPrune({
        root: '/repo',
        keepDatabase: KEEP,
        deriveRoles: localRolesFromOwner,
        adminUrl: null,
        yes: true,
        listDir: () => ['.next_local_abc123'],
        removeDir: (dir) => removed.push(dir),
        log: (line) => lines.push(String(line)),
        error: () => {},
    });

    assert.deepEqual(removed, ['/repo/.next_local_abc123']);
    assert.deepEqual(summary.databases, []);
    assert.ok(lines.some((line) => line.startsWith('PRUNE_DATABASES_SKIPPED')));
});
