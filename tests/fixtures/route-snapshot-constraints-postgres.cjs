const assert = require('node:assert/strict');
const crypto = require('node:crypto');

async function checkRouteSnapshotConstraints(owner, record) {
    const logicalModelId = crypto.randomUUID();
    const taskId = crypto.randomUUID();
    const ownerUserId = crypto.randomUUID();
    await owner.query('BEGIN');
    await owner.query(`INSERT INTO users (id, email, password_hash, email_verified_at)
        VALUES ($1, $2, $3, clock_timestamp())`, [
        ownerUserId,
        `route-constraint-${logicalModelId}@example.test`,
        `scrypt:32768:8:3:${crypto.randomBytes(16).toString('hex')}:${crypto.randomBytes(64).toString('hex')}`,
    ]);
    try {
        await owner.query(`INSERT INTO logical_models (
            id, logical_model_id, display_name, media_type, supported_operations,
            capability_template_key, capability_template_version, parameter_schema, parameter_schema_version
        ) VALUES ($1, $2, 'Constraint probe', 'image', '["image.generate"]'::jsonb, NULL, NULL, NULL, NULL)`,
        [logicalModelId, `constraint-probe-${logicalModelId}`]);
        await owner.query(`INSERT INTO generation_tasks (
            id, owner_id, idempotency_key, request_fingerprint, task_type, payload,
            logical_model_pk, route_snapshot, route_snapshot_version, route_snapshot_hash
        ) VALUES ($1, $2, $3, $4, 'route-constraint-probe', '{}'::jsonb, NULL, NULL, NULL, NULL)`,
        [taskId, ownerUserId, `route-probe:${logicalModelId}`, 'a'.repeat(64)]);

        const invalidRows = [
            ["UPDATE logical_models SET capability_template_key='template', capability_template_version=NULL WHERE id=$1", [logicalModelId], 'logical_models_template_pair_check'],
            ["UPDATE logical_models SET capability_template_key=NULL, capability_template_version=1 WHERE id=$1", [logicalModelId], 'logical_models_template_pair_check'],
            ["UPDATE logical_models SET parameter_schema='{}'::jsonb, parameter_schema_version=NULL WHERE id=$1", [logicalModelId], 'logical_models_schema_pair_check'],
            ["UPDATE logical_models SET parameter_schema=NULL, parameter_schema_version=1 WHERE id=$1", [logicalModelId], 'logical_models_schema_pair_check'],
            ["UPDATE generation_tasks SET route_snapshot='{}'::jsonb WHERE id=$1", [taskId], 'generation_tasks_route_snapshot_consistency_check'],
            ["UPDATE generation_tasks SET route_snapshot=NULL, route_snapshot_version=1 WHERE id=$1", [taskId], 'generation_tasks_route_snapshot_consistency_check'],
            ["UPDATE generation_tasks SET route_snapshot='{}'::jsonb, route_snapshot_version=1, route_snapshot_hash=NULL, logical_model_pk=$2 WHERE id=$1", [taskId, logicalModelId], 'generation_tasks_route_snapshot_consistency_check'],
            ["UPDATE generation_tasks SET route_snapshot='{}'::jsonb, route_snapshot_version=NULL, route_snapshot_hash=$2, logical_model_pk=$3 WHERE id=$1", [taskId, 'b'.repeat(64), logicalModelId], 'generation_tasks_route_snapshot_consistency_check'],
            ["UPDATE generation_tasks SET route_snapshot='{}'::jsonb, route_snapshot_version=1, route_snapshot_hash=$2, logical_model_pk=NULL WHERE id=$1", [taskId, 'b'.repeat(64)], 'generation_tasks_route_snapshot_consistency_check'],
        ];
        for (const [statement, params, constraint] of invalidRows) {
            await owner.query('SAVEPOINT invalid_pair');
            await assert.rejects(owner.query(statement, params), (error) => error.code === '23514' && error.constraint === constraint);
            await owner.query('ROLLBACK TO SAVEPOINT invalid_pair');
        }
        await owner.query(`UPDATE logical_models SET
            capability_template_key='template', capability_template_version=1,
            parameter_schema='{}'::jsonb, parameter_schema_version=1 WHERE id=$1`, [logicalModelId]);
        await owner.query(`UPDATE generation_tasks SET logical_model_pk=$2, route_snapshot='{}'::jsonb,
            route_snapshot_version=1, route_snapshot_hash=$3 WHERE id=$1`, [taskId, logicalModelId, 'c'.repeat(64)]);
        const complete = await owner.query('SELECT logical_model_pk, route_snapshot_version, length(route_snapshot_hash) AS hash_length FROM generation_tasks WHERE id=$1', [taskId]);
        assert.equal(complete.rows[0].logical_model_pk, logicalModelId);
        assert.equal(complete.rows[0].route_snapshot_version, 1);
        assert.equal(complete.rows[0].hash_length, 64);
        record('模板/schema 与路由快照 nullable pair 的真实 PostgreSQL 单边 NULL 负例及全空/完整正例', 'passed', { rejectedCases: invalidRows.length });
    } finally {
        await owner.query('ROLLBACK');
    }
}

module.exports = { checkRouteSnapshotConstraints };
