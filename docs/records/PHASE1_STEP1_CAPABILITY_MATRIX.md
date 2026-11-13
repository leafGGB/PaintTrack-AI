# 阶段 1 小步骤 1：现有能力盘点

- 日期：2026-11-04
- 范围：现有 API Route、中间件、MuAPI 代理、上传路径、任务恢复、共享 Studio 组件、Electron 本地推理边界。
- 方法：只读源码检查与 Git 状态检查；未修改业务源码。
- 目标：判断哪些能力可复用、哪些需改造、哪些尚缺失，避免将现有 MuAPI 代理误认为已具备 SaaS 服务端能力。

## 结论摘要

现有代码可提供 UI、模型/参数目录、部分请求适配、上传代理校验和 Electron 本地推理能力作为迁移基础。但 SaaS 关键权威能力仍未见完整实现：PaintTrack 用户认证与对象级授权、服务端持有供应商凭据、持久化任务与 Worker、额度账本、用户资产归属和长期存储。现有云端生成主要由浏览器携带 MuAPI key 提交并轮询 provider request ID，不能直接作为生产 SaaS 的信任边界。

## 能力矩阵

| 领域 | 源码证据 | 可复用 | 需改造 | 缺失 / 当前判断 |
|---|---|---|---|---|
| Next.js API Route 与 Middleware | `middleware.js` 将多数 `/api/v1/*` rewrite 到 MuAPI；creative-agent、上传 URL、上传二进制为例外。`app/api/{agents,app,workflow,api/v1}/[[...path]]/route.js` 代理请求至 MuAPI。 | Next App Router、Route Handler 路由结构、现有 API 路径兼容层。 | 将通用透明代理改为 PaintTrack 自有 API；在服务端统一认证、授权、输入 schema、限流、幂等、审计、超时和响应过滤。 | 未发现可证明 SaaS 用户身份/资源授权的统一服务端中间层；当前代理转发客户端提供的凭据。 |
| MuAPI 供应商调用 | Route Handler 接收 `x-api-key` 或 Bearer token 并转发；`packages/studio/src/muapi.js` 的浏览器路径以 `x-api-key` 提交。 | 可复用现有模型/参数映射、请求封装和 MuAPI 兼容经验，作为未来 Provider Adapter 的实现参考。 | 供应商 key 必须由 PaintTrack 服务端配置读取；统一供应商错误分类、超时、重试、结果校验与成本记录；浏览器只能收到 PaintTrack 任务 ID。 | 未发现服务端密钥托管、Provider Adapter 契约、成本归集和供应商调用审计的完整实现。 |
| 认证、授权与密钥 | 多个页面/client 从 cookie、localStorage 或 sessionStorage 取 MuAPI key；`DesignAgentStudio.jsx` 写入 `localStorage["token"]`；`WorkflowStudio.jsx` 写入 `sessionStorage["wl_workflow_token"]`；顶层 Studio 使用 `localStorage["muapi_key"]`。 | 现有 API key 设置 UI 可作为迁移入口参考；代理路由已有凭据读取/转发代码。 | 移除 SaaS 云端流程对个人供应商 key 的浏览器依赖；改为 PaintTrack 服务端会话及资源级授权。 | 未发现邮箱账户、会话生命周期、角色策略、CSRF/登录限速和 PaintTrack 用户身份作为授权权威的实现证据。浏览器存储供应商 key 不符合目标信任边界。 |
| 生成任务提交与状态查询 | `packages/studio/src/muapi.js` 提交后取得 provider request ID 并调用 `pollForGenerationResult`；默认轮询最多 900 次、每次间隔 2 秒。 | 生成 UI 状态、进度展示与轮询体验；`generationLifecycle.js` 可供未来 UI 适配层参考。 | 改为先创建 PaintTrack 任务；服务端 Worker 持有 provider ID 并推进状态；前端只查询 PaintTrack task ID。 | 未发现持久任务表、独立 Worker、租约/心跳、崩溃恢复、服务端幂等创建和任务所有者隔离。 |
| 浏览器任务恢复 | `src/lib/pendingJobs.js` 使用固定 `muapi_pending_jobs` key；Image、Video、LipSync 保存 provider request ID 与部分元数据并在浏览器恢复轮询。 | 现有历史/恢复 UI 的交互逻辑可移植。 | 恢复源需从浏览器本地 provider ID 改为服务端用户任务列表；清理本地 key 中的敏感信息与跨用户混用可能。 | 这只是客户端恢复，不是权威任务持久化；固定 key 未按 PaintTrack 用户作用域隔离，设备清理/浏览器更换无法恢复。 |
| Studio 持久化 | `packages/studio/src/persistKey.js` 通过 key hash 生成 scoped localStorage key；`migrateLegacyPersistKey()` 将旧共享 key 迁移到当前 key。Image/Video Studio 使用该模式。 | 本地草稿和界面偏好持久化逻辑。 | 云端历史、会话、资产应使用服务端用户归属；评估旧 key 首次迁移归属逻辑，避免多账号浏览器把历史状态错误归入当前身份。 | key hash 只隔离浏览器命名，不构成认证、加密或访问控制。 |
| 文件上传 | `app/api/v1/get_upload_url/route.js` 获取 MuAPI 预签名 URL；两个 upload-binary Route Handler 解析 multipart、校验 target 后向 S3 上传。`src/lib/uploadProxyTarget.js` 有 HTTPS/主机 allowlist、localhost/IP literal 与危险文件类型限制。 | 目标 URL 限制与文件类型拦截可作为纵深防御参考；现有上传交互可复用。 | 增加请求体/文件大小限制、认证与对象所有权、内容检测、超时/响应大小控制；避免上传凭据或供应商目标由客户端任意控制。 | 未发现 PaintTrack 自有对象存储、资产元数据/所有者记录、上传完成确认、私有下载授权、生命周期/删除策略。供应商临时 URL 不应当长期资产地址。 |
| API 代理资源与日志控制 | 多个代理使用 `request.arrayBuffer()` 或 `request.formData()` 完整读取请求；工作流、上传、creative-agent 路径有请求/响应或异常日志。 | 现有路径转发与方法适配可作兼容参考。 | 为每类路由加最大 body、上游超时/取消、响应大小上限、结构化错误与敏感字段脱敏；供应商响应一律按不可信输入处理。 | 本次抽查未找到统一 body 上限和 fetch timeout 控制；请求体过大和上游挂起可能扩大资源消耗。该结论是源码搜索范围内未发现，不等于经运行时测试证明绝对不存在。 |
| Creative Agent 与 Workflow | `CreativeCanvas.jsx` 从 localStorage token 或 embed code 访问 `/api/v1/creative-agent`；embed session ID 存 localStorage。Workflow 有独立 Route Handler，客户端传 key。 | 画布、会话、技能和工作流 UI/协议可以作为前端原型参考。 | 服务端按用户/租户校验 session、job、asset 与 workflow 所有权；限制 embed 能力并加入审计/速率/资源限制。 | 未证实服务端对象级 PaintTrack 用户授权、任务隔离或执行沙箱满足 SaaS 要求；不得仅凭代理路由存在认定已具备。 |
| Electron 本地推理 | `electron/preload.js` 通过 IPC 暴露 `localAI`、`wan2gp`；sd.cpp 运行本机二进制；Wan2GP 支持本机 `wgp.py` 或远端 MCP，远端模式上传输入图像并下载结果。 | 本地模型目录、Electron IPC 封装、取消/进度和模型能力目录可继续复用。 | 明确 local/remote 模式标签、输入文件去向、IPC 参数校验与错误/日志脱敏；确保 local 分支不触发云端任务和额度。 | 本地推理是独立能力，不等于 SaaS 后端。远程 MCP 可能将输入图像上传到第三方；需产品告知和数据政策。当前额度隔离仍须通过完整调用链测试确认。 |
| 测试覆盖 | 规范基线记录现有测试集中于 Electron 本地推理/Wan2GP；本轮没有新增/执行测试。 | 现有 Node 测试体系可扩展，并使用 mock 隔离供应商。 | 新增 API 集成与授权负例、任务状态/幂等/并发、上传限制、日志脱敏、Electron 云端/本地隔离测试。 | 未发现 SaaS API、认证、数据库、任务、账务和对象所有权测试体系。 |

## 关键调用与数据流

1. 云端生成：Studio UI → 浏览器请求 `/api` 或 `/api/v1` → middleware/Route Handler → MuAPI；浏览器保存 provider request ID 并自行轮询。
2. 上传：Studio 获取 MuAPI 预签名信息 → PaintTrack upload-binary 代理校验目标与文件类型 → 上游 S3；目前未见 PaintTrack 资产所有权/元数据闭环。
3. Electron 本地推理：Studio → `window.localAI` → preload IPC → Electron 主进程/本地 sd.cpp 或 Wan2GP；Wan2GP 远端 MCP 模式会将输入文件发送至远端服务。
4. Creative Agent：客户端 token/embed code → `/api/v1/creative-agent` → MuAPI creative-agent；客户端 token 与本地 embed session 不是 PaintTrack 服务端身份与权限系统。

## 优先风险与建议边界

- **阻断 SaaS 上线：**浏览器持有/发送供应商 key；客户端管理 provider request ID；缺少服务端任务持久化、用户授权、额度账本和对象所有权证据。
- **资源滥用风险：**代理全量读取 body；抽查范围未见统一请求大小和上游超时控制。
- **隐私风险：**日志可能记录请求字段、上游响应片段或异常；需脱敏策略与日志测试。
- **文件风险：**现有 URL 校验是有价值的防护，但不替代对象归属、私有访问、大小限制、内容验证和生命周期管理。
- **桌面边界：**本地推理应通过显式模式分流，不纳入云端额度；远端 MCP 必须按第三方处理输入素材告知用户。

## 验收记录

- 步骤编号与名称：阶段 1 小步骤 1，现有 API / Studio / 上传 / 任务恢复 / Electron 能力盘点。
- 目标与范围：只读梳理并形成可复用/需改造/缺失矩阵。
- 前置条件：开发规范已确认；本轮开始前复核 Git 状态。
- 修改文件/模块：新增本交付报告；业务源码未修改。
- 交付物：本文件的能力矩阵、数据流和风险结论。
- 功能测试：未运行；只读盘点不改变业务行为。
- 安全测试：完成源码层面边界检查；尚未运行动态安全测试。
- Git diff 检查：主仓库既有暂存差异为 `GIT_WORKFLOW.md`、`README.md`；既有未暂存改动与子模块变化保持原样。新增本报告前的差异统计：未暂存 23 项、1,241 insertions / 5,422 deletions；暂存 2 项、267 insertions / 1 deletion。仓库还存在多个 `.next_bak_*`、`.workbuddy/`、锁文件备份和未跟踪补丁/脚本，均未触碰。
- 未验证项/风险：Production build 先前在 `.next/trace` 遇到 `EPERM`、退出码 1；本轮未重试。测试/lint 未运行。构建缓存和其备份未访问。
- 验收结论：有条件通过源码盘点交付；不代表生产构建或动态安全验证通过。进入下一小步骤前需用户确认。
- 用户确认：待确认。
