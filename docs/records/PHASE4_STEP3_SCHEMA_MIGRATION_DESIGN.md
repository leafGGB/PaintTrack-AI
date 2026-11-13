# 阶段 4.7.2：多模型目录 Drizzle Schema 与迁移设计

- 日期：2026-11-10
- 状态：**已完成**。0016 已在 loopback:5433 随机隔离库完成全量验收，报告 `.workbuddy/database-acceptance-mwagpqj2_9ec86c.json`：88 项 passed / 0 failed，覆盖空库迁移、非空旧库升级、历史路由身份保持 NULL、journal/hash 与重复迁移、15 张迁移表结构与 snapshot 对照、运行角色表级/列级最小权限、越权与注入负例、Drizzle 事务回滚、独立 Web 探针目录安全投影、全部认证与任务 fixture，以及 Worker 段在 0016 schema 下的重新全绿（12 任务并发领取、SIGKILL 后自然租约过期重领、fencing、协作与非协作停止、无遗留连接）。本轮同时修复并验证的两处真实缺陷：①drizzle-orm 0.45 在 node-postgres 会话层禁用 timestamptz 内置解析，raw `execute()` 返回 PostgreSQL 文本，导致 `service.me().user.createdAt` 为字符串、`login().expiresAt` 使 `Set-Cookie` 的 `Expires` 变成 `Invalid Date`，已在 `lib/server/session.js` 增加 `toTimestamp()` 归一化并补回归单测；②`tests/fixtures/session-postgres.cjs` 在 HTTP JSON 边界误用 `Date` 比较序列化后的 ISO 字符串，已用 `sessionBody` 规范化期望值并追加 ISO 格式断言。全量 `npm test` 315/313 通过/0 失败/2 跳过。该迁移仅被批准用于隔离验收库，尚未应用到任何既有业务数据库；应用到 dev/test/production 属独立授权步骤。
- 前置：`PHASE4_STEP2_MODEL_CATALOG_ROUTING_DATA_DESIGN.md`；多 Provider 契约见 `PHASE4_MULTI_PROVIDER_ROUTING_CONTRACT.md`
- 权威执行顺序：仓库外 `../ImplementationPlan/PAINTTRACK_DEVELOPMENT_PROCESS.md` 第 10 节
- 范围：定义新增实体、关系、字段、约束、索引、Drizzle schema 与 SQL migration 的分步方案、非空库兼容、运行身份、回滚/恢复和隔离验收。
- 不在本步骤实施：不修改 `schema.js`、SQL migration、snapshot、journal 或运行时代码；不连接数据库、不应用迁移、不建立云资源、不写入真实 Provider 配置或凭据。

## 1. 实施决策摘要

1. 新增四张配置表：`provider_instances`、`provider_models`、`logical_models`、`model_provider_bindings`；另新增只追加的 `provider_config_audit_events`。
2. `generation_tasks.route_snapshot` 和 `provider_calls` 路由身份扩展先允许 NULL，以保留历史记录的真实不确定性；旧任务/调用不回填虚构 Provider、模型或绑定身份。
3. 历史路由由任务 JSON 快照保留，不以配置表 FK 作为唯一历史证据。配置表间 FK 使用 `ON DELETE RESTRICT`；配置默认软禁用。业务任务/账本已有历史引用时，禁止物理删除配置对象。
4. 首次任务创建以单个事务读取并锁定有效逻辑模型、主绑定、Provider model 和 Provider instance，插入规范 payload、指纹和快照。重复幂等请求先返回原任务，不重新解析路由。
5. 数据库运行角色现状不足以证明 Web/Worker 相互隔离：`grantRuntimePermissions(..., { worker: true })` 当前是在同一角色上叠加权限。正式接入前需明确独立 Web 与 Worker 登录身份；迁移身份独立且不得进入常驻进程。
6. Web 创建任务所需的 route snapshot 写入必须由受信服务端解析路径产生。列权限本身不能判断 JSON 快照是否由可信解析器生成；不得将“Web 可 INSERT 任务”误称为数据库证明了快照来源。若威胁模型要求数据库强制来源，需在实施时另行采用受限存储过程/窄服务角色，先验证兼容性再决定，不以宽权限 `SECURITY DEFINER` 函数作为默认方案。
7. 在生产/既有库迁移前，必须先取得明确目标授权、备份与恢复窗口；本设计步骤只要求全新随机隔离库验收及经授权的非空合成库升级测试。

## 2. 表结构基线

所有实体主键使用 `uuid DEFAULT gen_random_uuid()`；时间使用 `timestamptz NOT NULL DEFAULT now()`；禁用时间与配置状态保持一致。JSONB 只存受限配置/能力，不存密钥、完整 prompt、媒体内容或可执行代码。每张表均在 `schema.js` 中声明，与 SQL 列顺序保持一致；实施时同步 `schema.cjs` 对 `schema.js` 的复用关系、最新 snapshot 和 `_journal.json`。

### 2.1 `provider_instances`

- `id uuid PK`
- `slug text NOT NULL UNIQUE`：受控小写 slug，CHECK `^[a-z0-9][a-z0-9-]{1,62}$`
- `display_name text NOT NULL`
- `adapter_type text NOT NULL`：服务端 allowlist 值；CHECK 限制为已实现 Adapter 类型，初期不接任意模块名
- `base_url text NOT NULL`：仅服务端配置；不含 userinfo/query/fragment；数据库只做格式基础约束，完整 URL/DNS/SSRF 校验由服务端配置边界承担
- `credential_ref text`：opaque secret reference，不是密文本身；密钥存储方案未定，不把该字段设计成 API key 容器
- `credential_version integer NOT NULL DEFAULT 0 CHECK (credential_version >= 0)`
- `enabled boolean NOT NULL DEFAULT false`
- `health_state text NOT NULL DEFAULT 'unknown' CHECK IN ('unknown','healthy','degraded','disabled')`
- `config_version integer NOT NULL DEFAULT 1 CHECK (config_version > 0)`
- `created_at`, `updated_at`, `disabled_at timestamptz`
- CHECK：`enabled = true` 时 `disabled_at IS NULL`；停用时要求 `disabled_at IS NOT NULL`。若现有产品需要“配置但未启用且未被人工停用”的草稿语义，改用明确的 lifecycle 状态，不能让 enabled/disabled_at 含义冲突。
- 索引：唯一 `slug`；`(enabled, adapter_type)` 供路由候选查询。

### 2.2 `provider_models`

- `id uuid PK`
- `provider_instance_id uuid NOT NULL REFERENCES provider_instances(id) ON DELETE RESTRICT`
- `upstream_model_name text NOT NULL`：保留精确大小写/后缀
- `media_type text NOT NULL CHECK IN ('image','video')`
- `operation_profile text NOT NULL`：服务端 allowlist 的精确 profile
- `capabilities jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(capabilities)='object')`
- `parameter_mapping jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(parameter_mapping)='object')`；只允许受限声明式映射
- `request_mapping_version integer NOT NULL CHECK (>0)`
- `response_mapping_version integer NOT NULL CHECK (>0)`
- `validation_state text NOT NULL DEFAULT 'unverified' CHECK IN ('unverified','verified','disabled')`
- `enabled boolean NOT NULL DEFAULT false`
- `created_at`, `updated_at`, `disabled_at timestamptz`
- 唯一索引 `(provider_instance_id, upstream_model_name, operation_profile)`
- 查询索引 `(provider_instance_id, enabled, validation_state)`
- 约束“verified 才可绑定有效路由”由配置服务事务校验；同表 CHECK 不可跨表证明 Provider 已启用。

### 2.3 `logical_models`

- `id uuid PK`：内部关系主键
- `logical_model_id text NOT NULL UNIQUE`：对客户端稳定的 PaintTrack model key，CHECK `^[a-z0-9][a-z0-9._-]{1,127}$`；创建后不可修改/复用
- `display_name text NOT NULL`
- `provider_display_name text`
- `media_type text NOT NULL CHECK IN ('image','video')`
- `supported_operations jsonb NOT NULL CHECK (jsonb_typeof(...)='array' AND jsonb_array_length(...) > 0)`
- `capability_template_key text`
- `capability_template_version integer`
- `parameter_schema jsonb`：受限 JSON Schema 子集或 template registry 描述；不得包含可执行表达式
- `parameter_schema_version integer`
- `description text`, `icon_key text`
- `enabled boolean NOT NULL DEFAULT false`
- `sort_order integer NOT NULL DEFAULT 0`
- `catalog_version integer NOT NULL DEFAULT 1 CHECK (>0)`
- `created_at`, `updated_at`, `disabled_at timestamptz`
- CHECK：模板 key/version 必须同时空或同时非空；schema/version 同理；enabled 与 disabled_at 一致
- 索引：`(media_type, enabled, sort_order, logical_model_id)`；唯一 `logical_model_id`

### 2.4 `model_provider_bindings`

- `id uuid PK`
- `logical_model_pk uuid NOT NULL REFERENCES logical_models(id) ON DELETE RESTRICT`
- `provider_model_id uuid NOT NULL REFERENCES provider_models(id) ON DELETE RESTRICT`
- `priority integer NOT NULL CHECK (priority > 0)`
- `is_primary boolean NOT NULL DEFAULT false`
- `enabled boolean NOT NULL DEFAULT true`
- `binding_version integer NOT NULL DEFAULT 1 CHECK (>0)`
- `created_by uuid REFERENCES users(id) ON DELETE RESTRICT`；删除用户须走保留/去标识化决策，不级联抹掉审计
- `updated_by uuid REFERENCES users(id) ON DELETE RESTRICT`
- `created_at`, `updated_at`, `disabled_at timestamptz`
- 唯一索引 `(logical_model_pk, priority)`；唯一索引 `(logical_model_pk, provider_model_id)`，避免重复绑定
- partial unique index `(logical_model_pk) WHERE enabled AND is_primary`，保证最多一个启用主路由
- 普通索引 `(logical_model_pk, enabled, priority)` 与 `(provider_model_id, enabled)`
- DB 层约束最多一个主绑定；“恰有一个”依赖模型启用前服务层事务检查，因为零主路由是合法草稿/停用状态。
- 主绑定变更在事务中锁定 `logical_models` 行，停用旧主、启用新主并递增受影响的 binding version；冲突重试或返回明确 409。跨表媒体/operation/capability 兼容由配置服务验证。

### 2.5 `provider_config_audit_events`

- `id uuid PK`
- `actor_user_id uuid REFERENCES users(id) ON DELETE RESTRICT`
- `resource_type text NOT NULL CHECK IN ('provider_instance','provider_model','logical_model','binding')`
- `resource_id uuid NOT NULL`：不设多态 FK，避免下线/删除审计时级联失效
- `action text NOT NULL`：固定 allowlist
- `config_version_before integer`, `config_version_after integer`
- `change_summary jsonb NOT NULL DEFAULT '{}'::jsonb CHECK object`：仅脱敏字段名/版本/状态差异，不放 Base URL、秘密、prompt 或自由文本异常
- `request_id text`, `outcome text NOT NULL CHECK IN ('succeeded','rejected')`, `reason_code text`
- `created_at timestamptz NOT NULL DEFAULT now()`
- 索引 `(resource_type, resource_id, created_at)`、`(actor_user_id, created_at)`
- 运行角色只 INSERT/SELECT（按授权范围）；禁止 UPDATE/DELETE。审计保留期/归档另立治理步骤。

## 3. 任务路由快照与调用身份

### 3.1 `generation_tasks`

新增：

- `route_snapshot jsonb NULL`
- `route_snapshot_hash text NULL`：SHA-256 lowercase hex，CHECK `^[0-9a-f]{64}$` 或 NULL；对规范化快照求 hash，便于比对调用账本，不替代快照本身
- `route_snapshot_version integer NULL`：版本正整数；与 snapshot/hash 同时为空或同时非空
- 可选 `logical_model_pk uuid NULL REFERENCES logical_models(id) ON DELETE RESTRICT` 仅作筛选/统计提示。历史行为语义以快照为准；若对逻辑模型物理删除策略要求绝不删除，使用 RESTRICT。`logical_model_id` 字符串保存在快照，避免展示名变化影响历史解释。

约束：新增 JSONB object CHECK；一致性 CHECK 要求三字段同空/同非空。迁移阶段不做基于 task_type 的强制非空 CHECK，因为旧任务可能缺身份；新任务的完整性由任务创建服务验证，后续只有在旧任务自然清空/明确 legacy 策略和代码双版本窗口结束后，才另立收缩迁移。不可用默认 `{}` 伪装旧任务已路由。

快照最小字段：`snapshotVersion`、`logicalModelId`、`logicalModelVersion`、`providerInstanceId`、`providerConfigVersion`、`credentialRefVersion`（仅 opaque version，不是秘密）、`providerModelId`、`upstreamModelName`、`adapterType`、`adapterVersion`、`operationProfile`、`bindingId`、`bindingVersion`、request/response mapping version、受限 capability 摘要。禁止 Base URL、credential ref 本身（如可关联秘密）、API key、Authorization、完整 prompt、媒体字节和未经授权上游响应。

### 3.2 `provider_calls`

保留 `provider_name NOT NULL` 作为历史兼容/观测标签；增加以下可空字段：

- `provider_instance_id uuid REFERENCES provider_instances(id) ON DELETE RESTRICT`
- `provider_config_version integer`
- `credential_ref_version integer`
- `provider_model_id uuid REFERENCES provider_models(id) ON DELETE RESTRICT`
- `logical_model_id text`（稳定字符串快照，不加 FK，防止产品逻辑 ID 生命周期改变历史解释）
- `binding_id uuid REFERENCES model_provider_bindings(id) ON DELETE RESTRICT`
- `binding_version integer`
- `adapter_type text`, `adapter_version text`, `upstream_model_name text`, `operation_profile text`
- `route_snapshot_hash text`
- CHECK：新增版本号为 NULL 或正数；hash 为 NULL 或 64 位小写 hex；新调用完整身份要求由写入服务与后续约束收紧步骤执行，旧调用保持全 NULL
- 索引 `(provider_instance_id, created_at)`、`(provider_model_id, created_at)`；避免把多个可选字段建成冗余索引
- 任务外键策略沿用当前账本约束；新配置外键必须 RESTRICT，不能级联删除被历史调用引用的实例/模型/绑定。

恢复时比较 task snapshot 与 provider_call identity/hash；legacy 任务/调用不得尝试按当前主路由恢复，应按既有 Worker 安全策略处理为不可路由/人工处置。

## 4. Migration 拆分与顺序

迁移编号以执行前实际 journal 最后一项为准。目前只读检查发现最新 entry tag 为 `0015_task_cancel_request`，idx 14；编号文件与 journal index 不相等，不得按 idx 猜文件名。建议新增 migration：

### M1：`0016_model_catalog_routing.sql`

1. 创建五张配置/审计表，依赖顺序：`provider_instances` → `provider_models` 与 `logical_models` → `model_provider_bindings` → `provider_config_audit_events`。
2. 创建 FK、CHECK、唯一/部分唯一/查询索引。所有配置引用使用 RESTRICT；审计资源 ID 不做多态 FK。
3. 在 `generation_tasks` 增加 nullable `logical_model_pk`、`route_snapshot`、`route_snapshot_version`、`route_snapshot_hash` 及基础一致性约束。
4. 在 `provider_calls` 增加 nullable 路由身份字段、基础格式约束和必要索引；不回填既有值。
5. 不 seed 默认可调用模型；导入静态模型的 seed 必须另作可审查、全 disabled/unbound 起步的脚本/迁移，不能把所有目录条目自动启用。
6. SQL 需可在空库重放；如项目采用事务迁移，遵守当前迁移 runner；若使用 `CREATE INDEX CONCURRENTLY`，必须确认 runner 非事务行为并单独设计。本次建议隔离验收阶段先采用普通索引，后续大表生产上线再评估并发建索引。

### M2：角色权限迁移（同次实现可并入 M1，但必须独立验收）

- Web 公共目录读取仅允许访问安全投影：`logical_models` 的公开展示列及有效可用性查询所需最少列；不得读 Provider Base URL、credential_ref、mapping secret 或上游内部字段。
- Web 管理 API 必须 admin 授权；DB 若不能按列/视图隔离，则由独立服务查询边界限制并测试无敏感列返回。
- Web task API 读取模型/绑定/Provider 的路由所需字段并插入任务，但不应拥有 Provider 配置表写权限、审计 UPDATE/DELETE、provider_calls DML、任务执行列 UPDATE。
- Worker 读取任务 snapshot 与需要的 Provider 配置/模型映射，写 `provider_calls` 与任务执行字段；不能改逻辑模型、Provider 配置、绑定或审计事件。
- Migration role 独立执行 DDL；Web/Worker 不得有 DDL、迁移 journal、角色管理权限。
- Secret boundary 凭据读取不通过通用 DB SELECT 权限隐式开放；credential_ref 指向单独秘密系统/受控服务端接口。若最终只能使用共用 DATABASE_URL，则需明确这只是应用层边界，不宣称 Web 与 Worker 在 DB 层隔离。
- 当前 runtimePermissions 的 `worker=true` 是同一 role 的叠加授权，不能作为上述隔离证据。实施前改造并独立验收 Web/Worker 角色配置及测试夹具；不能只给现有同一角色多加 GRANT 后宣称最小权限完成。

### M3：收缩约束（后续独立迁移，不与首次兼容扩展同批）

在已确认所有新任务都写完整快照、所有新 Provider call 都与快照一致，且 legacy 任务处置策略通过评审后，才考虑增加新任务完整性/调用身份约束。不得对全表直接 `SET NOT NULL`，除非证明历史数据已归档且无依赖，并经单独批准。对于持续保留的 legacy 行，应保留 NULL 路由身份或定义显式 legacy marker，而不是伪造字段。

## 5. 空库、非空库兼容与部署顺序

### 空库

从最早 migration 全量重放到最新版本；比较 Drizzle schema 输出与 snapshot，确认表、列、FK、索引、CHECK、默认值一致；重复执行迁移 runner 不得重复建表或改变状态。

### 非空库

非空兼容升级必须由合成隔离库模拟真实旧版数据，至少包含：queued/running/succeeded/failed/cancelled task、既有 provider_calls（submitting/unknown/accepted/terminal）、资产和用户；先运行到 0015，再插入夹具，再应用 0016。验证：

- 旧 task 的 `route_snapshot*` 与 `logical_model_pk` 仍为 NULL，原状态、payload、result、owner、幂等键和时间不变。
- 旧 provider_calls 新身份字段仍为 NULL，`provider_name`、idempotency key、job ID、状态、恢复次数和租约不变。
- 不因新增外键/约束导致既有任务或调用丢失、被归属或改路由。
- 新任务必须完整写入路由快照；删除相关配置因 FK/历史引用被拒绝。
- 不把早期 0013 空表前提改写成可安全回填历史 owner 的先例；该迁移属于历史事实，新的迁移不复制其危险推断。

部署顺序：备份并确认恢复点 → 停止旧 Worker/阻止新写入的短维护窗口（若新旧代码不兼容）→ 以 migration role 应用扩展迁移 → 部署具备兼容读取的新版本 → 验证 legacy 与新任务路径 → 恢复 Worker → 观察指标/日志。是否可滚动无停机取决于实际旧版本是否忽略新 nullable 字段，未验证前采用维护窗口方案。

## 6. 权限矩阵与需通过的数据库负例

| 能力 | Web public/catalog | Web task/admin | Worker | Migration |
|---|---:|---:|---:|---:|
| 读逻辑模型公开投影 | 是 | 是 | 必要列 | 是 |
| 读 Provider Base URL/credential_ref | 否 | 管理服务仅必要时 | 受控读取；secret 另经 boundary | 是 |
| 写 Provider/模型/绑定配置 | 否 | admin 服务受控 | 否 | DDL only |
| 写审计事件 | 否 | 配置事务内 append | 否 | 可建表 |
| 创建 task + route snapshot | 否 | 受信任务服务 | 否 | 是 |
| 更新 task 执行状态/结果/租约 | 否 | 否（仅取消列例外） | 是 | 是 |
| provider_calls DML | 否 | 否 | 是 | 是 |
| 修改 schema/journal/role | 否 | 否 | 否 | 是 |

注意：现有 grantRuntimePermissions 为相同 role 提供 Web 基础权限并可选叠加 Worker 权限。权限测试必须分别使用独立登录身份，确认 Web 无法写 `provider_calls`、执行列或配置表；Worker 无法改配置/审计；普通用户 HTTP/API 仍受服务端 admin 授权。DB 角色权限不能替代 HTTP 授权，反之亦然。

路由快照来源正例/负例：通过 task submission service 创建可得到服务端生成快照；客户端 payload 注入 route/provider/baseUrl/upstream 字段必须拒绝或剥离并使请求失败；直接由不受信调用方对 DB 提交任意 snapshot 的风险必须在身份/调用边界评估中明确。若 Web DB role 可任意 INSERT snapshot，则不要声称数据库本身验证了路由来源。

## 7. 回滚与恢复边界

- 迁移失败且事务回滚：检查 journal 与 PostgreSQL transaction 状态，修正后以新版本或按“未成功应用且可证明未落地”的迁移修复流程处理；严禁猜测事务部分提交状态。
- 迁移成功但应用代码回退：保留新增表、nullable 列、索引和审计；旧代码不依赖它们时可运行。回退时停止新配置写入和新任务创建，避免旧代码把新 route snapshot 当普通 payload 误处理；确认 Worker 对新任务的处理策略后再恢复流量。
- 不执行反向 DROP 作为常规回滚，不删除 journal 行，不重写已应用 SQL，不把新 schema 降到旧版本并丢失路由历史。
- 如果新代码已创建带快照任务或 provider_calls，恢复旧 schema 会丢失可审计路由身份并破坏任务恢复，必须优先采用应用回滚、保留扩展 schema、修复前向 migration。
- 备份恢复演练：在另一随机恢复目标还原迁移前备份，验证应用兼容、任务/provider_calls 历史、权限及 snapshot/hash；切换恢复目标会丢失备份点之后的配置审计和任务写入，需用户/运营批准。
- 本步骤不连接 `painttrack_dev`、`painttrack_test` 或生产库，不执行迁移/回滚/恢复/删除。

## 8. 隔离验收矩阵

1. **静态 Drizzle**：schema.js 与 schema.cjs 快照生成差异为空；SQL migration 与 schema/snapshot/journal 一一对应；tag、idx、时间戳单调；历史 migration hash 不变。
2. **空库重放**：完整 migration 重放与重复运行；列类型/nullability/default、FK onDelete、CHECK、partial unique index、普通索引与 snapshot 一致。
3. **非空升级**：按第 5 节旧任务/调用夹具升级，旧身份字段保持 NULL 且既有业务字段 hash/快照前后相等。
4. **约束正负例**：重复逻辑 model ID、重复 provider model 三元组、重复 binding、同一逻辑模型双主路由、零/负版本、非法状态/media/profile、非 object JSON、snapshot/hash 半套、外键引用删除均按预期拒绝。
5. **配置事务并发**：两个并发 make-primary 仅一个最终主路由；版本递增无丢失；失败事务不留下“无主/双主”的部分状态。允许未启用模型为 0 个主路由。
6. **任务快照**：配置切换前后的任务快照一致性；幂等重放返回原快照；旧任务更新路由拒绝/无代码路径；快照无密钥/URL/prompt。
7. **调用账本一致性**：新 provider_call identity/hash 与任务 snapshot 一致；故意不匹配拒绝恢复；legacy NULL 调用不按当前路由补齐、不静默重提。
8. **最小权限**：独立 Web/Worker/Migration 身份正负例；Web 不能改 task execution/snapshot（若通过受控函数写入则函数参数与调用权限也做负例）、不能写 provider_calls/配置；Worker 不能配置/审计；运行身份不能 DDL/TRUNCATE/写 migration journal。
9. **审计与秘密**：配置成功/拒绝均有固定审计事件；API/日志/审计中不存在 credential_ref 明文（如属于敏感定位符）、secret material、Authorization、完整 prompt、完整上游响应。
10. **生命周期**：停用不删除；被任务/调用/绑定引用的 Provider、Provider model、逻辑模型、binding 物理删除被拒；审计事件不可由运行角色更新/删除。

隔离验收仅在新建随机 loopback acceptance 数据库和合成数据上执行；没有授权管理员连接时报告 blocked，不尝试复用现有 DB、不猜测密码。所有新建资源保留，清理另需授权。

## 9. 尚需在实施步骤定案的事项

- Provider secret reference 的最终秘密存储/轮换/撤销策略；本迁移只容纳 opaque ref/version，不宣称生产 Secret Store 已具备。
- 上游 Base URL 的 DB 列权限和配置服务读取方案；当前运行角色是共用 role 时不具备 DB 层 Web/Worker隔离。
- 是否以独立 Web/Worker DB 登录凭据改造现有单角色启动配置；作为真实 Worker 接动态路由前置，不可跳过。
- 审计 `resource_id` 是否需要保留已删除资源的可解释映射；建议默认禁止有审计引用资源物理删除。
- JSON schema 的具体受限子集与版本化方式；不得本步以任意 JSON Schema 执行器上线。
- 生产大表索引是否需并发创建、停机窗口与 RPO/RTO；目前缺乏已批准生产容量基线。

## 10. 本步骤记录与边界

- 依据：`lib/server/db/schema.js`、migrations 0011/0013/0014/0015、`drizzle/meta/_journal.json`、最新 snapshot 0015、`runtimePermissions.js`、DB_SETUP 与 database lifecycle tests。
- 当前 journal 最新 tag 为 `0015_task_cancel_request`、idx 14；migration 目录与 journal 有已验证的一一对应检查，快照名称按 tag 前缀定位，不能按 idx 推算。
- 当前角色设计风险已确认：Worker 权限在同一运行角色上叠加，不等同于 Web/Worker 独立 DB 权限；后续验收必须修正为独立登录身份或清楚标记为应用层隔离。
- 当前仓库已有大量未提交改动与未跟踪文件；本步骤不改源码、schema、迁移或数据库，仅新增/更新阶段文档和工作日志。
- 验证范围：文档一致性与 Git diff 检查；本步骤没有程序/数据库行为改动，不运行程序测试，也不声称隔离验收已通过。
