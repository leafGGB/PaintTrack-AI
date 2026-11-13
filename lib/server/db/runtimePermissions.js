// 仅迁移/本机准备进程使用；应用运行进程不调用授权 SQL。
const ROLE_PATTERN = /^pt_(?:local_(?:runtime|worker|cleanup)_[a-f0-9]{12}|(?:runtime|worker|cleanup)_[a-z0-9]+_[a-f0-9]{6}|runtime_webprobe_[a-f0-9]{6})$/;

function assertRole(role) {
    if (typeof role !== 'string' || !ROLE_PATTERN.test(role)) throw new Error('无效隔离运行角色');
}

async function grantWebRuntimePermissions(client, role) {
    assertRole(role);
    // 只为全新、无继承成员关系的运行角色授权；不通过宽泛 REVOKE 改动现有角色权限。
    await client.query(`GRANT SELECT,DELETE ON public.users TO "${role}"`);
    await client.query(`GRANT INSERT(id,email,password_hash,email_verified_at,created_at),UPDATE(password_hash,email_verified_at) ON public.users TO "${role}"`);
    await client.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON email_verification_tokens,password_reset_tokens,auth_rate_limits,auth_sessions,admin_mfa_factors,admin_recovery_codes TO "${role}"`);
    await client.query(`GRANT INSERT ON email_outbox TO "${role}"`);
    await client.query(`GRANT SELECT ON assets TO "${role}"`);
    // 用户删除只走软删除：仅这三列可写，mime_type/size_bytes/storage_key 等元数据
    // 与物理对象归属仍由 Worker 归档与后续清理流程掌握，Web 不能篡改。
    await client.query(`GRANT UPDATE(status,updated_at,deleted_at) ON assets TO "${role}"`);
    await client.query(`GRANT SELECT (id,logical_model_id,display_name,provider_display_name,media_type,supported_operations,capability_template_key,capability_template_version,parameter_schema,parameter_schema_version,description,icon_key,enabled,sort_order,catalog_version,updated_at) ON logical_models TO "${role}"`);
    await client.query(`GRANT SELECT ON model_catalog_public TO "${role}"`);
    await client.query(`GRANT INSERT ON provider_config_audit_events TO "${role}"`);
    await client.query(`GRANT SELECT ON generation_tasks TO "${role}"`);
    await client.query(`GRANT INSERT(task_type,payload,max_attempts,available_at,updated_at,owner_id,idempotency_key,request_fingerprint) ON generation_tasks TO "${role}"`);
    await client.query(`GRANT UPDATE(status,cancel_requested_at,completed_at,updated_at) ON generation_tasks TO "${role}"`);
}

async function grantWorkerRuntimePermissions(client, role) {
    assertRole(role);
    await client.query(`GRANT SELECT ON generation_tasks TO "${role}"`);
    await client.query(`GRANT UPDATE(status,attempts,available_at,lease_token,lease_expires_at,worker_id,last_error,updated_at,completed_at,result) ON generation_tasks TO "${role}"`);
    await client.query(`GRANT SELECT,INSERT ON provider_calls TO "${role}"`);
    await client.query(`GRANT UPDATE(status,provider_job_id,worker_id,lease_token,lease_expires_at,available_at,last_error_code,recovery_attempts,updated_at) ON provider_calls TO "${role}"`);
    await client.query(`GRANT SELECT,UPDATE ON email_outbox TO "${role}"`);
    await client.query(`GRANT SELECT ON logical_models TO "${role}"`);
    await client.query(`GRANT INSERT(owner_id,media_type,mime_type,size_bytes,metadata,status) ON assets TO "${role}"`);
    await client.query(`GRANT SELECT(id,owner_id,status) ON assets TO "${role}"`);
    await client.query(`GRANT UPDATE(status,storage_key,thumbnail_storage_key,checksum_sha256,updated_at,deleted_at) ON assets TO "${role}"`);
    await client.query(`GRANT SELECT (id,slug,display_name,adapter_type,base_url,credential_ref,credential_version,enabled,health_state,config_version,created_at,updated_at,disabled_at) ON provider_instances TO "${role}"`);
    await client.query(`GRANT SELECT (id,provider_instance_id,upstream_model_name,media_type,operation_profile,capabilities,parameter_mapping,request_mapping_version,response_mapping_version,validation_state,enabled,created_at,updated_at,disabled_at) ON provider_models TO "${role}"`);
    await client.query(`GRANT SELECT (id,logical_model_pk,provider_model_id,priority,is_primary,enabled,binding_version,created_by,updated_by,created_at,updated_at,disabled_at) ON model_provider_bindings TO "${role}"`);
}

// 兼容既有 Web 初始化调用，但拒绝重新引入同一身份合并 Web/Worker 权限。
async function grantRuntimePermissions(client, role, { worker = false } = {}) {
    if (worker) throw new Error('Web and Worker permissions require distinct database roles');
    return grantWebRuntimePermissions(client, role);
}

/**
 * 资产清理进程专用角色。它只做一件事：把已软删除资产的对象删掉。
 * - 只读定位所需的列，读不到 metadata、checksum、内容本身；
 * - 只写清理进度三列，不能改 status/storage_key，因此无法伪装成归档或删除他人资产；
 * - 没有 INSERT/DELETE 表级权限，也读不到用户、任务、目录等其他表。
 */
async function grantCleanupRuntimePermissions(client, role) {
    assertRole(role);
    // 可读：定位对象所需的键与生命周期时间；created_at 用于判定「这行等了多久」。
    // 可写：只有清理进度列。刻意不含 status/storage_key/mime_type/size_bytes/owner_id ——
    // 验收脚本对这几列有 42501 负例，扩大权限会直接破坏资产归属与状态机的边界。
    await client.query(`GRANT SELECT (id,owner_id,status,storage_key,thumbnail_storage_key,deleted_at,purged_at,purge_attempts,created_at,abandoned_at) ON assets TO "${role}"`);
    await client.query(`GRANT UPDATE(purged_at,purge_attempts,last_purge_error,updated_at,abandoned_at) ON assets TO "${role}"`);
}

module.exports = {
    grantRuntimePermissions, grantWebRuntimePermissions, grantWorkerRuntimePermissions, grantCleanupRuntimePermissions,
};
