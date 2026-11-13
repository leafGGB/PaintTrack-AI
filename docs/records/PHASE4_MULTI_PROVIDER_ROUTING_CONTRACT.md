# 阶段 4：多 Provider 配置与模型路由契约（设计稿）

- 日期：2026-11-09；2026-11-10 更新
- 状态：多模型配置与路由契约；MyVigna `gpt-image-2` T2I 异步图片 Adapter 已完成 loopback mock 协议验收（7/7），Worker 动态路由、任务快照和既有 Studio 接线尚未完成。2026-11-10 用户确认：产品必须支持多个图片/视频逻辑模型及后台模型管理，不得将首个协议切片误作单模型产品限制。
- 执行顺序权威来源：`../ImplementationPlan/PAINTTRACK_DEVELOPMENT_PROCESS.md` 第 10 节。本专题稿只规定阶段 4 的路由契约与候选实施顺序，不覆盖整体阶段依赖或另行授权实现。
- 目标：支持多个 OpenAI-compatible API 中转站，并允许 PaintTrack 的每个逻辑图片/视频模型独立绑定一个上游 Provider 配置实例及上游模型名。
- 参考资料：用户提供的 `../../../doc/myvigna-api-guide.md`；该资料作为首个协议参考，不代表所有中转站/模型的全部端点都兼容。
- 本设计稿范围：定义多 Provider 实例、多逻辑模型、Provider 上游模型、绑定路由、任务快照、切换语义、安全边界及后续验收。当前不代表已实现管理 UI、动态目录 API、数据库迁移、真实 Provider 调用、生产凭据管理或云资源。

## 1. 决策摘要

1. Provider 配置实例、PaintTrack 逻辑模型、上游模型绑定是三个分离实体。
2. 相同协议、不同 Base URL/凭据的中转站共用一个协议 Adapter；不同站点不复制业务适配代码。
3. 用户在 Studio 中选择 PaintTrack 逻辑模型。客户端不能指定 Provider 实例、任意 Base URL、凭据或未批准的上游模型名。
4. 服务端创建任务时解析当前有效绑定，将路由信息固定为不可变快照；快照不包含凭据或 Authorization 信息。
5. 绑定切换默认只影响切换后新建的任务；排队、运行和恢复中的任务按原快照执行。
6. 默认不自动跨 Provider 故障转移。未来启用时必须显式配置、检查能力/价格/数据策略兼容并记录实际路由；未知提交状态不能换上游重提。
7. Provider Base URL 是受信配置，不是通用代理参数。所有服务端请求及结果抓取均实施 SSRF、DNS、重定向、超时和响应大小控制。
8. MyVigna 文档中聊天 API 的 OpenAI 兼容说明不可推导出所有媒体 API 兼容。首期媒体端点范围需逐项确认。

## 2. 名词与三层实体

### 2.1 Provider 配置实例（上游连接）

一条配置代表用户保存的某个中转站连接，例如“站点 A - 生图线路”或“站点 B - 视频备用”。同一站点若使用不同 Key、分组、区域或用途，可配置为独立实例。

建议字段：

| 字段 | 说明 |
|---|---|
| `id` | PaintTrack 内部 UUID；客户端仅在授权范围内使用 opaque ID |
| `owner_scope` | 初期可限定管理员全局；如未来用户自带 Key，必须显式改成用户归属并隔离授权 |
| `display_name` | 管理界面显示名称，不作为协议选择依据 |
| `adapter_type` | 受服务端允许列表控制，例如 `openai-compatible`；不能由客户端传模块名/代码路径 |
| `base_url` | 规范化后的服务端请求根地址；不可从生成 payload 覆盖 |
| `credential_ref` | 指向服务端 Secret Store/加密凭据记录的引用；不返回客户端、不写任务 payload |
| `enabled` | 管理员显式启停；停用禁止新路由，已固定任务的处理见第 6 节 |
| `config_version` | 每次影响请求行为的配置修改递增；路由快照固定版本 |
| `health_state` | `unknown` / `healthy` / `degraded` / `disabled` 等内部观测状态，不作为绝对可用承诺 |
| `created_at`, `updated_at` | 审计时间 |

不得在普通日志、任务 JSON、错误响应或前端状态中存明文 Key。密钥替换应有独立审计事件，并支持禁用/轮换。

### 2.2 PaintTrack 逻辑模型

逻辑模型是 Studio 向用户展示的稳定模型键，例如 `gpt-image-2`、`gemini-3-pro-image-preview`、`nano-banana-2.1`、`kling-v3`。项目必须支持多个图片、视频及其他已纳入范围的模型；任何一个模型只是目录中的一项，不得作为全站唯一模型硬编码。逻辑模型表达 PaintTrack 产品能力和参数约束，不等于任一中转站的模型名。

建议记录：

- `logical_model_id`：稳定且不含上游凭据/地址的标识；
- `task_type`：`image.generate`、后续明确批准的 `image.edit` / `video.generate` 等；
- `media_kind`、输入形式、输出形式、参数 schema 和平台侧约束；
- 展示名称、是否启用及规则版本。

若兼容现有 Studio 的模型选择器，迁移期间前端静态目录（当前 `packages/studio/src/models.js`、`modelFamilies.js` 及参数能力模块）暂作展示、参数控件和历史兼容模板，不再决定模型是否可调用。服务端动态目录是可调用能力、启用状态和授权的权威来源；Studio 只展示服务端返回且存在有效绑定的模型，并与本地参数模板按稳定逻辑模型 ID 合并。未知模板的动态模型须使用服务端提供的受限通用参数 schema；不能匹配或校验失败时禁用该模型，不得猜测请求格式。前后端目录不一致时 fail-closed，不以客户端的 `provider`、`baseUrl`、`endpoint` 或 `upstreamModel` 字段作为路由依据。

### 2.3 Provider 上游模型登记与逻辑模型绑定（路由）

为避免把“模型发现结果”“可调用能力”和“产品逻辑模型”混成一项，配置概念分为：

1. **Provider 上游模型（`provider_models`）**：某 Provider 实例下可选的精确模型名，以及经过验证的媒体类型、operation/endpoint profile、能力和参数映射。模型列表探测只能提供待审核候选，不能自动授予可调用状态。
2. **逻辑模型路由绑定（`model_provider_bindings`）**：把 PaintTrack 逻辑模型指向一个已登记且已验证的 Provider 上游模型，并指定主用/备用优先级、映射版本和启用状态。

后台添加逻辑模型时必须同时定义 PaintTrack 展示信息及服务端参数/能力契约；将其绑定到上游模型前，必须确认 Adapter 对应端点和请求/响应映射已实现并测试。一个上游模型不能仅凭名称或 `/v1/models` 返回值自动被宣传为支持 T2I、I2I、T2V 等能力。

绑定把一个逻辑模型映射到某个 Provider 实例登记的上游模型及其受控 Adapter/operation profile。一个逻辑模型可有多个绑定并配置明确的主路由和备用顺序；同一逻辑模型同一时刻只允许一个主路由。

建议记录：

- `logical_model_id`；
- `provider_instance_id`；
- `upstream_model_id`：精确上游模型名，保留大小写、括号和后缀；
- `operation` / `endpoint_profile`：generation、edit、video submit/query/content 等明确端点能力；
- `request_mapping_version`、`response_mapping_version`；
- 经验证的 `capability_profile`：同步/异步、支持参考素材形式、尺寸/时长限制、query/cancel、幂等、结果格式等；
- `priority` 或主/备用标识、`enabled`、生效状态、配置版本和审计信息。

一个逻辑模型可以有多个候选绑定，但任何时刻只有明确确定的主路由；备用绑定不得仅因存在就被静默使用。主路由变更需有操作者与时间审计。

## 3. 任务 API 与服务端路由解析

### 3.1 客户端请求

现有任务 API 的外层仍保持 `taskType + payload`。Studio 的规范化 payload 可包含 PaintTrack `logicalModelId` 和业务参数，但严禁包含 `providerInstanceId`、`baseUrl`、`credential`、任意上游模型名或 URL。

服务端验证顺序：

1. 会话认证、owner 来源、Origin 和幂等键校验；
2. 根据 `taskType + logicalModelId` 查服务端逻辑模型和参数 schema；
3. 检查模型启用、用户/租户授权和额度前置条件；
4. 读取有效绑定与 Provider 配置版本，检查实例启用、能力匹配及目标 URL 策略；
5. 生成规范化任务输入及路由快照；
6. 在同一事务中保存任务、请求指纹、绑定版本/路由快照及审计关联，之后交由 Worker。

任何一步发现模型未注册、无绑定、绑定禁用、能力不兼容或 Provider 未配置，都应明确拒绝新任务且不让 Worker 领取后再失败。

### 3.2 幂等语义

同一 owner、幂等键和同一规范化请求仍应返回原任务。路由必须在任务创建时固定：如果重复 API 请求发生在管理员切换绑定之后，但命中原幂等键/指纹，仍返回原任务及原路由，不得偷偷创建或重路由。

是否把路由版本纳入请求指纹需实现前定案。推荐将用户可见业务请求指纹与服务端解析出的路由快照分开保存：API 重放仍依业务请求匹配，而路由快照仅在首次创建时解析并持久化，避免切换路由导致同请求被判为幂等冲突。

### 3.3 路由快照

每个任务固定包含不含密钥的服务端路由快照，至少包括：

```json
{
  "logicalModelId": "painttrack.image.fast",
  "providerInstanceId": "opaque-provider-uuid",
  "providerConfigVersion": 4,
  "adapterType": "openai-compatible",
  "adapterVersion": "1",
  "upstreamModelId": "exact-upstream-model-name",
  "operationProfile": "image-generation-async",
  "requestMappingVersion": 2,
  "responseMappingVersion": 1,
  "bindingVersion": 7
}
```

此为逻辑示例，不是最终数据库 schema。快照不得包含 `base_url`、密钥、Authorization header、完整 prompt 或未经授权的上游响应。执行时通过实例 ID/配置版本解析服务端受控配置；密钥轮换不应改变模型路由语义。

## 4. Provider Adapter 边界

### 4.1 通用 OpenAI-compatible 层

Adapter 接收已经解析并校验的上游调用上下文：Provider 实例、配置版本、逻辑任务/模型、精确上游模型名、规范化参数、映射版本和受限 `AbortSignal`。Adapter 内部从服务端配置取得 Base URL 与凭据，负责 Bearer 注入、路径拼接、请求序列化、状态/响应解析及固定错误映射。

Base URL 与 endpoint profile 必须分开配置/解析，避免截图示例中某个 `/v1/chat/completions` 被误当成所有任务的根地址。规范化规则须拒绝重复 `/v1/v1`、不允许带 userinfo/query/fragment 的 Base URL，并只允许经过审核的协议与端口。

### 4.2 媒体能力不能仅靠“OpenAI compatible”标签推断

依据当前 MyVigna 指南，至少识别以下差异：

- 文本：`/v1/chat/completions`，另有 `/v1/responses`，响应和流式协议不同；当前 PaintTrack 本步骤只聚焦图像/视频，不据此扩展文本 Agent。
- 图片同步：`/v1/images/generations`；可能返回 URL 或 `b64_json`。
- 图片编辑：`/v1/images/edits`；普通 GPT 图片可使用 multipart，原生 GPT/Seedream/Gemini 等使用 JSON 的 `images[].image_url`，字段能力随模型变化。
- 图片异步：`/v1/images/tasks`、查询及结果端点；提交幂等、poll 间隔、任务状态和保留期需独立验证。
- 视频：`/v1/videos` 提交、`/v1/videos/{id}` 查询、`/content` 取回；异步状态和模型参数有自身规则，参考素材 URL 限制与计费方式也可能不同。

因此采用“协议 Adapter + endpoint/operation profile + 模型能力映射”，不得让一个协议布尔值代表全部端点兼容。模型列表 `/v1/models` 可作为发现提示，但不能替代适配/参数/结果兼容验证；模型可见不表示支持所有端点。

## 5. 动态目录与后台管理 API/UI 约束（后续分步实现）

参考用户截图，配置流程可做成“添加上游 API”对话框，至少包含：

- 协议：首期 `OpenAI-compatible`，未来协议由服务端 Adapter allowlist 扩展；
- Provider 名称；
- Base URL（界面标明根地址格式，不要求填写具体 endpoint）；
- API Key（只在新增/轮换时输入，保存后不回显，仅显示已配置/更新时间）；
- 连接测试（服务端执行，返回脱敏状态；不把 key 发回浏览器）；
- 模型发现/手动刷新，以及模型能力校验；
- 启用/停用与删除保护（已有任务/绑定引用时先停用或迁移，不硬删除历史身份）。

后台分离管理三个对象：

- **Provider 实例**：名称、协议 Adapter 类型、根 Base URL、凭据设置状态、启停、健康状态、版本；凭据只在新增/轮换时输入，保存后不回显。
- **逻辑模型目录**：稳定 ID、显示名称、厂商名、媒体类别、T2I/I2I/T2V/I2V 等能力、参数 schema、图标、排序和启用状态。管理员可添加、编辑、启用和下线模型；Studio 仅展示有启用且已验证路由的模型。
- **Provider 上游模型与路由绑定**：按 Provider 登记精确上游模型名及已验证能力；将逻辑模型绑定到一个或多个上游模型，配置主路由、备用优先级、operation profile 和映射版本。连接测试由服务端执行并返回脱敏状态。

路由变更前明确提示只影响新任务；已有任务保留快照。删除使用软下线作为默认操作。只有无任务快照、调用账本、绑定、审计及其他外键引用的配置才允许物理删除；有引用时必须阻止删除并指导管理员先下线或迁移绑定。

不得把截图中输入“完整 `/v1/chat/completions`”的 URL 直接作为通用 URL 代理。对于 Base URL 采用协议根地址，例如 `https://host.example/v1`，实际 endpoint 由受控 Adapter profile 构造；如果不同上游要求非标准路径，需作为受限、审核后的 endpoint profile 配置，不开放任意路径转发。

## 6. 路由切换、禁用与故障转移

- **手动切换：**绑定变更事务化递增版本；已创建任务不变，新任务使用新绑定。
- **Provider 停用：**阻止新任务路由到该实例；已固定但尚未提交的任务默认标记为 `provider_unavailable` 并等待管理员处理/明确重路由，不自动换线；已受理任务继续向原实例查询，除非凭据/安全策略要求立即停止。
- **上游模型不可用：**只将对应绑定标记异常，其他逻辑模型/绑定不受影响；保留错误分类、时间、配置版本，不写入供应商敏感原文。
- **自动故障转移：**首期关闭。将来开启时须满足绑定能力兼容、预算/价格规则、输入数据策略一致、调用尚未产生不确定副作用，并为切换创建可审计的新 provider call attempt。提交后状态未知时禁止直接切换 Provider 重提。
- **重试：**同一次 Provider call 的未知提交恢复必须固定原 Provider 实例、上游模型和幂等键；若需要人工改路由，须显式创建新的业务尝试/任务语义并处理可能重复计费。

## 7. 安全与合规门禁

1. Base URL 只由认证管理员通过受控配置 API 写入，不能来自 Studio 生成请求。
2. 首期限制 `https:`；拒绝用户名/密码、fragment、异常端口、IP literal（除经批准的本地测试模式）、loopback、私网、link-local、云 metadata、特殊 IPv4/IPv6 表示和 DNS 解析到禁止网段的地址。
3. 请求前解析并验证 DNS；连接时绑定验证结果或使用等效防 DNS rebinding 的网络层；每次重定向重新校验目标，优先禁用自动重定向。
4. 连接测试与模型发现也必须走同一 SSRF 防护、限流、超时和响应大小上限；不能因“测试按钮”降低校验。
5. 返回的 `poll_url`、`result_url`、视频内容 URL 必须限制为预期 Provider origin 或受控允许域，不能盲目 fetch 任意上游返回 URL；重定向逐跳检查。
6. Key 仅服务端 secret boundary 使用；API 响应只返回 `credentialConfigured: true/false`、更新时间等脱敏元数据。
7. 管理配置增删改、启停、测试、模型绑定和路由切换均写入审计事件；日志不得包含 Key、Authorization、完整请求体、prompt、媒体字节、临时 URL。
8. Provider 输出、模型列表、状态、尺寸/时长枚举、成本和错误均是不可信数据；严格 schema 校验、大小/数量/速率限制。
9. 上游费用可能因重试/切换重复发生。阶段 6 账务未完成前不展示虚假额度，不承诺上游费用可自动退款。

## 8. 数据库候选模型（待 schema 设计步骤确认）

建议的逻辑表（设计基线，仍需独立 schema/权限/迁移评审，不代表已批准迁移）：

- `provider_instances`：受控连接配置元数据、Base URL、adapter type、状态、config version、credential reference；凭据密文/Secret Store 方案另行决策。
- `provider_models`：Provider 实例下人工登记或审核发现的上游模型名、端点/operation profile、验证状态、能力/参数映射版本；探测结果不自动启用。
- `logical_models`：PaintTrack 稳定逻辑模型、展示信息、媒体/任务能力、参数 schema 版本、enabled/排序和软下线时间。
- `model_provider_bindings`：逻辑模型到 `provider_models` 的绑定，含主/备用优先级、验证/启用状态、映射版本和 binding version。
- `generation_tasks`：增加服务端路由快照或关联不可变任务路由版本；逻辑模型/绑定/Provider 配置版本/Adapter/上游模型/operation profile/映射版本在任务创建事务中固定，快照不含密钥。
- `provider_calls`：增加 Provider 实例 ID、config version、adapter version、logical model ID、provider model/upstream model ID、binding version 等审计关联；不存凭据。
- `provider_config_audit_events`：Provider、上游模型、逻辑模型、绑定的创建/更新/启停/主路由切换/删除阻止等管理员、时间、变更类别及安全摘要；不存秘密值。

需在后续 schema 设计时确定删除/保留策略、外键行为、并发切换锁、RLS/权限、迁移空库条件、历史任务查询和索引。配置历史不能因软删除 Provider 实例而丢失。

## 9. 最小实施顺序建议

每个子步骤单独授权、测试和验收：

0. **多模型数据/API 设计审查：**先审查 `PHASE4_STEP2_MODEL_CATALOG_ROUTING_DATA_DESIGN.md` 中实体关系、快照、权限、动态目录和迁移兼容；通过后再开展目录范围盘点与 schema/migration 设计。
1. **本契约与目录范围评审：**确认首批需出现在动态目录的既有图片/视频逻辑模型及能力；模型目录支持多项，按能力分批实现，不要求第一步就让所有上游都可调用。
2. **逻辑模型目录规范：**梳理现有 Studio 模型元数据、模型族、参数 schema 和能力；定义稳定逻辑 ID、后台可编辑字段、静态模板兼容策略和动态目录 API 返回契约。
3. **上游能力登记规范：**定义 Provider 实例下的 `provider_models`、Adapter/endpoint allowlist、能力验证状态和模型发现审核流程；未经 Adapter 与 fixture 验证的能力不得启用。
4. **路由与任务快照数据设计：**确定 Provider 实例、上游模型、绑定、任务快照、provider_calls 关联、权限、审计、删除/软下线策略；先做设计与隔离测试，不录真实凭据。
5. **管理员配置服务/API 与动态目录 API：**实现认证授权、Base URL/SSRF 安全校验、secret reference、脱敏读取、版本/审计、逻辑模型目录查询和绑定维护；第一版先让 Studio 读取服务端可用模型。
6. **Adapter + mock/fake HTTP：**按协议和 operation profile 逐个实现，覆盖 Bearer 注入、路径构造、模型/参数映射、响应规范化、错误/超时和 SSRF 防护。已有 MyVigna `gpt-image-2` Adapter 是第一个已验证切片，不是唯一模型配置。
7. **按任务快照动态路由 Worker：**取代进程级固定 Provider 选择，保证提交、恢复、轮询严格使用任务首次绑定的 Provider、上游模型、配置和 Adapter 版本。
8. **Studio 动态目录与既有页面接线：**先接 ImageStudio/VideoStudio 的模型选择器，使其展示后台启用且有有效绑定的逻辑模型；再按能力逐类接现有任务 API，不新增平行生成页面。
9. **后台 UI：**在配置 API 稳定后实现 Provider 实例、逻辑模型目录、Provider 上游模型和路由绑定管理；支持添加/编辑/启用/下线、主路由切换、连接测试和删除保护。
10. **扩展媒体能力与真实上游验收：**逐个增加图片编辑、异步图片、视频提交/查询/结果抓取；用户另行确认真实 Key、预算和测试模型后再开展公网 Provider 测试。

## 10. 验收矩阵

| 类别 | 必须验证 |
|---|---|
| Provider 配置 | 多实例同协议；同名/重复 URL 策略；编辑版本递增；启停；凭据轮换不回显；配置删除受历史引用保护 |
| Base URL/SSRF | 非 HTTPS、userinfo、恶意端口、loopback、私网、link-local、metadata、IPv4/IPv6 变形、DNS rebinding、重定向到禁区均拒绝 |
| 路由 | 每个逻辑模型选定正确实例和上游模型；未绑定/停用/能力不匹配拒绝；客户端伪造 Provider ID/Base URL/upstream model 不改变路由 |
| 快照 | 管理员切换后旧排队任务仍用旧快照；新任务用新绑定；配置/映射版本可追溯；快照不含凭据 |
| 幂等/恢复 | 同键同请求返回原任务/原路由；同键不同请求冲突；提交未知恢复固定原 Provider 和幂等键；不得跨 Provider 自动盲目重提 |
| Adapter | Bearer 不泄露；正确 Base URL + endpoint profile；JSON/multipart 正确；模型名精确；响应大小/状态/schema/错误/超时限制有效 |
| 任务执行 | provider_calls 记录真实实例和模型快照；异步 query/cancel 依 capability；迟到结果、取消竞态和租约恢复无重复提交 |
| 结果抓取 | 返回 URL 仅允许已验证目标；逐跳重定向校验；内容类型/魔数/大小验证；不向客户端暴露上游临时 URL |
| 动态模型目录 | 支持多个图片/视频逻辑模型；只返回启用且存在可用绑定的模型；能力和参数 schema 与 Studio 控件兼容；未验证能力不展示为可用 |
| 管理 UI/API | Provider、上游模型、逻辑模型和绑定的角色授权、CSRF/Origin、审计、连接测试限流与脱敏；Key 保存后不回显；逻辑模型主路由切换明确提示只影响新任务 |
| 删除/下线 | 默认软下线；被任务快照、provider_calls、绑定或审计引用的对象拒绝物理删除；历史任务仍可按快照解释和审计 |
| 产品链路 | 复用既有 ImageStudio/VideoStudio；配置缺失/上游故障显示可操作状态；任务中心继续只负责查看/取消 |

## 11. 本步骤边界与待确认

本设计稿不批准任意用户开放注册 Provider 配置，也不决定密钥加密存储方案。当前产品约束为管理员管理服务端 Provider；若未来改为每个普通用户保存自己的中转站 Key，必须单独审查租户隔离、加密、授权、滥用控制、计费和删除策略。

### 11.1 首个协议切片（已实现，不代表模型目录限制）

用户于 2026-11-10 确认：PaintTrack 需支持多个图片/视频模型，并希望后台能添加、编辑、下线模型以及指定每个逻辑模型使用的上游 Provider 模型。故原先“先把 ImageStudio 固定接到一个模型”的顺序已调整为先完成动态模型目录和路由架构设计。MyVigna `gpt-image-2` T2I 是首个协议验证切片：对应同名上游模型；异步任务 profile 提交 `POST /v1/images/tasks`，使用服务端 Bearer 鉴权、`Idempotency-Key`、JSON 字段 `model`、`prompt`、`n`、`size`、`response_format`，并按 GPT Image 2 规则传 `quality: high`；响应提供 `task_id`、相对 `poll_url`、`result_url`、`poll_after_ms`，GET poll 读取状态，成功后 GET result，图片数据为 `data[].url` 或 `data[].b64_json`。Adapter 已通过 loopback mock HTTP 测试 7/7；未访问公网或使用真实凭据。该实现用于验证一种 Adapter/profile 与任务契约，不得将逻辑模型校验、动态目录或 Studio 接线永久限制为 `gpt-image-2`。

### 11.2 用户已确认的产品决策与待细化项

已确认：

1. 模型目录不能限定为一个生图或生视频模型；首批需能覆盖现有多个图片/视频逻辑模型，之后按 Adapter 与能力验证逐步启用。
2. 管理员应可在后台添加/编辑逻辑模型、启用/下线模型，并指定它绑定到哪个 Provider 实例下的上游模型；同一逻辑模型可配置多个 Provider 绑定并手动切换主路由。
3. Studio 展示逻辑模型；浏览器不提交 Provider、Base URL、凭据或上游模型名。任务创建时服务端解析并固定无密钥路由快照，改路由只影响新任务。
4. 静态 Studio 模型文件短期作为显示/参数兼容模板，迁移到服务端动态目录后，服务端目录决定可调用模型；逐步迁移，避免破坏现有参数交互。
5. 默认以软下线代替删除；历史任务、调用账本、绑定或审计引用存在时拒绝物理删除。
6. 默认关闭自动故障转移；未知提交不允许切换 Provider 重提。

实现前仍需在对应小步骤细化：Provider 凭据的生产密钥存储、数据库表/索引/权限与迁移、动态目录 API schema、模型参数 schema 兼容策略、备用路由触发规则（若未来开启）及管理员强化认证。发现 `/v1/models` 只能产生审核候选，不能自动启用能力。

## 12. 当前实现差距（静态审查）

- 初始设计稿时 `providerConfig.js` 仅读一组环境配置；后续实现已增加首个 `myvigna-image` 环境模式，但它仍不是多实例配置存储。
- Provider Registry 在 Worker 启动时解析一次 Provider，当前仍不是任务级动态路由。
- `taskSubmission.js` 已增加首个 `gpt-image-2` payload 校验，但动态逻辑模型目录和路由解析尚未接入；此校验属于协议切片的临时限制，动态目录实现时必须替换为服务端注册模型与能力 schema 校验。
- `generation_tasks` 仍没有路由快照列；`provider_calls` 尚不能完整区分 Provider 实例、Provider 模型和绑定版本。

> 本节包含设计稿初始基线及当前差距。实施前必须重新核对代码与迁移；若代码已变更，以当前代码/验收证据更新差距，不得把旧快照当作永久现状。
- 现有 Studio SDK 已改为同源 `/api`，但图片/视频业务 SDK 与新的任务创建 API/Worker 尚未打通；不宣称当前 Studio 已支持多 Provider。
- **2026-11-10 更新：**MyVigna `gpt-image-2` 异步图片 Adapter 已实现并通过 loopback mock HTTP 测试 7/7；未访问公网或使用真实凭据。用户随后确认产品必须支持多个图片/视频模型及后台逻辑模型配置，因此此前“下一步仅限单模型 T2I”的顺序已废止。阶段 4.7.1 数据/API 设计与 4.7.2 Drizzle schema/SQL migration 分步设计已分别记录于 `PHASE4_STEP2_MODEL_CATALOG_ROUTING_DATA_DESIGN.md` 和 `PHASE4_STEP3_SCHEMA_MIGRATION_DESIGN.md`。4.7.2 设计确认五张配置/审计表、任务快照与 provider_calls 的 nullable 扩展、旧记录不回填、非空库兼容、回滚/恢复及隔离验收矩阵；本轮未改 schema、SQL、snapshot/journal 或数据库。

## 13. 本步骤记录

- 原始设计记录：新增本设计稿；未修改业务源码、数据库 schema/migration、依赖或真实凭据。后续实施以各步骤的记录和验收结果为准。
- 本轮文档修订：更新多模型产品决策、动态目录/后台管理契约、软下线与删除保护、实施顺序及当前差距；未修改运行时代码、数据库 schema/migration、依赖或真实凭据。
- 验证：检查主路线、阶段索引与本专题契约的一致性，并运行文档差异检查；不运行程序测试（本轮无程序行为变更）。
- 安全边界：未进行网络请求；未使用真实 Provider Key；未创建云资源；未改现有数据库。
- 当前下一步：阶段 4.7 多模型目录与路由数据/API 设计审查。其后才实现动态目录、管理员配置和任务级快照路由，再接既有 Studio。执行顺序以 `../ImplementationPlan/PAINTTRACK_DEVELOPMENT_PROCESS.md` 第 10 节为准。
