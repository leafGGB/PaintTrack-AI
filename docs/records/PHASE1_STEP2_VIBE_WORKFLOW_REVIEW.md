# 阶段 1 小步骤 2：Vibe-Workflow 节点协议、执行引擎、文件传递与许可证审查

- 日期：2026-11-04
- 项目：PaintTrack
- 审查对象：`packages/Vibe-Workflow`
- 审查方式：只读源码检查、固定提交与工作区状态检查
- 本轮原则：不修改业务源码，不把源码观察表述为动态安全验证，不进入阶段 1 小步骤 3 的架构设计

## 1. 审查目标与结论

本步骤用于确认 Vibe-Workflow 是否能够作为 PaintTrack 的工作流画布、节点协议和执行链基础，以及哪些部分必须在 SaaS 化时重做。

### 1.1 总体结论

Vibe-Workflow 具有可复用价值，但不能直接作为 PaintTrack 的生产级 SaaS 执行后端。

可复用的主要部分：

- React Flow 画布交互、节点/边的可视化模型和运行历史展示；
- 节点 schema 驱动的表单与模型参数映射；
- 工作流节点之间通过输出值连接输入值的表达式协议；
- 保存、运行、轮询状态和单节点运行的前端交互骨架；
- 文件选择、预签名上传表单和上传进度展示等 UI 参考；
- MuAPI 工作流接口的路径适配经验，可作为未来 Provider Adapter 的参考。

必须改造或替换的部分：

- 以 PaintTrack 用户身份为权威的认证、授权和对象归属；
- 工作流、运行、节点运行、文件和输出资产的服务端持久化；
- 任务队列、Worker、租约/心跳、重试、幂等和崩溃恢复；
- 供应商密钥托管、成本/额度记录、供应商错误分类和审计；
- 上传文件的大小限制、内容验证、私有存储、所有者校验、下载授权和生命周期；
- 节点协议的版本化、输入校验、表达式校验和运行时资源限制。

当前最重要的判断是：现有实现主要是“前端工作流编辑器 + FastAPI 到 MuAPI 的透明代理 + 浏览器轮询”。它不能被视为 PaintTrack 已经具备了用户隔离、任务持久化、对象级授权或完整执行引擎。

## 2. 证据范围

| 领域 | 主要文件 | 观察重点 |
|---|---|---|
| 节点恢复与协议序列化 | `packages/workflow-builder/src/components/NodeFlow.jsx` | 节点、边、模型、输入输出、连接表达式和运行历史 |
| 文件上传 | `packages/workflow-builder/src/components/UploadNode.jsx` | MIME 白名单、预签名上传、CDN 地址和客户端元数据读取 |
| 节点输出传递 | `packages/workflow-builder/src/components/NodeSendButton.jsx` | 运行历史输出向其他节点传递的 UI 机制 |
| 服务端代理 | `server/app/utils/workflow_helper.py` | `MU_API_KEY`、MuAPI URL、HTTP timeout 和错误传播 |
| 工作流路由 | `server/app/routers/workflow_router.py` | 创建、读取、运行、状态、发布、模板和 API 执行入口 |
| 上传授权路由 | `server/app/routers/app_router.py` | 文件名 query 参数到 MuAPI 上传授权请求的转发 |
| 服务入口 | `server/app/main.py` | Router 注册、CORS 和可见的中间件边界 |
| 许可证 | `packages/Vibe-Workflow/LICENSE` | MIT 许可与分发义务 |

本报告只记录已读取源码的证据。未执行 MuAPI 实际调用、浏览器动态测试、渗透测试、并发测试或文件内容安全测试。

## 3. 节点协议审查

### 3.1 工作流节点的核心结构

`NodeFlow.jsx` 的 `buildWorkflowPayload()` 将画布节点转成工作流 payload。当前协议包含以下核心字段：

- `id`：画布节点 ID；
- `category`：根据节点类型映射到 `text`、`image`、`video`、`audio`、`api` 或 `utility`；
- `model`：选中的模型 ID，或 passthrough/utility 模型；
- `input_params`：节点当前表单值；
- `output_params`：节点当前输出和结果地址；
- `params`：根据节点 schema 和连接结果组装后的执行参数；
- `position`：画布位置；
- `inputs`：存在入边时记录来源节点 ID。

边至少保存以下信息：

- `id`；
- `source`、`target`；
- `sourceHandle`、`targetHandle`；
- 前端显示用的颜色和样式。

恢复工作流时，`processWorkflowData()` 根据 `workflow.nodes` 重建节点类型、位置、模型、表单值、输出值和运行历史；根据 `workflow.edges` 重建边及其 handle。运行历史来自 `workflowData.run_history[nodeId]`，并按 `started_at` 排序。

### 3.2 节点连接表达式

节点之间的值传递不是直接把上游结果写死到下游输入，而是生成模板表达式。例如：

```text
{{ sourceNodeId.outputs[0].value }}
```

当前代码会根据目标 handle 将连接转换为不同形态：

- prompt、system prompt、单个 URL 等字段使用单个模板字符串；
- 图片、视频、音频等列表字段使用模板字符串数组；
- `concatNode` 可以把多个连接转换为多个模板项；
- `apiNode` 会结合远程 API schema 判断字段是否为数组，并覆盖对应输入值。

这套协议适合表现“节点输出作为下游输入”的工作流语义，但有明显的版本耦合：

1. 表达式固定依赖 `outputs[0].value`，输出端口变化时兼容性有限；
2. handle 名称直接写在前端逻辑中，节点 schema 与 UI 实现没有独立的协议版本；
3. `input_schema` 的字段形状会影响 payload 生成，远程 schema 变化可能导致既有工作流行为变化；
4. 当前审查未看到服务端对表达式语法、引用节点存在性、类型兼容性和循环依赖的统一校验；
5. `params`、`input_params`、`output_params` 和 `edges` 同时保存，存在重复状态，需要后续确定权威字段和迁移规则。

### 3.3 节点协议的复用判断

| 能力 | 判断 | PaintTrack 处理建议 |
|---|---|---|
| 节点类别与模型 schema 映射 | 可复用为 UI/适配层 | 抽出版本化 Node Definition，不让页面组件单独决定协议 |
| 节点位置与边的 React Flow 表达 | 可复用 | 保存前执行结构校验，服务端保存规范化 JSON |
| `{{ node.outputs[...] }}` 模板 | 可作为兼容格式 | 设计受限表达式语法、类型检查和最大深度，禁止任意模板执行 |
| `outputHistory` 运行历史展示 | 可复用交互 | 数据来源改为 PaintTrack 服务端任务/节点运行记录 |
| 直接把远程 schema 用于参数构建 | 需改造 | 固定 schema 版本或保存 schema 快照，避免供应商无通知破坏旧工作流 |
| 前端通过边重写表单值 | 需改造 | 前端只做预览；服务端重新解析并验证最终执行图 |

## 4. 执行引擎与调用链审查

### 4.1 前端可见执行链

当前主要工作流运行链为：

1. 用户在画布上修改节点、表单和边；
2. `handleSaveWorkFlow()` 调用 `/api/workflow/create` 保存或更新工作流；
3. `handleRunWorkflow()` 调用 `/api/workflow/{workflowId}/run`；
4. 服务端返回 `run_id`；
5. 前端每 3 秒轮询 `/api/workflow/run/{runId}/status`；
6. 前端按节点状态更新 loading、outputs、resultUrl 和 outputHistory；
7. 全部完成或任一节点失败后停止轮询并触发 UI 回调。

代码还提供单节点运行、发布、模板化、缩略图、API 输入输出和远程架构生成等接口路径。

这条链路能够支撑原型级交互，但前端仍承担了较多状态解释工作。PaintTrack 需要把“状态事实”收回服务端：前端应只提交用户意图、读取 PaintTrack task/run 状态，不应把供应商 request ID 或供应商返回结构作为长期权威状态。

### 4.2 FastAPI 代理边界

`workflow_router.py` 暴露的路由主要把请求体解析后交给 `workflow_helper.py`。helper 从环境变量读取 `MU_API_KEY`，并将请求转发到固定的 `https://api.muapi.ai/...` 地址。HTTP 客户端 timeout 为 60 秒。

这说明当前服务端确实存在“服务端持有 MuAPI key”的路径，但该路径仍是供应商透明代理，不是完整的 PaintTrack 执行引擎：

- 未看到 PaintTrack 用户身份依赖；
- 未看到 workflow、run、node run 的 PaintTrack 数据库持久化；
- 未看到任务队列或独立 Worker；
- 未看到租约、心跳、重试、幂等键或崩溃恢复；
- 未看到按用户/租户归属校验 workflow、run、asset 的对象级授权；
- 未看到额度账本、成本记录和供应商调用审计；
- 未看到统一的输入 schema、body 大小、响应大小和资源预算控制。

`main.py` 中可见的是 Router 注册和针对 `http://localhost:3000` 的 CORS 配置；本次读取范围内未发现认证 middleware 或对象级授权依赖。该结论是源码抽查结果，不等同于对所有未读取模块作绝对断言。

### 4.3 错误传播与资源风险

`workflow_helper.py` 会把上游错误转换为 HTTPException，并将上游异常文本或响应中的 `detail` 放入日志或 HTTP 错误详情。生产 SaaS 中需要避免把供应商内部信息、请求上下文、URL、凭据相关内容或堆栈信息直接回传给用户。

同时，路由使用 `request.json()`，helper 直接将 payload 转发给上游。后续服务端实现需要明确：

- 请求体最大尺寸；
- 单个工作流节点数量、边数量和表达式长度；
- 单次运行的最大节点数、并发数、执行时长和输出大小；
- 上游超时、取消和重试策略；
- 同一用户重复点击运行时的幂等行为；
- 供应商长时间不可用、部分节点成功和失败重试的状态语义。

### 4.4 执行引擎复用判断

| 能力 | 判断 | PaintTrack 处理建议 |
|---|---|---|
| 运行按钮、进度和结果回填 | 可复用 UI 交互 | 改为消费 PaintTrack task/run API |
| MuAPI URL 适配 | 可作为 Provider Adapter 参考 | 封装为服务端 provider adapter，不让页面直接依赖供应商协议 |
| FastAPI 路由外形 | 可复用少量开发骨架 | 重新定义认证、授权、schema 和错误格式 |
| 供应商请求转发 | 不能直接作为生产执行引擎 | 放入 Worker，增加持久任务、幂等、重试和审计 |
| 当前轮询机制 | 可复用为前端过渡方案 | 优先改为任务详情查询或 SSE/WebSocket；轮询也必须只面向 PaintTrack ID |
| 单节点运行 | 业务上可保留 | 服务端验证节点归属、输入来源和额度，不允许绕过工作流权限 |

## 5. 文件传递与资产边界审查

### 5.1 当前客户端上传路径

`UploadNode.jsx` 当前流程为：

1. 根据 `acceptType` 检查 MIME 白名单；
2. 调用 `/api/app/get_file_upload_url?filename=...`；
3. 接收上游返回的 `url` 和 `fields`；
4. 将字段和文件组装为 `FormData`，直接 POST 到预签名地址；
5. 根据 `fields.key` 拼接 `https://cdn.muapi.ai/`，把结果写入节点表单值；
6. 对图片额外通过浏览器读取尺寸，并尝试以 HEAD 请求读取 `content-length`。

当前允许的主要 MIME 类型包括：

- 图片：JPEG、PNG、WebP、GIF、AVIF；
- 视频：MP4、WebM；
- 音频：MPEG、WAV、WebM。

### 5.2 服务端上传路径

`app_router.py` 从 query 参数读取文件名，并调用 helper 请求 MuAPI 的 `app/get_file_upload_url`。helper 使用服务端 `MU_API_KEY` 向上游请求预签名上传信息。

当前流程的优点是文件内容可以直接上传到供应商对象存储，PaintTrack 服务端不一定需要中转整个大文件。但这也意味着 PaintTrack 需要补齐资产登记和安全边界，否则只能得到一个供应商 CDN 地址，而不是 PaintTrack 可控的资产对象。

### 5.3 必须补齐的文件安全控制

仅检查浏览器 MIME 类型不足以作为生产文件安全边界。后续应至少明确：

- 认证用户和上传会话绑定；
- 文件大小、总容量、每日/每用户上传额度；
- 扩展名、声明 MIME、魔数和实际内容的交叉验证；
- 图片、音频、视频解析器的安全隔离与超时；
- 预签名 URL 的有效期、key 前缀和不可修改的对象归属；
- 上传完成回调或 HEAD/metadata 校验；
- 私有对象默认访问，下载时检查所有者或共享权限；
- CDN/供应商临时 URL 不作为永久公开资产地址；
- 病毒/恶意内容扫描和不受信任媒体的转码隔离；
- 删除、过期、失败上传清理、备份和数据保留期限；
- 运行任务引用的输入资产与输出资产之间的关联。

### 5.4 文件传递复用判断

| 能力 | 判断 | PaintTrack 处理建议 |
|---|---|---|
| 拖拽/选择/进度 UI | 可复用 | 接入 PaintTrack upload session API |
| MIME 白名单 | 可作为第一层体验校验 | 服务端必须重复校验，不能信任浏览器值 |
| 预签名表单上传 | 可复用模式 | 由 PaintTrack 生成受约束的对象 key 和 session |
| MuAPI CDN 地址 | 仅可作为临时供应商引用 | 建立资产记录和受控下载 URL |
| 浏览器 HEAD 读取文件大小 | 不应作为安全校验 | 由服务端记录实际上传 metadata |
| 直接保存 `fields.key` | 需改造 | 保存 asset ID，不把供应商 key 当作用户可见权威 ID |

## 6. 许可证与维护状态

### 6.1 许可证

`packages/Vibe-Workflow/LICENSE` 声明为 MIT License，版权行是：

```text
Copyright (c) 2024 Vibe Workflow Contributors
```

MIT 条款允许使用、复制、修改、合并、发布、再许可和销售，但分发软件或其重要部分时必须保留版权声明和许可证声明；软件按现状提供，不附带担保。

PaintTrack 如果继续分发或打包 Vibe-Workflow 的代码，应至少做到：

- 保留原有 `LICENSE`；
- 在 PaintTrack 的第三方声明或分发包中保留 Vibe Workflow 的版权与 MIT 文本；
- 继续核对 Vibe-Workflow 依赖项各自的许可证，不把 MIT 结论扩大到依赖树；
- 对 PaintTrack 自己的修改保留变更记录，避免后续同步时无法识别本地补丁。

### 6.2 固定版本与本地改动

本次检查确认：

- 子模块当前固定提交：`c65ce897e82bf73659c2725528c8492cd609d831`；
- 本地记录的最近提交日期为 2026-07-28；
- 子模块内存在用户已有的 `client/package.json` 修改；
- 外部 GitHub 提交页面显示的上游提交日期为 2026-09-17，但仅凭提交日期差异不能判断维护质量、兼容性或安全状态；
- 当前版本是固定提交，不应在未审查的情况下自动跟随上游更新。

建议后续把 Vibe-Workflow 当作受控上游组件维护：固定 commit，维护补丁目录/变更清单，升级时执行协议兼容性、依赖许可证、构建和安全回归，而不是直接执行无审查的 submodule update。

## 7. PaintTrack 复用边界总表

| 组件/能力 | 结论 | 进入 SaaS 的前置条件 |
|---|---|---|
| React Flow 工作流画布 | 可复用 | 将画布状态与服务端规范化工作流模型解耦 |
| Node schema 表单 | 可复用但需版本化 | schema 版本、快照、迁移和服务端校验 |
| 边/handle 与模板表达式 | 可兼容复用 | 受限表达式解析、类型检查、循环检测和资源上限 |
| 运行历史展示 | 可复用 | 使用 PaintTrack 节点运行记录，不使用浏览器状态作权威 |
| MuAPI helper | 仅作适配参考 | Provider Adapter + Worker + 密钥/成本/审计体系 |
| FastAPI 路由骨架 | 部分复用 | 统一认证、授权、schema、错误、限流和请求上限 |
| 浏览器轮询 | 可短期复用 | 只轮询 PaintTrack task/run ID，补充取消和超时语义 |
| 上传 UI | 可复用 | upload session、服务端内容校验、资产归属和私有下载 |
| MuAPI CDN URL | 不作为 PaintTrack 资产主键 | 资产表、对象存储抽象和生命周期策略 |
| 当前透明代理执行模式 | 不可直接上线 | 必须由持久任务和 Worker 承接供应商调用 |

## 8. 风险清单

### 阻断 SaaS 架构落地的风险

1. 当前工作流保存、运行和状态查询缺少已证实的 PaintTrack 用户对象授权边界；
2. 当前执行链没有已证实的 PaintTrack 持久任务、Worker、重试和崩溃恢复；
3. 当前节点协议依赖远程 schema、固定 handle 名称和 `outputs[0].value`，没有看到版本化与服务端规范化证据；
4. 当前文件流程没有已证实的 PaintTrack 资产所有权、私有访问和生命周期闭环；
5. 当前代理错误传播和资源限制不足以直接满足生产 SaaS 的安全要求。

### 需要在后续架构步骤明确的风险

- 工作流定义、运行、节点运行、资产和供应商调用记录的实体边界；
- 本地推理与云端工作流的额度、数据流和日志隔离；
- 供应商失败、部分成功、取消和重复执行的状态机；
- 表达式执行是否由 PaintTrack 自己解析，及其沙箱和最大资源预算；
- 上游供应商结果的长期存储与下载策略；
- MIT 代码、第三方依赖和 PaintTrack 修改的分发声明方式。

## 9. 验收记录

- 步骤编号与名称：阶段 1 小步骤 2，Vibe-Workflow 节点协议、执行引擎、文件传递、许可证与维护状态审查。
- 目标与范围：确认可复用边界，识别不能直接作为 SaaS 生产后端的部分。
- 前置条件：开发流程规范已复核；阶段 1 小步骤 1 能力盘点已完成；用户已授权开始下一步骤。
- 修改文件/模块：新增本报告；未修改 Vibe-Workflow 业务源码。
- 许可证结论：MIT；分发时保留版权和许可声明，并单独核对依赖树许可证。
- 固定版本结论：子模块固定在 `c65ce897e82bf73659c2725528c8492cd609d831`；存在用户已有的 `client/package.json` 修改，未回滚。
- 功能测试：本步骤未运行测试、构建或 MuAPI 实际调用；只读审查不改变业务行为。
- 动态安全测试：未运行；报告中的安全结论均为源码层边界识别和后续要求。
- 工作区保护：未删除、覆盖或回滚用户既有改动；未处理 `.next_bak_*` 或 `.workbuddy` 内容。
- 阶段门禁：小步骤 2 报告完成；小步骤 3（架构图、威胁模型、数据流图和服务边界）尚未开始；数据库和认证实现未开始。
- 验收结论：**有条件完成小步骤 2，等待用户验收。**

## 10. 下一步边界

只有在用户确认本报告结论后，才进入阶段 1 小步骤 3。下一步将基于本报告和阶段 1 小步骤 1 的能力矩阵，形成：

- 初版组件架构图；
- 工作流、文件、密钥、供应商和用户身份的数据流图；
- SSRF、越权、重放、资源滥用、文件滥用和供应商失败威胁模型；
- PaintTrack 自有 API、数据库、对象存储、Worker、Provider Adapter、桌面本地推理之间的服务边界。

本报告不提前做数据库、认证、队列或部署方案的最终选型，也不在用户确认前修改这些实现。
