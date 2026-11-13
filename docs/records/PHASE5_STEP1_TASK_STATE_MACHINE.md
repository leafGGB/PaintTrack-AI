# 阶段 5 小步骤 1：任务状态机与合法转换

- 日期：2026-11-09
- 项目：PaintTrack
- 步骤：阶段 5 小步骤 1
- 范围：任务状态集合语义、合法转换、终态规则、失败/租约超时规则、取消路径、与 Provider 调用账本的边界
- 前置条件：阶段 2 任务表与 Worker 租约、阶段 3 身份与授权、阶段 4 Provider 契约与 `provider_calls` 账本已完成隔离验收
- 当前状态：设计 + 纯函数模块 + 迁移 0012 已落地；本步骤不实现任务创建 API、不接真实 Provider、不接额度账本

## 1. 目的与结论

本步骤把「任务状态」从散落在 SQL 与 Worker 里的隐含约定，收敛成单一、可测试的定义。核心结论：

1. 任务状态是**用户可见的权威**，Provider 状态只服务内部调用恢复，两者不共用一套枚举。
2. 任务状态集合固定为 `queued`、`running`、`succeeded`、`failed`、`cancelled` 五态；后三者为终态。
3. 终态**不可再变**：重复写入同一终态按幂等成功处理；写入另一个终态属于冲突（典型为取消后供应商结果迟到），必须拒绝并保留原终态。
4. 失败与租约过期的去留由 `attempts` 与 `max_attempts` 决定，不由错误文本或调用方猜测决定。
5. 取消不是一次 UPDATE：未领取可立即取消；执行中必须由持有租约的执行方协作停止后才能写 `cancelled`。
6. 不引入 `cancelling` 状态。取消意图与任务状态分离，避免出现「数据库显示正在取消、但没有任何执行方在推进」的伪状态。

## 2. 状态语义

| 状态 | 含义 | 终态 | 租约要求 |
| --- | --- | --- | --- |
| `queued` | 等待被 Worker 领取；包含首次入队与失败后重新入队 | 否 | 租约三列为 NULL |
| `running` | 已被某个 Worker 领取并持有租约 | 否 | `lease_token` 与 `lease_expires_at` 必须非空 |
| `succeeded` | 生成成功且结果已通过边界校验 | 是 | 租约三列为 NULL，`completed_at` 已写 |
| `failed` | 不可重试，或已达最大尝试次数 | 是 | 同上 |
| `cancelled` | 用户取消已被执行方确认，或未领取前直接取消 | 是 | 同上 |

`queued` 刻意不区分「首次入队」和「重试入队」：两者对用户和 Worker 的语义相同，重试次数由 `attempts` 表达，另立 `retrying` 状态只会增加状态迁移面而没有额外信息。

## 3. 合法转换表

| 从 | 到 | 触发者 | 持久化条件 |
| --- | --- | --- | --- |
| `queued` | `running` | Worker | `FOR UPDATE SKIP LOCKED` 选中，`attempts` 自增，写入新租约 |
| `queued` | `cancelled` | 任务 API（阶段 5.4） | 记录取消请求方与时间，终态写入 |
| `running` | `queued` | Worker 失败路径 / 租约恢复 | 仍持有有效租约（失败路径），或租约已过期（恢复路径） |
| `running` | `succeeded` | Worker | 持有有效租约 + `resolveTransition` 返回 `apply` |
| `running` | `failed` | Worker | 持有有效租约，且 `attempts >= max_attempts` |
| `running` | `cancelled` | Worker 协作停止 | 持有有效租约 + 取消已被确认 |

终态没有任何出边。非法组合（如 `queued → succeeded`、`queued → failed`）一律拒绝，不允许「跳过执行直接成功」或「没被领取就失败」。

## 4. 终态冲突与幂等

`resolveTransition(from, to)` 返回三种动作，供 API 与 Worker 在写库前判断：

| 情形 | 动作 | 处理 |
| --- | --- | --- |
| 合法非终态转换 | `apply` | 执行带条件的 UPDATE |
| 同一终态重复写入 | `noop` | 返回当前记录，视为幂等成功，不重复产生副作用 |
| 终态写入另一个终态 | `conflict` | 拒绝写入，保留原终态 |
| 其它非法组合 | 抛 `ILLEGAL_TRANSITION` | 调用方转 4xx 或失败路径 |

`conflict` 的典型场景是「用户已取消，供应商结果随后返回」。此时**不得**把 `cancelled` 覆盖成 `succeeded`，否则会对一个已释放额度的任务生成资产并可能重复计费。`noop` 的典型场景是 Worker 在提交完成结果后进程重启并重放同一次完成写入。

## 5. 失败、重试与租约超时

- 领取时 `attempts = attempts + 1`，因此 `attempts < max_attempts` 表示「还有下一次机会」。
- `nextStatusAfterFailure` 与现有 `failTask` 的 SQL 语义一致：还有机会回 `queued`（写入退避 `available_at`），否则写 `failed` 并落 `completed_at`。
- 租约过期只对 `running` 有意义：`isLeaseExpired` 对非 `running` 返回 `false`；`running` 却缺少租约视为 `LEASE_INCONSISTENT`，属于数据不一致而非可恢复状态。
- `attempts > max_attempts` 视为数据被破坏，抛 `RangeError`，不静默按失败处理。
- 重试上限由 `max_attempts` 保证，不做无限重试；退避时长由调用方按 Provider 错误分类传入，本步骤不定义具体秒数。

## 6. 取消路径

| 当前状态 | 路径 | 说明 |
| --- | --- | --- |
| `queued` | `immediate` | 未领取，可直接写 `cancelled` |
| `running` | `cooperative` | 通过 `AbortSignal` 通知执行方；只有执行方确认停止后才写 `cancelled` |
| 终态 | `null` | 不可取消；重复取消按 `noop` 或 `conflict` 处理 |

执行中的任务若供应商不支持取消，任务仍可由执行方在停止轮询后写 `cancelled`，但**供应商侧任务可能继续运行并产生成本**。这一成本边界必须在阶段 6 额度结算和阶段 5.4 取消 API 中显式处理，不能由状态机掩盖。

不设 `cancelling` 的理由：它需要额外的超时与补偿规则，而在当前架构下「取消请求」本身是一条可持久化的意图（例如 `cancel_requested_at`），状态仍如实反映执行方是否真的停止。该字段与取消 API 在阶段 5.4 实现。

## 7. 与 Provider 调用账本的边界

任务状态与 `provider_calls.status` 是两套独立状态，禁止互相直接赋值：

| `provider_calls.status` | 允许的任务侧动作 |
| --- | --- |
| `submitting` | 任务保持 `running`；崩溃后由租约恢复重新领取，不写失败 |
| `unknown` | 任务保持 `running`；必须先复用同一幂等键查询或恢复，不得盲目重提 |
| `accepted` | 任务保持 `running`；继续轮询，不因「还没结果」写超时失败 |
| `succeeded` | 结果通过 `resultBoundary` 校验后，任务 `running → succeeded` |
| `failed` | 按错误分类与 `attempts` 决定 `running → queued` 或 `running → failed` |
| `cancelled` | 仅当任务已进入取消路径时，任务 `running → cancelled` |

「Provider 失败一次」不等于「任务失败」；「Provider 已受理」也不等于「任务成功」。任务终态只在结果校验完成或重试上限耗尽时写入。

## 8. 实现与迁移

新增 `lib/server/worker/taskStateMachine.js`（纯函数，无数据库依赖）：

- `TASK_STATUS`、`TERMINAL_STATUSES`、`ALLOWED_TRANSITIONS`
- `isTaskStatus`、`isTerminalStatus`、`canTransition`、`assertTransition`
- `resolveTransition` → `apply` / `noop` / `conflict`
- `nextStatusAfterFailure`、`isLeaseExpired`、`cancelPathFor`
- 固定错误码 `UNKNOWN_STATUS`、`ILLEGAL_TRANSITION`、`LEASE_INCONSISTENT`

`lib/server/worker/taskQueue.js` 改为复用该模块的 `TASK_STATUS`，消除两处枚举漂移。

迁移 `drizzle/0012_task_cancellation.sql` 扩展 `generation_tasks_status_check`，纳入 `cancelled`；快照 `drizzle/meta/0012_snapshot.json` 与 journal 同步。该迁移为约束替换，不改列、不迁移数据。

## 9. 验证

| 项目 | 结果 |
| --- | --- |
| `node --test tests/taskStateMachine.test.js` | 9/9 通过 |
| 全量 `npm test` | 231 项 / 229 通过 / 0 失败 / 2 跳过 |
| `npm run lint` | 0 error / 11 warning（与基线一致） |
| `npx drizzle-kit check` | `Everything's fine` |
| 真实 PostgreSQL 隔离验收 | `.workbuddy/database-acceptance-mw8nywgz_579cad.json`，`passed`，71 项检查 / 67 passed / 0 failed |

真实 PostgreSQL 隔离验收新增两项针对性检查：「`generation_tasks` 接受 `cancelled` 终态写入」（SAVEPOINT 内正向探测后回滚，避免把 `cancelled → queued` 这种业务非法转换留在夹具里）与「`cancelling` 仍被约束拒绝」（CHECK 负例由 11 项增至 12 项）；「全部迁移表列/主键/CHECK/索引与最新 snapshot」同时通过，说明约束名与定义均与快照一致，而不只是名字对得上。


测试覆盖：状态集合与终态、转换表完整性与终态无出边、非法转换错误码、终态幂等与冲突、重试边界、租约过期与不一致、取消路径，以及「schema、最新 snapshot、迁移文件三者与状态机同步」的漂移守卫。

## 10. 本步骤不做

- 不实现任务创建/查询/取消 API（阶段 5.2、5.4）。
- 不新增 `owner_id`、幂等键、`cancel_requested_at` 等列（随对应小步骤的迁移加入）。
- 不接真实 Provider、不接额度账本、不实现结果归档。
- 不改变 Worker 现有领取/心跳/完成/失败 SQL 的行为；`cancelled` 的写入路径随 5.4 实现。

## 11. 验收门禁

- 状态转换表完整，终态无出边；
- 非法转换有固定错误码，不静默通过；
- 重复终态与冲突终态语义明确，可通过纯函数判定；
- 重试、租约超时、取消路径与现有 `taskQueue`、`provider_calls` 语义不冲突；
- 数据库约束与状态机一致，迁移可从空库重放；
- 未引入额度扣费或真实供应商调用。
