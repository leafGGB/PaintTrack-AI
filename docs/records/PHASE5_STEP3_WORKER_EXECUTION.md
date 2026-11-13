# 阶段 5.3：Worker 领取、租约、执行、心跳、重试与崩溃恢复

> 状态：已完成（2026-11-09），等待用户验收。真实 Provider 仍未接入，本步骤只使用 mock Provider。

## 1. 范围

本步骤把「领取到任务」推进到「供应商调用 + 任务终态」，并补齐崩溃恢复语义：

- 新增执行器 `lib/server/worker/taskExecutor.js`：提交、受理、轮询、终态落库；
- 新增 `lib/server/providers/providerRegistry.js`：Worker 进程的 Provider 选择，未配置即 fail-closed；
- `taskQueue` 增加结果描述符写入与 `terminal` 失败语义；
- `provider_calls` 账本增加「受理但保留租约」「轮询心跳」「退避释放」三个转换；
- 迁移 `0014_generation_task_result.sql`：`generation_tasks.result` 与两条约束。

本步骤**不**做：任务查询/详情/取消接口（5.4）、真实自定义 Provider 接入、结果文件下载与对象存储归档、额度扣减、限流与并发上限。整体后续顺序见 `../ImplementationPlan/PAINTTRACK_DEVELOPMENT_PROCESS.md` 第 10 节。

## 2. 组件与职责

| 组件 | 职责 | 不负责 |
| --- | --- | --- |
| `worker/index.js` | 领取节奏、任务租约心跳、停机、把处理器结果转成 `completeTask`/`failTask` | 供应商协议 |
| `taskExecutor.js` | 单次领取的执行语义：提交、轮询、错误分类、终态事务 | 调度、进程管理、计费 |
| `taskQueue.js` | 任务状态与租约的条件写入（fencing） | 供应商状态 |
| `providerCallLedger.js` | 调用记录状态机与调用租约 | 任务状态 |
| `providerRegistry.js` | 同步仅选择非生产 mock；真实 Provider 通过可信绑定与显式 resolver 构造 | 从环境变量读取 Provider 凭据（已退役） |

## 3. 执行流程

```text
Worker 领取任务（attempts+1，任务租约）
  ↓
按 taskId 找可恢复的调用记录
  ├─ 找到（submitting / unknown / accepted）→ 接管调用租约，继续该轮次
  ├─ 没找到但仍存在未终结调用（租约在别人手上）→ 退避重试，不新建提交
  └─ 都没有 → beginProviderCall(attempt_no = attempts)
  ↓
submit（幂等键 = pt_<taskId>_<attempt_no>）
  ├─ completed → 补登 provider_job_id → 调用 succeeded + 任务 succeeded(result)（同一事务）
  ├─ accepted  → 保持调用租约 → 轮询
  └─ unknown   → 调用停在 unknown，退避后用同一把键重提
  ↓
轮询：每次先续调用租约，再 query
  ├─ succeeded → 同一事务结算调用与任务
  ├─ failed / expired / cancelled → 调用终态，任务失败
  └─ 超过轮询上限 → 调用保留 accepted 但释放租约并退避，任务回队列
```

## 4. 状态映射

| 任务状态 | 允许的调用记录状态 | 说明 |
| --- | --- | --- |
| `queued` | 无记录 / `unknown`（待重提）/ `accepted`（待轮询）/ `failed`（上一轮次） | 领取后一定进入 `running` |
| `running` | `submitting`、`unknown`、`accepted` | 持有任务租约的一方是唯一写入者 |
| `succeeded` | `succeeded` | 两者同一事务提交，不存在中间态 |
| `failed` | `failed`、`cancelled` | 终态失败不回队列 |
| `cancelled` | `cancelled` | 取消入口属 5.4，本步骤不写入 |

任务侧 `attempts` 表示**领取次数**（含恢复重领），调用侧 `attempt_no` 表示**供应商提交轮次**。恢复会复用同一提交轮次，因此两者可能不相等；这一点是有意设计，避免同一次提交被重复发起。

## 5. 失败决策

| `mapProviderError` 结果 | 调用记录 | 任务 | 说明 |
| --- | --- | --- | --- |
| `retry` | `failed`（终态） | 回队列 + 退避 | 下一轮领取会开新提交轮次 |
| `fail` | `failed`（终态） | 立即 `failed`（`terminal`） | 不浪费剩余重试次数 |
| `unknown_submission` | `unknown`（保留幂等键） | 回队列 + 退避 | 恢复时用同一把键重提 |
| 查询可重试失败 | 保留 `accepted`，释放租约并退避 | 回队列 + 退避 | 不丢掉 `provider_job_id` |
| 查询不可重试失败 | `failed`（终态） | 立即 `failed` | — |
| 轮询超限 | 保留 `accepted`，释放租约并退避 | 回队列 + 退避 | 由下一轮领取继续轮询 |

`terminal` 是 `failTask` 的新选项：`true` 时无论剩余重试次数都直接进入 `failed`，并写 `completed_at`。

## 6. 崩溃恢复

| 崩溃点 | 残留状态 | 恢复行为 |
| --- | --- | --- |
| 领取后、提交前 | 任务 `running` + 租约过期；无调用记录 | 租约过期回收 → 再次领取 → 新建调用 |
| 提交途中 | 任务 `running`；调用 `submitting` | 调用租约过期后可接管，用同一把幂等键重提 |
| 提交结果不明 | 调用 `unknown` | 接管后用同一把键重提，供应商去重 |
| 受理后、轮询中 | 调用 `accepted` + `provider_job_id` | 接管后继续轮询，不重新提交 |
| 结算瞬间 | 无残留 | 调用成功与任务成功在同一事务，整体提交或整体回滚 |

**在途保护**：如果任务被重新领取，但该任务仍有未终结的调用且调用租约被上一个 Worker 持有，执行器不会新建提交，而是退避重试。代价是这次领取会消耗一次任务尝试；收益是绝不重复提交。

## 7. Provider 选择

直接 Worker CLI 的 `PAINTTRACK_WORKER_PROVIDER` 契约（2026-11-12 更新）：

| 值 | 行为 |
| --- | --- |
| 未设置 / 空 / `none` | `PROVIDER_NOT_CONFIGURED`，Worker 拒绝启动，任务留在队列 |
| `mock` | 使用内存 mock；`NODE_ENV=production` 时以 `PROVIDER_MODE_FORBIDDEN` 拒绝启动 |
| 所有非 mock | `WORKER_TRUSTED_BOOTSTRAP_REQUIRED`，在 Provider 解析和建池前拒绝 |

兼容同步导出 `resolveWorkerProvider()` 保留 mock、未配置和未知模式的拒绝契约；旧 `myvigna-image` 分支固定返回 `PROVIDER_ENV_CREDENTIAL_RETIRED`，不读取 Provider 名称、凭据、Base URL 或上游模型环境变量，不构造 Adapter。`providerConfig` 两个兼容入口也固定退役，配置旧环境变量无法恢复调用。真实 Provider 通过可信宿主调用 `bootstrapWorker`，显式提供 descriptor、approvedBindings 和 secretResolver；当前生产宿主与正式秘密后端仍未接线，不能直接照旧 env 指引启动。

Worker 拒绝启动是刻意的：先领取再因为"不会调用"把用户任务烧成失败，比不启动更糟。

## 8. 结果描述符

`generation_tasks.result` 只在 `succeeded` 时写入，内容是可审计摘要：

```json
{ "kind": "mock-asset", "mediaType": "image/png", "sizeBytes": null,
  "resultUrl": null, "archive": "not_configured", "provider": "mock-provider" }
```

- 不写入生成内容本身（mock 的 `content` 字段被丢弃，验收有专门断言）；
- `archive: "not_configured"` 明确表示**文件尚未归档**，真实对象存储接入前不得把它读成"结果已落盘"。**2026-11-13 起**：配置了对象存储时归档成功会写 `archive: "ready"`、`assetId` 与 `/api/assets/:id/content`（见第 11 节第 2 条与 `DB_SETUP.md` 阶段 5.5）；未配置存储时仍是 `not_configured`；
- 数据库约束：`(status = 'succeeded') = (result IS NOT NULL)`，且 `result` 必须是 JSON 对象。

## 9. 验证

| 项目 | 结果 |
| --- | --- |
| 执行器单元测试 | `tests/taskExecutor.test.js` 9/9 |
| Worker 契约测试 | `tests/worker.test.js` 新增 3 项（已终结不重复写、失败元数据、默认描述符） |
| Provider 选择测试 | `tests/providerRegistry.test.js` 5/5 |
| 全量 `npm test` | 267 项 / 265 通过 / 0 失败 / 2 跳过 |
| `npm run lint` | 0 error / 11 warning（与基线一致） |
| `drizzle-kit check` | `Everything's fine` |
| 真实 PostgreSQL 隔离验收 | `passed`，79 项检查 / 75 passed / 0 failed |

真实库验收覆盖 6 个执行器场景：同步成功、异步受理、未知提交恢复、可重试失败、终态失败、租约丢失回滚；并新增 `generation_tasks` 结果约束的正负例（成功可写描述符、成功缺结果被拒、CHECK 负例增至 15 项）。

## 10. 验收报告

- 最终报告：`.workbuddy/database-acceptance-mw8oy85s_2ec1e9.json`（`passed`，79 项 / 75 passed / 0 failed）。
- 过程报告保留为缺陷证据：
  - `.workbuddy/database-acceptance-mw8ovf2z_7451be.json`：同步完成未写 `provider_job_id`，触发「成功必须有任务号」约束 → 修正为在同一事务内先 accepted 再 succeeded；
  - `.workbuddy/database-acceptance-mw8oxgje_134684.json`：旧验收探针调用 `completeTask` 未传结果描述符，暴露 5.2 时代调用点未同步。


## 11. 已知限制

1. **真实 Provider 未接入**：只有 mock，`providerRegistry` 明确拒绝未知模式；用户确认的自定义 Provider Adapter 尚未实施，按主路线阶段 4 处理。
2. **结果归档**（原文为"未归档"，现状见下）：本步骤完成时 `archive` 恒为 `not_configured`，没有对象存储写入、下载授权或结果 URL 抓取。**2026-11-13 已由阶段 5.5 与 4.3.1 补齐**：配置对象存储后 Worker 走列级 `pending → ready` 归档并把 `resultUrl` 改写为 `/api/assets/:id/content`，`archive` 变为 `ready`；结果 URL 抓取与 SSRF 门禁见 `PHASE4_4.3.1_RESULT_FETCH_SSRF.md`，权限与授权读取见 `DB_SETUP.md` 阶段 5.5。仍未做：资产生命周期删除、生产对象存储、magic byte 校验。
3. **取消未实现**：供应商侧 `cancelled` 会被记为任务失败（`PROVIDER_CANCELLED`）；用户主动取消走 5.4 的协作取消。
4. **在途保护会消耗一次尝试**：极端情况下（任务租约丢失但调用租约仍在），等待调用租约过期会消耗一次领取尝试。
5. **无并发上限与限流**：单 Worker 串行处理，多 Worker 并发额度、用户级并发上限和供应商成本控制未实现。
6. **轮询在进程内**：没有独立的轮询调度器；进程重启后靠 `accepted` 记录的恢复领取继续。
