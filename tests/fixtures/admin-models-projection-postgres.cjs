'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { drizzle } = require('drizzle-orm/node-postgres');
const { DrizzleQueryError } = require('drizzle-orm/errors');
const { createAdminModelsProjectionRead } = require('../../lib/server/adminModelsProjectionRead');
const { grantAdminModelsProjectionPermission } = require('../../lib/server/db/runtimePermissions');

const signature = 'public.admin_model_bindings_read(uuid[])';
function expectSqlState(expected) {
    return error => {
        // Drizzle wraps server errors; report only the SQLSTATE, never SQL or arguments.
        const candidate = error instanceof DrizzleQueryError ? error.cause?.code : error?.code;
        const actual = typeof candidate === 'string' && /^[0-9A-Z]{5}$/.test(candidate) ? candidate : 'unknown';
        assert.equal(actual, expected, 'Unexpected PostgreSQL SQLSTATE');
        return true;
    };
}

async function checkAdminModelsProjection(admin, runtimeUrl, names, record) {
    const suffix = /^pt_acceptance_([a-z0-9]+_[a-f0-9]{6})$/.exec(names.database)?.[1];
    assert.ok(suffix);
    assert.equal(names.runtimeRole, `pt_runtime_${suffix}`);
    const pool = new Pool({ connectionString: runtimeUrl, max: 1, connectionTimeoutMillis: 3000 });
    const id = () => 'SELECT current_database() AS db, current_user AS role, session_user AS session';
    try {
        assert.equal((await admin.query(id())).rows[0].db, names.database);
        assert.deepEqual((await pool.query(id())).rows[0], { db: names.database, role: names.runtimeRole, session: names.runtimeRole });
        const acl = (await admin.query(`SELECT p.prosecdef AS definer, p.provolatile AS volatility, p.proconfig AS config,
            r.rolname AS owner, r.rolcanlogin AS login, has_schema_privilege(r.oid,'public','CREATE') AS ddl,
            EXISTS(SELECT 1 FROM pg_auth_members WHERE roleid=r.oid OR member=r.oid) AS memberships,
            EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) WHERE grantee=0 AND privilege_type='EXECUTE') AS public_execute
            FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.oid=$1::regprocedure`, [signature])).rows[0];
        assert.deepEqual(acl, { definer: true, volatility: 's', config: ['search_path=pg_catalog, pg_temp'],
            owner: names.adminModelsOwnerRole, login: false, ddl: false, memberships: false, public_execute: false });
        for (const role of [names.migrationRole, names.workerRole, names.cleanupRole, names.bootstrapRole]) {
            assert.equal((await admin.query('SELECT has_function_privilege($1,$2,\'EXECUTE\') AS allowed', [role, signature])).rows[0].allowed, false);
        }
        for (const table of ['provider_instances', 'provider_models', 'model_provider_bindings', 'pricing_versions']) {
            assert.equal((await pool.query("SELECT has_any_column_privilege(current_user,$1,'SELECT') AS allowed", [`public.${table}`])).rows[0].allowed, false);
        }
        record('管理员模型投影 owner 与运行角色 ACL', 'passed');

        const first = randomUUID(), second = randomUUID(), provider = randomUUID(), tag = `pt-projection-${randomUUID()}`;
        const filter = new URLSearchParams({ q: `${tag}_`, type: 'image' });
        const service = createAdminModelsProjectionRead({ database: drizzle(pool) });
        const bind = (count, offset = 0) => admin.query(`WITH upstream AS (
            INSERT INTO public.provider_models(provider_instance_id,upstream_model_name,media_type,operation_profile,capabilities,parameter_mapping,request_mapping_version,response_mapping_version,validation_state,enabled)
            SELECT $1, $3 || '-' || n, 'image', 'image.generate','{}','{}',1,1,'verified',true
            FROM generate_series($4::int+1,$4::int+$5::int) AS n RETURNING id, upstream_model_name
        ) INSERT INTO public.model_provider_bindings(logical_model_pk,provider_model_id,priority,is_primary,enabled,binding_version)
          SELECT $2,id,substring(upstream_model_name from '[0-9]+$')::int,false,false,3 FROM upstream`, [provider, first, tag, offset, count]);
        try {
            await admin.query(`INSERT INTO public.provider_instances(id,slug,display_name,adapter_type,base_url,credential_ref,enabled)
                VALUES ($1,$2,'Projection probe','openai-compatible','https://projection.invalid/v1','projection-private-reference',true)`, [provider, tag]);
            await admin.query(`INSERT INTO public.logical_models(id,logical_model_id,display_name,provider_display_name,media_type,supported_operations,enabled,sort_order,catalog_version)
                VALUES ($1,$3,$5,'Probe','image','["image.generate"]',false,1,2), ($2,$4,$5,'Probe','image','["image.generate"]',true,2,2)`,
            [first, second, `${tag}-a`, `${tag}-b`, `${tag}_`]);
            await bind(50);
            const result = await service.read(filter);
            const [a, b] = result.data.models;
            assert.deepEqual(result.data.models.map(row => row.logicalModelPk), [first, second]);
            assert.equal(a.enabled, false);
            assert.equal(a.bindings.data.length, 50);
            assert.deepEqual(a.bindings.data[0], { providerInstanceId: provider, providerModelId: a.bindings.data[0].providerModelId,
                routeRole: 'secondary', routeOrder: 1, bindingVersion: 3, active: false });
            assert.deepEqual(a.pricing, { readable: false, reason: 'NOT_AUTHORIZED', data: null });
            assert.deepEqual(b.bindings, { readable: true, data: [] });
            assert.match(result.meta.asOf, /Z$/);
            const pageFilter = new URLSearchParams(filter);
            pageFilter.set('limit', '1');
            const page = await service.read(pageFilter);
            assert.ok(page.data.nextCursor);
            pageFilter.set('cursor', page.data.nextCursor);
            assert.deepEqual((await service.read(pageFilter)).data.models.map(row => row.logicalModelPk), [second]);
            pageFilter.set('enabled', 'false');
            await assert.rejects(service.read(pageFilter), { code: 'INVALID_ADMIN_MODEL_QUERY' });
            record('管理员模型投影真实 DTO、数组绑定与跨页筛选', 'passed');

            await assert.rejects(pool.query(`SELECT * FROM ${signature.replace('uuid[]', '$1::uuid[]')}`, [Array(51).fill(first)]), expectSqlState('22023'));
            await bind(1, 50);
            await assert.rejects(service.read(filter), expectSqlState('54000'));
            await admin.query('DELETE FROM public.model_provider_bindings WHERE logical_model_pk=$1 AND priority=51', [first]);
            const role = `"${names.runtimeRole}"`;
            await admin.query(`REVOKE EXECUTE ON FUNCTION ${signature} FROM ${role}`);
            try {
                await assert.rejects(service.read(filter), expectSqlState('42501'));
            } finally {
                await grantAdminModelsProjectionPermission(admin, names.runtimeRole);
            }
            assert.equal((await service.read(filter)).data.models[0].bindings.data.length, 50);
            assert.equal(pool.waitingCount, 0);
            assert.equal(pool.idleCount, 1);
            record('管理员模型投影批量上限、扇出失败关闭、ACL 拒绝及单连接池恢复', 'passed');
        } finally {
            await admin.query('DELETE FROM public.model_provider_bindings WHERE logical_model_pk=$1', [first]);
            await admin.query('DELETE FROM public.provider_models WHERE provider_instance_id=$1', [provider]);
            await admin.query('DELETE FROM public.logical_models WHERE id=ANY($1::uuid[])', [[first, second]]);
            await admin.query('DELETE FROM public.provider_instances WHERE id=$1', [provider]);
        }
    } finally {
        await pool.end();
    }
}

module.exports = { checkAdminModelsProjection };
