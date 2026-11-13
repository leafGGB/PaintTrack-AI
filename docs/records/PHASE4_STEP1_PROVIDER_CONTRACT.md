# 阶段 4 小步骤 1：Provider 契约与供应商边界审查

- 日期：2026-11-07
- 项目：PaintTrack
- 步骤：阶段 4 小步骤 1
- 范围：服务端 Provider Adapter 的输入/输出、能力声明、状态、错误、超时、取消、幂等、安全和成本边界
- 前置条件：阶段 1 架构/威胁模型与数据治理基线；阶段 2 服务端基础；阶段 3.1–3.6 认证、授权、任务队列和持久邮件基础能力
- 当前状态（2026-11-09）：本文记录的是阶段 4 小步骤 1 的契约基线；后续已完成小步骤 2–4 与 4.5.1–4.5.3。阶段 4 整体仍未完成，逐步骤状态和最终证据见 `PHASE1-4_ACCEPTANCE_INDEX.md` 与 `DB_SETUP.md`。
- 本文范围限制：本文及 mock Provider 不调用真实供应商、不读取或写入真实供应商凭据、不创建云资源；mock Provider 仅供隔离测试，不接入生产 Worker。真实自定义 Provider Adapter 与生产任务集成尚未开始；整体执行顺序见 `../ImplementationPlan/PAINTTRACK_DEVELOPMENT_PROCESS.md` 第 10 节。

## 1. 目的与结论

本步骤把“供应商适配层”从路线图概念具体化为可审查的服务端契约。契约的目标是让 PaintTrack Worker 能够在不暴露供应商细节的情况下提交、查询、取消和解析生成任务，同时保持 PaintTrack 自己的身份、任务、资产、额度和审计记录为业务权威。

本步骤形成以下设计结论：

1. Provider 只能由服务端 Worker 调用。浏览器、Electron renderer 和客户端页面不得持有或转发长期供应商密钥。
2. Provider 接口使用 PaintTrack 规范化输入和规范化输出；供应商 request ID 只能作为服务端调用记录，不能成为客户端任务 ID。
3. Provider 不决定 PaintTrack 任务终态、用户授权、额度冻结/结算/释放或资产所有权。Worker、任务服务、账务服务和对象存储边界分别负责这些事实。
4. 同步和异步供应商都通过能力声明接入。调用端必须先检查能力，不得假设所有 Provider 都支持查询、取消或同一种媒体类型。
5. 供应商响应、状态、错误、临时 URL 和成本字段都属于不可信外部输入，必须经过 schema 校验、大小限制、超时和脱敏处理。
6. 网络超时和“提交结果未知”不能直接当作提交失败。若供应商支持幂等键或状态查询，必须先查询或按契约恢复；不能盲目重复创建任务。
7. Provider 可以返回供应商成本和用量观测数据，但本阶段不执行扣费，不改变额度账本，也不将供应商成本直接转化为用户收费。

## 2. 当前实现事实与缺口

### 2.1 已存在的服务端基础

`lib/server/worker/index.js` 已提供以下执行边界：

- 领取持久化任务并使用租约；
- 按固定间隔发送心跳；
- 通过 `AbortSignal` 向处理器传递协作取消；
- 检测租约丢失并阻止旧 Worker 完成任务；
- 处理器失败时调用任务队列失败路径；
- Worker 无 Provider 配置时以 `No generation provider is configured` 明确失败。

`lib/server/worker/taskQueue.js` 当前任务状态为 `queued`、`running`、`succeeded` 和 `failed`。领取、心跳、完成、失败和过期恢复由数据库租约与 lease token 保护；队列层尚未定义 Provider 错误分类，也尚未保存 Provider 返回值。

因此，本步骤定义的是下一层 Provider Adapter 契约，不能把现有 Worker 描述为已经完成 Provider 状态持久化、结果归档或供应商级重试。

### 2.2 当前 API 与客户端边界

- `/api/v1` 当前由 fail-closed handler 拒绝未实现的云端路径，不是可用的 Provider proxy。
- 多个 `/api/*` Route Handler 已形成 PaintTrack 自有 API 边界，未来 Provider 调用应由这些服务端路径创建任务并交给 Worker。
- **历史实现记录（2026-11-07）：**`app/agents/[agent_id]/AgentChatClient.js`、`app/agents/create/AgentCreateClient.js` 和 `app/agents/edit/[id]/AgentEditClient.js` 曾存在旧路径：浏览器读取 `muapi_key` cookie，并为内部 axios 请求设置 `x-api-key`。
- 这些旧路径当时是迁移风险；已于 2026-11-09 在阶段 4.5.3 撤除。当前客户端凭据零容忍门禁及范围见第 18 节和 `tests/clientCredentialBoundary.test.js`。新的云端调用必须把供应商密钥留在服务端配置边界内。
- Electron 本地 sd.cpp/Wan2GP 路径属于本地或用户配置的远程能力，必须与云端 Worker、PaintTrack 额度和账务路径分开。

### 2.3 本步骤明确不改变的内容

本步骤不修改现有客户端密钥路径、不启用 `/api/v1`、不改变任务表、不增加供应商密钥、不接入网络服务，也不提前实现任务 API、额度账本、对象存储归档或正式管理员配置。上述内容按阶段 4 后续小步骤及阶段 5–7 的依赖顺序推进。

## 3. 信任边界与职责

```text
PaintTrack API
  负责认证、授权、任务归属、输入校验、幂等任务创建和审计
        |
        v
持久化任务 / 额度协调 / Worker
  负责任务租约、执行时限、重试上限、终态和账务流程编排
        |
        v
Provider Adapter
  负责参数映射、供应商认证封装、submit/query/cancel、响应解析和错误分类
        |
        v
External Provider
  实际生成；所有响应、状态、URL、错误和成本均按不可信输入处理
```

| 组件 | 负责 | 不负责/不得成为权威 |
|---|---|---|
| PaintTrack API | 用户认证、对象授权、规范化请求、任务幂等键、任务归属、审计 | 不把客户端状态、供应商 request ID 或客户端价格作为权威 |
| 任务/额度服务 | 任务状态机、额度冻结/结算/释放、业务重试上限和终态 | 不把 Provider 的成本字段直接当作扣费事实 |
| Worker | 领取任务、租约/心跳、调用 Provider、状态轮询、结果归档编排、失败处置 | 不向客户端暴露密钥；不绕过任务和账务不变量 |
| Provider Adapter | Provider 专属鉴权、参数映射、提交、查询、取消、结果和错误规范化 | 不创建用户、任务所有权、额度账本或长期资产身份 |
| External Provider | 生成或处理供应商侧任务 | 不决定 PaintTrack 用户授权、PaintTrack 任务终态或长期资产归属 |
| Object Storage | 保存经过验证的 PaintTrack 资产字节 | 不使用供应商临时 URL 直接替代内部 asset ID 和授权检查 |
| Electron 本地路径 | 本地推理和本地进度 | 不自动进入云端任务、云端额度或供应商成本结算 |

## 4. Provider 接口形状

以下为逻辑契约。它不是当前代码接口，也不授权本步骤直接实现。

```js
const provider = {
    name: 'provider-name',
    version: 'adapter-version',
    capabilities: {
        modes: ['sync', 'async'],
        mediaTypes: ['image'],
        operations: {
            submit: true,
            query: true,
            cancel: false,
        },
        idempotency: {
            submit: 'provider-key-or-unsupported',
        },
    },
    async submit(request, context) {},
    async query(request, context) {},
    async cancel(request, context) {},
};
```

实现时必须满足：

- Provider 实例由服务端显式注入，不从客户端请求选择任意模块、任意 URL 或任意代码路径。
- `submit`、`query` 和 `cancel` 都接收 `AbortSignal`；不支持的操作必须由能力声明为 `false`，调用后返回固定的 unsupported 结果或抛出可分类错误。
- 所有方法返回有限大小的普通对象，禁止返回带有隐式网络句柄、响应流或未消费的供应商 SDK 对象。
- 方法不得把原始响应、完整请求头、密钥、完整 prompt 或媒体内容写入错误对象、日志或指标标签。
- Provider Adapter 不自行启动后台循环；轮询节奏、总体超时、租约和任务终态由 Worker/任务编排层控制。

## 5. 规范化请求

### 5.1 请求结构

Provider 只接收已经由 PaintTrack 服务端校验并规范化的请求。建议逻辑结构如下：

```js
{
    taskId: 'painttrack-task-id',
    taskType: 'image-generation',
    idempotencyKey: 'painttrack-task-attempt-key',
    input: {
        model: 'approved-model-key',
        prompt: 'validated prompt or provider-specific safe input',
        negativePrompt: null,
        parameters: {},
        inputAssets: [
            {
                assetId: 'painttrack-asset-id',
                mediaType: 'image/png',
                source: 'server-controlled-reference',
            },
        ],
    },
    limits: {
        requestTimeoutMs: 30000,
        totalTimeoutMs: 900000,
        maxOutputBytes: 52428800,
    },
}
```

约束如下：

- `taskId` 是 PaintTrack 内部标识，只供服务端关联，不发送给客户端作为供应商身份。
- `model`、参数、媒体类型、数量、尺寸和时长必须通过 PaintTrack 的允许列表和资源预算校验；Provider 不替代业务层校验。
- 输入资产只能引用已授权的内部 asset ID 或由服务端构造的受控引用。不得接受客户端提供的任意内网地址、任意对象 key 或任意下载 URL。
- `idempotencyKey` 必须由服务端生成或由服务端绑定到用户作用域任务幂等键，不能只相信客户端重复提交的字符串。
- `limits` 是服务端预算，Provider 只能在更严格的供应商限制内执行，不能自行扩大预算。
- 规范化请求不得携带数据库连接串、Provider key、用户会话 token、邮箱或管理员凭据。

### 5.2 输入与供应商参数映射

Provider Adapter 负责把规范化输入映射为供应商请求。映射必须是显式、可版本化和可测试的：

- 未支持的字段应被拒绝或明确忽略并记录固定分类，不得静默改变语义。
- 供应商默认值必须写入 Adapter 版本或能力说明，不从客户端隐藏字段推断。
- 供应商模型名与 PaintTrack 模型键分离，客户端不得直接指定未经批准的供应商模型名。
- 不同 Provider 的尺寸、采样步数、视频帧数、时长、并发和输出格式限制必须在能力声明中表达。

## 6. 规范化输出与结果边界

### 6.1 submit 输出

`submit` 只返回供应商提交事实，不直接改变 PaintTrack 任务状态：

```js
{
    kind: 'accepted' | 'completed' | 'rejected' | 'unknown',
    providerJobId: 'opaque-provider-reference-or-null',
    providerState: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown',
    pollAfterMs: 2000,
    result: null,
    usage: {
        inputUnits: null,
        outputUnits: null,
        providerCostMinorCny: null,
        currency: 'CNY',
    },
    providerMetadata: {},
}
```

- `providerJobId` 是不透明服务端引用，必须按敏感业务元数据处理；默认不返回客户端。
- `kind=unknown` 表示调用结果无法确定，不等于供应商已拒绝，也不等于可以安全重提。
- `pollAfterMs` 必须经过服务端上限裁剪，不能让供应商返回任意长等待或零间隔轮询。
- `result` 仅在供应商同步完成且结果经过解析时出现；异步任务通常为 `null`。
- `usage` 只能作为观测和后续结算输入。当前阶段不执行扣费、不直接写用户余额。

### 6.2 query 输出

`query` 返回供应商状态的规范化表示：

```js
{
    providerJobId: 'opaque-provider-reference',
    state: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'expired' | 'unknown',
    pollAfterMs: 2000,
    result: null,
    failure: null,
    usage: null,
}
```

状态映射规则：

| Provider 规范状态 | 处理含义 | PaintTrack 侧处理原则 |
|---|---|---|
| `queued` | 供应商已接受但未开始 | 保持处理中，按受控间隔查询 |
| `running` | 供应商正在执行 | 保持处理中，执行总体超时预算 |
| `succeeded` | 供应商完成 | 先验证并归档结果，再决定 PaintTrack 成功终态 |
| `failed` | 供应商明确失败 | 按错误分类决定重试或失败释放 |
| `cancelled` | 供应商确认取消 | 按取消语义释放或结算额度，需由业务层确定 |
| `expired` | 供应商任务超时/过期 | 通常按临时或永久失败分类，禁止无限查询 |
| `unknown` | 响应无法映射或状态未知 | 暂不声称成功或失败，进入查询/人工处置边界 |

供应商成功不等于 PaintTrack 资产成功。结果 URL、媒体字节或结果元数据必须经过结果 schema、内容类型、大小、目标地址和归档流程验证；归档失败应保持可解释的中间/失败状态，不直接标记用户可下载。

## 7. 能力声明

Provider 必须声明调用端可以依赖的能力，不支持的能力不能通过运行时猜测。

| 能力维度 | 必须表达的内容 |
|---|---|
| 执行模式 | `sync`、`async` 或两者；同步也必须受请求超时和响应大小限制 |
| 媒体类型 | 支持 image/video/audio 等类型及 MIME、大小和输出限制 |
| 任务操作 | `submit` 必须支持；`query`、`cancel` 可选 |
| 状态查询 | 是否支持按 Provider job ID 查询、最小查询间隔和状态保留时间 |
| 取消 | 是否支持取消、取消是否有确认返回、取消后的结果是否可能迟到 |
| 幂等 | 是否接受供应商侧幂等键、幂等键有效期和重复提交返回语义 |
| 结果形式 | 内联媒体、临时 URL、资产引用或其他形式；最大大小和生命周期 |
| 用量/成本 | 是否返回用量、成本币种、精度和是否为估算值 |
| 限制 | 请求大小、执行时长、并发、速率、模型/参数能力和区域约束 |

Provider 能力声明是 Adapter 的静态配置和版本化输入，不是客户端可修改字段。每次能力变更都应更新契约版本、映射测试和运行说明。

## 8. 错误分类与重试

Provider Adapter 必须把外部异常映射为固定分类和安全的公开代码，禁止把供应商原文直接写入任务、日志或 API 响应。

| 分类 | 典型含义 | 默认是否可重试 | 处理边界 |
|---|---|---:|---|
| `INVALID_REQUEST` | 参数、模型、媒体或响应 schema 不符合契约 | 否 | 修复输入或 Adapter；不重复提交 |
| `AUTH_CONFIGURATION` | Provider key 缺失、失效或配置不一致 | 否 | 告警并阻断该 Provider；不暴露凭据细节 |
| `FORBIDDEN` | 供应商拒绝权限、区域或内容政策 | 通常否 | 记录固定原因分类；不盲目重试 |
| `RATE_LIMITED` | 供应商限流或配额达到 | 是，受限 | 尊重 Retry-After 的安全上限和本地退避；不能无限等待 |
| `TEMPORARY_PROVIDER` | 供应商 5xx、暂时不可用或可恢复错误 | 是，受限 | 使用任务最大尝试次数和退避；不重复扣费 |
| `NETWORK_TIMEOUT` | 连接或读取超时 | 条件性 | 若提交结果未知，先按未知提交处理；不能直接安全重提 |
| `NETWORK_UNAVAILABLE` | DNS、连接、TLS 或网络不可用 | 是，受限 | 仅对明确未发送或可查询的阶段重试 |
| `REMOTE_JOB_NOT_FOUND` | 查询时供应商找不到任务 | 条件性 | 结合提交幂等和时间窗口判断，进入未知/人工处置，不自动无限重建 |
| `CANCEL_UNSUPPORTED` | Provider 不支持取消 | 否 | 由业务层停止后续查询或标记取消请求，不伪称已取消 |
| `CANCEL_REJECTED` | Provider 拒绝取消或状态已完成 | 否/条件性 | 重新查询最终状态，按结果处理 |
| `RESULT_INVALID` | 成功状态但结果 URL/媒体/元数据无效 | 通常否 | 进入结果归档失败处置，禁止向用户发出未验证结果 |
| `PROVIDER_UNKNOWN` | 无法安全归类的外部异常 | 条件性 | 固定错误码、告警和人工复核；不记录原文 |
| `ABORTED` | 由服务端取消或 Worker 停止触发 | 否（本次） | 释放本地调用；是否取消远端任务取决于能力声明 |

“可重试”只表示允许进入有限重试决策，不表示 Adapter 自己无限循环。最终重试次数、退避、额度释放和任务终态由任务编排层决定。当前 `taskQueue.failTask` 只按尝试次数处理通用错误；Provider 错误分类接入时必须单独扩展队列/任务错误字段或等价映射，不能把所有分类压扁成一个供应商错误字符串。

## 9. 超时、取消和未知提交结果

必须区分三个时间边界：

1. **单次 HTTP 请求超时：**限制一次连接、写入或读取，避免连接长期占用。
2. **Provider 总体执行超时：**限制从提交到完成/失败的最长时间，适用于异步查询。
3. **Worker 租约与心跳：**保护任务领取者，不等于 Provider 请求超时。Provider 调用必须服从 Worker 的取消信号和租约状态。

取消语义：

- Worker 通过 `AbortSignal` 发出协作取消；Provider Adapter 必须在网络请求和轮询等待处检查信号。
- Abort 只保证本地调用停止，不自动证明供应商侧任务已经取消。
- 如果能力声明支持 `cancel`，Worker 可以在适当阶段调用并查询确认；如果不支持，必须停止继续轮询并进入明确的业务处置路径。
- Provider 可能在取消后迟到返回成功；迟到结果必须通过任务版本/调用状态和资产归属校验，不能无条件写入已终止任务。

未知提交结果：

- 如果请求在发送前确定失败，可以按未提交处理。
- 如果发送后在收到响应前超时、断链或进程崩溃，状态为 `unknown`，不能直接再次提交。
- 有 Provider 幂等键时，使用同一幂等键恢复提交或查询；不得为同一逻辑尝试生成新的键并创建第二个任务。
- 无 Provider 幂等或查询能力时，必须进入可观测的人工处置/风险边界；不能声称 exactly-once，也不能把未知状态直接计为失败后再次扣费或提交。

## 10. 幂等、重复提交与并发

需要分开管理三层幂等：

| 层级 | 依据 | 目标 |
|---|---|---|
| PaintTrack 任务 | 用户作用域任务幂等键 + 数据库唯一约束 | 重复 API 请求返回同一任务或确定性冲突，不产生第二次额度冻结 |
| Provider 调用尝试 | 任务 ID + 逻辑尝试号 + Provider 幂等键 | Worker 重启或网络重试不重复创建不可控供应商任务 |
| 结果归档/结算 | 内部 task/asset/call 唯一约束和状态机 | 迟到结果、重复回调或重复 Worker 不重复建资产、结算或释放 |

Provider Adapter 不得只使用客户端传来的幂等键，也不得把供应商 job ID 当作 PaintTrack 任务主键。重复 `submit` 的处理必须依据 Provider 能力：

- 支持幂等：复用同一键并接受同一任务的已有结果；
- 支持查询但不支持幂等：保存提交调用记录，未知结果先查询；
- 两者都不支持：限制自动重试并把未知提交暴露为运维处置状态；
- 任何情况下都不允许通过“换一个新 request ID”掩盖未知结果。

## 11. 结果 URL、媒体和 SSRF 边界

供应商返回的 URL 和媒体元数据是不可信输入。后续实现至少必须满足：

- 结果 URL 只能由固定 Provider Adapter 使用，不能提供面向用户的通用 URL 代理。
- 目标协议、主机、端口、DNS 解析结果、重定向次数、响应大小、连接/读取超时和内容类型必须受限。
- 必须拒绝 loopback、私网、链路本地、云元数据和其他禁止目标；DNS 重绑定和 IPv4/IPv6 表示需要纳入验证测试。
- 不能仅根据 URL 后缀判断媒体类型；需要检查响应头、大小和必要的媒体解码/魔数验证。
- 结果下载必须使用服务端控制的网络客户端，禁止让供应商响应直接驱动任意服务端请求。
- 供应商临时 URL 只用于受控抓取，不是长期 asset 身份，不直接发送给客户端作为永久下载地址。
- 归档到私有对象存储后，客户端只获得 PaintTrack `asset_id` 和经过授权的短时下载能力。

**实现状态（2026-11-13）**：上述要求已由 `lib/server/providers/resultFetcher.js` 落地——协议/主机/端口/DNS 结果/重定向/响应大小/空闲超时/内容类型全部受限，loopback 与私网、链路本地、CGNAT、云元数据地址拒绝（含 IPv4 映射 IPv6），DNS 只解析一次并把连接钉在已验证 IP 上（消除重绑定窗口），逐跳重定向重新校验，抓取失败不把外部 URL 暴露给客户端，归档后只返回 `/api/assets/:id/content`。**未满足项**：`Content-Type` 之外的媒体解码/魔数验证未做。详见 `PHASE4_4.3.1_RESULT_FETCH_SSRF.md`。

## 12. 凭据、日志和隐私

- Provider key 只从服务端运行时秘密配置读取，不能进入浏览器 bundle、Cookie、localStorage、Electron renderer、数据库业务 payload、命令行参数或公开错误响应。
- Provider Adapter 的日志采用 allowlist：内部 task ID、provider 名称、adapter 版本、固定错误分类、耗时、尝试号和低基数状态；不记录 key、Authorization header、完整请求/响应体、完整 prompt、媒体内容或临时 URL。
- provider job ID 只保存于受保护的服务端调用记录；日志和指标默认使用内部调用记录 ID或聚合计数，避免把供应商引用暴露到客户端或高基数指标标签。
- 供应商错误原文只可在受控、脱敏的故障诊断边界暂存；默认任务/API/日志使用固定错误码和安全消息。
- 供应商成本和用量可以作为服务端观测字段保存，需注明币种、精度、估算/实际性质和 Adapter 版本；本阶段不执行用户扣费、余额更新或账本写入。
- 用户内容是否传给 Provider、保存多久、是否用于训练、供应商区域和子处理方需要在真实接入前完成合同/政策审查；未确认前不得把工程假设当作产品承诺。

## 13. 与后续阶段的依赖

| 后续步骤 | Provider 契约提供的输入 | 后续步骤必须补充的内容 |
|---|---|---|
| 阶段 4.2 mock Provider | 状态、能力、错误和幂等模型 | 可控故障、异步轮询、未知提交和结果 fixture |
| 阶段 4.3 MuAPI Adapter | submit/query/cancel 映射和服务端密钥边界 | MuAPI 实际 API、凭据注入、沙箱/预算和兼容测试 |
| 阶段 4.4 结果与失败处理 | 结果 schema、URL/SSRF和错误分类 | 真实响应验证、临时 URL 抓取和归档策略 |
| 阶段 5 任务 API/状态恢复 | PaintTrack 状态与 Provider 状态分离 | 任务状态机、租约恢复、用户查询、取消接口和迟到结果处理 |
| 阶段 6 额度账本 | usage/cost 仅作为输入观测 | 计价版本、冻结/结算/释放、对账和管理员充值 |
| 阶段 7 对象存储 | 结果归档安全边界 | 上传、归档、私有下载、生命周期和删除 |
| 阶段 8 管理后台 | provider 健康/成本观测边界 | MFA、敏感操作、配置审计和管理员 UI |

## 14. 验收标准

### 14.1 本步骤应通过的设计检查

- [x] 明确 Provider、Worker、PaintTrack API、账务、对象存储和外部供应商的职责边界。
- [x] 定义规范化请求、submit/query/cancel 逻辑接口和规范化输出。
- [x] 定义同步/异步、媒体类型、查询、取消、幂等、结果和成本能力声明。
- [x] 定义供应商状态与 PaintTrack 状态的分离及状态映射原则。
- [x] 定义固定错误分类、重试资格和未知提交结果处理。
- [x] 区分请求超时、总体执行超时、Worker 租约和协作取消。
- [x] 定义任务幂等、Provider 调用幂等和结果归档幂等的三层边界。
- [x] 定义结果 URL 验证、临时 URL 生命周期和 SSRF 防护要求。
- [x] 定义服务端密钥、日志脱敏、供应商成本观测和本阶段不扣费边界。
- [x] 记录旧客户端 `muapi_key`/`x-api-key` 路径为迁移风险，不将其作为新契约。

### 14.2 本步骤未验证且不得宣称完成的内容

- **本契约步骤的历史限制（2026-11-07）：**当时未调用真实供应商，未验证 MuAPI 实际字段、状态、错误和幂等语义；未接入真实密钥、Secret Manager、供应商沙箱或云资源。
- **截至 2026-11-09 的阶段现状：**mock Provider、错误决策、结果输入边界、Provider 调用账本和客户端凭据撤除已完成；但真实 Provider Adapter、Provider 与任务队列的生产映射/集成、真实结果归档仍未实现。
- 尚未完成 SSRF 动态测试、真实供应商响应/超时测试、DNS 重绑定测试或成本对账测试。
- 客户端密钥路径原先未改变；已在阶段 4.5.3 撤除，详见第 18 节。此处描述的是本步骤设计时点，不是当前实现状态。

## 15. 步骤记录

- **步骤编号与名称：**阶段 4 小步骤 1，Provider 契约与供应商边界审查。
- **目标与范围：**形成服务端 Provider Adapter 的可审查契约，覆盖输入/输出、能力、状态、错误、超时、取消、幂等、结果 URL、密钥、日志和成本边界。
- **前置条件：**阶段 1 架构与威胁模型、数据治理基线，阶段 2 服务端/Worker 基础，阶段 3.1–3.6 认证与持久基础能力已完成。
- **修改文件/模块：**新增本报告；未修改业务源码、配置、依赖、迁移、子模块、凭据或云资源。
- **文档检查：**已核对现有 Worker、任务队列、API fail-closed 边界、旧客户端供应商 key 路径、阶段流程文档、DB_SETUP 和数据治理基线；本报告章节层级和代码围栏已闭合。
- **功能测试：**未运行业务测试；本步骤只新增设计文档，不改变程序行为。
- **安全检查：**完成设计层服务边界、SSRF、密钥、日志、重放、未知提交和成本风险映射；未执行动态安全测试。
- **Git 工作区检查：**开始前检查分支和状态，当前分支为 `my-work`；工作区存在大量既有未提交改动，本步骤未覆盖、回滚、清理或提交这些改动。
- **未验证项/风险：**真实供应商协议、供应商幂等能力、状态保留、错误语义、成本口径、对象存储归档和生产网络控制均待后续阶段确认。
- **验收结论（本步骤，2026-11-07）：**设计文档交付；此记录仅描述当时步骤门禁，不代表阶段 4 当前状态。
- **用户确认记录：**后续工作已获明确继续授权；阶段当前状态见第 17 节及 `PHASE1-4_ACCEPTANCE_INDEX.md`。

## 16. 阶段 4 小步骤 2：隔离 mock Provider 记录

在用户明确授权继续后，新增 `lib/server/providers/mockProvider.js` 和 `tests/mockProvider.test.js`。mock Provider 采用纯内存状态，不访问网络、不读取凭据、不写数据库，并且没有接入生产 Worker 入口。

当前验证覆盖：

- 能力声明包含同步/异步模式、image/video 类型、submit/query/cancel 和 Provider 幂等能力；
- 同步任务直接完成并返回受控合成结果；
- 异步任务经历 queued → running → succeeded 状态；
- 相同幂等键重复提交不创建第二个 mock job；
- 支持取消、取消不支持和已完成任务拒绝取消；
- 可注入固定错误分类并验证可重试属性；
- 未知提交第一次返回 `unknown`，复用同一幂等键可恢复真实 Provider job ID；
- `AbortSignal` 取消和非法请求被转换为固定 Provider 错误。

验证结果：`node --check` 通过；`node --test tests/mockProvider.test.js` 为 **5/5 passed，0 failed**。本步骤仍未实现真实 Provider、任务队列错误映射、结果归档、SSRF 动态验证或成本结算。

## 17. 阶段状态与门禁

本节原始内容「阶段 4 小步骤 2 完成后暂停等待用户验收」是 2026-11-07 的历史门禁，已被后续明确授权和实施记录取代，不再代表当前状态。

截至 2026-11-09：

- 已完成：Provider 契约、纯内存 mock、Provider 错误决策、结果输入边界、`provider_calls` 调用账本及其真实 PostgreSQL 隔离验收；客户端凭据门禁、服务端配置读取入口和浏览器凭据/直连路径撤除也已完成。
- 尚未完成：用户确认的自定义 Provider Adapter 与真实供应商协议验证；多 Provider 实例和模型路由；Provider 与阶段 5 任务 API/Worker 的集成；真实结果抓取、动态 SSRF/DNS 重绑定测试、阶段 7 对象存储归档及阶段 6 成本/用户账务对账。MuAPI 不再是默认 Provider 目标。
- 当前方案不允许恢复浏览器持有供应商凭据。未配置服务端 Provider 时，只有生成调用 fail-closed；Studio 工作区与导航仍可访问。早期以整个 `/studio`、`/workflow` 显示 Provider 占位页的实现已于 2026-11-09 移除，不作为当前 UI 状态。恢复生成能力必须由服务端任务路径提供。
- 所有真实供应商调用、凭据、成本、云资源和生产数据变更仍须单独评估并获明确授权。

阶段级细项、报告路径和“隔离验收不等于生产验收”的证据边界见 `PHASE1-4_ACCEPTANCE_INDEX.md`。

## 18. 后续补充记录：阶段 4.5.3 客户端凭据撤除（2026-11-09）

本节补充记录本契约第 12 节（凭据、日志和隐私）在客户端侧的执行结果。契约要求「供应商密钥只留在服务端」，4.5.3 之前仓库仍保留上游 BYO-key 路径（浏览器 `localStorage`/cookie 持有密钥并请求供应商或同源代理），属于对第 12 节的实际违反。

已完成撤除：

- 删除密钥输入弹窗 `components/ApiKeyModal.js`；`AuthModal`/`SettingsModal` 改为纯提示与只读状态。
- `components/StandaloneShell.js` 移除本地存储键、localStorage 读取、cookie 写入、axios 密钥注入拦截器与余额轮询，挂载时显式清空状态。
- `src/lib/muapi.js` 改为 fail-closed 桩（保留签名，全部抛 `ProviderUnavailableError`）；共享 SDK `packages/studio/src/muapi.js` 移除全部密钥请求头并把 `BASE_URL` 固定为同源 `/api`；`utils/generationLifecycle.js` 轮询不再附带密钥头。
- 旧版 `{Image,Video,Cinema,LipSync}Studio`、`UploadPicker`、`app/agents/*` 三个客户端组件不再读取或注入凭据，统一通过 `src/lib/providerAvailability.js` 的 `isClientProviderConfigured()`（恒 false）fail-closed。
- 删除 `src/lib/i18n.js` 中「密钥只发往 api.muapi.ai」的承诺文案与 MCP 示例里的 `Bearer YOUR_KEY`；删除 `uploadProxyTarget.getApiKeyFromRequest`。

门禁同步收紧：`tests/clientCredentialBoundary.test.js` 扫描根目录增加 `packages/studio/src`（此前遗漏的共享 SDK 盲区），受管模式增加 `__MUAPI_KEY__`，允许清单 `entries` 清空即零容忍，并新增「第一方客户端零命中」与「SDK `BASE_URL` 必须同源」两条断言。验证：`npm test` 222 项 / 220 通过 / 0 失败 / 2 跳过，`npm run lint` 0 error / 11 warning。

**未改变契约的边界**：Provider 仍只能由服务端 Worker 调用；本步骤没有接入真实供应商、没有写入凭据、没有创建云资源，也没有实现真实自定义 API Adapter。Provider 未配置时生成能力 fail-closed；Studio 工作区仍可访问。早期整页 Provider 占位 UI 已于 2026-11-09 移除，恢复生成能力必须来自服务端适配器与任务接口。
