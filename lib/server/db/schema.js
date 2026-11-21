const { sql } = require('drizzle-orm');
const {
    check,
    index,
    uniqueIndex,
    bigint,
    boolean,
    integer,
    jsonb,
    pgTable,
    numeric,
    foreignKey,
    pgView,
    text,
    timestamp,
    uuid,
} = require('drizzle-orm/pg-core');

const schemaVersion = pgTable('__painttrack_schema_version', {
    version: integer('version').primaryKey(),
});

const assets = pgTable(
    'assets',
    {
        id: uuid('id').defaultRandom().primaryKey(),
        ownerId: uuid('owner_id').notNull(),
        mediaType: text('media_type').notNull(),
        mimeType: text('mime_type'),
        sizeBytes: bigint('size_bytes', { mode: 'number' }),
        storageKey: text('storage_key'),
        thumbnailStorageKey: text('thumbnail_storage_key'),
        status: text('status').notNull().default('pending'),
        checksumSha256: text('checksum_sha256'),
        metadata: jsonb('metadata').notNull().default({}),
        createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
        updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
        deletedAt: timestamp('deleted_at', { withTimezone: true }),
        // 软删除只标记意图；物理对象清理是独立流程，用这三列记录进度与最后一次失败，
        // 以便中断后重试，并与「已删除但对象仍在」明确区分。
        purgedAt: timestamp('purged_at', { withTimezone: true }),
        purgeAttempts: integer('purge_attempts').notNull().default(0),
        lastPurgeError: text('last_purge_error'),
        // 归档中途被强杀会留下「对象已写入、行仍是 pending/uploading」的孤儿：
        // 这两种状态按约束不能持有 storage_key，键只能由 (owner_id, id) 推导。
        // 回收成功即写本列；NULL 表示尚未处理，因此它是收敛信号而不是时间戳记录。
        abandonedAt: timestamp('abandoned_at', { withTimezone: true }),
    },
    (table) => ({
        mediaTypeCheck: check(
            'assets_media_type_check',
            sql`${table.mediaType} IN ('image', 'video', 'audio', 'document')`,
        ),
        sizeBytesCheck: check(
            'assets_size_bytes_check',
            sql`${table.sizeBytes} IS NULL OR ${table.sizeBytes} >= 0`,
        ),
        statusCheck: check(
            'assets_status_check',
            sql`${table.status} IN ('pending', 'uploading', 'ready', 'failed', 'deleted')`,
        ),
        statusStorageConsistencyCheck: check(
            'assets_status_storage_consistency_check',
            sql`(${table.status} IN ('pending', 'uploading', 'failed') AND ${table.storageKey} IS NULL) OR (${table.status} IN ('ready', 'deleted') AND ${table.storageKey} IS NOT NULL)`,
        ),
        deletedAtConsistencyCheck: check(
            'assets_deleted_at_consistency_check',
            sql`(${table.status} = 'deleted' AND ${table.deletedAt} IS NOT NULL) OR (${table.status} <> 'deleted' AND ${table.deletedAt} IS NULL)`,
        ),
        checksumSha256FormatCheck: check(
            'assets_checksum_sha256_format_check',
            sql`${table.checksumSha256} IS NULL OR ${table.checksumSha256} ~ '^[0-9a-f]{64}$'`,
        ),
        purgeAttemptsCheck: check(
            'assets_purge_attempts_check',
            sql`${table.purgeAttempts} >= 0`,
        ),
        purgeStateCheck: check(
            'assets_purge_state_check',
            sql`${table.purgedAt} IS NULL OR (${table.status} = 'deleted' AND ${table.purgedAt} >= ${table.deletedAt})`,
        ),
        // 放弃标记只对「从未落盘」的两个状态有意义；一旦回到 ready/deleted，
        // 该列必须为空，否则同一行会同时被两条清理流程认领。
        abandonedStateCheck: check(
            'assets_abandoned_state_check',
            sql`${table.abandonedAt} IS NULL OR (${table.status} IN ('pending', 'uploading') AND ${table.abandonedAt} >= ${table.createdAt})`,
        ),
        ownerCreatedIndex: index('assets_owner_created_idx').on(table.ownerId, table.createdAt),
        statusCreatedIndex: index('assets_status_created_idx').on(table.status, table.createdAt),
        // 清理进程按 deleted_at 顺序认领待清理行；部分索引让扫描只覆盖真正待处理的行。
        purgePendingIndex: index('assets_purge_pending_idx').on(table.deletedAt)
            .where(sql`${table.status} = 'deleted' AND ${table.purgedAt} IS NULL`),
        // 孤儿回收按 created_at 老化顺序认领，同样用部分索引把扫描限制在待处理集合。
        orphanPendingIndex: index('assets_orphan_pending_idx').on(table.createdAt)
            .where(sql`${table.status} IN ('pending', 'uploading') AND ${table.abandonedAt} IS NULL`),
    }),
);

const providerInstances = pgTable('provider_instances', {
    id: uuid('id').defaultRandom().primaryKey(),
    slug: text('slug').notNull(),
    displayName: text('display_name').notNull(),
    adapterType: text('adapter_type').notNull(),
    baseUrl: text('base_url').notNull(),
    credentialRef: text('credential_ref'),
    credentialVersion: integer('credential_version').notNull().default(0),
    enabled: boolean('enabled').notNull().default(false),
    healthState: text('health_state').notNull().default('unknown'),
    configVersion: integer('config_version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
}, (table) => ({
    slugUnique: uniqueIndex('provider_instances_slug_unique').on(table.slug),
    enabledAdapterIndex: index('provider_instances_enabled_adapter_idx').on(table.enabled, table.adapterType),
    slugCheck: check('provider_instances_slug_check', sql`${table.slug} ~ '^[a-z0-9][a-z0-9-]{1,62}$'`),
    credentialVersionCheck: check('provider_instances_credential_version_check', sql`${table.credentialVersion} >= 0`),
    configVersionCheck: check('provider_instances_config_version_check', sql`${table.configVersion} > 0`),
    healthStateCheck: check('provider_instances_health_state_check', sql`${table.healthState} IN ('unknown', 'healthy', 'degraded', 'disabled')`),
    enabledDisabledAtCheck: check('provider_instances_enabled_disabled_at_check', sql`NOT ${table.enabled} OR ${table.disabledAt} IS NULL`),
}));

const providerModels = pgTable('provider_models', {
    id: uuid('id').defaultRandom().primaryKey(),
    providerInstanceId: uuid('provider_instance_id').notNull().references(() => providerInstances.id, { onDelete: 'restrict' }),
    upstreamModelName: text('upstream_model_name').notNull(),
    mediaType: text('media_type').notNull(),
    operationProfile: text('operation_profile').notNull(),
    capabilities: jsonb('capabilities').notNull().default({}),
    parameterMapping: jsonb('parameter_mapping').notNull().default({}),
    requestMappingVersion: integer('request_mapping_version').notNull(),
    responseMappingVersion: integer('response_mapping_version').notNull(),
    validationState: text('validation_state').notNull().default('unverified'),
    enabled: boolean('enabled').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
}, (table) => ({
    providerUpstreamProfileUnique: uniqueIndex('provider_models_provider_upstream_profile_unique').on(table.providerInstanceId, table.upstreamModelName, table.operationProfile),
    providerEnabledValidationIndex: index('provider_models_provider_enabled_validation_idx').on(table.providerInstanceId, table.enabled, table.validationState),
    mediaTypeCheck: check('provider_models_media_type_check', sql`${table.mediaType} IN ('image', 'video')`),
    capabilitiesObjectCheck: check('provider_models_capabilities_object_check', sql`jsonb_typeof(${table.capabilities}) = 'object'`),
    parameterMappingObjectCheck: check('provider_models_parameter_mapping_object_check', sql`jsonb_typeof(${table.parameterMapping}) = 'object'`),
    requestMappingVersionCheck: check('provider_models_request_mapping_version_check', sql`${table.requestMappingVersion} > 0`),
    responseMappingVersionCheck: check('provider_models_response_mapping_version_check', sql`${table.responseMappingVersion} > 0`),
    validationStateCheck: check('provider_models_validation_state_check', sql`${table.validationState} IN ('unverified', 'verified', 'disabled')`),
    enabledDisabledAtCheck: check('provider_models_enabled_disabled_at_check', sql`NOT ${table.enabled} OR ${table.disabledAt} IS NULL`),
}));

const logicalModels = pgTable('logical_models', {
    id: uuid('id').defaultRandom().primaryKey(),
    logicalModelId: text('logical_model_id').notNull(),
    displayName: text('display_name').notNull(),
    providerDisplayName: text('provider_display_name'),
    mediaType: text('media_type').notNull(),
    supportedOperations: jsonb('supported_operations').notNull(),
    capabilityTemplateKey: text('capability_template_key'),
    capabilityTemplateVersion: integer('capability_template_version'),
    parameterSchema: jsonb('parameter_schema'),
    parameterSchemaVersion: integer('parameter_schema_version'),
    description: text('description'),
    iconKey: text('icon_key'),
    enabled: boolean('enabled').notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),
    catalogVersion: integer('catalog_version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
}, (table) => ({
    logicalModelIdUnique: uniqueIndex('logical_models_logical_model_id_unique').on(table.logicalModelId),
    directoryIndex: index('logical_models_directory_idx').on(table.mediaType, table.enabled, table.sortOrder, table.logicalModelId),
    logicalModelIdCheck: check('logical_models_logical_model_id_check', sql`${table.logicalModelId} ~ '^[a-z0-9][a-z0-9._-]{1,127}$'`),
    mediaTypeCheck: check('logical_models_media_type_check', sql`${table.mediaType} IN ('image', 'video')`),
    supportedOperationsArrayCheck: check('logical_models_supported_operations_array_check', sql`jsonb_typeof(${table.supportedOperations}) = 'array' AND jsonb_array_length(${table.supportedOperations}) > 0`),
    templatePairCheck: check('logical_models_template_pair_check', sql`(${table.capabilityTemplateKey} IS NULL AND ${table.capabilityTemplateVersion} IS NULL) OR (${table.capabilityTemplateKey} IS NOT NULL AND ${table.capabilityTemplateVersion} IS NOT NULL AND ${table.capabilityTemplateVersion} > 0)`),
    schemaPairCheck: check('logical_models_schema_pair_check', sql`(${table.parameterSchema} IS NULL AND ${table.parameterSchemaVersion} IS NULL) OR (${table.parameterSchema} IS NOT NULL AND jsonb_typeof(${table.parameterSchema}) = 'object' AND ${table.parameterSchemaVersion} IS NOT NULL AND ${table.parameterSchemaVersion} > 0)`),
    catalogVersionCheck: check('logical_models_catalog_version_check', sql`${table.catalogVersion} > 0`),
    enabledDisabledAtCheck: check('logical_models_enabled_disabled_at_check', sql`NOT ${table.enabled} OR ${table.disabledAt} IS NULL`),
}));

const modelProviderBindings = pgTable('model_provider_bindings', {
    id: uuid('id').defaultRandom().primaryKey(),
    logicalModelPk: uuid('logical_model_pk').notNull().references(() => logicalModels.id, { onDelete: 'restrict' }),
    providerModelId: uuid('provider_model_id').notNull().references(() => providerModels.id, { onDelete: 'restrict' }),
    priority: integer('priority').notNull(),
    isPrimary: boolean('is_primary').notNull().default(false),
    enabled: boolean('enabled').notNull().default(true),
    bindingVersion: integer('binding_version').notNull().default(1),
    createdBy: uuid('created_by'),
    updatedBy: uuid('updated_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
}, (table) => ({
    logicalPriorityUnique: uniqueIndex('model_provider_bindings_logical_priority_unique').on(table.logicalModelPk, table.priority),
    logicalProviderModelUnique: uniqueIndex('model_provider_bindings_logical_provider_model_unique').on(table.logicalModelPk, table.providerModelId),
    oneEnabledPrimaryUnique: uniqueIndex('model_provider_bindings_one_enabled_primary_unique').on(table.logicalModelPk).where(sql`${table.enabled} AND ${table.isPrimary}`),
    logicalEnabledPriorityIndex: index('model_provider_bindings_logical_enabled_priority_idx').on(table.logicalModelPk, table.enabled, table.priority),
    providerModelEnabledIndex: index('model_provider_bindings_provider_model_enabled_idx').on(table.providerModelId, table.enabled),
    priorityCheck: check('model_provider_bindings_priority_check', sql`${table.priority} > 0`),
    bindingVersionCheck: check('model_provider_bindings_version_check', sql`${table.bindingVersion} > 0`),
    enabledDisabledAtCheck: check('model_provider_bindings_enabled_disabled_at_check', sql`NOT ${table.enabled} OR ${table.disabledAt} IS NULL`),
}));

const modelCatalogPublic = pgView('model_catalog_public', {
    logicalModelId: text('logical_model_id'),
    displayName: text('display_name'),
    providerDisplayName: text('provider_display_name'),
    mediaType: text('media_type'),
    supportedOperations: jsonb('supported_operations'),
    capabilityTemplateKey: text('capability_template_key'),
    capabilityTemplateVersion: integer('capability_template_version'),
    parameterSchemaVersion: integer('parameter_schema_version'),
    description: text('description'),
    iconKey: text('icon_key'),
    sortOrder: integer('sort_order'),
    catalogVersion: integer('catalog_version'),
}).with({ securityBarrier: true })
    .as(sql`SELECT
        lm.logical_model_id,
        lm.display_name,
        lm.provider_display_name,
        lm.media_type,
        lm.supported_operations,
        lm.capability_template_key,
        lm.capability_template_version,
        lm.parameter_schema_version,
        lm.description,
        lm.icon_key,
        lm.sort_order,
        lm.catalog_version
    FROM logical_models AS lm
    WHERE lm.enabled = true
      AND EXISTS (
          SELECT 1
          FROM model_provider_bindings AS b
          JOIN provider_models AS pm ON pm.id = b.provider_model_id
          JOIN provider_instances AS pi ON pi.id = pm.provider_instance_id
          WHERE b.logical_model_pk = lm.id
            AND b.enabled = true
            AND b.is_primary = true
            AND pm.enabled = true
            AND pm.validation_state = 'verified'
            AND pm.media_type = lm.media_type
            AND pi.enabled = true
      )`);

const providerConfigAuditEvents = pgTable('provider_config_audit_events', {
    id: uuid('id').defaultRandom().primaryKey(),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'restrict' }),
    resourceType: text('resource_type').notNull(),
    resourceId: uuid('resource_id').notNull(),
    action: text('action').notNull(),
    configVersionBefore: integer('config_version_before'),
    configVersionAfter: integer('config_version_after'),
    changeSummary: jsonb('change_summary').notNull().default({}),
    requestId: text('request_id'),
    outcome: text('outcome').notNull(),
    reasonCode: text('reason_code'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
    resourceCreatedIndex: index('provider_config_audit_resource_created_idx').on(table.resourceType, table.resourceId, table.createdAt),
    actorCreatedIndex: index('provider_config_audit_actor_created_idx').on(table.actorUserId, table.createdAt),
    resourceTypeCheck: check('provider_config_audit_resource_type_check', sql`${table.resourceType} IN ('provider_instance', 'provider_model', 'logical_model', 'binding')`),
    actionCheck: check('provider_config_audit_action_check', sql`${table.action} IN ('create', 'update', 'enable', 'disable', 'credential_rotate', 'validate', 'bind', 'make_primary', 'delete_rejected')`),
    outcomeCheck: check('provider_config_audit_outcome_check', sql`${table.outcome} IN ('succeeded', 'rejected')`),
    changeSummaryObjectCheck: check('provider_config_audit_change_summary_object_check', sql`jsonb_typeof(${table.changeSummary}) = 'object'`),
    configVersionBeforeCheck: check('provider_config_audit_version_before_check', sql`${table.configVersionBefore} IS NULL OR ${table.configVersionBefore} > 0`),
    configVersionAfterCheck: check('provider_config_audit_version_after_check', sql`${table.configVersionAfter} IS NULL OR ${table.configVersionAfter} > 0`),
}));

const generationTasks = pgTable(
    'generation_tasks',
    {
        id: uuid('id').defaultRandom().primaryKey(),
        taskType: text('task_type').notNull(),
        payload: jsonb('payload').notNull(),
        status: text('status').notNull().default('queued'),
        attempts: integer('attempts').notNull().default(0),
        maxAttempts: integer('max_attempts').notNull().default(3),
        availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
        leaseToken: uuid('lease_token'),
        leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
        workerId: text('worker_id'),
        lastError: text('last_error'),
        createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
        updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
        completedAt: timestamp('completed_at', { withTimezone: true }),
        // 归属与幂等键是任务创建 API 的安全边界：owner_id 只能来自已认证会话，
        // idempotency_key 在同一个 owner 内唯一，request_fingerprint 用于识别"同键不同请求"。
        // 这三列由 0013 增量迁移追加，因此保留在定义末尾，保持 schema 顺序与物理列顺序一致。
        ownerId: uuid('owner_id').notNull(),
        idempotencyKey: text('idempotency_key').notNull(),
        requestFingerprint: text('request_fingerprint').notNull(),
        // 结果描述符只在成功终态写入：媒体类型、大小、来源、归档状态等可审计摘要，
        // 不含生成内容本身。真实文件归档（对象存储）仍是后续步骤，这里显式记为 not_configured。
        result: jsonb('result'),
        // 取消意图与任务状态分离：running 任务只登记“用户已请求取消”，由持有租约的 Worker
        // 在安全点协作停止后才写 cancelled；queued 任务由 API 直接写 cancelled 并同时记录该时间。
        // 允许 queued 残留该值，是为了避免“失败回队列”与“取消请求”并发时触发约束错误。
        cancelRequestedAt: timestamp('cancel_requested_at', { withTimezone: true }),
        logicalModelPk: uuid('logical_model_pk').references(() => logicalModels.id, { onDelete: 'restrict' }),
        routeSnapshot: jsonb('route_snapshot'),
        routeSnapshotVersion: integer('route_snapshot_version'),
        routeSnapshotHash: text('route_snapshot_hash'),
    },
    (table) => ({
        statusCheck: check('generation_tasks_status_check', sql`${table.status} IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')`),
        attemptsCheck: check('generation_tasks_attempts_check', sql`${table.attempts} >= 0`),
        maxAttemptsCheck: check('generation_tasks_max_attempts_check', sql`${table.maxAttempts} > 0`),
        attemptLimitCheck: check('generation_tasks_attempt_limit_check', sql`${table.attempts} <= ${table.maxAttempts}`),
        leaseConsistencyCheck: check('generation_tasks_lease_consistency_check',
            sql`(${table.status} = 'running' AND ${table.leaseToken} IS NOT NULL AND ${table.leaseExpiresAt} IS NOT NULL) OR (${table.status} <> 'running' AND ${table.leaseToken} IS NULL AND ${table.leaseExpiresAt} IS NULL)`),
        resultConsistencyCheck: check('generation_tasks_result_consistency_check',
            sql`(${table.status} = 'succeeded' AND ${table.result} IS NOT NULL) OR (${table.status} <> 'succeeded' AND ${table.result} IS NULL)`),
        resultObjectCheck: check('generation_tasks_result_object_check',
            sql`${table.result} IS NULL OR jsonb_typeof(${table.result}) = 'object'`),
        idempotencyKeyCheck: check('generation_tasks_idempotency_key_check',
            sql`${table.idempotencyKey} ~ '^[A-Za-z0-9._:-]{8,128}$'`),
        requestFingerprintCheck: check('generation_tasks_request_fingerprint_check',
            sql`${table.requestFingerprint} ~ '^[0-9a-f]{64}$'`),
        // 取消是"用户意图"，只能出现在仍可终结的任务上；成功/失败终态后再挂取消请求没有意义，
        // 也会让审计读不出先后顺序，因此在数据库层直接拒绝。
        cancelRequestCheck: check('generation_tasks_cancel_request_check',
            sql`${table.cancelRequestedAt} IS NULL OR ${table.status} IN ('queued', 'running', 'cancelled')`),
        routeSnapshotObjectCheck: check('generation_tasks_route_snapshot_object_check',
            sql`${table.routeSnapshot} IS NULL OR jsonb_typeof(${table.routeSnapshot}) = 'object'`),
        routeSnapshotConsistencyCheck: check('generation_tasks_route_snapshot_consistency_check',
            sql`(${table.routeSnapshot} IS NULL AND ${table.routeSnapshotVersion} IS NULL AND ${table.routeSnapshotHash} IS NULL AND ${table.logicalModelPk} IS NULL) OR (${table.routeSnapshot} IS NOT NULL AND ${table.routeSnapshotVersion} IS NOT NULL AND ${table.routeSnapshotVersion} > 0 AND ${table.routeSnapshotHash} IS NOT NULL AND ${table.routeSnapshotHash} ~ '^[0-9a-f]{64}$' AND ${table.logicalModelPk} IS NOT NULL)`),
        routeSnapshotHashCheck: check('generation_tasks_route_snapshot_hash_check',
            sql`${table.routeSnapshotHash} IS NULL OR ${table.routeSnapshotHash} ~ '^[0-9a-f]{64}$'`),
        ownerIdempotencyUnique: uniqueIndex('generation_tasks_owner_idempotency_unique').on(
            table.ownerId,
            table.idempotencyKey,
        ),
        ownerCreatedIndex: index('generation_tasks_owner_created_idx').on(
            table.ownerId,
            table.createdAt,
        ),
        claimableIndex: index('generation_tasks_claimable_idx').on(
            table.status,
            table.availableAt,
            table.createdAt,
        ),
        leaseExpiryIndex: index('generation_tasks_lease_expiry_idx').on(
            table.status,
            table.leaseExpiresAt,
        ),
    }),
);

const users = pgTable('users', {
    id: uuid('id').defaultRandom().primaryKey(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    role: text('role').notNull().default('user'),
}, (table) => ({
    roleCheck: check('users_role_check', sql`${table.role} IN ('user', 'admin')`),
    emailUnique: uniqueIndex('users_email_unique').on(table.email),
    emailCanonical: check('users_email_canonical_check', sql`${table.email} = lower(btrim(${table.email})) AND octet_length(${table.email}) BETWEEN 3 AND 254 AND ${table.email} ~ '^[a-z0-9.!#$%&''*+/=?^_\x60{|}~-]+@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'`),
    passwordFormat: check('users_password_hash_check', sql`${table.passwordHash} ~ '^scrypt:32768:8:3:[0-9a-f]{32}:[0-9a-f]{128}$'`),
}));

const emailVerificationTokens = pgTable('email_verification_tokens', {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
        tokenUnique: uniqueIndex('email_verification_token_hash_unique').on(table.tokenHash),
        userUnique: uniqueIndex('email_verification_user_unique').on(table.userId),
        expiryCleanupIndex: index('email_verification_expiry_cleanup_idx').on(table.expiresAt).where(sql`${table.consumedAt} IS NULL`),
        consumedCleanupIndex: index('email_verification_consumed_cleanup_idx').on(table.consumedAt).where(sql`${table.consumedAt} IS NOT NULL`),
    hashFormat: check('email_verification_hash_check', sql`${table.tokenHash} ~ '^[0-9a-f]{64}$'`),
    expiry: check('email_verification_expiry_check', sql`${table.expiresAt} > ${table.createdAt}`),
}));

const authRateLimits = pgTable('auth_rate_limits', {
    bucket: text('bucket').primaryKey(),
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
    hits: integer('hits').notNull(),
}, (table) => ({
    bucketCheck: check('auth_rate_limits_bucket_check', sql`${table.bucket} IN ('register', 'verify-email', 'login', 'password-reset', 'mfa-login', 'mfa-recovery')`),
    hitsCheck: check('auth_rate_limits_hits_check', sql`${table.hits} BETWEEN 1 AND 60`),
}));

const passwordResetTokens = pgTable('password_reset_tokens', {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
        tokenUnique: uniqueIndex('password_reset_token_hash_unique').on(table.tokenHash),
        userIndex: index('password_reset_user_idx').on(table.userId),
        expiryCleanupIndex: index('password_reset_expiry_cleanup_idx').on(table.expiresAt).where(sql`${table.consumedAt} IS NULL`),
        consumedCleanupIndex: index('password_reset_consumed_cleanup_idx').on(table.consumedAt).where(sql`${table.consumedAt} IS NOT NULL`),
    hashFormat: check('password_reset_hash_check', sql`${table.tokenHash} ~ '^[0-9a-f]{64}$'`),
    expiry: check('password_reset_expiry_check', sql`${table.expiresAt} > ${table.createdAt}`),
}));

const emailOutbox = pgTable('email_outbox', {
    id: uuid('id').defaultRandom().primaryKey(),
    idempotencyKey: text('idempotency_key').notNull(),
    kind: text('kind').notNull(),
    recipientEmail: text('recipient_email').notNull(),
    payloadCiphertext: text('payload_ciphertext').notNull(),
    payloadNonce: text('payload_nonce').notNull(),
    payloadTag: text('payload_tag').notNull(),
    status: text('status').notNull().default('queued'),
    attempts: integer('attempts').notNull().default(0),
    availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    lockedBy: text('locked_by'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    lastErrorCode: text('last_error_code'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
    idempotencyUnique: uniqueIndex('email_outbox_idempotency_key_unique').on(table.idempotencyKey),
    deliveryIndex: index('email_outbox_delivery_idx').on(table.status, table.availableAt, table.createdAt),
    statusCheck: check('email_outbox_status_check', sql`${table.status} IN ('queued', 'processing', 'sent', 'failed')`),
    kindCheck: check('email_outbox_kind_check', sql`${table.kind} IN ('verification', 'password-reset')`),
    attemptsCheck: check('email_outbox_attempts_check', sql`${table.attempts} >= 0`),
    lockConsistencyCheck: check('email_outbox_lock_consistency_check', sql`(${table.status} = 'processing' AND ${table.lockedAt} IS NOT NULL AND ${table.lockedBy} IS NOT NULL) OR (${table.status} <> 'processing')`),
    sentConsistencyCheck: check('email_outbox_sent_consistency_check', sql`(${table.status} = 'sent' AND ${table.sentAt} IS NOT NULL) OR (${table.status} <> 'sent' AND ${table.sentAt} IS NULL)`),
}));

const providerCalls = pgTable('provider_calls', {
    id: uuid('id').defaultRandom().primaryKey(),
    taskId: uuid('task_id').notNull(),
    attemptNo: integer('attempt_no').notNull(),
    providerName: text('provider_name').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    providerJobId: text('provider_job_id'),
    status: text('status').notNull().default('submitting'),
    recoveryAttempts: integer('recovery_attempts').notNull().default(0),
    workerId: text('worker_id'),
    leaseToken: uuid('lease_token'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    // 与 lease_expires_at 刻意分成两组字段：租约回答“谁现在持有”，available_at 回答“什么时候可以被领取”。
    // 释放租约时三列同时置空，重试退避只写 available_at，避免 lease_consistency_check 被同一个字段硬塞两种语义。
    availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
    lastErrorCode: text('last_error_code'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    providerInstanceId: uuid('provider_instance_id').references(() => providerInstances.id, { onDelete: 'restrict' }),
    providerConfigVersion: integer('provider_config_version'),
    credentialRefVersion: integer('credential_ref_version'),
    providerModelId: uuid('provider_model_id').references(() => providerModels.id, { onDelete: 'restrict' }),
    logicalModelId: text('logical_model_id'),
    bindingId: uuid('binding_id').references(() => modelProviderBindings.id, { onDelete: 'restrict' }),
    bindingVersion: integer('binding_version'),
    adapterType: text('adapter_type'),
    adapterVersion: text('adapter_version'),
    upstreamModelName: text('upstream_model_name'),
    operationProfile: text('operation_profile'),
    routeSnapshotHash: text('route_snapshot_hash'),
}, (table) => ({
    taskAttemptUnique: uniqueIndex('provider_calls_task_attempt_unique').on(table.taskId, table.attemptNo),
    idempotencyUnique: uniqueIndex('provider_calls_idempotency_unique').on(table.idempotencyKey),
    recoveryIndex: index('provider_calls_recovery_idx').on(table.status, table.availableAt),
    providerInstanceCreatedIndex: index('provider_calls_provider_instance_created_idx').on(table.providerInstanceId, table.createdAt),
    providerModelCreatedIndex: index('provider_calls_provider_model_created_idx').on(table.providerModelId, table.createdAt),
    statusCheck: check('provider_calls_status_check', sql`${table.status} IN ('submitting', 'unknown', 'accepted', 'succeeded', 'failed', 'cancelled')`),
    attemptCheck: check('provider_calls_attempt_check', sql`${table.attemptNo} > 0`),
    recoveryAttemptsCheck: check('provider_calls_recovery_attempts_check', sql`${table.recoveryAttempts} >= 0`),
    leaseConsistencyCheck: check('provider_calls_lease_consistency_check', sql`(${table.workerId} IS NULL AND ${table.leaseToken} IS NULL AND ${table.leaseExpiresAt} IS NULL) OR (${table.workerId} IS NOT NULL AND ${table.leaseToken} IS NOT NULL AND ${table.leaseExpiresAt} IS NOT NULL)`),
    providerJobStatusCheck: check('provider_calls_provider_job_status_check', sql`${table.status} NOT IN ('accepted', 'succeeded', 'cancelled') OR ${table.providerJobId} IS NOT NULL`),
    errorCodeCheck: check('provider_calls_error_code_check', sql`${table.lastErrorCode} IS NULL OR ${table.lastErrorCode} ~ '^[A-Z][A-Z0-9_]{0,63}$'`),
    routeIdentityVersionsCheck: check('provider_calls_route_identity_versions_check', sql`(${table.providerConfigVersion} IS NULL OR ${table.providerConfigVersion} > 0) AND (${table.credentialRefVersion} IS NULL OR ${table.credentialRefVersion} >= 0) AND (${table.bindingVersion} IS NULL OR ${table.bindingVersion} > 0)`),
    routeSnapshotHashCheck: check('provider_calls_route_snapshot_hash_check', sql`${table.routeSnapshotHash} IS NULL OR ${table.routeSnapshotHash} ~ '^[0-9a-f]{64}$'`),
}));

const authSessions = pgTable('auth_sessions', { 
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    authLevel: text('auth_level').notNull().default('password'),
    mfaVerifiedAt: timestamp('mfa_verified_at', { withTimezone: true }),
    stepUpVerifiedAt: timestamp('step_up_verified_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
    tokenUnique: uniqueIndex('auth_sessions_token_hash_unique').on(table.tokenHash),
        userIndex: index('auth_sessions_user_idx').on(table.userId),
        expiryIndex: index('auth_sessions_expiry_idx').on(table.expiresAt),
        expiryCleanupIndex: index('auth_sessions_expiry_cleanup_idx').on(table.expiresAt).where(sql`${table.revokedAt} IS NULL`),
        revokedCleanupIndex: index('auth_sessions_revoked_cleanup_idx').on(table.revokedAt).where(sql`${table.revokedAt} IS NOT NULL`),
    hashFormat: check('auth_sessions_hash_check', sql`${table.tokenHash} ~ '^[0-9a-f]{64}$'`),
    authLevelCheck: check('auth_sessions_auth_level_check', sql`${table.authLevel} IN ('password', 'mfa')`),
    mfaTimestampCheck: check('auth_sessions_mfa_timestamp_check', sql`(${table.authLevel} = 'password' AND ${table.mfaVerifiedAt} IS NULL) OR (${table.authLevel} = 'mfa' AND ${table.mfaVerifiedAt} IS NOT NULL)`),
    stepUpTimestampCheck: check('auth_sessions_step_up_timestamp_check', sql`${table.stepUpVerifiedAt} IS NULL OR ${table.authLevel} = 'mfa'`),
    expiryCheck: check('auth_sessions_expiry_check', sql`${table.expiresAt} > ${table.createdAt}`),
}));

const adminMfaFactors = pgTable('admin_mfa_factors', {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    factorType: text('factor_type').notNull().default('totp'),
    secretCiphertext: text('secret_ciphertext').notNull(),
    secretNonce: text('secret_nonce').notNull(),
    secretTag: text('secret_tag').notNull(),
    lastTotpCounter: bigint('last_totp_counter', { mode: 'number' }),
    enabledAt: timestamp('enabled_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
    userFactorUnique: uniqueIndex('admin_mfa_factors_user_type_unique').on(table.userId, table.factorType),
    userIndex: index('admin_mfa_factors_user_idx').on(table.userId),
    factorTypeCheck: check('admin_mfa_factors_type_check', sql`${table.factorType} IN ('totp')`),
    lifecycleCheck: check('admin_mfa_factors_lifecycle_check', sql`(${table.enabledAt} IS NULL AND ${table.revokedAt} IS NULL) OR (${table.enabledAt} IS NOT NULL AND ${table.revokedAt} IS NULL) OR (${table.revokedAt} IS NOT NULL)`),
}));

const adminRecoveryCodes = pgTable('admin_recovery_codes', {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    codeDigest: text('code_digest').notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
    codeDigestUnique: uniqueIndex('admin_recovery_codes_digest_unique').on(table.codeDigest),
    userIndex: index('admin_recovery_codes_user_idx').on(table.userId),
    digestFormatCheck: check('admin_recovery_codes_digest_check', sql`${table.codeDigest} ~ '^[0-9a-f]{64}$'`),
}));

// 0024 只建立未接线的内部基础；没有报价链，不提供创建 reserve 的函数或运行授权。
const creditAccounts = pgTable('credit_accounts', {
    userId: uuid('user_id').primaryKey().references(() => users.id, { onDelete: 'restrict' }),
    availableTenths: numeric('available_tenths').notNull().default('0'),
    reservedTenths: numeric('reserved_tenths').notNull().default('0'),
    unitVersion: text('unit_version').notNull().default('credit_tenths_v1'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
    availableCheck: check('credit_accounts_available_check', sql`${table.availableTenths} BETWEEN 0 AND 9223372036854775807 AND ${table.availableTenths} = trunc(${table.availableTenths})`),
    reservedCheck: check('credit_accounts_reserved_check', sql`${table.reservedTenths} BETWEEN 0 AND 9223372036854775807 AND ${table.reservedTenths} = trunc(${table.reservedTenths})`),
    unitCheck: check('credit_accounts_unit_check', sql`${table.unitVersion} = 'credit_tenths_v1'`),
}));

const creditLedgerEvents = pgTable('credit_ledger_events', {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id').notNull().references(() => creditAccounts.userId, { onDelete: 'restrict' }),
    // 0029 起发放事件不属于任何任务，task_id 可空；任务类事件仍由 shape check 强制非空。
    taskId: uuid('task_id').references(() => generationTasks.id, { onDelete: 'restrict' }),
    kind: text('kind').notNull(),
    creditTenths: numeric('credit_tenths').notNull(),
    unitVersion: text('unit_version').notNull().default('credit_tenths_v1'),
    sourceType: text('source_type').notNull(),
    sourceId: uuid('source_id').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    actor: text('actor').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
    amountCheck: check('credit_ledger_events_amount_check', sql`${table.creditTenths} BETWEEN 1 AND 9223372036854775807 AND ${table.creditTenths} = trunc(${table.creditTenths})`),
    unitCheck: check('credit_ledger_events_unit_check', sql`${table.unitVersion} = 'credit_tenths_v1'`),
    // 两类事件：任务类（reserve/settle/release，必须绑定任务）与发放类（grant，必须不绑定任务）。
    // 幂等键同样分两族，唯一索引保证同一发放来由只会成功一次。
    shapeCheck: check('credit_ledger_events_shape_check', sql`(${table.kind} IN ('reserve', 'settle', 'release') AND ${table.taskId} IS NOT NULL AND ${table.sourceType} = 'task' AND ${table.sourceId} = ${table.taskId} AND ${table.actor} = 'system' AND ${table.idempotencyKey} = ${table.kind} || ':' || ${table.taskId}::text) OR (${table.kind} = 'grant' AND ${table.taskId} IS NULL AND ${table.sourceType} IN ('signup', 'manual') AND ${table.actor} IN ('system', 'admin') AND ${table.idempotencyKey} = 'grant:' || ${table.sourceType} || ':' || ${table.sourceId}::text)`),
    keyUnique: uniqueIndex('credit_ledger_events_key_unique').on(table.idempotencyKey),
    // 0027 起每个任务最多三条事件：reserve、settle、release 各至多一条。
    taskKindUnique: uniqueIndex('credit_ledger_events_task_kind_unique').on(table.taskId, table.kind),
    identityUnique: uniqueIndex('credit_ledger_events_identity_unique').on(table.id, table.userId, table.taskId, table.creditTenths),
}));

const creditReservations = pgTable('credit_reservations', {
    taskId: uuid('task_id').primaryKey().references(() => generationTasks.id, { onDelete: 'restrict' }),
    userId: uuid('user_id').notNull().references(() => creditAccounts.userId, { onDelete: 'restrict' }),
    creditTenths: numeric('credit_tenths').notNull(),
    reserveEventId: uuid('reserve_event_id').notNull(),
    status: text('status').notNull().default('reserved'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
    amountCheck: check('credit_reservations_amount_check', sql`${table.creditTenths} BETWEEN 1 AND 9223372036854775807 AND ${table.creditTenths} = trunc(${table.creditTenths})`),
    statusCheck: check('credit_reservations_status_check', sql`${table.status} = 'reserved'`),
    eventUnique: uniqueIndex('credit_reservations_event_unique').on(table.reserveEventId),
    eventIdentity: foreignKey({ name: 'credit_reservations_event_identity_fk', columns: [table.reserveEventId, table.userId, table.taskId, table.creditTenths], foreignColumns: [creditLedgerEvents.id, creditLedgerEvents.userId, creditLedgerEvents.taskId, creditLedgerEvents.creditTenths] }).onDelete('restrict'),
}));

// 0027 终态裁决：reservations 保持不可变，任务是否结算/释放只在这里追加一行。
const creditSettlements = pgTable('credit_settlements', {
    taskId: uuid('task_id').primaryKey().references(() => generationTasks.id, { onDelete: 'restrict' }),
    userId: uuid('user_id').notNull().references(() => creditAccounts.userId, { onDelete: 'restrict' }),
    kind: text('kind').notNull(),
    creditTenths: numeric('credit_tenths').notNull(),
    eventId: uuid('event_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
    amountCheck: check('credit_settlements_amount_check', sql`${table.creditTenths} BETWEEN 1 AND 9223372036854775807 AND ${table.creditTenths} = trunc(${table.creditTenths})`),
    kindCheck: check('credit_settlements_kind_check', sql`${table.kind} IN ('settle', 'release')`),
    eventUnique: uniqueIndex('credit_settlements_event_unique').on(table.eventId),
    eventIdentity: foreignKey({ name: 'credit_settlements_event_identity_fk', columns: [table.eventId, table.userId, table.taskId, table.creditTenths], foreignColumns: [creditLedgerEvents.id, creditLedgerEvents.userId, creditLedgerEvents.taskId, creditLedgerEvents.creditTenths] }).onDelete('restrict'),
}));

const pricingVersions = pgTable('pricing_versions', {
    id: uuid('id').defaultRandom().primaryKey(),
    logicalModelPk: uuid('logical_model_pk').notNull().references(() => logicalModels.id, { onDelete: 'restrict' }),
    pricingVersion: text('pricing_version').notNull(),
    config: jsonb('config').notNull(),
    configHash: text('config_hash').notNull(),
    effectiveFromUs: numeric('effective_from_us').notNull(),
    publishedAtUs: numeric('published_at_us').notNull(),
    revokedAtUs: numeric('revoked_at_us'),
    cancelledAtUs: numeric('cancelled_at_us'),
}, (table) => ({
    versionUnique: uniqueIndex('pricing_versions_model_version_unique').on(table.logicalModelPk, table.pricingVersion),
    timelineUnique: uniqueIndex('pricing_versions_model_time_unique').on(table.logicalModelPk, table.effectiveFromUs),
    configCheck: check('pricing_versions_config_check', sql`jsonb_typeof(${table.config}) = 'object' AND ${table.configHash} ~ '^[0-9a-f]{64}$' AND ${table.pricingVersion} ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'`),
    timeCheck: check('pricing_versions_time_check', sql`${table.publishedAtUs} BETWEEN 0 AND 253402300799999999 AND ${table.publishedAtUs} = trunc(${table.publishedAtUs}) AND ${table.effectiveFromUs} BETWEEN ${table.publishedAtUs} AND 253402300799999999 AND mod(${table.effectiveFromUs}, 1000000) = 0 AND (${table.revokedAtUs} IS NULL OR (${table.revokedAtUs} BETWEEN ${table.publishedAtUs} AND 253402300799999999 AND ${table.revokedAtUs} = trunc(${table.revokedAtUs}))) AND (${table.cancelledAtUs} IS NULL OR (${table.cancelledAtUs} >= ${table.publishedAtUs} AND ${table.cancelledAtUs} < ${table.effectiveFromUs} AND ${table.cancelledAtUs} = trunc(${table.cancelledAtUs}))) AND NOT (${table.revokedAtUs} IS NOT NULL AND ${table.cancelledAtUs} IS NOT NULL)`),
}));

// 独立报价凭证，不创建可执行任务；未来原子协调器须另行接线。
const pricingQuotes = pgTable('pricing_quotes', {
    id: uuid('id').defaultRandom().primaryKey(),
    ownerId: uuid('owner_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
    taskId: uuid('task_id').references(() => generationTasks.id, { onDelete: 'restrict' }),
    idempotencyKey: text('idempotency_key').notNull(),
    requestFingerprint: text('request_fingerprint').notNull(),
    pricingVersionId: uuid('pricing_version_id').notNull().references(() => pricingVersions.id, { onDelete: 'restrict' }),
    snapshot: jsonb('snapshot').notNull(),
    snapshotHash: text('snapshot_hash').notNull(),
    creditTenths: numeric('credit_tenths').notNull(),
    createdAtUs: numeric('created_at_us').notNull(),
    expiresAtUs: numeric('expires_at_us').notNull(),
}, (table) => ({
    replayUnique: uniqueIndex('pricing_quotes_owner_key_unique').on(table.ownerId, table.idempotencyKey),
    taskUnique: uniqueIndex('pricing_quotes_task_unique').on(table.taskId)
        .where(sql`${table.taskId} IS NOT NULL`),
    shapeCheck: check('pricing_quotes_shape_check', sql`jsonb_typeof(${table.snapshot}) = 'object' AND ${table.snapshotHash} ~ '^[0-9a-f]{64}$' AND ${table.requestFingerprint} ~ '^[0-9a-f]{64}$' AND ${table.idempotencyKey} ~ '^[A-Za-z0-9._:-]{8,128}$'`),
    amountCheck: check('pricing_quotes_amount_check', sql`${table.creditTenths} BETWEEN 0 AND 9007199254740991 AND ${table.creditTenths} = trunc(${table.creditTenths})`),
    timeCheck: check('pricing_quotes_time_check', sql`${table.createdAtUs} BETWEEN 0 AND 253402300799999999 AND ${table.createdAtUs} = trunc(${table.createdAtUs}) AND ${table.expiresAtUs} BETWEEN ${table.createdAtUs} + 300000000 AND ${table.createdAtUs} + 86400000000 AND ${table.expiresAtUs} <= 253402300799999999 AND ${table.expiresAtUs} = trunc(${table.expiresAtUs})`),
}));

module.exports = { pricingVersions, pricingQuotes, creditAccounts, creditLedgerEvents, creditReservations, creditSettlements, assets, generationTasks, schemaVersion, users, emailVerificationTokens, authRateLimits, passwordResetTokens, emailOutbox, authSessions, adminMfaFactors, adminRecoveryCodes, providerCalls, providerInstances, providerModels, logicalModels, modelProviderBindings, modelCatalogPublic, providerConfigAuditEvents };
