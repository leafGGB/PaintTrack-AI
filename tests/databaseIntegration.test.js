const test = require('node:test');
const assert = require('node:assert/strict');
const { getEnvironment } = require('../lib/server/env');
const { assertIsolatedTestTarget } = require('../lib/server/db/testIsolation');

const env = getEnvironment();
const testDatabaseUrl = env.testDatabaseUrl;
const developmentDatabaseUrl = env.databaseUrl;

if (!testDatabaseUrl) {
    test('PostgreSQL integration suite requires TEST_DATABASE_URL', { skip: true }, () => {});
} else {
    assertIsolatedTestTarget({
        testDatabaseUrl, databaseUrl: developmentDatabaseUrl,
        migrationDatabaseUrl: env.migrationDatabaseUrl,
        testMigrationDatabaseUrl: env.testMigrationDatabaseUrl,
    });
    if (!env.testMigrationDatabaseUrl) {
        throw new Error('TEST_MIGRATION_DATABASE_URL is required for database integration migrations');
    }
    const { migrateDatabase } = require('../lib/server/db/migrate');
    const { Pool } = require('pg');
    const { claimNextTask, createTask, recoverExpiredTasks } = require('../lib/server/worker/taskQueue');
    const { createAsset, getAsset, transitionAsset } = require('../lib/server/assetService');

    test('isolated PostgreSQL accepts repeated migrations and task queue operations', async () => {
        const pool = new Pool({ connectionString: testDatabaseUrl, max: 4, connectionTimeoutMillis: 3000 });
        const insertedTaskIds = [];
        const insertedAssetIds = [];
        try {
            const migrationSettings = {
                migrationDatabaseUrl: env.testMigrationDatabaseUrl,
                databaseUrl: testDatabaseUrl,
                localDatabaseAdminUrl: process.env.LOCAL_DATABASE_ADMIN_URL,
            };
            await migrateDatabase(migrationSettings);
            await migrateDatabase(migrationSettings);
            const result = await pool.query('select 1 as healthy');
            assert.equal(result.rows[0].healthy, 1);

            const tables = await pool.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public'");
            assert.ok(tables.rows.some((row) => row.tablename === 'assets'));
            assert.ok(tables.rows.some((row) => row.tablename === 'generation_tasks'));

            const ownerId = '00000000-0000-4000-8000-000000000001';
            const insertedAsset = await pool.query(
                `INSERT INTO assets (owner_id, media_type, mime_type, size_bytes, status, metadata)
                 VALUES ($1, 'image', 'image/png', 1024, 'pending', $2::jsonb)
                 RETURNING id, owner_id, media_type, size_bytes, status, metadata`,
                [ownerId, JSON.stringify({ marker: 'asset-integration-test' })],
            );
            const assetId = insertedAsset.rows[0].id;
            insertedAssetIds.push(assetId);
            assert.equal(insertedAsset.rows[0].owner_id, ownerId);
            assert.equal(insertedAsset.rows[0].size_bytes, '1024');
            assert.deepEqual(insertedAsset.rows[0].metadata, { marker: 'asset-integration-test' });

            await assert.rejects(
                pool.query(
                    `INSERT INTO assets (owner_id, media_type, size_bytes)
                     VALUES ($1, 'image', -1)`,
                    [ownerId],
                ),
                (error) => error.code === '23514',
            );

            const readyAsset = await pool.query(
                `UPDATE assets SET status = 'ready', storage_key = $2
                 WHERE id = $1 RETURNING status, storage_key`,
                [assetId, 'local-test-only/object-1'],
            );
            assert.equal(readyAsset.rows[0].status, 'ready');
            assert.equal(readyAsset.rows[0].storage_key, 'local-test-only/object-1');

            const deletedAsset = await pool.query(
                `UPDATE assets SET status = 'deleted', deleted_at = now()
                 WHERE id = $1 RETURNING status, deleted_at`,
                [assetId],
            );
            assert.equal(deletedAsset.rows[0].status, 'deleted');
            assert.ok(deletedAsset.rows[0].deleted_at);

            // Service-layer lifecycle: ownership isolation, conditional updates,
            // retries, concurrent claims, timestamps, and terminal soft deletion.
            const serviceAsset = await createAsset(pool, {
                ownerId, mediaType: 'image', sizeBytes: 0, metadata: { service: true },
            });
            insertedAssetIds.push(serviceAsset.id);
            assert.equal(serviceAsset.status, 'pending');
            const otherOwnerId = '00000000-0000-4000-8000-000000000099';
            assert.equal(await getAsset(pool, { assetId: serviceAsset.id, ownerId: otherOwnerId }), null);
            const move = (expectedStatus, status, extra = {}) => transitionAsset(pool, {
                assetId: serviceAsset.id, ownerId, expectedStatus, status, ...extra,
            });
            const conflict = (error) => error.code === 'ASSET_CONFLICT';
            await assert.rejects(move('pending', 'uploading', { ownerId: otherOwnerId }), conflict);
            await assert.rejects(transitionAsset(pool, {
                assetId: '00000000-0000-4000-8000-000000000000',
                ownerId, expectedStatus: 'pending', status: 'uploading',
            }), conflict);
            await assert.rejects(move('pending', 'ready', { storageKey: 'test/object' }),
                (error) => error.code === 'INVALID_TRANSITION');
            assert.equal((await getAsset(pool, { assetId: serviceAsset.id, ownerId })).status, 'pending');
            await pool.query("UPDATE assets SET updated_at = now() - interval '1 day' WHERE id = $1", [serviceAsset.id]);
            const concurrentMoves = await Promise.allSettled([
                move('pending', 'uploading'), move('pending', 'uploading'),
            ]);
            assert.equal(concurrentMoves.filter((entry) => entry.status === 'fulfilled').length, 1);
            assert.equal(concurrentMoves.filter((entry) => entry.status === 'rejected' && conflict(entry.reason)).length, 1);
            const uploadingAsset = concurrentMoves.find((entry) => entry.status === 'fulfilled').value;
            assert.ok(uploadingAsset.updated_at >= serviceAsset.created_at);
            await move('uploading', 'failed');
            await move('failed', 'uploading');
            const serviceReady = await move('uploading', 'ready', {
                storageKey: 'local-test-only/service-object',
                thumbnailStorageKey: 'local-test-only/service-thumb',
                checksumSha256: 'a'.repeat(64),
            });
            assert.equal(serviceReady.deleted_at, null);
            assert.equal(serviceReady.storage_key, 'local-test-only/service-object');
            assert.equal(serviceReady.thumbnail_storage_key, 'local-test-only/service-thumb');
            assert.equal(serviceReady.checksum_sha256, 'a'.repeat(64));
            const persistedReady = await getAsset(pool, { assetId: serviceAsset.id, ownerId });
            assert.equal(persistedReady.storage_key, serviceReady.storage_key);
            assert.equal(persistedReady.thumbnail_storage_key, serviceReady.thumbnail_storage_key);
            assert.equal(persistedReady.checksum_sha256, serviceReady.checksum_sha256);
            await assert.rejects(move('uploading', 'failed'), conflict);
            const serviceDeleted = await move('ready', 'deleted');
            assert.ok(serviceDeleted.deleted_at instanceof Date);
            assert.equal(serviceDeleted.storage_key, serviceReady.storage_key);
            assert.equal(serviceDeleted.thumbnail_storage_key, serviceReady.thumbnail_storage_key);
            await assert.rejects(move('ready', 'deleted'), conflict);
            await assert.rejects(move('deleted', 'uploading'), (error) => error.code === 'INVALID_TRANSITION');
            assert.equal((await getAsset(pool, { assetId: serviceAsset.id, ownerId })).status, 'deleted');

            const minimalAsset = await createAsset(pool, { ownerId, mediaType: 'document' });
            insertedAssetIds.push(minimalAsset.id);
            await transitionAsset(pool, {
                assetId: minimalAsset.id, ownerId, expectedStatus: 'pending', status: 'uploading',
            });
            const minimalReady = await transitionAsset(pool, {
                assetId: minimalAsset.id, ownerId, expectedStatus: 'uploading', status: 'ready',
                storageKey: 'local-test-only/minimal-object',
            });
            assert.equal(minimalReady.storage_key, 'local-test-only/minimal-object');
            assert.equal(minimalReady.thumbnail_storage_key, null);
            assert.equal(minimalReady.checksum_sha256, null);

            const firstTask = await createTask(pool, {
                ownerId,
                idempotencyKey: 'integration:parallel:1',
                requestFingerprint: 'a'.repeat(64),
                taskType: 'integration-test',
                payload: { marker: `parallel-${Date.now()}` },
            });
            assert.equal(firstTask.inserted, true);
            const firstTaskId = firstTask.task.id;
            insertedTaskIds.push(firstTaskId);
            const claims = await Promise.all([
                claimNextTask(pool, {
                    workerId: 'integration-worker-a',
                    leaseSeconds: 30,
                    taskType: 'integration-test',
                }),
                claimNextTask(pool, {
                    workerId: 'integration-worker-b',
                    leaseSeconds: 30,
                    taskType: 'integration-test',
                }),
            ]);
            const claimedIds = claims.filter(Boolean).map((task) => task.id);
            assert.equal(claimedIds.filter((id) => id === firstTaskId).length, 1);
            assert.equal(new Set(claimedIds).size, claimedIds.length);

            const secondTask = await createTask(pool, {
                ownerId,
                idempotencyKey: 'integration:expiry:1',
                requestFingerprint: 'b'.repeat(64),
                taskType: 'integration-test-expiry',
                payload: { marker: `expiry-${Date.now()}` },
                maxAttempts: 2,
            });
            const secondTaskId = secondTask.task.id;
            insertedTaskIds.push(secondTaskId);
            const secondClaim = await claimNextTask(pool, {
                workerId: 'integration-worker-expiry',
                leaseSeconds: 30,
                taskType: 'integration-test-expiry',
            });
            assert.equal(secondClaim.id, secondTaskId);
            await pool.query(
                'UPDATE generation_tasks SET lease_expires_at = now() - interval \'1 second\' WHERE id = $1',
                [secondTaskId],
            );
            assert.equal(await recoverExpiredTasks(pool), 1);
            const recovered = await pool.query('SELECT status, attempts, lease_token FROM generation_tasks WHERE id = $1', [secondTaskId]);
            assert.equal(recovered.rows[0].status, 'queued');
            assert.equal(recovered.rows[0].attempts, 1);
            assert.equal(recovered.rows[0].lease_token, null);
        } finally {
            try {
                if (insertedAssetIds.length) {
                    await pool.query('DELETE FROM assets WHERE id = ANY($1::uuid[])', [insertedAssetIds]);
                }
                if (insertedTaskIds.length) {
                    await pool.query('DELETE FROM generation_tasks WHERE id = ANY($1::uuid[])', [insertedTaskIds]);
                }
            } finally {
                await pool.end();
            }
        }
    });
}
