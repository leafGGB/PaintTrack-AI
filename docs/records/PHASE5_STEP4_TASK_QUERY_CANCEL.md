# 阶段 5.4：任务列表、详情与取消

> 状态：已完成（2026-11-09），等待用户验收。本步骤只做服务端接口与协作取消语义；前端轮询作为 5.4 后续小步，待确定交互载体后接。

## 1. 范围

- `GET /api/tasks`：当前用户的任务列表，keyset 分页；
- `GET /api/tasks/:taskId`：任务详情，严格按 owner 隔离；
- `POST /api/tasks/:taskId/cancel`：取消任务（排队中立即取消 / 运行中协作取消）；
- 迁移 `0015_task_cancel_request.sql`：`generation_tasks.cancel_requested_at` 与一致性 CHECK；
- Web 运行角色获得**列级** UPDATE：只能写取消意图相关列，不能写租约、`worker_id`、`attempts`、`result`；
- Worker 在安全点观察取消意图，把 `running` 写成 `cancelled`；租约过期恢复时优先按取消终结。

不在本步骤范围：前端轮询/SSE 与任务页面、真实 Provider 取消协议、结果归档、额度扣减与限流。

## 2. API 契约

### 2.1 列表

```http
GET /api/tasks?limit=20&cursor=<opaque>
Cookie: painttrack_session=...
```

```json
{
  "tasks": [
    {
      "id": "uuid",
      "taskType": "image.generate",
      "status": "running",
      "createdAt": "2026-11-09T02:00:00.000Z",
      "updatedAt": "2026-11-09T02:05:00.000Z",
      "completedAt": null,
      "cancelRequestedAt": "2026-11-09T02:04:00.000Z",
      "result": null,
      "errorCode": null
    }
  ],
  "nextCursor": "eyJjcmVhdGVkQXQiOi..."
}
```

- `limit` 默认 20、上限 50；越界或非整数返回 `400 INVALID_PAGINATION`。
- 游标是不透明的 base64url，内部为 `(created_at, id)`；用 keyset 而不是 OFFSET，避免并发新增任务导致重复或漏项。
- 排序固定 `created_at DESC, id DESC`。

### 2.2 详情

```http
GET /api/tasks/:taskId
```

- 返回 `{ "task": {...} }`，字段同列表。
- 不存在、非法 UUID、属于他人任务统一 `404 TASK_NOT_FOUND`：不能用错误差异枚举他人任务。

### 2.3 取消

```http
POST /api/tasks/:taskId/cancel
Origin: https://<app-origin>
Cookie: painttrack_session=...
```

| 当前状态 | 结果 | HTTP | 响应 |
| --- | --- | --- | --- |
| `queued` | 立即写 `cancelled`，记录 `cancel_requested_at` + `completed_at` | 200 | `cancelRequested: false` |
| `running` | 只登记 `cancel_requested_at`，由执行方协作停止 | 202 | `cancelRequested: true` |
| `cancelled` | 幂等返回当前记录，不覆盖首次取消时间 | 200 | `cancelRequested: false` |
| `succeeded` / `failed` | 终态不可取消 | 409 `TASK_NOT_CANCELLABLE` | — |
| 不存在 / 他人 / 非法 ID | 统一未找到 | 404 `TASK_NOT_FOUND` | — |

取消是变更请求，必须校验 Origin；不需要 `Idempotency-Key`——状态本身就是幂等依据。

### 2.4 错误

| 状态 | 错误码 | 触发条件 |
| --- | --- | --- |
| 400 | `INVALID_PAGINATION` | limit 越界/非整数、游标不可解析 |
| 401 | `UNAUTHENTICATED` | 无有效会话 |
| 403 | `ORIGIN_REJECTED` | 跨站或缺失 Origin 的取消请求 |
| 404 | `TASK_NOT_FOUND` | 不存在、他人任务、非法 UUID |
| 405 | `METHOD_NOT_ALLOWED` | 列表非 GET/POST、详情非 GET、取消非 POST |
| 409 | `TASK_NOT_CANCELLABLE` | 任务已成功或已失败 |
| 503 | `TASK_QUERY_UNAVAILABLE` / `TASK_CANCELLATION_UNAVAILABLE` | 数据库或未知内部故障，不泄露堆栈 |

## 3. 取消语义

取消不是一次状态覆盖，而是「意图」与「执行事实」分离：

```text
用户取消
  ├─ queued  → 状态机允许 queued → cancelled：API 直接写 cancelled（无执行方需要通知）
  └─ running → 只写 cancel_requested_at；持有租约的 Worker 在安全点观察到后写 cancelled
```

理由：Web 进程直接改写 `running` 会制造「数据库显示已取消、供应商仍在跑并计费」的伪状态。因此 Web 角色只有列级写权限，`running → cancelled` 只能由租约持有者完成。

### 3.1 与 Worker 的交互

执行器在三个安全点检查取消：

1. 领取后、创建调用记录前；
2. 每次向供应商提交前；
3. 每次轮询前（已经开始的一次 query 无法撤回，但不会再发起下一次）。

命中取消时：

- 若持有调用记录，先把它终结为 `provider_calls.cancelled`（错误码 `TASK_CANCEL_REQUESTED`）；
- 抛出带 `cancelled: true` 的 `TaskExecutionError`；
- Worker 收到后调用 `cancelClaimedTask` 写 `cancelled`，**不**走 `failTask`（否则会被退避后重新执行）。

### 3.2 结果与取消的竞态

成功结算在事务内先 `SELECT ... FOR UPDATE` 锁定任务行，再写调用记录与任务终态：

- 取消事务先提交 → 执行方读到 `cancel_requested_at`，任务写 `cancelled`、`result` 保持 NULL；调用记录仍如实写 `succeeded`（供应商确实完成、成本已经发生），这是**有意的不一致**，用于阶段 6 成本对账；
- 执行方先提交成功 → 取消 API 随后看到 `succeeded`，返回 409，不会覆盖终态。

没有这层行锁时，两者之间存在一个会把用户已取消任务写成成功的时间窗。

### 3.3 租约过期

`recoverExpiredTasks` 增加取消优先分支：租约过期且 `cancel_requested_at` 非空 → `cancelled`；否则维持原有「还有次数就回队列、否则 failed」。

### 3.4 代价边界

- 供应商不支持取消时，任务可按用户意图终结，但**供应商侧任务可能继续运行并产生成本**；该成本必须由阶段 6 的对账处理，不能由状态机掩盖。
- `queued` 任务取消不触达供应商；若该任务此前留有 `accepted` 调用（轮询超限退避），该调用会随任务取消而不再被轮询，需在成本对账中作为「放弃的调用」识别。

## 4. 数据模型与权限

迁移 `0015_task_cancel_request.sql`：

- `cancel_requested_at timestamptz`；
- `generation_tasks_cancel_request_check`：该列非空时状态必须是 `queued`、`running` 或 `cancelled`。
  允许 `queued` 是为了避免「可重试失败回队列」与「取消请求」并发时触发约束错误。

`runtimePermissions.js`：

- Web 角色：`GRANT SELECT, INSERT` + `GRANT UPDATE(status, cancel_requested_at, completed_at, updated_at)`；
- Worker 角色：原有整表 DML；
- 真实库正负例：`has_column_privilege(worker_id|result,'UPDATE') = false`，以该角色写 `worker_id` 返回 `42501`，`SELECT ... FOR UPDATE` 仍可用（取消服务依赖行锁）。

## 5. 视图投影

`lib/server/tasks/taskView.js` 统一列表/详情/创建三处投影：

- 不返回 `owner_id`、`payload`、租约、`worker_id`、`request_fingerprint`；
- `last_error` 只有在符合固定错误码格式（`^[A-Z][A-Z0-9_]{0,63}$`）时才作为 `errorCode` 暴露，否则折叠为 `TASK_FAILED`，避免把 `ECONNREFUSED`、SQL 片段等内部信息带给浏览器；
- `result` 原样返回描述符（不含生成内容）。

## 6. 实现清单

| 文件 | 变更 |
| --- | --- |
| `lib/server/tasks/taskView.js` | 新增统一公开投影与错误码折叠 |
| `lib/server/tasks/taskQuery.js` | 新增列表/详情服务、keyset 游标、分页边界 |
| `lib/server/tasks/taskCancellation.js` | 新增取消服务（行锁 + 条件更新 + 终态判定） |
| `lib/server/tasks/taskHttp.js` | 新增列表/详情/取消处理器，创建逻辑行为不变 |
| `lib/server/tasks/taskService.js` | 复用 `taskView` 投影 |
| `lib/server/worker/taskQueue.js` | 新增 `isCancellationRequested`、`cancelClaimedTask`、`lockClaimedTask`；恢复语句取消优先 |
| `lib/server/worker/taskExecutor.js` | 三处取消检查；成功结算锁行并处理迟到结果 |
| `lib/server/worker/index.js` | `cancelled` 错误写取消终态 |
| `app/api/tasks/route.js` | 增加 `GET` |
| `app/api/tasks/[taskId]/route.js` | 新增详情 |
| `app/api/tasks/[taskId]/cancel/route.js` | 新增取消 |
| `drizzle/0015_task_cancel_request.sql` + 快照 | 新增列与 CHECK |
| `lib/server/db/runtimePermissions.js` | Web 列级 UPDATE |

## 7. 验证

| 项目 | 结果 |
| --- | --- |
| 定向测试 | `taskQuery`、`taskCancellation`、`taskApi`、`taskQueue`、`taskExecutor`、`worker` 全部通过 |
| 全量 `npm test` | 296 项 / 294 通过 / 0 失败 / 2 跳过 |
| `npm run lint` | 0 error / 11 warning（与基线一致） |
| `npx drizzle-kit check` | `Everything's fine` |
| 真实 PostgreSQL 隔离验收 | `.workbuddy/database-acceptance-mw8pnd8v_58228d.json`，`passed`，88 项 / 84 passed / 0 failed（4 项为过程标记） |

真实库新增 9 项检查：

1. 取消 `queued` 任务直接终结并记录取消时间/完成时间；
2. 重复取消返回当前任务且不覆盖取消时间；
3. 取消与查询严格按 owner 隔离（含列表不串用户）；
4. `running` 任务只登记意图且执行方可观察到；
5. 协作取消只允许当前租约持有者写入且不可重复；
6. 租约过期且已请求取消的任务恢复为 `cancelled` 而非重新排队；
7. 终态任务拒绝取消，`cancel_requested_at` CHECK 负例返回 `23514`；
8. 执行器尊重取消意图：提交前停止且不创建供应商调用；
9. Web 运行角色仅获取消列级写权限，无法写租约或结果。

### 7.1 过程问题

- `drizzle-kit generate --name` 按「快照下标 + 1」生成文件名，直接产出了 `0014_task_cancel_request.sql` 并覆盖 `0014_snapshot.json`。已改为 `0015_*`，并用 `generateMigration(还原的0014, 0015)` 逐字比对，确认还原快照与新迁移 SQL 完全一致，`drizzle-kit check` 通过。
- 验收中的 Web 权限探针最初放在迁移连接里，因子角色 `NOCREATEROLE` 触发 `42501`；改由管理员连接创建临时角色，验完即删除。

## 8. 后续入口

- 5.4 后续小步：前端任务轮询/状态展示与取消按钮（需先确定放在哪个页面）。
- 后续集成：接入经用户确认的自定义 Provider，并与现有 Studio 完成端到端沙箱测试；整体依赖顺序以 `../ImplementationPlan/PAINTTRACK_DEVELOPMENT_PROCESS.md` 第 10 节为准。原计划中的 MuAPI 不是默认目标。
- 阶段 6：额度冻结/结算，需要处理「取消后供应商仍计费」与「放弃的调用」两类成本。
