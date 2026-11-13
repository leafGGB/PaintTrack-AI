# 阶段 4.7：多模型目录与路由数据/API 设计

- 日期：2026-11-10
- 状态：4.7.4 管理员配置 API 准入设计已完成评审；不代表已批准数据库迁移、配置写入实现或真实 Provider 调用
- 权威执行顺序：仓库外 `../ImplementationPlan/PAINTTRACK_DEVELOPMENT_PROCESS.md` 第 10 节
- 关联契约：`PHASE4_MULTI_PROVIDER_ROUTING_CONTRACT.md`
- 目标：允许管理员维护多个图片/视频逻辑模型，为每个逻辑模型绑定一个或多个 Provider 实例下的上游模型；Studio 只使用逻辑模型 ID，服务端按不可变任务路由快照执行。
- 本设计稿最初边界：仅设计数据实体、关系、API 契约、权限/删除语义、迁移策略与验收矩阵。
- 后续实施步骤记录在第 14 节；本稿更新不代表配置写 API 获准。

## 1. 用户需求与设计结论

用户确认 PaintTrack 并非只有一个生图/生视频模型；现有 Studio 模型列表需要能够由后台添加、编辑、启用/下线，并指定每个 PaintTrack 逻辑模型使用哪个 Provider 实例下的上游模型。

据此确定：

1. 逻辑模型目录是多项目录，不硬编码为 `gpt-image-2`。
2. 逻辑模型、Provider 实例、Provider 上游模型和路由绑定是不同实体。
3. 同一个逻辑模型可配置多个绑定，显式指定一个主路由和备用顺序；默认不自动故障转移。
4. Studio 只提交 `logicalModelId` 与业务参数；Provider、Base URL、密钥、上游模型名均由服务端解析。
5. 创建任务时原子保存路由快照。切换配置只影响新任务；排队、重试、未知提交恢复与查询沿用原快照。
6. 模型下线默认软禁用；存在历史任务、调用账本、绑定或审计引用时拒绝物理删除。
7. 现有静态目录继续作为 UI/参数兼容模板，逐步迁移。动态目录决定可调用和可展示状态，不能因为服务端模型名与模板不一致而泄漏上游信息或默默猜参数。
8. `gpt-image-2` MyVigna Adapter 是已验证的首个 Adapter/profile 样例，不是平台模型白名单。

## 2. 当前实现审查基线

### 2.1 Studio 模型元数据

`packages/studio/src/models.js` 含有大量现有模型与模式列表（当前可见导出包括 `t2iModels`、`t2vModels`、`i2iModels`、`i2vModels`；另有 v2v 等目录），`modelFamilies.js`、`modelCapabilities.js`、`modelParameters.js`、视频参数模块负责模型族归并、变体、参数表单和工作流约束。不得通过替换一个小型动态列表而破坏这些既有能力。

第一阶段迁移建议：

- 保留现有静态资料作为 `capability_template_key` 对应的 UI/参数模板。
- 服务端模型目录返回稳定逻辑 ID、启用状态、受支持 mode、展示字段、模板 key/版本和必要的受限 schema。
- 前端按逻辑 ID 合并；只有服务端可用目录与兼容模板匹配，或存在经过审核的通用参数 schema 时才允许生成。
- 未匹配、未知能力、未知 schema 版本均 fail-closed；不得默认套用另一个模型的参数或 endpoint。
- 服务端仍需独立校验业务参数，不信任浏览器提交的 capabilities 或 schema。

### 2.2 任务输入限制

当前 `lib/server/tasks/taskSubmission.js` 对图片任务中出现的 `logicalModelId` 特判为 `gpt-image-2`，并使用固定字段集和首期尺寸映射。动态目录上线时，应把该单模型分支替换为服务端读取 `logical_models` 的模型类型、启用状态、operation 和参数 schema 校验；在该替换与迁移完成前，不能宣称所有 Studio 模型已接通任务 API。

现有 `generation_tasks` 字段包含 task type、payload、owner、幂等键、请求指纹、结果和取消状态，但没有模型外键或路由快照。现有 `provider_calls` 记录 `provider_name`、上游 job ID 和幂等键，尚不能区分同名 Provider 的多个实例，也没有上游模型、绑定版本和 Adapter profile 身份。

### 2.3 现有权限/迁移约束

任务表通过独立迁移追加 owner、幂等、result 和取消字段；Web 角色采用列级授权，Worker 承担执行状态与结果更新。新 Provider 配置表和路由表应沿用最小权限分离，不把密钥写入任务 payload 或调用日志。当前 migration 以显式 SQL 和 Drizzle schema/snapshot/journal 一致性管理，实际迁移前需设计空库/非空库策略及回滚/恢复方式。此设计阶段不执行迁移。

## 3. 概念实体与关系

```text
provider_instances 1 ── * provider_models
                                  │
                                  *
logical_models 1 ── * model_provider_bindings * ── 1 provider_models
       │                         │
       │                         └─ 主路由/备用顺序、映射版本、状态
       │
       └── generation_tasks.route_snapshot (首次创建时固定)
                   │
                   └── provider_calls (实际调用按快照身份记录)

provider_config_audit_events 记录以上配置的管理员变更，不存秘密值
```

模型发现结果是候选元数据，不应直接成为 `provider_models` 的可调用记录；必须经过能力/Adapter/profile 验证和管理员启用。

## 4. 候选表结构（逻辑设计，非迁移 SQL）

字段类型是候选，最终需在后续 schema 小步骤验证命名、约束、索引、删除行为与权限。

### 4.1 `provider_instances`

| 字段 | 约束/含义 |
|---|---|
| `id` | UUID 主键；稳定实例身份 |
| `slug` | 管理员可读稳定代号；同一作用域唯一，不作为路由输入 |
| `display_name` | 管理后台展示名称 |
| `adapter_type` | 服务端 allowlist 中的 Adapter 类型；不可从客户端动态加载模块 |
| `base_url` | 规范化 Provider 根地址；仅服务端可读，禁止凭据嵌入 URL |
| `credential_ref` | 指向服务端 Secret Store/加密秘密记录的引用；密文方案另行设计，不在本表明文保存 key |
| `enabled` | 是否允许新任务使用 |
| `health_state` | `unknown/healthy/degraded/disabled` 等观测值，不等同服务可用承诺 |
| `config_version` | 影响请求行为的配置每次更新递增 |
| `created_at/updated_at/disabled_at` | 审计与软禁用时间 |

密钥轮换应记录审计并更新秘密版本；若轮换不改变请求映射，不必改变逻辑模型绑定身份，但需明确任务快照执行时使用当前密钥还是固定 secret version。安全建议：固定 secret reference/version；若旧密钥撤销导致既有任务不可执行，任务明确失败/待管理员处理，不静默换线路。

### 4.2 `logical_models`

| 字段 | 约束/含义 |
|---|---|
| `id` | UUID 主键 |
| `logical_model_id` | 全局稳定的产品 ID（例如 `gpt-image-2`、`gemini-3-pro-image-preview`、`kling-v3`）；创建后不因上游名称变化而复用 |
| `display_name` | Studio 显示名 |
| `provider_display_name` | 可选厂商/系列标签，仅用于展示，不作为 Provider 路由依据 |
| `media_type` | `image/video/audio` 等受控枚举 |
| `supported_operations` | 与 task type/Studio mode 对应的受控操作集合，例如 `image.generate`、`image.edit`、`video.generate` |
| `capability_template_key/version` | 现有 Studio 参数/UI 模板兼容引用；可空但需有已验证通用 schema 才能启用 |
| `parameter_schema` | 服务端权威 JSON Schema 子集或受控参数契约版本；限制复杂度与可执行能力，不接受脚本/任意代码 |
| `description/icon_key` | 可选展示资料；图标优先用受控本地 key |
| `enabled/sort_order` | 是否出现在用户目录及展示顺序 |
| `catalog_version/created_at/updated_at/disabled_at` | 目录版本和软下线审计 |

`logical_model_id` 唯一且不可变。模型重新命名使用 `display_name`；真正改变语义时创建新 ID，不复用已有历史 ID。

### 4.3 `provider_models`

| 字段 | 约束/含义 |
|---|---|
| `id` | UUID 主键 |
| `provider_instance_id` | 外键到 Provider 实例；使用限制删除 |
| `upstream_model_name` | 精确上游模型名，大小写/后缀原样保存，仅服务端和授权管理端可见 |
| `media_type` | 图片/视频等类型 |
| `operation_profile` | Adapter allowlist 中已实现的 endpoint/operation profile |
| `capabilities` | 经验证的能力集合，不从上游模型列表自动推断 |
| `parameter_mapping` / `request_mapping_version` / `response_mapping_version` | 经审查映射配置及版本；禁止自由执行代码 |
| `validation_state` | `unverified/verified/disabled` 等；未验证记录不能被绑定为有效路由 |
| `enabled` | 管理员启用状态 |
| `created_at/updated_at/disabled_at` | 生命周期字段 |

同一 Provider 下 `(provider_instance_id, upstream_model_name, operation_profile)` 建议唯一。模型发现只可创建待审核候选，禁止自动设置 `validation_state=verified`。

### 4.4 `model_provider_bindings`

| 字段 | 约束/含义 |
|---|---|
| `id` | UUID 主键 |
| `logical_model_id` | 逻辑模型外键；逻辑 ID 在快照中另存以便审计 |
| `provider_model_id` | 指向已验证 Provider 上游模型 |
| `priority` | 正整数，排序唯一性按模型范围约束 |
| `is_primary` | 每个启用的逻辑模型最多一个启用主路由；数据库可用 partial unique index |
| `enabled` | 绑定是否参与新任务路由 |
| `binding_version` | 影响路由/参数映射的修改递增 |
| `created_by/updated_by/created_at/updated_at/disabled_at` | 管理审计信息 |

必须满足：主绑定指向 enabled Provider、enabled 且 verified 的 Provider model，operation/媒体能力与 logical model 兼容；变更须在事务内保证每逻辑模型恰有 0 或 1 个主绑定。主路由切换只影响尚未创建的任务。备用绑定首期只用于人工切换，不隐含自动故障转移。

### 4.5 `generation_tasks` 路由快照

建议增加 `route_snapshot jsonb`，要求仅在已验证的生成任务提交成功时非空，并用数据库 JSON object/check 校验。快照最少字段：

```json
{
  "snapshotVersion": 1,
  "logicalModelId": "gemini-3-pro-image-preview",
  "logicalModelVersion": 12,
  "providerInstanceId": "opaque-uuid",
  "providerConfigVersion": 3,
  "credentialRefVersion": 2,
  "providerModelId": "opaque-uuid",
  "upstreamModelName": "gemini-3-pro-image-preview",
  "adapterType": "gemini-compatible",
  "adapterVersion": "1.0.0",
  "operationProfile": "image-generation-async-v1",
  "bindingId": "opaque-uuid",
  "bindingVersion": 5,
  "requestMappingVersion": 2,
  "responseMappingVersion": 1,
  "capabilitySnapshot": {
    "operation": "image.generate",
    "mediaType": "image"
  }
}
```

快照不得包含：Base URL、API Key、Authorization、完整 prompt、媒体字节、无关上游响应。`credentialRefVersion` 是否需要固定需结合密钥轮换/撤销策略最终确定；如果存入任务行，必须是不能反推出秘密的 opaque version/ref。

任务创建事务必须锁定或以版本条件读取逻辑模型、绑定、Provider 和 Provider model，规范化业务 payload，写入 task、请求指纹和快照。若配置在事务期间改变，应整体重试或返回明确冲突，不允许写入混合版本快照。

重放幂等请求：先按 owner + idempotency key 找已有任务并比较业务请求指纹；匹配时返回原任务/原快照。不能因管理员切换主绑定造成幂等冲突或重新解析旧任务。

### 4.6 `provider_calls` 身份扩展

现有 `provider_name` 字段可保留作兼容/观测标签，但不再作为唯一路由身份。候选增加：

- `provider_instance_id`
- `provider_config_version`
- `provider_model_id`
- `logical_model_id`
- `binding_id` 与 `binding_version`
- `adapter_type` 与 `adapter_version`
- `upstream_model_name`
- `operation_profile`
- 可选 `route_snapshot_hash`

开始调用时从任务快照写入这些字段；恢复时验证调用记录身份与快照一致。发生不匹配应 fail-closed，不能调用当前主路由。已有 `provider_calls` 记录的扩展迁移需考虑空表/非空表兼容：先允许旧记录的新字段为 NULL 并标记 legacy，再由新代码只为具备快照的新任务写完整字段；不得伪造旧任务的 Provider 实例身份。

### 4.7 `provider_config_audit_events`

建议存：事件 ID、操作者 ID、资源类型/ID、动作类型、配置版本前后值摘要（脱敏）、request ID、时间、结果与固定原因码。不得存 API Key、Authorization、完整 prompt、Base URL 中的凭据或完整上游响应。审计记录只追加，不随逻辑模型/Provider 下线删除。

## 5. API 契约

路径为建议，需服从项目现有路由与管理员授权模式；所有写 API 需认证、admin 授权、Origin/CSRF 校验、速率限制、审计与固定错误码。

### 5.1 Studio 公共动态目录

```http
GET /api/catalog/models?media=image
GET /api/catalog/models?media=video
```

示例：

```json
{
  "catalogVersion": "opaque-version",
  "models": [
    {
      "logicalModelId": "gemini-3-pro-image-preview",
      "displayName": "Gemini 3 Pro Image Preview",
      "providerDisplayName": "Google",
      "mediaType": "image",
      "operations": ["image.generate", "image.edit"],
      "studioModeIds": ["t2i", "i2i"],
      "capabilityTemplate": {"key": "gemini-image", "version": 1},
      "parameterSchemaVersion": 2,
      "availability": "available",
      "sortOrder": 120
    }
  ]
}
```

公共响应不含 Provider 实例 ID、Base URL、凭据状态细节、上游模型名、成本或备用线路。若无有效主绑定，默认不列为可生成模型；若产品希望显示但不可用，应返回明确 `availability`，不能把它伪装成可生成。

目录缓存按 `catalogVersion`/ETag；配置版本更新使缓存失效。Studio 的已保存旧选择若已下线，应安全回退到有效模型并提示，不能把旧 ID 当有效路由发送。

### 5.2 管理员逻辑模型 API

候选：

- `GET /api/admin/model-catalog`：分页读取逻辑模型及绑定摘要。
- `POST /api/admin/model-catalog`：创建逻辑模型。
- `PATCH /api/admin/model-catalog/{id}`：修改显示字段、schema/template 版本、排序、启用状态。
- `POST /api/admin/model-catalog/{id}/disable`：软下线。

创建/更新只能选择服务端已知的 `capability_template_key`、受限 schema 版本和受支持 operations；不接受脚本、任意 endpoint 或模块路径。`logicalModelId` 创建后不可变。涉及修改参数语义的更新必须产生新 `catalog_version`，不得追溯改变旧任务快照。

### 5.3 Provider 与上游模型 API

候选：

- `/api/admin/providers`：Provider 实例列表、新增、修改、启用、停用、轮换秘密、删除请求。
- `/api/admin/providers/{providerId}/models`：上游模型候选及已登记模型列表；新增/验证/启停。
- `/api/admin/providers/{providerId}/test`：服务端连通测试，限流并返回脱敏状态。

Provider 列表返回 `credentialConfigured`、`credentialUpdatedAt` 等安全元数据，不回传凭据。上游模型 discovery 是候选数据；登记为可用之前必须绑定已实现 Adapter profile 并通过请求/响应 mock fixture 或受控验收。

### 5.4 路由绑定 API

候选：

- `GET /api/admin/model-catalog/{logicalModelId}/bindings`
- `POST /api/admin/model-catalog/{logicalModelId}/bindings`
- `PATCH /api/admin/model-bindings/{bindingId}`
- `POST /api/admin/model-bindings/{bindingId}/make-primary`
- `POST /api/admin/model-bindings/{bindingId}/disable`

绑定写入需检查模型/Provider/上游模型均存在、启用且能力兼容；主路由切换事务性更新唯一主绑定并递增 binding version，审计明确“只影响新任务”。首期不提供自动 failover 开关，避免 UI 暗示尚未实现的恢复语义。

## 6. 删除、版本、审计与权限

### 6.1 生命周期

- Provider、逻辑模型、Provider model、绑定均优先软禁用。
- 被任务快照、provider_calls、有效/历史绑定或审计事件引用时，禁止物理删除。
- 绑定可禁用；若任务快照保留原绑定身份，绑定历史记录不得级联删除。
- Provider 停用阻止新任务；已提交/排队任务遵循快照和可用性处置策略。无法按快照执行时明确失败/等待管理员处理，不自动改道。
- 物理删除只允许从未被引用、无审计保留要求的草稿/测试配置，并经服务端检查后执行；默认管理操作不提供永久删除。

### 6.2 数据库角色建议

- Web 公共目录：只读逻辑模型中可公开字段及有效主绑定存在性；不能读取 credential ref/secret。
- Web 管理 API：通过独立受控服务层执行 admin 授权；尽量以窄查询和列级权限读取必要字段。管理 API 禁止把 secret material 返回给 Web。
- Web 创建任务：可读取目录/路由并在事务中创建 task，但不能自行改 Provider 配置、路由快照或 provider_calls。
- Worker：读取任务 payload 与路由快照、按快照受控解析 Provider 配置、写任务执行字段和 provider_calls；不授予模型配置管理权限。
- Migration 身份：只用于迁移，不进入常驻 Web/Worker 环境。
- Secret Store：只有 Provider Adapter/专用服务端 secret boundary 可取用；普通模型目录、任务响应和日志均不可读。

需进一步审计现有 `DATABASE_URL` 角色是否能满足“Web 读取/写入配置”和“Worker 读取秘密引用”的边界；若无法细分，不能把保密承诺仅建立在 UI 不返回字段上，必须通过独立 DB role、服务端 API 边界或 Secret Store 权限实现。

## 7. 参数与能力 schema 兼容策略

1. Studio 的模式/参数控制来自现有模板或受限动态 schema；具体可用字段以逻辑模型服务端 schema 版本为准。
2. 客户端传入的 `taskType`、`logicalModelId`、业务参数必须经过服务端 schema 校验和规范化；不接收客户端给出的 Provider/上游模型/映射版本。
3. Adapter profile 定义协议/端点行为；逻辑模型 schema 定义用户可选参数；binding mapping 将规范参数翻译为上游请求。三者分别版本化。
4. `model_provider_bindings` 若无法满足逻辑模型所要求的 capability/参数域，不可设为 primary。
5. 如果多个绑定的可用参数交集不足以满足该逻辑模型，禁止静默裁剪参数；应要求模型定义选择兼容能力集或分拆逻辑模型。
6. 图片、视频各 operation 独立验证，不能仅凭“OpenAI compatible”标签判定可用。

## 8. 配置切换和快照语义

- 新任务解析逻辑模型 → 当前主绑定 → Provider model → Provider instance，并在同一 DB 事务写任务快照。
- 同幂等键同业务请求重放返回原任务，不重新解析当前路由。
- 任务重试、Worker 崩溃恢复、`unknown` 提交恢复和 poll 始终使用快照中身份及原 provider call 幂等键。
- 管理员主路由切换不修改已有 task 或 provider_call；只改变后续任务解析。
- 配置被停用、删除请求或凭据撤销影响既有任务时，采取可审计的暂停/失败/人工处置策略；禁止静默切换到其他 Provider。
- 首期备用绑定供管理员显式切换主路由，不作自动故障转移。以后引入自动故障转移必须另有产品授权、重复计费/未知提交规则与验收。

## 9. 迁移策略与顺序

本稿不生成 SQL。后续实现前至少完成以下子步骤：

1. 盘点现有模型目录中的 ID、mode、参数 template、模型族和重复 endpoint，生成可审查的导入映射；不要把所有静态条目自动标成可用。
2. 确定新表与 `generation_tasks.route_snapshot`、`provider_calls` 扩展的 Drizzle schema、SQL、snapshot、journal、CHECK/索引/外键及列级权限。
3. 为旧 task/provider_call 设计兼容策略。不得虚构旧记录路由身份；旧记录标记 legacy/NULL 路由身份，且只有新版本任务要求完整快照。
4. 定义初始逻辑模型 seed：静态模型可导入为 disabled/unbound 或已审查状态；仅当对应 Adapter/profile 和参数映射通过验证后才允许 enabled。
5. 先在隔离数据库验收空库初始化与非空库升级策略、并发主路由切换、历史引用阻止删除、任务快照不可变和 Web/Worker 权限正负例。
6. 迁移必须由独立 migration role 执行；不在本设计步骤应用到 `painttrack_dev`、`painttrack_test` 或任何外部数据库。

若迁移必须在非空数据库上线，应采用兼容性扩展（nullable 新列/新表 → 新代码双读或受控读 → 新任务写快照 → 验证 → 后续收紧约束），不能用“表为空”的假设掩盖历史任务身份缺失。具体迁移顺序和回滚方案须在数据库设计验收步骤定案。

## 10. 验收矩阵

| 范围 | 验收条件 |
|---|---|
| 多模型目录 | 至少可表达多个图片和视频逻辑模型；ID 稳定；媒体类型、operation、template/schema 版本可区分 |
| Provider 多实例 | 同一 adapter 下多个实例可共存；不同配置版本和同名 Provider 不混淆 |
| 上游模型登记 | discovery 候选不自动启用；未验证 profile/能力不能绑定为 primary |
| 路由关系 | 一个逻辑模型多个绑定；最多一个 enabled primary；禁用/能力不兼容项不能设主路由 |
| 动态目录 | 只返回公开展示字段和有效模型；不返回凭据、Base URL、秘密引用、非必要上游信息 |
| 参数校验 | 服务端按逻辑模型 schema 校验；未知字段、未知 schema/template 版本、伪造路由字段拒绝 |
| 快照原子性 | 路由读取与任务创建形成一致快照；并发切换不能产生混合配置版本 |
| 快照不可变 | 切换主路由后旧任务/重放/恢复保持旧快照；新任务使用新绑定 |
| 幂等 | 同 owner + key + 同规范业务请求重放原 task/route；同 key 不同请求冲突 |
| Provider call 恢复 | 原实例、模型、Adapter/profile、映射版本与幂等键保持一致；不匹配 fail-closed |
| 删除保护 | 任何历史任务/provider_call/绑定/审计引用阻止物理删除；软下线不破坏查询 |
| 权限 | 普通用户不能读取/改配置；Web 不能写任务路由快照或 provider_calls；Worker 不能改模型配置；迁移身份不进常驻服务 |
| 配置审计 | 添加、编辑、启停、轮换、绑定和主路由变更均审计；秘密/完整请求不入日志 |
| 迁移 | Drizzle schema、SQL、snapshot、journal 一致；旧记录不被伪造归属/路由；隔离数据库正负例通过 |

## 11. 风险与未决细节

本设计不阻塞产品方向，但下列实现细节需在各自迁移/API 步骤前确定：

1. Provider 凭据使用本机环境变量、加密数据库字段还是 Secret Store；生产方案尚未确定。
2. 任务快照中的 secret version 固定语义：历史任务引用旧密钥版本会增加撤销/保留管理成本，改用当前密钥则须确保不会改变路由身份且任务执行策略可解释。
3. `parameter_schema` 采用受限 JSON Schema 子集还是模板注册表；禁止 arbitrary executable schema。
4. 多绑定主路由切换的并发控制方式（行锁/版本 compare-and-swap/事务约束触发器）。
5. Provider 上游模型是否支持人工登记、只做发现，或两者并行；任何方式都不替代能力验证。
6. 图片/视频模型完整清单、首批可启用能力与顺序需由当前静态目录审计生成；此设计不自动批准所有历史静态模型向用户开放。
7. Web 与 Worker 当前数据库角色/Secret Store 是否足以实现本文最小权限，需要在实施前检查现有 DB setup 和部署边界。
8. 动态目录的缓存、客户端旧模型选择恢复策略及模型目录版本格式需与现有 Studio 持久化兼容测试。

## 12. 4.7.4 管理员配置 API 准入设计（2026-11-11）

本小步骤只完成现状审查、API 边界和安全准入设计，不实现写路由、不修改数据库、不接入真实 Provider。

### 12.1 首版资源与动作

1. **逻辑模型**：`GET/POST /api/admin/model-catalog`、`PATCH /api/admin/model-catalog/{id}`、`POST .../{id}/enable`、`POST .../{id}/disable`。稳定 `logicalModelId` 创建后不可修改；只允许服务端 allowlist 的媒体类型、operations、模板/schema 版本和本地图标 key。
2. **Provider 实例**：`GET/POST /api/admin/providers`、`PATCH /api/admin/providers/{id}`、启用/停用动作、凭据轮换动作。响应只返回脱敏状态，例如 `credentialConfigured` 和版本/更新时间；绝不返回凭据、Authorization、秘密引用或可用于定位秘密的原始材料。
3. **Provider 上游模型**：`GET/POST /api/admin/providers/{providerId}/models`、`PATCH`、验证/启用/停用动作。发现结果只能创建 `unverified` 候选；未经 Adapter profile、请求/响应 mock 和能力审查，不得变为 `verified` 或参与主绑定。
4. **路由绑定**：读取、创建、更新优先级/启用状态、切换主绑定、停用。主绑定切换在事务中锁定逻辑模型，递增 binding version，确保最多一个启用主绑定；首版不提供自动故障转移。

### 12.2 统一 HTTP 与授权规则

- 所有写请求必须通过同源 Origin/Fetch Metadata 检查、严格 JSON body schema、请求体大小限制、请求 ID、速率限制和固定错误码。
- 所有资源写入必须重新从服务端 session 读取角色，并要求 `requireAdminMfa`；不能信任客户端角色、`authLevel`、资源 owner 或“已确认”字段。
- Provider Base URL 变更、凭据轮换、启用未验证模型和切换主路由属于高影响操作，除 MFA 外要求近期 `requireAdminStepUp`；失败时不产生部分写入。
- 所有成功和拒绝的配置动作都在同一受控事务中追加脱敏审计；审计只追加，运行 Web/Worker 身份不得 UPDATE/DELETE 审计记录。
- 配置更新使用 `config_version`/`binding_version`/`catalog_version` 的版本条件或等价行锁；版本冲突返回明确 `409 CONFIG_VERSION_CONFLICT`，不能静默覆盖并发修改。
- Provider、Provider model、逻辑模型和绑定默认软禁用；存在任务快照、provider_calls、绑定或审计引用时，首版不提供物理删除。

### 12.3 字段和秘密边界

- Provider `adapterType`、`operationProfile`、template key/version、schema version、operations、icon key 均使用服务端 allowlist；拒绝模块路径、脚本、任意 endpoint 和可执行 JSON Schema。
- Base URL 只接受规范化、无 userinfo/query/fragment 的批准 HTTPS 地址；服务端连接测试、模型发现、结果抓取统一执行私网/loopback/link-local/metadata 拒绝、DNS rebinding 防护、禁止自动重定向、超时、响应大小和 schema 校验。
- API、日志、审计摘要、任务 payload、路由快照和 provider_calls 均不得包含 API key、Authorization、secret material、完整 Base URL（若含敏感定位信息）、完整 prompt 或完整上游响应。
- 任务路由快照只保存不含秘密的 Provider/模型/绑定身份、版本、Adapter/profile 和能力摘要；配置切换只影响新任务，旧任务按原快照恢复。
- Web/Worker 当前运行角色没有配置表写权限；在独立 Web/Worker 身份、审计 append 权限和 Secret boundary 定案前，不实现可写配置服务，也不把同一角色叠加权限称为最小权限隔离。

### 12.4 实施顺序与验收门禁

1. 先补齐 schema/SQL 中模板、schema、snapshot、version/hash 的显式 `IS NOT NULL` 配对约束，并为单边 NULL 写真实 PostgreSQL 负例。
2. 再设计独立 Web/Worker/Migration 角色和 Secret boundary；验证 Web/Worker 的配置、审计、provider_calls、任务执行字段正负例。
3. 实现只读管理员详情查询和严格字段校验；先以全 disabled/unbound 合成数据验收。
4. 实现 Provider/模型/绑定事务服务与脱敏审计，再接对应 HTTP 写 API；为并发主路由切换、版本冲突、失败回滚、删除保护补真实数据库验收。
5. 最后才允许动态目录从配置数据产生可用模型；Provider 写 API、真实凭据和公网连通测试仍须单独授权，不因本设计完成自动开放。

## 13. 本步骤验证与边界

- 本步骤完成了只读代码审查、API/安全边界固化和设计文档修订；没有实现业务写路由，没有修改 schema/SQL migration，没有连接或修改数据库。
- 依据：当前 `schema.js`、0016/0017 migrations、`runtimePermissions.js`、`modelCatalog.js`、`catalogHttp.js`、`providerConfig.js`、任务 API 与阶段 4.7 设计稿。
- 已确认：公共目录只读投影不暴露 Provider 实例、Base URL、凭据引用、上游模型名和参数映射；管理员 MFA 门禁已由服务端强制覆盖管理员汇总、模型目录和任务 API。
- 未访问公网、未使用真实 Provider 凭据、未创建云资源、未修改任何数据库；本步骤不宣称配置写 API 已实现或 Provider 已可用。
- 下一步：先完成 nullable pair 约束修正及真实 PostgreSQL 正负例；随后独立 Web/Worker/Migration 角色与 Secret boundary 仍需单独设计、实现和验收，再进入配置事务服务和 HTTP 写 API。

## 14. 4.7.4 下一小步骤：NULL 配对约束与权限边界（2026-11-11）

### 14.1 SQL NULL 约束修正

PostgreSQL `CHECK` 只拒绝 `FALSE`，表达式结果为 `NULL` 时视为通过。因此原有模板/schema 成对校验可能允许左侧字段存在、版本字段为 NULL；原有路由快照校验也可能允许只有部分快照字段的行。

新增 `0021_route_snapshot_null_pair_checks`，不改写历史迁移：

- `logical_models` 的模板 key/version 与参数 schema/version 均要求“全部 NULL”或“值与正版本全齐”；schema 若存在必须为 JSON object。
- `generation_tasks` 的 `logical_model_pk`、snapshot、snapshot version、hash 要求四字段全 NULL 或四字段全齐；完整快照的版本必须为正，hash 必须是 64 位小写十六进制。
- 全 NULL 路由字段继续兼容 0021 以前的历史任务；不回填或伪造历史路由身份。
- `schema.js`、SQL、0021 snapshot 与 journal 同步；旧 migration 文件保持不变。

隔离数据库验收新增真实 PostgreSQL 正负例：两种全空/全齐状态应通过，模板/schema 和快照各单边 NULL 状态应以预期 CHECK 失败。迁移只可由脚本在 loopback:5433 新建随机隔离库中验证；不得对 `.env` 中的既有业务数据库执行。

### 14.2 数据库身份现状与准入边界

本机启动器使用独立 migration owner 与 runtime role；Migration 凭据只交给迁移准备逻辑，Next 子进程仅接收 runtime `DATABASE_URL`。真实 Web 角色正负权限由隔离验收脚本中的独立 NOLOGIN probe 角色代表。Worker 目前没有独立登录角色：`grantRuntimePermissions(..., { worker: true })` 在同一个 runtime role 上累加执行权限，不能视为 Web/Worker 数据库身份隔离。

当前可验证结论仅为：

- Migration 与常驻 runtime 在本机启动器中使用不同数据库身份。
- Web probe 只能读取安全目录视图，不能读取 Provider 实例/上游模型明细，也不能写 provider_calls、Worker 租约/结果或 Provider 配置。
- `worker: true` 角色是 Web+Worker 合并权限的测试/运行合并身份，不是生产最小权限隔离证明。
- 审计 append-only 权限、Worker 独立数据库身份及 Provider secret 的读取边界未全部落地；Provider 配置写 API 必须继续关闭。

### 14.3 本小步骤边界

只修正数据库 nullable pair CHECK 并增加隔离验收。未新建常驻 Worker role、未扩大 Provider 配置表权限、未连接真实 Provider、未访问或修改任何既有业务数据库，未实现管理员 Provider 写 API。独立 Web/Worker/Migration 与 Secret boundary 的完整设计和正负权限验收仍是写 API 前置门禁。

## 15. 4.7.5 Web/Worker/Migration 数据库身份拆分（2026-11-12）

本节替换 14.2 中「Worker 没有独立登录角色」的旧结论。14.2 保留原文，仅作为历史记录，不再代表当前实现。

### 15.1 已落地的代码改动

**Worker 连接改为 fail-closed**（`lib/server/worker/index.js`）

原实现为 `databaseUrl || PAINTTRACK_WORKER_DATABASE_URL || getEnvironment().databaseUrl`，最后一段让 Worker 在缺少独立凭据时静默复用 Web 的 `DATABASE_URL`，使身份隔离在该路径上形同不存在。现改为只接受显式入参或 `PAINTTRACK_WORKER_DATABASE_URL`，两者都缺失时直接抛错，不建立连接，也不再依赖 `getEnvironment()`。

**权限授予按身份拆分**（`lib/server/db/runtimePermissions.js`）

- 拆为 `grantWebRuntimePermissions` 与 `grantWorkerRuntimePermissions` 两个入口。
- 旧入口 `grantRuntimePermissions(..., { worker: true })` 保留签名但直接抛错，防止合并身份被重新引入。
- Web 侧：`provider_config_audit_events` 只授 `INSERT`；`generation_tasks` 只授取消相关列 `UPDATE`（`status`、`cancel_requested_at`、`completed_at`、`updated_at`）与建任务所需列 `INSERT`；不再有 `email_outbox` 的 `UPDATE`；`provider_calls` 无任何权限。
- Worker 侧：`generation_tasks` 授 `SELECT` 与执行列 `UPDATE`；`provider_calls` 授 `SELECT`、`INSERT` 与执行列 `UPDATE`，**不授 `DELETE`**；`email_outbox` 授 `SELECT`、`UPDATE`；保留目录与路由读权限；**不授** `provider_config_audit_events` 任何权限。

**本机启动器拆出三个数据库身份**（`scripts/local-registration.js`）

- 创建 migration / runtime / worker 三个角色，分别建连接串。
- `CONNECT` 与 schema `USAGE` 同时授予 runtime 与 worker。
- Web、Worker 授权分别调用对应入口。
- Worker 连接串**不再进入 Next 子进程环境**；由 `createWorkerEnvironment(workerUrl)` 单独构造，只含系统环境、`NODE_ENV`、`PAINTTRACK_WORKER_DATABASE_URL`、`PAINTTRACK_WORKER_PROVIDER` 与可选 `PAINTTRACK_WORKER_ID`。
- 独立 Worker 进程仅在 `PAINTTRACK_LOCAL_WORKER=1` 时启动，避免本机注册入口默认带出 Provider/邮件 Worker 副作用。

**隔离验收脚本补齐 Worker 维度**（`scripts/accept-database-local.js`）

- 新建 `pt_worker_<suffix>` 角色、随机密码与独立 URL，并在 `checkDatabase` 中传入。
- 新增 `checkWorkerRolePrivileges`：比对列级权限清单、断言 Worker 无任务 `INSERT`/`DELETE`、无 `provider_calls` `DELETE`、无审计 `INSERT`/`UPDATE`/`DELETE`，并在 `SET ROLE` 后执行真实越权 SQL 负例。
- Web 验收新增审计 append-only 正反例：真实 `INSERT` 成功，`UPDATE`/`DELETE` 以 `42501` 拒绝。
- `checkPostgresWorkers` 改用 Worker URL 启动子进程；`main()` 已补传 `workerUrl`（此前遗漏该参数）。
- `assertDistinctRuntimeIdentity(runtimeUrl, workerUrl)` 加入 Worker 验收，`pg_stat_activity.usename` 的期望值改为 Worker role。

**Worker 验收 fixture 自证身份**（`tests/fixtures/worker-postgres.cjs`）

改用 `PAINTTRACK_WORKER_DATABASE_URL`，并在启动 Worker pool 之前用独立连接执行 `SELECT current_user`，经 IPC 发出 `identity` 事件，由主验收比对实际登录角色；失败时不输出连接串与 PostgreSQL 错误正文。

**环境与单元测试**

- `lib/server/env.js` 解析 `PAINTTRACK_WORKER_DATABASE_URL` 并纳入 PostgreSQL URL 格式校验，返回 `workerDatabaseUrl`。
- `tests/localRegistrationLauncher.test.js` 新增用例：Worker 环境含 Worker URL，不含 `DATABASE_URL`、`MIGRATION_DATABASE_URL`、`PAINTTRACK_PROVIDER_CREDENTIAL`，保留 `PATH`；缺 URL 时抛错。

### 15.2 已验证与未验证

**最终收尾结论（优先于全部历史记录）：4.7.5本地实现及真实隔离库验收已完成。**

- 最终命令：在嵌套仓库根运行 `RUN_ADMIN_MFA_PG_ACCEPTANCE=1 npm run test:db:local`，退出0；日志 `.workbuddy/phase4-4.7.5-final-with-mfa.log`，报告 `.workbuddy/database-acceptance-mwcyonlg_45f52d.json` status=passed，108 passed/0 failed/0 skipped。4条running为段落开始事件，各段有passed及最终passed，不是悬置检查。默认命令报告mwcyn04y_04cf67也passed（99 passed/1 skipped，跳过MFA），由最终含MFA报告补齐覆盖。
- 原四项验收缺口均闭环：真实PG整体passed；Worker显式185项列级清单与真实展开一致；Web最小权限清单及正负回归通过；Worker该段越权真实返回42501。3个独立Worker后端并发12任务、SIGKILL后自然过期重领、旧token heartbeat/complete/fail fencing、有效心跳、协作/非协作停止与恢复、无遗留连接/事务均通过。
- 本轮修复6文件：accept-database-local.js及email-outbox/provider-call-ledger/task-executor/task-cancel/authorization五个fixture。Web建任务/取消/查询，Worker邮件与调用账本/任务执行，migration准备资产/邮件及精确清理；完整Worker段清理由migration执行，fencing独立Worker pool执行。未更改runtimePermissions.js授权。
- 定向单测命令 `node --test tests/localRegistrationLauncher.test.js tests/databaseLifecycle.test.js tests/serverEnvironment.test.js tests/worker.test.js` 为53 pass/0 fail、退出0（`.workbuddy/phase4-4.7.5-final-unit.log`）；6文件node --check及限定git diff --check退出0（`.workbuddy/phase4-4.7.5-completion-check.log`）。
- 隔离库pt_acceptance_mwcyonlg_45f52d及四角色按策略保留，其他尝试同样保留，不自动清理。未触碰既有业务库、未连接真实Provider或公网、未开放写API。
- 本结论只完成数据库身份边界；Provider Secret boundary未完成，凭据仍为进程环境变量，审计append-only只限制Web/Worker而非owner/migration；Worker默认不启动，生产部署未验收。下一步为秘密边界设计实施，不自动进入Provider写API。

以下是排查历史，所有“未重跑/未验证/下一小步”均以本最终结论为准：

**最新实测（2026-11-12 10:51，优先于下文）**：执行一次test:db:local，日志 `.workbuddy/phase4-4.7.5-db-expectation-recheck.log`，退出1；报告 `.workbuddy/database-acceptance-mwcybt19_7ad662.json` 为failed，75 passed/1 skipped/7 failed记录。Worker列级清单及该段真实42501越权负例已通过，Web权限回归通过，原四项未验证须按此更新：整体未通过，但上述子项已实测。5个fixture以42501失败：email-outbox-postgres.cjs:9、provider-call-ledger-postgres.cjs:38、task-executor-postgres.cjs:210、task-cancel-postgres.cjs:33、authorization-postgres.cjs:39；另2条failed为汇总和终止，非独立根因。admin-mfa-postgres因未显式启用而skipped，不能计通过。完整Worker并发恢复未执行到。隔离库pt_acceptance_mwcybt19_7ad662及四角色按策略保留。本轮未改代码、未再次重跑；下一步定位fixture身份与准备SQL权限冲突，不扩大授权。

**最新实测（2026-11-12 10:09，优先于以下历史记录）**：身份分工修正后在嵌套根执行一次 `npm run test:db:local`，日志 `.workbuddy/phase4-4.7.5-db-recheck.log`，退出码 1。报告 `.workbuddy/database-acceptance-mwcwtoqq_754590.json` 最终 failed，34 项 passed：Web 建任务/取消/参数化往返、资产及执行列写入和删除越权负例、migration 15项CHECK/NOT NULL/主键探测、Worker独立连接结果写正例、Drizzle事务、Web审计追加及UPDATE/DELETE 42501、安全目录投影均通过。停止于脚本889行 Worker列级权限比对，code=LOCAL_CHECK_FAILED，missing=[]、extra非空；hint只保留部分差异，不能视为完整差异列表。Worker后续越权负例与完整Worker并发恢复验收未执行到；整体验收仍未通过。本轮未修改代码或重跑。隔离库 pt_acceptance_mwcwtoqq_754590 及报告列出的四角色按脚本策略保留。下一步先定位该清单差异，不扩大授权。

2026-11-12 10:00 实测追加：在嵌套仓库根执行 `npm run test:db:local`，退出码 1。日志 `.workbuddy/phase4-4.7.5-db-acceptance.log`；机器报告 `.workbuddy/database-acceptance-mwcwiaua_78f510.json`，最终 `status: failed`，20 项检查 passed，随后在 `scripts/accept-database-local.js:405` 的 Web `INSERT INTO assets(owner_id, media_type, metadata) ... RETURNING id` 报 `42501` 终止。真实验收已重跑但未通过；以下「未重跑」为执行前记录，Worker 列级清单与越权负例等后续检查仍未执行到，Web 清单整体未完成回归。不得据此宣称 4.7.5 完成。下一小步定位 assets 权限失败，尚未修代码或重跑。脚本保留随机隔离库 `pt_acceptance_mwcwiaua_78f510` 与报告列出的四角色，未清理。

已验证：

- 语法检查通过：`scripts/accept-database-local.js`、`scripts/local-registration.js`、`tests/fixtures/worker-postgres.cjs`、`lib/server/worker/index.js`。
- 定向单元测试通过：`localRegistrationLauncher`、`databaseLifecycle`、`serverEnvironment`、`worker` 四个文件共 53 项，53 pass / 0 fail。

**未验证，不得表述为通过**：

- 真实 PostgreSQL 隔离库验收本轮**未重跑**。`checkWorkerRolePrivileges` 的列级权限期望清单与 `information_schema.column_privileges` 的实际展开是否完全一致，尚未实证。
- Web 权限清单（`fullDmlTables` 等）仍是按旧合并身份写的，需按拆分后身份回归。
- Worker 越权负例的报错码是否稳定为 `42501`（而非先触发其它约束）尚未实证。

#### 2026-11-12 assets 权限失败定位（只诊断）

- 失败 SQL 使用 `runtimeUrl`（Web 身份）。`runtimePermissions.js:15` 只授 assets SELECT；脚本 359–375 行也明确期望 assets 只有表级 SELECT，且本次报告中这项权限比对已通过。405 行却期望该身份 INSERT assets 成功，416 行还期望 UPDATE assets 成功，正例与权限边界矛盾；42501 是权限拦截的预期结果，不能据此扩大 Web 授权。
- assets.id 是 `uuid().defaultRandom()`，不存在为该 INSERT 补授序列权限的理由。后续 428 行还用 Web 身份更新任务 result，434–462 行在 Web 身份下执行资产写入/任务执行列 CHECK 负例并期望 23514 等约束错误，也会受权限检查影响。只绕过首条 INSERT 不足以修复验收身份设计。
- 建议下一步仅修验收脚本：Web 保留自身允许操作的正例及资产写入/任务执行列越权负例；结构 CHECK/NOT NULL/主键探测用隔离 migration 身份、独立事务与夹具执行；任务执行正例使用 Worker 身份。保留注入往返及约束覆盖，不删失败断言来制造通过。内部 assetService 存在资产写方法，但不构成开放 Web 写权限的授权。
- 本轮附加只读权限探针因当前 Agent 调用未取得 LOCAL_DATABASE_ADMIN_URL 被阻断，日志 `.workbuddy/phase4-4.7.5-assets-permission-diagnosis.log` 为 `BLOCKED: LOCAL_DATABASE_ADMIN_URL is not set`；没有产生新的数据库实测结论。上述定位依据源码与既有真实报告，未改代码、未重跑验收。

#### 2026-11-12 验收脚本身份分工修正（未重跑数据库）

仅修改 `scripts/accept-database-local.js`：Web 独立连接验证建任务、参数化注入往返、取消及资产写入/任务执行列/删除/DDL 越权负例；原资产注入往返、15 项 CHECK 与 NOT NULL/主键探测移入 migration 独立回滚事务；新增 Worker 独立连接结果描述符写入正例，夹具由 migration 创建并在 finally 精确清理；Drizzle 仍用 Web 验证真实提交/回滚，提交后先 SELECT 断言存在，再由 migration 精确清理，不再要求 Web DELETE。未扩大任何身份权限。

在嵌套根运行 `node --check scripts/accept-database-local.js` 与 `git diff --check -- scripts/accept-database-local.js`，日志 `.workbuddy/phase4-4.7.5-identity-fix-check.log` 中两项退出码均为 0。仅语法与差异格式检查通过，未跑程序单测或真实数据库验收，不能宣称这些新正反例已通过；最新真实报告仍是 mwcwiaua_78f510 的 failed。下一步待确认后重跑一次隔离验收。

#### 2026-11-12 10:12 Worker 清单差异定位（只诊断）

当前调用未取得 LOCAL_DATABASE_ADMIN_URL，只读实时探针 blocked，未连接数据库。离线执行 grantWorkerRuntimePermissions（捕获 SQL、不执行 SQL），按 0021_snapshot 表列展开表级授权，对照验收 expected：expected=155，展开=185，missing=[]，extra=30。日志 `.workbuddy/phase4-4.7.5-worker-permission-diagnosis.log` 保存完整离线差异；不得将此说成实时数据库完整差异实测。

30项分组：email_outbox 9项（漏 idempotency_key SELECT，且8个非执行列 UPDATE未列入期望）；logical_models 2项（created_at/disabled_at SELECT）；provider_calls 19项 INSERT（表级 INSERT 会覆盖全部27列，期望仅列8列）。原因是验收手写清单使用比当前授权及15.1描述更窄的列集。当前授权明确是 email_outbox SELECT+UPDATE、logical_models SELECT、provider_calls SELECT+INSERT，不能直接称30项是意外新增授权。

建议下一小步按现有15.1边界修正显式期望清单，不更改授权，并保留 Worker 禁止 UPDATE 调用身份、禁止创建任务/改路由/写审计等负例；不得直接用授权实现动态生成验收expected以免同源假绿。若要把邮件UPDATE或调用INSERT进一步收紧，应另行设计并检查调用点，不混入本次清单一致性修正。本轮未改代码或重跑验收；最新真实报告仍 failed。

#### 2026-11-12 10:47 Worker 显式期望清单修正（仅离线检查）

仅修改验收脚本 expected：provider_calls INSERT 补19项、email_outbox SELECT补1项/UPDATE补8项、logical_models SELECT补2项，155→185；保持显式列举，不从授权实现生成运行时expected。未修改runtimePermissions.js或越权负例。node --check及限定脚本git diff --check退出0；离线捕获授权SQL按0021 snapshot展开，对照得到185/185、missing=[]、extra=[]且期望无重复，退出0。语法/差异证据 `.workbuddy/phase4-4.7.5-worker-expectation-check.log`，完整离线证据 `.workbuddy/phase4-4.7.5-worker-expectation-offline.log`（以独立离线日志为准）。未执行程序单测或数据库验收，最新真实报告仍 mwcwtoqq_754590 failed；Worker后续越权错误码和完整并发恢复仍未验证。下一步待用户确认后运行一次真实隔离验收。

### 15.3 仍未闭环的边界

- **Provider Secret boundary 未完成。** 凭据仍从 `PAINTTRACK_PROVIDER_CREDENTIAL` 等进程环境变量读取。数据库角色拆分只能证明数据库身份隔离，不能证明 secret 读取已隔离；在专用 Secret Store 或等价专用服务边界落地前，不得宣称 Secret boundary 已完成。
- **审计 append-only 只对 Web/Worker 生效。** 表 owner 与 migration 身份仍可修改审计记录，不能宣称数据库所有者无法篡改。
- **本机 Worker 默认不启动。** 需显式 `PAINTTRACK_LOCAL_WORKER=1`，不能表述为所有运行环境已自动完成独立 Worker 部署。

### 15.4 本小步骤边界

未开放 Provider 配置写 API，未连接真实 Provider，未访问公网，未修改既有业务数据库，未覆盖工作区其它已有改动。真实验收仅在脚本自建的 loopback 隔离库中运行。Provider 配置写 API 继续关闭，直至 Secret boundary 与正负权限验收均落地。

## 16. Provider Secret boundary：本地设计入口（4.7.5之后，2026-11-12）

### 16.1 状态与审查依据

4.7.5完成不改变秘密读取现状。providerConfig.js默认读取process.env，并以不可枚举credential属性保存明文；providerRegistry.js将其传入myvignaImageProvider.js闭包。不可枚举只减少常规序列化暴露，不提供读取权限隔离。local-registration.js为mock Worker构建白名单环境，但Web直接next启动及Next自行加载项目.env文件仍可能带入秘密。当前并未发现Web主动调用registry，这不构成Web无权读取的证明。生产秘密供应商与部署身份尚未选定。

本节为设计完成、实现未开始，不编号宣称已完成新的实施阶段。现有环境变量路径仍存在，Secret boundary未完成，Provider配置写API继续关闭。本轮只读源码审查和文档变更，没有程序测试、网络请求、真实凭据或数据库访问。

### 16.2 本地切片方案与信任范围

先实施独立秘密持有进程及受控IPC的完全离线替身，使用合成秘密、内存映射和注入fetch，不依赖外部产品或云资源。秘密进程持有假token；测试监督进程是可信引导身份，建立专用Worker通道，Web不取得通道。授权绑定通道身份，不采信请求体role字段，不把通道能力放入任务、日志或Web环境。禁止列表、任意路径读取及配置写接口。IPC消息大小、请求ID、超时、待处理数设上限；退出/断连拒绝全部待处理请求，不静默回退环境变量。

该方案允许获授权Adapter进程短暂持有明文；不声称Worker无法读取已交付给它的秘密，不抵御同一OS用户的调试器/内存读取或可信监督进程。生产级边界另需独立OS/容器身份、Secret Store ACL或等价进程权限部署证据，内存替身通过不能自动放行写API。

### 16.3 读取契约与版本

- 输入为providerInstanceId、credentialRef、credentialVersion和已批准adapter/目标身份；精确匹配白名单，不接受任意secret路径或URL。目标允许列表由可信启动配置提供，任务payload不可覆盖；Base URL校验和redirect:error保持。
- 固定引用和版本；轮换产生新版本，不覆盖旧版本。撤销旧版本后旧请求明确拒绝，不自动取latest、不切Provider、不重提未知提交。现有任务快照尚未接通，此为后续集成契约，不伪称运行时已实现。
- resolver为显式依赖，缺失、无权、引用/版本不匹配、撤销、超时、服务退出均fail-closed；新切片不得回退PAINTTRACK_PROVIDER_CREDENTIAL。旧路径保留至替换及回归完成，不把新模块存在称为系统已隔离。
- 内部错误转换为稳定错误码，不透传第三方message/cause/Authorization；秘密不写日志、审计、数据库、任务响应、路由快照、命令行或.env文件。先校验非秘密配置与目标，再申请秘密，失败时不得开始领取任务。

### 16.4 后续实施顺序及验收门槛

1. 实现独立秘密进程、受控通道客户端和合成数据fixture；独立子进程证明授权Worker取指定引用/版本成功，Web无通道、伪造role、错引用/版本、撤销及服务退出/超时拒绝。全程不启动数据库或HTTP服务。
2. registry增加显式resolver和Adapter factory注入点，用内存fetch贯通假凭据到请求头；新模式拒绝env-only回退，Provider/Adapter/目标不匹配时拒绝。保留现有mock/协议回归，不连接真实Provider。
3. 提取可测Web/Worker启动环境构造并处理Next环境文件回载；补进程负例及客户端导入门禁。仅env白名单单测通过不足以完成此项。
4. 负例验证stdout/stderr、错误及序列化结果无合成秘密，包括带code/cause的异常；网络及数据库入口在纯离线用例中禁止。原有loopback协议测试独立执行并明确标记，不与零网络切片混称。
5. 本地切片通过后只标本地契约/进程路径已验证；还须评估旧env路径退役、正式秘密后端、生产身份与文件权限证据，逐项满足后才能讨论Secret boundary整体闭环及写API准入。

### 16.5 第1项本地切片实现与实测（2026-11-12）

新增 `lib/server/providers/secretBoundary.js`、`secretBoundaryProcess.cjs` 和 `tests/secretBoundary.test.js`。可信监督进程经IPC引导合成秘密和一次性绑定的worker/web principal；返回的resolve闭包是通道能力，revoke/close属于监督句柄，不可交给Web。秘密进程不读环境凭据/文件/网络/数据库；引用严格绑定实例、ref和version；消息64KiB、种子32项、值4096字符、待处理默认16/最大64、启动及请求超时均受限。撤销删除该版本，拒绝latest及环境回退；断连/退出拒绝请求，晚到响应不命中新请求。子进程stdout/stderr丢弃，不透传子进程错误正文。

命令：`node --check`检查3个新增文件；`node --test tests/secretBoundary.test.js tests/providerConfig.test.js tests/providerRegistry.test.js tests/localRegistrationLauncher.test.js`。日志 `.workbuddy/secret-boundary-ipc-test.log` 22 pass/0 fail/0 cancelled/0 skipped，退出0，其中新增8项覆盖真实子进程授权/并发、Web与伪造role拒绝、引用/版本不符、撤销、无环境回退、非法/过大/重复种子、待处理上限、关闭、启动/请求超时及晚回复隔离。超时用Node MockTimers，日志有实验API提示，不是失败。首轮退出等待问题已修正为等待exit/error事件。

范围限制：这是可信父进程引导的合成秘密切片，父进程本来就拥有seed，Worker获授权后仍可读明文；Web拒绝测试用模拟web通道，未启动真实Next；尚未强杀进程故障注入或直接原始IPC伪造测试，未做全链路stdout泄漏审计。未接registry、未退役原env路径、未处理Next环境文件回载，不证明整体Secret boundary已完成。未跑数据库或Provider网络请求。下一步第2项：registry显式resolver与Adapter factory注入，内存传输贯通与拒绝回退/错目标负例。

### 16.7 第3项启动环境与Next环境加载隔离（本地路径完成，端到端未完成，2026-11-12）

local-registration.js提取createNextEnvironment，使用系统键白名单及显式本地Web配置，不继承Provider/Worker/Migration凭据或父NODE_OPTIONS。在创建数据库资源前及Next spawn前，用lstat检查Next开发模式默认读取的.env.development.local、.env.local、.env.development、.env；任意路径存在（包括符号链接）或探测失败时拒绝启动，不读取文件内容；.env.example不在拒绝名单。依据已安装Next 15.5.29 config.js与setup-dev-bundler.js，Next会主动加载并监视这些文件，仅过滤父环境不足以隔离。

嵌套根运行node --check scripts/local-registration.js及node --test tests/localRegistrationLauncher.test.js tests/secretBoundary.test.js tests/providerRegistrySecrets.test.js tests/providerRegistry.test.js tests/providerConfig.test.js，日志.workbuddy/local-registration-test.log：30 pass/0 fail/0 cancelled/0 skipped，命令退出0；启动器自身6项含新增Web环境过滤和四类文件拒绝用例。没有启动Next/HTTP服务、数据库或真实Provider。

后续本轮补齐本地运行期路径：新增scripts/local-next-env-preload.cjs，以可信NODE_OPTIONS --require绝对路径在Next CLI及fork之前安装@next/env无文件facade；不调用原loadEnvConfig，首次与forceReload均返回空loadedEnvFiles/parsedEnv；非空processEnv拒绝。保持initialEnv/updateInitialEnv/resetEnv当前兼容语义，安装失败终止；仍保留启动前文件拒绝。该方案依赖当前Next 15.5.29 CommonJS加载链，升级、多副本、独立dotenv/原生Turbopack需重新审查；不能限制任意代码直接fs读取或同OS身份访问。

新增tests/localNextEnvPreload.test.js，真实独立进程中原@next/env控制组读取四类合成文件及变更后forceReload共8次；保护组首次/变更/强制回载均0读取，fork默认继承及Next实际NODE_OPTIONS解析格式化后也0读取。覆盖带空格路径、快照更新/重置兼容、非空processEnv无副作用拒绝及preload缺失/exports安装失败时主程序不执行。合成文件仅项目.workbuddy随机目录，不读取真实.env、不启动HTTP/数据库。

新增tests/clientServerImportBoundary.test.js，AST从use client入口递归检查静态import/export/require/动态import字面量，解析相对/项目别名/baseUrl/workspace源码，禁止触达根lib/server；包含直接/间接/循环/reexport/类型边/解析失败及合法服务端入口合成正负例。当前扫描237源码、50入口、116依赖节点无违规；不计算变量拼接导入，不遍历第三方依赖或资源，不能等同浏览器构建产物审计。

最终node --check检查启动器及preload；node --test运行localNextEnvPreload、localRegistrationLauncher、clientServerImportBoundary、clientCredentialBoundary、secretBoundary、providerRegistrySecrets、providerRegistry、providerConfig八文件，共60 pass/0 fail/0 cancelled/0 skipped，退出0，日志.workbuddy/secret-boundary-environment-final.log。

### 16.8 第3项Next集成与第4项泄漏负例（2026-11-12）

真实Next 15.5.29最小App集成仅用合成env和loopback 127.0.0.1，目录在.workbuddy随机隔离目录，通过项目内node_modules junction复用已安装依赖；测试路由只回canaryPresent布尔，不回显env。启动前写入.env.development.local与.env，启动后确认Ready及HTTP 200/canaryPresent=false；运行中新增.env.local/.env.development、修改四类文件，记录Next watcher真实forceReload loadedEnvFiles=[]及client/node/edge无错误编译，再次请求仍false。8个合成键及16个合成值均未出现在Next stdout/stderr；测试专用网络guard记录1次非loopback尝试并阻断，子进程树被精确停止、端口关闭。命令 `node --test tests/localNextEnvIntegration.test.js` 独立复跑1 pass/0 fail，日志 `.workbuddy/secret-boundary-next-integration-final.log`，详细证据 `.workbuddy/secret-boundary-next-integration.log`。此前失败尝试与超时如实留在累积证据日志，最终通过日志标明独立复跑成功；失败尝试没有被删改。此为最小Next集成，不是业务Web/Worker端到端或生产环境权限证明。

新增 `tests/secretBoundaryLeakage.test.js`，在独立Node进程用同一合成canary作为秘密和异常标记，捕获stdout/stderr及递归错误序列化/返回结果；覆盖resolver嵌套message/code/cause、Adapter factory失败、非法返回、Web拒绝、错ref、撤销、模拟超时与模拟子进程退出；经registry+真实Adapter和内存fetch覆盖submit/running poll/result，并检查每次内存请求Authorization严格等于Bearer canary，submit/poll/result传输或供应商错误体含canary时不泄漏。全局fetch、net.connect/createConnection/Socket.connect、tls.connect、http/https request/get及pg/drizzle导入均设阻断guard；自检逐项触发并计数，业务用例要求计数为0。`node --test tests/secretBoundaryLeakage.test.js tests/secretBoundary.test.js tests/providerRegistrySecrets.test.js` 为19 pass/0 fail/0 cancelled/0 skipped，日志 `.workbuddy/secret-boundary-leakage.log`。超时/退出由mock fork模拟，未强杀真实秘密子进程；未访问真实Provider、数据库或公网。

边界：Next loader方案绑定已安装15.5.29 CommonJS实现；版本升级、其他env loader/原生Turbopack须重新验收。客户端静态依赖门禁不覆盖计算导入。完整poll/result目前是本地Adapter协议贯通，不是实际任务Worker数据库轮询。旧同步CLI仍读取环境变量；生产OS/Secret Store ACL、真实Worker/Next同机隔离、强杀故障、正式密钥轮换与全链路审计仍未验证。Provider写API继续关闭，整体Secret boundary未完成。下一步转入真实worker CLI resolver接入与进程故障/凭据路径退役审查，不连接真实Provider或业务库。

### 16.9 Worker CLI resolver接入审查（2026-11-12，仅源码审查）

当前index.js:305的CLI同步调用旧resolveWorkerProvider，成功后才runWorkerProcess→startWorker→new Pool→createTaskProcessor→worker.run。第一次实际数据库连接在taskQueue.claimNextTask的事务pool.connect，之后回收过期租约、锁定并领取任务。Provider构造本身不发请求，实际submit/query发生于领取后的taskExecutor调用账本流程。本轮没有运行Worker、测试或数据库，不将源码推断称为实测。

最小接入方案：新增可测试的异步Worker启动引导入口，由可信监督/部署调用方显式传descriptor、approvedBindings、secretResolver，先await resolveWorkerProviderWithSecrets，再将已构造Provider传入原createTaskProcessor和runWorkerProcess；保持固定Provider启动模式，不提前实现任务级路由。mock保留非production显式模式及现有依赖注入。绑定、目标、引用/版本不合法或resolver缺失/拒绝时，必须在Pool构造、连接与claim之前失败，输出固定允许错误码，不透传第三方message/code/cause。错误不得消耗用户任务尝试次数。

可信引导来源当前尚无生产实现；不得从任务payload、客户端、任意env模块路径或可请求修改的配置建立approvedBindings/resolver。合成秘密进程只用于本地验收，不是生产Secret Store。下一实施切片应先提供可调用引导入口及明确模式拒绝策略；CLI非mock缺可信能力应拒绝，不自动回退PAINTTRACK_PROVIDER_CREDENTIAL。切换属于显式兼容性变更，实施时同步旧CLI测试/使用说明，保留直接注入Provider的单元测试；是否删除旧registry/env工具函数须另盘点调用者，不能把新增入口等同旧路径已退役。

验收要求：记录resolver→Pool构造→processor→首次connect/claim顺序；所有预检失败计数Pool/connect/claim均0；允许绑定成功仅解析一次；错目标在读取secret前拒绝；secret服务不可用/撤销无env回退；真实CLI离线fixture及mock生命周期回归；监督能力的close在启动失败/正常退出均释放。之后再补真实秘密子进程强杀与待处理请求拒绝。上述为待实现/待验证，不计通过。任务级snapshot路由与配置写API不在本次接入切片内；写API继续关闭。

### 16.10 Worker异步引导切片实现与离线验收（2026-11-12）

worker/index.js新增bootstrapWorker，可信宿主显式传descriptor/approvedBindings/secretResolver，await显式registry成功后才runWorkerProcess；Adapter固定注入原任务处理器，不引入任务级路由。startWorker新增PoolClass依赖注入点供离线验证，默认仍为pg.Pool。secretBoundaryLifecycle为显式委派关闭句柄，预检失败、正常返回及可捕获运行错误均finally关闭；仅传resolver不取得资源所有权，close失败使用固定码且不覆盖原错误。强制process.exit/非协作退出不保证finally执行，不能宣称强杀也能完成关闭。

兼容性变更：直接CLI仅允许非production显式mock；所有非mock模式（包括旧myvigna-image环境凭据齐全）在建池前返回WORKER_TRUSTED_BOOTSTRAP_REQUIRED，未配置返回PROVIDER_NOT_CONFIGURED、production mock返回PROVIDER_MODE_FORBIDDEN。可信非mock需由宿主调用bootstrapWorker；当前没有生产宿主/Secret Store接线。旧resolveWorkerProvider及providerConfig环境工具函数仍保留供既有调用者，不能称全仓环境凭据路径已退役。新引导错误仅固定允许码，无原message/cause；未增加env任意模块加载或秘密种子入口。

新增tests/workerSecretBootstrap.test.js十二项，包含resolver→Adapter→run→Pool→processor→connect→claim顺序及等待resolver期间无其他事件；缺绑定/错目标/缺resolver/非法秘密/解析异常均Pool/connect/claim零次；委派close生命周期/异常脱敏；实际runWorkerProcess配fake Pool正常退出与连接失败；真实合成IPC撤销/已关闭无env回退；独立真实CLI旧env模式拒绝且legacy resolver/Pool/connect/claim全部零次。命令在嵌套根运行 `node --test tests/workerSecretBootstrap.test.js tests/worker.test.js tests/workerProcess.test.js tests/providerRegistrySecrets.test.js tests/providerRegistry.test.js tests/providerConfig.test.js`，日志 `.workbuddy/worker-secret-bootstrap-test.log` 为66 pass/0 fail/0 cancelled/0 skipped、退出0。默认mock进程生命周期回归通过。所有数据库操作使用替身，未访问真实数据库/Provider或公网。

当前只完成可信宿主可调用引导及旧CLI拒绝策略，不是生产CLI完整秘密接线；尚未用该bootstrap在数据库任务上执行真实Adapter，未验收生产ACL、真实秘密进程强杀与运行中撤销后已构造Adapter失效。下一步真实秘密子进程故障验收、盘点旧env读取调用者与可信宿主部署方案；写API继续关闭，整体Secret boundary未完成。

### 16.11 真实秘密子进程故障及旧env盘点（2026-11-12）

新增tests/secretBoundaryProcessFailure.test.js，测试侧包装真实fork捕获本次secretBoundaryProcess.cjs，对初始化/resolve/revoke发送设置传输屏障；子进程是真实进程，exit不是模拟事件。初始化尚未发送时、已READY且resolve/revoke并发pending时分别child.kill('SIGKILL')并等待真实exit，验证SECRET_SERVICE_UNAVAILABLE、后续resolve拒绝、重复close有界完成，错误和捕获子进程stdout/stderr不含合成秘密或父环境旧凭据。Windows上的SIGKILL是Node提供的强制终止语义，不是POSIX信号处理证明。传输屏障意味着不证明秘密进程处理到一半被杀的内部竞态；也不证明已交付Adapter明文在故障后失效。只终止测试自己创建的进程，恢复fork及模块缓存，不改产品代码。

命令 `node --test tests/secretBoundaryProcessFailure.test.js tests/secretBoundary.test.js tests/workerSecretBootstrap.test.js`，日志 `.workbuddy/secret-boundary-process-failure.log`：21 pass/0 fail/0 cancelled/0 skipped，退出0。无网络、数据库或真实Provider。

只读盘点范围lib/scripts/app JS/CJS/MJS：providerConfig.js仍从source[ENV_CREDENTIAL]读取PAINTTRACK_PROVIDER_CREDENTIAL，默认source为process.env；providerRegistry.js旧同步myvigna-image分支仍调用requireProviderConfig。当前生产源码检索到的同步registry调用者为worker/index.js的受控mock分支，非mock CLI在调用前拒绝。新bootstrap不走旧env路径，但旧导出仍可供代码调用，不能宣称已全仓退役；盘点不是第三方包/动态加载完整数据流证明。下一步明确退役旧同步非mock分支和providerConfig兼容契约，再评估可信生产宿主接线。整体Secret boundary未完成，Provider写API保持关闭。

### 16.12 旧同步环境凭据入口退役（2026-11-12）

providerConfig.js保留兼容导出和常量，但loadProviderConfig不再接触传入环境或process.env，固定返回ok=false、reason=PROVIDER_ENV_CREDENTIAL_RETIRED；requireProviderConfig固定抛该码，不再校验、保存或返回旧env明文。providerRegistry移除对旧配置读取的依赖，同步myvigna-image固定退役拒绝且不构造Adapter；未知模式不回显输入。非生产mock及显式resolver保持。兼容性变化：原调用load/requireProviderConfig获取env凭据的代码即使变量齐全也不能恢复；可信真实Provider仅走bootstrapWorker显式能力，生产宿主尚未接线。

修改providerConfig/registry及其测试、providerRegistrySecrets测试、secretBoundaryLeakage测试，并更新DB_SETUP.md和PHASE5_STEP3_WORKER_EXECUTION.md旧启动说明。getter/枚举陷阱和process.env canary负例验证兼容API及同步真实模式零凭据读取、零Adapter构造、错误/序列化/输出无秘密；新resolver缺失/失败无env回退，成功只使用显式结果。

命令：NODE_ENV=test PAINTTRACK_WORKER_DATABASE_URL=postgres://unused/offline-provider-retirement node --test tests/providerConfig.test.js tests/providerRegistry.test.js tests/providerRegistrySecrets.test.js tests/secretBoundaryLeakage.test.js tests/secretBoundary.test.js tests/workerSecretBootstrap.test.js tests/worker.test.js tests/workerProcess.test.js tests/mockProvider.test.js tests/clientCredentialBoundary.test.js。日志.workbuddy/provider-env-retirement-test.log保留首轮92/93及修正后93/93，最终0 failed/0 cancelled/0 skipped、退出0。首轮为重载registry后新旧错误class的instanceof断言不一致，仅改测试使用同模块class，未放宽零读取/构造断言。定向lint和语法检查通过。未连接网络、真实Provider或数据库。

本结论只针对上述旧API和已盘点第一方入口，不等同任意第三方代码均无环境秘密读取；原env变量名兼容常量仍在。生产可信宿主、正式Secret Store/OS ACL、运行中撤销已交付Adapter凭据等仍待设计验收，整体Secret boundary未完成，写API关闭。下一步确定可信宿主的能力注入与部署边界，不新增env动态模块或秘密种子启动通道。

### 16.13 可信宿主契约与部署准入（2026-11-12，仅设计）

当前bootstrapWorker是可信宿主调用接口，不是生产宿主；Dockerfile runner/npm start和docker-compose仍只有Web启动，没有正式Worker启动脚本或Secret Store授权。基础设施方向见PHASE1_STEP4_INFRASTRUCTURE_OPTIONS.md：Web/API、独立Worker、托管PostgreSQL、私有对象存储、独立migration release job；具体平台/地域/账户/秘密后端尚未确认。本节未部署资源、未改启动代码、未运行程序或连接网络/数据库。

可信能力注入契约：

- 宿主为受控发布的固定服务端代码，由部署身份读取经批准、版本化且不含秘密的descriptor/approvedBindings，显式调用bootstrapWorker。不得从客户端/任务payload生成授权，不新增env任意模块路径、静态secret seed或默认假resolver。任务级snapshot路由另行实施。
- 秘密后端使用Worker专属身份认证，仅允许精确providerInstanceId/credentialRef/credentialVersion读取；无列举/任意路径/写秘密权限。Web与migration身份均无读取该Provider秘密权限；管理MFA不自动授予明文读取。进程环境和命令行不传Provider明文，正式身份认证方式需按所选后端单独审查。
- 宿主创建resolver并显式委派生命周期句柄，启动预检在Pool/claim之前；失败输出固定码，禁止env fallback。正常退出/可捕获失败关闭句柄；强杀时finally不保证执行，必须依赖后端会话/令牌到期、OS资源回收和后续撤权证据，不把close调用当安全擦除。
- 生产Web/Worker/秘密服务使用独立OS或容器身份及文件/进程权限；同OS用户的本地IPC不能防调试器、内存读取或可信父进程。合成seed只留在测试引导中，不作为正式秘密供应链。
- 撤销先阻止新解析。已经构造的Adapter仍持有明文，当前代码不保证其停止发请求；宿主须定义停止领取、在途任务处置、Worker/Adapter销毁重建及必要的上游凭据撤销。已发送请求不能声称被收回，未知提交不得切Provider重提。不能宣称只调用revoke便完成即时全局撤销。

部署前必须取得的证据：Worker身份获准精确读取且Web/migration/错版本/撤销/后端失联拒绝；权限失败时Pool/connect/claim零次；无明文环境/命令行/日志/文件落地；正常与异常资源回收；运行中撤销后新解析和已有Adapter行为；实际OS/文件/秘密后端ACL负例；正式宿主与mock/synthetic入口分离。只有选型说明或本地合成测试不算部署验收。

需要用户确定的生产输入：目标平台/区域及现有账户、秘密后端及Worker身份方式、预算/自运维范围、撤销和轮换的可接受时限。未确认前不选择厂商SDK、不创建云资源或连接真实秘密。可以先独立补合成运行中撤销测试，明确现有Adapter缓存行为并验证停止策略，但该测试不能替代生产ACL。整体Secret boundary仍未完成，Provider写API继续关闭。

### 16.14 合成运行中撤销行为实测（2026-11-12）

新增tests/secretBoundaryRevocation.test.js两项，不改产品代码。真实合成秘密进程→显式registry→真实Adapter→内存fetch：revoke后新registry解析拒绝，旧Adapter仍可submit/query；关闭boundary后旧Adapter仍用缓存凭据query。断言每次请求Authorization匹配合成canary，错误及公开序列化无秘密。这个通过结果是在验证当前限制，不是实现即时撤销。

第二项用实际createWorker、队列替身和确定性响应屏障：submit已发送后撤销版本，确认新resolve拒绝，再worker.stop；释放submit响应后当前处理器仍能调用旧Adapter query，宽限内完成，Worker停止且claim总数为1，宿主此后不再调用Adapter。处理器为测试自定义函数，完成记录仅表示该测试处理器完成，不是上游生成成功；当前策略为优雅停止，不是凭据紧急失效。已发送请求不能收回；stop不自动销毁Adapter或阻止当前处理器后续请求。默认fetch/pg Pool connect/query设拒绝guard并计数0，boundary显式关闭；不将这些guard视为任意第三方IO全面拦截。

命令 `node --test tests/secretBoundaryRevocation.test.js tests/secretBoundary.test.js tests/workerSecretBootstrap.test.js tests/worker.test.js`，日志 `.workbuddy/secret-boundary-revocation.log`：55 pass/0 fail/0 cancelled/0 skipped、退出0。使用内存请求及数据库替身，未访问真实网络/数据库/Provider。

下一步在生产接线前确定两种策略：正常轮换允许旧版本在途任务按明确期限排空；紧急撤销必须阻止后续Provider操作、处理当前任务不确定状态、停止/销毁Worker并由上游撤销凭据。当前只实测优雅stop边界，未实现紧急撤销闸门或正式宿主，不自动重提未知请求。后端/部署身份选型及ACL证据仍需确认，整体Secret boundary未完成、写API关闭。

### 16.15 Provider 调用闸门及恢复竞态修复（2026-11-12）

本地调用闸门 providerInvocationGate.js 已接入 bootstrapWorker：可信宿主通过 onProviderGate 获得控制句柄，任务执行器仅获得包装后的 Provider。active 允许调用；draining 拒绝新 submit，允许 query/cancel 到明确 deadline；revoked/closed 拒绝后续调用并中止在途等待。已发送请求不能收回，非协作 Adapter 的底层副作用仍可能继续；该实现不抹除已交付的明文，也不能替代上游撤权及生产进程隔离。

修复首次审查发现的六项问题：① taskExecutor 仅对当前新建且确定未 dispatch 的调用按失败终结，历史 unknown/submitting 在拒发后保持 unknown、释放租约并保留同一幂等键；② 预中止 Promise 立即参与 race，独立 strict 子进程验证无 unhandledRejection；③ dispatch 微任务与成功/失败结果接收时重新检查 deadline；④ drain 只持有一个 timer，提前触发重排、close/revoke 清理；⑤ 同步 revoke/close/drain/abort 在 dispatch 前被识别，Adapter 零调用；⑥ 使用模块私有 WeakSet 识别未发送错误，已 dispatch 的 submit 不接受旧 gate error 或外部 abort reason 的未发送语义，而按未知提交处理。bootstrap 回调抛错时也关闭 gate、timer 和委派秘密资源。

验证证据：`.workbuddy/provider-invocation-gate-fixed.log` 保留首轮 82 pass/1 fail 及最终 83 pass/0 fail/0 cancelled/0 skipped；本次独立复跑命令 `node --test tests/providerInvocationGate.test.js tests/taskExecutor.test.js tests/providerCallLedger.test.js tests/worker.test.js tests/workerSecretBootstrap.test.js`，日志 `.workbuddy/provider-invocation-gate-verified.log`，78 pass/0 fail/0 cancelled/0 skipped，退出0。两组选择的测试文件不同，数量不能直接比较。组合测试执行真实 gate/executor/ledger 模块，但 SQL 使用内存池替身、部分队列操作使用桩；不是实际 PostgreSQL 验收，不证明真实锁竞争或事务恢复。本轮未连接数据库、真实 Provider 或公网，未开放写 API。

本地闸门切片及六项修复通过定向验收；整体 Secret boundary 仍未完成。下一步收口可信宿主的正常轮换/紧急撤销编排：将停止领取、gate drain/revoke、在途未知状态和资源关闭形成可验证的生命周期；生产接线前仍需用户确认平台/地域、秘密后端、Worker 身份及撤销时限，再获取真实 ACL 与隔离证据。任务快照路由和配置写 API 不在本切片范围。

### 16.20 本地 mock 真库首跑失败：身份断言加字段级诊断（2026-11-13）

首次真实隔离库运行（报告 `.workbuddy/database-acceptance-mwea3nkn_60b7d6.json`，`pt_acceptance_mwea3nkn_60b7d6`）结果为 failed，唯一失败子项是 `local-mock-route-postgres`，仅记录到 `LOCAL_CHECK_FAILED` 与源码位置 `tests/fixtures/local-mock-route-postgres.cjs:25`。该行位于 `assertAcceptanceIdentities`，即三个连接身份的事实校验失败；报告同时缺少 `本地mock快照准备` 这条唯一的前置通过记录，可交叉确认失败发生在任何授权与写入之前。此前 89 项检查（含管理员权限只读探测、四角色与空库创建、迁移链、Web/Worker 列级权限正反例、执行器与撤销/授权用例）全部 passed，`admin-mfa-postgres` 按开关 skipped，因此失败不是环境整体故障。

原实现把 8 个不匹配条件压成同一个 `LOCAL_MOCK_ACCEPTANCE_IDENTITY_REQUIRED`，报告只留行号，无法判断是 `database/role/session_role/database_owner/port/address/privileged/has_membership` 中的哪一项，也无法区分“连接身份真的不对”和“断言写得过严”。本次改为逐字段比对并抛出携带 `identity[序号] fields: <字段名>` 的 AssertionError：只输出身份序号和字段名，不输出数据库名、角色名、连接串或任何字段值，也不放宽任何一条判据（仍要求同后缀验收库、三角色各自的 current_user 与 session_user、migration 为库主、loopback:5433、无 superuser/createdb/createrole/replication/bypassrls、无角色成员关系）。新增离线断言校验该消息只含序号与字段名且不含身份值。

证据：`node --test tests/localMockRoutePostgresFixture.test.js tests/localMockCatalog.test.js tests/taskExecutor.test.js` 29 pass/0 fail/0 cancelled/0 skipped，退出0；全量 `npm test` 452 项 450 pass/0 fail/2 skipped，退出0（日志 `.workbuddy/full-test-after-identity-diag.log`）。以上均为离线或替身证据，不构成真实 PG 通过；具体不匹配字段待用户用显式管理连接重跑一次 `npm run test:db:local` 后由报告 hint 给出。不访问既有业务库、真实 Provider 或公网，写 API 保持关闭。

**第二次真跑（报告 `.workbuddy/database-acceptance-mweb19lu_3c31d4.json`）拿到了答案**：`hint` 为 `<redacted> identity[0] fields: address`，`line` 32。即 `owner`（migration 连接）的其余七项——`database/role/session_role/database_owner/port/privileged/has_membership`——全部匹配，只有“服务器端看到的地址”一项与白名单不等。这说明角色、库名、库主、端口、无高权限与无成员关系都是对的，问题出在判定写法本身。

根因是判定不一致：`accept-database-local.js` 的 `withClient` 对同一端点用的是“`::1` 或 `startsWith('127.')`”，一直通过；而 fixture 只认 `'127.0.0.1'`、`'::1'` 两个精确字符串。同一回环语义的等价写法（127.0.0.0/8 内其它地址、IPv4 映射回环 `::ffff:127.x`、或 inet 文本带 `/32` 掩码）会被误判成“身份不合格”。这是断言过严，不是连接身份有问题。

修正：新增 `isLoopbackAddress`，与 `withClient` 语义对齐——接受 `::1`、`::ffff:127.x.x.x`（去掉映射前缀后按 127/8 判定）、整个 `127.0.0.0/8`，并容忍 `/32`、`/128` 掩码后缀；任何非回环地址（含 `172.17.x`、`192.0.2.x`、域名形如 `127.0.0.1.example.com`、空串、`null`）仍然拒绝。仅 `address` 这一项在失败信息里回显实际值（它是 IP 文本，不是凭据），便于下次直接看到真值；其余字段仍只报字段名。

证据：`node --test tests/localMockRoutePostgresFixture.test.js` 6 pass/0 fail/0 skipped，新增用例覆盖 5 种可接受回环写法与 7 种拒绝值；全量 `npm test` 453 项 451 pass/0 fail/2 skipped、退出0（日志 `.workbuddy/full-test-after-loopback-fix.log`）。仍为离线证据，不构成真实 PG 通过；真实库是否转绿以第三次运行报告为准。不访问既有业务库、真实 Provider 或公网，写 API 保持关闭。

**第三次真跑通过**：报告 `.workbuddy/database-acceptance-mweb6dgr_e1f6d4.json`，`status` 为 `passed`，`pt_acceptance_mweb6dgr_e1f6d4` 及四个 `pt_*_mweb6dgr_e1f6d4` 角色由脚本自建；112 条检查中 107 passed、1 skipped（`admin-mfa-postgres`，需显式 `RUN_ADMIN_MFA_PG_ACCEPTANCE=1`）、4 条为 Worker 验收的 `running` 开始事件，0 failed。即本地 mock 路由快照 fixture 已在真实 PostgreSQL 隔离库通过：三身份事实校验、四列临时授权、快照落库与重放零 resolver、同键并发单任务、image/video 执行、Web/Worker 快照 UPDATE 均 42501、落库篡改重算 hash 仍拒发、未知提交恢复保留调用 ID/轮次/幂等键、历史 provider_name 冲突零调用、migration 精确清理并撤销授权。此前两次失败均源于 fixture 自身判定写法（先是 8 条件一刀切无诊断，后是回环地址白名单过严），不涉及被测代码路径。

新增 `scripts/cleanup-acceptance-databases.js` 清理失败运行遗留的隔离库与角色：库名必须严格匹配 `pt_acceptance_<后缀>`，四个角色名由后缀推导、不接受手输角色名，因此无法指向 `painttrack_dev`/`painttrack_test`/生产库；有活动连接时跳过该库不删角色，库不存在时只探测不执行 DROP，先 `DROP DATABASE` 再按 bootstrap/worker/runtime/migrate 顺序 `DROP ROLE`，角色仍有依赖对象时记为 `blocked_dependent_objects` 而不伪装成功，全程无事务包裹（PostgreSQL 不允许事务内 DROP DATABASE），缺管理员变量时在建连前退出且不读 `.env`。证据：`tests/acceptanceCleanup.test.js` 6 项离线测试（含拒绝非验收库名、活动连接跳过、顺序与引号、2BP01 受阻、缺变量零连接），全量 `npm test` 459 项 457 pass/0 fail/2 skipped、退出0（日志 `.workbuddy/full-test-after-cleanup-script.log`）。真实清理须由用户持显式管理连接执行，本轮未连接数据库。

### 16.19 本地 mock 隔离 PG 验收准备（2026-11-12）

新增local-mock-route-postgres.cjs并接入accept-database-local现有随机隔离库流程。授权/写入前核实数据库名及三角色同后缀、current_user/session_user、migration所有权、loopback:5433和无高权限/成员关系，拒绝既有业务库及身份替换；临时授权Web快照四列INSERT，不改runtimePermissions。fixture覆盖真实service快照写入、重放零resolver、同键不同请求、双事务屏障竞争、image/video执行、两运行身份UPDATE四列42501、migration篡改并重算hash拒发、未知恢复同调用ID/轮次/幂等键、历史Provider冲突零调用。finally按owner+登记key找精确任务ID，migration清理调用/任务/本轮合成模型并撤销临时授权。

验收入口不再隐式加载.env，仅使用显式LOCAL_DATABASE_ADMIN_URL；缺变量blocked/退出2，不创建资源。新增localMockRoutePostgresFixture.test.js四项离线测试，覆盖身份负例、身份失败零写入、准备失败精确清理、缺管理变量零.env读取/零DB。9文件72 pass/0 fail/0 cancelled/0 skipped，日志local-mock-route-offline-20261112.log；3文件语法通过及管理变量存在性false记录于local-mock-route-syntax-20261112.log，均已读回。

真实PG未执行，上述数据库断言均待实测。fixture调用实际service/queue/executor但不启动HTTP或独立Worker；mock同进程恢复不证明跨进程重启。残留同类型排队任务可干扰领取、并发屏障5秒、清理失败可能遮蔽原错；调用账本完整路由审计字段未验证。下一步显式管理连接可用后运行现有test:db:local仅随机新库验收，再接Studio；不访问既有业务库、真实Provider或公网，写API保持关闭。

### 16.18 Worker 本地快照选路（2026-11-12）

createLocalMockProviderSelector仅在三重本地门禁下建立，可信宿主注入mock-provider实例；启动时从固定合成目录预计算两个批准快照。select逐任务比对逻辑模型ID/FK、任务operation、快照版本/hash与完整白名单快照，拒绝未知版本/目标/实例/额外字段，返回相同可信mock实例，不根据任务构造Adapter或从实时目录重新选路。createWorkerEnvironment仅显式mockRouting选项传递双guard；CLI在createProcessor/Pool前等待selector建立。该切片不实现生产Provider池或秘密版本路由。

taskExecutor识别四个路由列任一非NULL即强制selector，在取消/账本SQL前完成验证；缺selector或拒绝转换固定TASK_ROUTE_SELECTOR_REQUIRED/TASK_ROUTE_REJECTED，可重试且不泄漏原异常；全部NULL历史任务保持兼容。恢复账本后核对provider_name，不匹配以PROVIDER_ROUTE_MISMATCH拒发，不终结/改写历史unknown，不新建幂等键；此次领取的调用租约保留至自然过期。此处name核对不等于生产精确实例/版本账本绑定，生产多Provider恢复仍需后续设计与验收。

新增4项测试：image/video实际selector+executor+内存ledger未知提交后成功且一条调用/同键；完整或部分快照篡改/缺selector在零SQL前拒绝；历史provider_name冲突保留unknown及幂等键；Worker环境开关不得从父env自动继承且production拒绝。命令node --test覆盖taskExecutor/localMockCatalog/localRegistrationLauncher/worker/workerSecretBootstrap/providerCallLedger/modelRouteResolver七文件；日志`.workbuddy/worker-local-route-test.log`，93 pass/0 fail/0 cancelled/0 skipped，退出0。6个修改JS文件语法检查通过（worker-local-route-syntax.log）。未运行真实PostgreSQL、Next/Studio、公网或真实Provider；旧兼容与宿主生命周期回归通过不代表生产整体完成。

下一步新增本地隔离DB路由任务验证，再装配Studio主流程。当前缺显式管理连接，不猜凭据或读取既有.env；既有业务库不接触。任务管理页面暂缓、Provider配置写API关闭，生产Secret Store/ACL未验收。

### 16.17 本地 mock 可信目录与任务 POST 装配（2026-11-12）

localMockCatalog 固定提供 local-mock-image / local-mock-video 两个合成身份与mock绑定，源对象冻结；每次读取返回独立对象，仅在development、内部guard和显式routing开关同时满足时允许建立。app/api/tasks POST启用时使用createRoutedTaskHandler注入目录，非法环境503；GET及未开启时保留兼容任务处理。启动器显式传开关，不继承父进程任意环境；Migration身份在新隔离库插入禁用的logical_models行，仅作为快照FK，公共模型目录不开放这些fixture。

核查发现通用Web INSERT没有快照四列，本地装配若直接运行会权限失败。本轮仅在本地mock准备函数中为严格匹配pt_local_runtime_<12hex>的新角色授予logical_model_pk/route_snapshot/route_snapshot_version/route_snapshot_hash INSERT，未增加UPDATE、Provider表写权限，也不改runtimePermissions的通用权限契约。准备函数拒绝Worker/既有库身份及SQL注入字符串，负例零SQL。

上轮日志local-mock-routing-test.log为55/55。本轮命令node --test依次覆盖localMockCatalog、localRegistrationLauncher、modelRouteResolver、taskApi、taskQueue、taskSubmission六文件；最终`.workbuddy/local-mock-routing-final-test.log`为57 pass/0 fail/0 cancelled/0 skipped，四文件node语法检查退出0。新增测试核查禁用fixture、精确列级授权与角色负例、目录源和嵌套返回值隔离。授权SQL使用替身，尚未验证实际PG权限/触发器/并发；当前显式管理连接存在性false（local-mock-routing-db-precheck.log），未尝试认证数据库或重启Next、未访问公网/真实Provider。

Worker仍固定Provider，尚不按快照选择；Studio未接任务API，本地完整生成闭环未验收。下一步实现Worker快照选择和拒绝不匹配路由，再补真实新隔离库与Studio主流程验证。任务管理页面暂缓，配置写API关闭，生产Secret Store ACL未验收。

> **2026-11-13 更新（本条已过时，勿据此判断现状）**：Worker 快照选路、Studio 接 `/api/tasks`、二进归档与 owner 授权读取均已完成；本地 mock 闭环在真实隔离 PG 通过（报告 `.workbuddy/database-acceptance-mweebpub_346a46.json`，108 passed / 0 failed）。当前状态见 `HANDOFF_2026-11-13.md` 与开发流程 3.0.4 / 10.4。仍未完成：真实 Provider 出图、资产生命周期删除、配置写 API（仍关闭）、生产 Secret Store ACL。

### 16.16 可信宿主轮换/撤销生命周期切片（2026-11-12）

worker/index.js 在实际 runWorkerProcess 中建立可信宿主生命周期，bootstrap 显式传 gate control；宿主经 onHostLifecycle 获得 getState/rotate/revoke，任务处理器仅获得包装 Provider。rotate(deadline) 校验有限时间后先 gate.drain 再 worker.stop：拒绝新 submit，停止下一次领取，在 gate 截止前允许当前任务 query/cancel。revoke 先 gate.revoke 再 stop，允许 draining 升级紧急撤销；重复操作返回false。SIGINT/SIGTERM 对可信bootstrap路径采用撤销，对原mock路径保留stop。finally撤销残留操作、标记宿主closed并关闭Pool，bootstrap随后关闭gate及委派秘密资源；宿主回调抛错也走相同清理，不透传原始异常。

新增4项bootstrap组合测试：实际Worker在submit在途时正常轮换后query可完成、后续submit拒绝；紧急撤销使已dispatch提交按unknown错误返回且后续query拒绝；启动即轮换升级撤销零connect/claim；无效deadline不改状态及宿主回调异常清理。断言每次只领取1个任务（启动即停止为0）、Pool/秘密恰好关闭一次、重复命令及完成后的控制无副作用；处理器完成/失败计数防止内部断言被Worker异常处理掩盖。该处理器为测试自定义函数，其complete只证明测试处理器完成；未知状态实际ledger保持由同组既有gate/executor/ledger内存组合回归覆盖。

最终命令 `node --test tests/workerSecretBootstrap.test.js tests/worker.test.js tests/providerInvocationGate.test.js tests/taskExecutor.test.js tests/providerCallLedger.test.js`，日志 `.workbuddy/worker-host-lifecycle-final.log`，82 pass/0 fail/0 cancelled/0 skipped、退出0；两个修改文件node --check通过。首轮3新测试为81/81（worker-host-lifecycle-test.log），加强断言并补第4项后最终82/82。未访问数据库/公网/真实Provider，未安装依赖。

限制：轮换期限为gate操作上限，Worker既有shutdownGraceMs可能更早取消当前处理器；不保证任务排空成功。控制不自动创建新版本Worker，不实现多进程监督、上游撤权、明文清除或非协作Adapter硬终止；信号分支未以操作系统信号单独实测。正常轮换的新实例必须由可信宿主在独立秘密版本预检后创建，历史未知任务不得自动换Provider重提。整体Secret boundary及生产部署ACL仍未完成，配置写API关闭。下一步进入生产宿主接线准入：确认平台/地域、秘密后端、Worker身份和时限；确认前不创建资源或假接厂商后端。

### 16.6 第2项显式registry切片（2026-11-12）

providerRegistry.js新增异步resolveWorkerProviderWithSecrets，使用显式descriptor、可信approvedBindings与secretResolver，绑定实例/ref/version/Adapter/Base URL/上游模型；严格字段校验并复制配置，避免await期间被改写目标。仅支持当前myvigna-image/gpt-image-2协议，目标为批准的HTTPS /v1地址；目标校验和精确允许清单匹配在读取秘密之前完成。解析器缺失不回退env，解析器及工厂错误转换稳定码，不透传message/cause。原同步registry和Worker CLI路径未切换，不能称运行时env路径已退役。批准清单和resolver由可信启动方提供，不得来自任务payload。

新增tests/providerRegistrySecrets.test.js六项：真实秘密子进程→新registry→真实Adapter→内存fetch请求头合成凭据贯通；缺resolver无env回退；错身份/版本/Adapter/模型/目标在读取前拒绝；秘密异常及无效返回值脱敏；读取期间descriptor变异不能重定向凭据；Web拒绝和撤销阻止Adapter构造。2文件node --check通过；与秘密IPC、原registry、providerConfig、启动器回归共28 pass/0 fail/0 cancelled/0 skipped，退出0，日志 `.workbuddy/secret-boundary-registry-test.log`。未启动HTTP/数据库、未访问公网或真实Provider。未测试完整poll/result链、真实CLI切换和全链路日志泄漏，整体Secret boundary仍未完成，写API关闭。下一步第3项启动环境构造与Next环境文件回载隔离；真实部署身份和旧env路径退役仍待完成。



