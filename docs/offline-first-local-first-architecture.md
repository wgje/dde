# NanoFlow Offline-first / Local-first 架构审计与验收合同

> 状态：架构合同与当前实现审计<br>
> 最后验证：2026-06-18<br>
> 适用范围：项目、任务、连接、附件、偏好、Focus / Routine、黑匣子与同步恢复链路<br>

本文件把 NanoFlow 的离线模式定义为正式运行模式，而不是网络错误兜底。核心验收句是：在浏览器或应用本地存储仍可用、用户未主动清除本地数据、设备存储介质未损坏的前提下，任何已经成功写入本地持久化存储的用户操作，都不得因断网、弱网、刷新、退出、崩溃、请求失败或同步重试而静默丢失。

## 1. 当前项目的数据流审计结果

读路径当前由本地快照优先支撑：

```text
IndexedDB / localStorage 快照 -> ProjectState / UI -> 后台远端探测 -> 增量或完整拉取 -> LWW / 冲突处理 -> 本地快照
```

真实模块锚点：

- `src/app/core/services/sync/project-offline-snapshot.service.ts`：启动快照读取，优先 IndexedDB，兼容 legacy localStorage，并按 owner 可见性筛选。
- `src/app/core/services/sync/project-data.service.ts`：远端项目读取、探测、离线快照委派；连接中断或 Supabase 不可用时返回本地分支。
- `src/app/core/services/sync/project-sync-cursor.service.ts` 与 `src/app/core/state/persistence/sync-cursor-persistence.service.ts`：同步游标持久化。

写路径当前已具备本地优先结构：

```text
用户操作 -> 本地状态 / 快照 -> ActionQueue 持久 Outbox -> UI 立即可见 -> 后台 Sync Engine -> RetryQueue / 冲突 / 死信
```

真实模块锚点：

- `src/services/project-operation.service.ts`：项目新增、编辑、删除先 durable enqueue，再更新本地 UI。
- `src/services/task-record-tracking.service.ts`：任务新增、编辑、删除、排序和结构变更先确认可恢复 Outbox 意图；云端项目写入走 ActionQueue，`local-only` 项目先写离线快照再提交 UI。
- `src/services/action-queue.service.ts`：正式 Outbox。它为本地写操作生成本地 `id` 和远端幂等 `operationId`，并持久化待同步动作。
- `src/services/action-queue-enqueue-mutation.service.ts`：合并同实体连续操作，保留 Outbox identity、`operationId`、`localCommittedAt` 和 `syncState`。
- `src/services/action-queue-restore.helpers.ts`：ActionQueue 恢复合并算法；从启动备份或本地数据安全包恢复时按 `operationId` / `id` 去重，只补缺失操作。
- `src/services/queue-backup.service.ts`：ActionQueue 的 IndexedDB 备份与原子 `updateQueue()` read-modify-write 入口。
- `src/app/core/services/sync/retry-queue.service.ts`：远端写失败后的持久 RetryQueue。
- `src/app/core/services/simple-sync-runtime.controller.ts`：网络监听、RetryQueue loop、恢复调度和 Realtime 降级入口。
- `src/app/core/services/sync/sync-state.service.ts`：同步状态、离线状态、pending count、后台 notice、冲突状态的单一事实源。
- `src/services/network-awareness.service.ts`：统一 Network Monitor，读取浏览器在线状态、Network Information API、Data Saver、电池和存储压力。
- `src/services/mobile-sync-strategy.service.ts`：弱网/离线同步策略 gate。离线或策略不允许自动同步时，后台批量刷新保留队列并延后远端回调，不把失败抛回前台交互链路。
- `src/services/attachment-upload-outbox.service.ts`：附件二进制 Outbox，负责把 Blob/ArrayBuffer 写入本地持久化存储。
- `src/services/attachment-upload-queue.helpers.ts`：附件离线入队原子入口；只有 Blob outbox 写入成功后才允许附件元数据进入 ActionQueue。
- `src/services/action-queue-attachment-processors.service.ts`：附件上传 outbox processor；`ActionQueueAttachmentProcessorsService` 负责把固定 storage path 幂等重放后的远程附件写回本地任务，并且只有 follow-up task update durable 入队成功后才清理 Blob。
- `src/services/action-queue-dead-letter-notifier.ts`：dead-letter 观察者隔离层，负责失败回调、用户提示、日志和 Sentry breadcrumb，任何观察者异常不得中断死信记录。
- `src/services/sync-coordinator-conflicts.service.ts`：冲突捕获、持久化、发布和显式解决。
- `src/services/disaster-backup.service.ts`：数据安全包导出入口，打包本地快照、ActionQueue、RetryQueue、dead letters、冲突、附件上传 outbox 与同步安全快照。

直接远端写边界当前由合同测试保护：

- `src/tests/contracts/foreground-supabase-write-boundary.contract.spec.ts` 禁止前台 UI / shell 直接 `.insert()`、`.update()`、`.upsert()`、`.delete()`、`.rpc()`、`.functions.invoke()` 或 storage mutation。
- `src/tests/contracts/local-first-write-path.contract.spec.ts` 禁止在 task record tracking 中保留“本地提交后再因 Outbox 失败回滚”的路径。
- `src/services/task-record-tracking.service.spec.ts` 覆盖 local-only 任务修改：离线快照必须在 UI 暴露变更前写入成功，且不会误入云端 ActionQueue。

## 2. 离线与弱网风险清单

已缓解风险：

- 完全断网：`SimpleSyncRuntimeController` 标记 offlineMode，挂起 Realtime，RetryQueue loop 只在在线时处理。
- 弱网、请求超时、5xx、429：批同步和 push 层失败后转交 RetryQueue 或后台 notice，前台 UI 不等待远端成功。
- 网络状态抖动：`NetworkAwarenessService.refresh()` 和 connection change 会以 `navigator.onLine` 为准保留 `offline` 质量，避免 Network Information API 仍显示 `4g` 时误启后台远端刷新。
- 离线批量刷新：`MobileSyncStrategyService.flushBatchQueue()` 在 `isOnline=false`、`offline` 或低质量自动同步关闭时只保留队列并重新调度，不调用远端 batch callback，不 reject 用户已排队的前台 Promise。
- 刷新、退出、崩溃：`ActionQueue`、`RetryQueue`、项目快照、同步游标均有持久化路径。
- 重复提交：`operationId` 作为本地和 RPC 的幂等键；同一 operationId 入队复用已有 action。
- 旧请求覆盖新数据：`ActionQueueEnqueueMutationService` 折叠同实体连续 update，`ProjectSaveFlightCoordinatorService` 对项目保存做 single-flight + fold。
- 远端同时修改：LWW、baseUpdatedAt、delete base map、冲突服务共同避免静默覆盖。
- 鉴权过期 / auth pending：ActionQueue 的 task、connection、project:create/update/delete、preference、focus-session、routine-task 与 routine-completion processor 在 `currentUserId()` 暂不可用时统一返回 `SYNC_AUTH_PENDING` deferred result；队列层会把当前 owner-scoped Outbox 项持久化为 `blocked_by_auth`，不调用远端、不消耗 retry budget、不进入 dead-letter，例如 `non-task-auth-pending-defer` 与 `project-delete-auth-pending-defer`。
- sync RPC capability gap：Focus / Routine 等 ActionQueue processor 收到 `details.reason = "sync-rpc-unavailable"` 且 `deferred/retryable` 的失败结果时，`ActionQueueStorageService` 会分类为 deferred retry，保留 owner-scoped Outbox、调度后台重试、不消耗 retry budget、不进入 dead-letter，例如 `should defer sync RPC capability gaps without consuming retry budget`。
- sync RPC probe rejection：`TaskSyncPushService` 在 `primeTaskSyncRpcCapability()` 判定客户端协议过期时不再只返回失败；非 RetryQueue 回放的 task upsert 会先按原 `sourceUserId`、`writeIntent` 和 `operationId` 写入 RetryQueue，例如 `queued-op-task-probe-rejected`，并继续禁止降级到没有 RPC 幂等键的 direct table upsert。
- 带 operationId 的 task upsert：`TaskSyncPushService` 在 sync RPC 未启用且调用方已经提供 `operationId` 时，不再执行没有幂等键的 direct table upsert；该写入会保留到 RetryQueue，例如 `queued-op-task-rpc-unavailable`，等待具备幂等 RPC 能力的后台重放。
- 带 operationId 的 connection upsert：`ConnectionSyncOperationsService` 在 sync RPC 不可用但调用方已经提供 `operationId` 时，不再执行没有幂等键的 direct table upsert；非 RetryQueue 来源会按原 owner 保留到 RetryQueue，例如 `connection-rpc-unavailable-operation-id`。真实 RetryQueue replay 由 `SimpleSyncRuntimeController` 显式传入 `requireSyncRpc=true`，sync RPC 不可用时保留原队列项而不是降级 REST 写入，例如 `pushConnection 从 RetryQueue 重放且 sync RPC 不可用时应保留原队列项并禁止直接 table upsert`。
- 带 operationId 的 project metadata upsert：`ProjectPushService` 在 sync RPC 不可用但调用方已经提供 `operationId` 时，不再执行没有幂等键的 `projects` table direct upsert；该写入会保留到 RetryQueue，例如 `project-rpc-unavailable-operation-id`，等待 RPC 能力恢复后后台重放。
- 带 operationId 的 black box upsert：`BlackBoxSyncPushLayer.pushToServer()` 在 sync RPC 不可用但 RetryQueue / 后台调用方已经提供 `operationId` 时，不再回退到没有 RPC 幂等键的 legacy direct insert/update；本地 pending 条目保持可重放，等待具备幂等 RPC 能力的后台重试，例如 `should keep operationId black box pushes pending when sync RPC is unavailable`。
- 带 operationId 的 project delete：`ProjectDeleteCoordinatorService` 在 sync RPC 不可用但调用方已经提供 `operationId` 时，不再调用没有 RPC 幂等键的 legacy `soft_delete_project`；删除意图保持在 ActionQueue / 后台重试链路中，返回 `details.reason = "sync-rpc-unavailable"` 的 deferred retry failure，例如 `deleteProjectFromCloud 带 operationId 且 sync RPC 不可用时应保留重试且不调用旧删除 RPC`。
- 带 operationId 的 task purge/delete：`TaskSyncDeleteService` 在 `purgeTasksFromCloudDetailed()` 发现 sync RPC 不可用且调用方已经提供 `operationId` 时，不再回退到无幂等键的 legacy purge / soft-delete cascade；删除意图会按原 owner、baseUpdatedAtMap 和 `operationId` 保留到 RetryQueue，例如 `task-delete-rpc-unavailable`。
- 带 operationId 的 batch soft delete：`TaskSyncDeleteService.softDeleteTasksBatch()` 在 sync RPC 不可用且调用方已经提供 `operationId` 时，不再调用无幂等键的 `safe_delete_tasks` 或逐行 update fallback；本地 tombstone 仍立即生效，删除意图按 baseUpdatedAtMap 与 `operationId` 保留到 RetryQueue，例如 `op-soft-delete-rpc-unavailable`。
- batch soft delete RPC rejected：`softDeleteTasksViaSyncRpc()` 在服务端返回 `deleted-remote-newer` 等拒绝态时，会复用本次 RPC 的 effective `operationId` 和 resolved baseUpdatedAtMap 入 RetryQueue，避免同一删除意图在重放时换幂等键或退回 TaskStore 旧基线，例如 `op-soft-delete-rpc-conflict`。
- batch soft delete client rejected：`handleSoftDeleteSyncRpcClientRejected()` 在 sync RPC 客户端/协议被拒绝且调用方带 `operationId` 时，会在保留本地 tombstone 后把同一删除意图写入 RetryQueue，避免客户端刷新前后的删除操作失去后台重放材料，例如 `op-soft-delete-client-rejected`。
- 连接批量差异同步部分失败：`TaskRepositoryBatchService.syncConnections()` 在删除、插入或更新连接批次仍有未恢复错误时返回 `success: false` 和错误文本，禁止只写 warn 后误报成功，避免弱网 / 5xx 下上层跳过后台重试。
- 连接新增差异同步幂等重试：`TaskRepositoryBatchService` 对 diff 计算出的新增连接使用客户端稳定 `id` 执行 `upsert(..., { onConflict: 'id' })`，避免请求超时但服务端已写入后，后台重试因重复 `insert` 撞唯一键而卡住。
- 旧批量连接删除弱网重试：`TaskRepositoryBatchService.deleteConnections()` 对 endpoint-pair 软删除复用连接重试器，避免临时 5xx / 弱网抖动时一次失败就向上报告失败并跳过后续后台恢复窗口。
- ProjectSave task purge operationId：`ProjectSaveBatchExecutorService` 在项目保存批次删除任务时，会把调用方 `operationId` 继续传给 `purgeTasksFromCloud` 回调，例如 `queued-project-task-purge-op`，避免项目级 ActionQueue 幂等键在 task delete 子写入处断链。
- ProjectSave position-only operationId：`ProjectSaveTaskBatchService` 在项目保存批次已经带有 `operationId` 时，不再使用无幂等键的 `pushTaskPosition` 直接位置写入，而是走完整 task upsert 并透传调用方幂等键，例如 `queued-project-position-op`；无 `operationId` 的 legacy position-only 路径保持兼容。
- RetryQueue IDB 持久化覆盖：`RetryQueueStorageLayer.saveToIdb()` 在成功写入 IndexedDB 前会先读取当前 store，并通过 `mergeStoredRetryQueueItems()` 合并未被本地移除的其它标签队列项，再执行 clear+put，避免 stale tab 持久化当前内存视图时丢弃另一个标签刚写入的 RetryQueue item。
- 死信可恢复证据：`ActionQueueDeadLetterNotifier` 会隔离 failure callback、callback provider 与 dead-letter queue provider 自身的异常，确保观察者失败不会中断 dead-letter 日志、Sentry breadcrumb 和关键失败提示。
- 附件半成功写入：`queuePendingLocalAttachmentUpload()` 先等待 `AttachmentUploadOutboxService.savePendingUpload()` 完成；Blob 持久化失败时返回受控失败，禁止生成缺少二进制本体的附件元数据队列。
- 附件上传半成功重放：`AttachmentService` 使用 `userId/projectId/taskId/attachmentId.ext` 固定 storage path 幂等重放；`ActionQueueAttachmentProcessorsService` 在远程上传成功但 follow-up task update durable 入队失败时保留 Blob，避免刷新或崩溃后丢失重建附件元数据的材料。
- 未分配文本任务草稿双字段写入：`TextUnassignedComponent.persistTaskDraft()` 不再用 `Promise.all` 并发调用 `updateTaskTitle()` 与 `updateTaskContent()`；标题和正文任一变化时统一调用 `TaskOperationAdapterService.updateTaskDraft()`，最终由 `TaskAttributeService.updateTaskDraftDurably()` 在一次 `recordAndUpdateDurably()` 中保存 title/content，避免底层 `isUpdating` 互斥导致只落一半。
- Active project refresh 旧响应覆盖：`SyncCoordinatorProjectRefreshService.refreshActiveProjectSilent()` 在远端完整项目返回后、merge 后 apply 前重新计算当前本地项目 watermark；若请求期间发生新的本地编辑，返回 `local-project-changed-during-refresh` 并跳过旧远端结果、离线快照写入和 cursor commit。
- Download merge 旧合并结果覆盖：`SyncCoordinatorProjectRefreshService.downloadAndMerge()` 在 context 创建时记录本地项目集合签名，并在 apply 前重新读取当前本地项目集合；若 merge 期间发生新的本地编辑，跳过旧合并结果、`setProjects()` 和离线快照写入。
- ActionQueue 恢复覆盖风险：启动时 IndexedDB 备份会替换未变化的 stale localStorage 镜像；如果恢复等待期间出现前台新写入，则改为与当前 runtime 队列按 `operationId` 合并，禁止晚到备份覆盖新操作。本地备份文件中的 `localState.actionQueue` 也通过 `QueueBackupService.updateQueue()` 原子合并，只恢复缺失 operation。
- 旧 owner settlement 收口覆盖风险：`ActionQueueOwnerStorageService.settleSuccessfulActionForOwner()`、`settleProjectDeleteSuccessForOwner()` 与 `settleFailedActionForOwner()` 通过 `QueueBackupService.updateQueue()` / `persistQueueMutationForOwner()` 基于 IndexedDB 最新 owner 队列做原子过滤或 retry 状态更新，并刷新 localStorage 镜像；`owner-successful-settlement-atomic`、`owner-project-delete-settlement-atomic`、`owner-failed-settlement-atomic` 与 `owner-dead-letter-settlement-atomic` 锁定 IDB-only 新 action 不会被 stale mirror 擦掉，dead-letter 保存失败时原 action 仍保留在队列中。

仍需重点关注的风险：

- 如果 IndexedDB 与 localStorage 同时不可写，系统只能进入冻结/导出路径，无法承诺自动恢复。
- 不同实体类型的字段级冲突规则并不完全一致，部分仍依赖 LWW 或显式冲突副本。
- 附件二进制 Outbox 受浏览器配额影响更明显；当前已避免元数据/Blob 半成功，但仍需继续压测大文件、多文件离线、配额耗尽后的冻结/导出体验。
- 跨标签同时写入依赖 lease、owner bucket 与 IDB 原子 mutation，仍需保留多标签回归测试。
- 其它后台 refresh 路径仍需继续沿用 active project refresh / download merge 的 watermark 或 generation gate，避免未来新增入口重新引入晚到响应覆盖。
- 跨标签 single-writer 已通过 `sync-writer-lease-default-enabled` 默认启用：`SyncWriterLeaseService` 在未设置 `syncLeaseEnabled` 时启用 Web Locks / IndexedDB lease，`scripts/set-env.cjs` 与 `scripts/ensure-env-files.cjs` 生成的环境默认 `syncLeaseEnabled: true`，`.env.template` 显式列出 `NG_APP_SYNC_LEASE_ENABLED=true`。只有 `NG_APP_SYNC_LEASE_ENABLED=false` 会作为临时排障开关降级到 `memory-only fallback`；剩余风险是浏览器同时缺少 Web Locks 与 IndexedDB 时仍只能每标签页内互斥，以及未来新增 full-snapshot 写入入口仍需同等 merge/item-level 保护。
- 写请求 timeout 仍需区分 `failed` 与 `unknownOutcome`：`RequestThrottleService.withTimeout()` 当前不会中止底层 Supabase promise，弱网超时后的盲目重放应先按 operationId/updatedAt reconcile。
- RPC 不可用时的 REST/direct fallback 仍需继续收口：带 `operationId` 的 task upsert、connection upsert、project metadata upsert、task purge/delete 与 batch soft delete 已禁止 silent direct fallback，真实 RetryQueue connection replay 已要求 sync RPC，ProjectSave task purge 已继续传播项目级 `operationId`，ProjectSave position-only 在有 `operationId` 时已改走完整 task upsert；剩余重点是 legacy 无 operationId 路径和其它兼容降级路径补幂等日志、payload equality success 判定或 fail-closed 入队策略。
- 鉴权恢复后的跨标签唤醒还需继续收口：`blocked_by_auth` 项已能 durable 保留，但 session restored 后的多标签 single-writer 唤醒、旧 owner 切换窗口与后台刷新节流仍需要更细的端到端验证。
- `BackupLocalState.retryQueue` 已通过 `RetryQueueService.restoreFromBackupItems()` 接入本地备份导入流程，恢复时会复用 RetryQueue owner 隔离、TTL、retry 上限、UUID 过滤和持久化回滚保护；`BackupLocalState.deadLetters` 已通过 `ActionQueueStorageService.restoreDeadLettersFromBackupItems()` 接入本地备份导入流程，恢复时按 owner、TTL 和 `operationId` 合并，避免重复失败记录或跨账号失败记录污染当前账号。

## 3. Offline-first 架构设计

统一分层如下：

```text
UI / Shell
  -> Domain Operation Services
  -> Local Repository / State / Snapshot
  -> Durable Outbox (ActionQueue)
  -> Background Sync Engine
  -> RetryQueue / Conflict Store / Dead Letter
  -> Supabase RPC / Tables / Storage
```

职责边界：

- UI 只发起业务意图，不直接调用 Supabase 写接口。
- Domain Operation Services 先构造本地模型、写入本地快照或 Outbox，再更新 UI。
- `ActionQueue` 是核心业务写操作的持久 Outbox。
- `RetryQueue` 是远端写失败后的恢复队列，不能替代本地提交链路。
- `SyncStateService` 是同步 UI 状态唯一入口，页面不直接拼接网络错误状态。
- `ConnectivityRecoveryService` / `SimpleSyncRuntimeController` 负责网络恢复、后台同步恢复、轮询与 Realtime 降级。
- `SyncCoordinatorConflictService` / conflict storage 负责保留冲突双方数据，禁止静默覆盖或丢弃无法自动解决的数据。

## 4. 新增和修改的模块列表

本次收口新增：

- `docs/offline-first-local-first-architecture.md`：当前文件，作为离线-first 审计、架构和验收合同。
- `src/tests/contracts/offline-first-architecture.contract.spec.ts`：合同测试，要求该文档持续存在并锚定真实模块、`operationId`、`IndexedDB`、`ActionQueue` 和 `RetryQueue`。
- `src/services/action-queue-restore.helpers.ts`：可复用的 ActionQueue 恢复合并 helper。
- `src/app/features/text/components/text-unassigned.component.ts`：未分配文本任务草稿保存改为 title/content 单次 durable 写入。
- `src/services/task-operation-adapter.service.ts`：新增 `TaskOperationAdapterService.updateTaskDraft()`，统一 guard、编辑标记与失败日志。
- `src/services/task-operation.service.ts`：新增 `updateTaskDraft()` / `updateTaskDraftDurably()`，转发到任务属性层。
- `src/services/task-attribute.service.ts`：新增 `TaskAttributeService.updateTaskDraftDurably()`，用一次 `recordAndUpdateDurably()` 同时保存 title/content。
- `src/services/sync-coordinator-project-refresh.service.ts`：为 active project refresh 增加当前本地 watermark gate，为 download merge 增加本地项目集合签名 gate，阻止弱网晚到远端响应或旧合并结果覆盖请求期间的新本地编辑。

当前实现中承担离线-first 职责的已有模块：

- `src/services/action-queue.service.ts`
- `src/services/action-queue-enqueue-mutation.service.ts`
- `src/services/action-queue-storage.service.ts`
- `src/services/action-queue-owner-storage.service.ts`
- `src/services/queue-backup.service.ts`
- `src/services/import-backup-conversion.helpers.ts`
- `src/app/shared/modals/settings-modal/local-backup-ui.service.ts`
- `src/app/core/services/sync/retry-queue.service.ts`
- `src/app/core/services/sync/retry-queue-storage.service.ts`
- `src/services/task-repository-batch.service.ts`
- `src/app/core/services/sync/sync-state.service.ts`
- `src/app/core/services/simple-sync-runtime.controller.ts`
- `src/app/core/services/sync/connectivity-recovery.service.ts`
- `src/services/network-awareness.service.ts`
- `src/services/mobile-sync-strategy.service.ts`
- `src/services/action-queue-dead-letter-notifier.ts`
- `src/app/core/services/sync/project-offline-snapshot.service.ts`
- `src/app/core/services/sync/project-save-flight-coordinator.service.ts`
- `src/app/core/services/sync/project-save-runtime.service.ts`
- `src/services/sync-coordinator-conflicts.service.ts`

## 5. 数据同步状态机

Outbox 单项状态：

```text
local_committed
  -> pending_sync
  -> syncing
  -> synced
```

可恢复分支：

```text
syncing
  -> retry_scheduled
  -> pending_sync
```

阻塞与终态分支：

```text
pending_sync | syncing
  -> blocked_by_auth
  -> blocked_by_protocol
  -> conflict_detected
  -> conflict_saved
  -> dead_letter
  -> storage_frozen
```

系统级状态：

- `offlineMode=true`：允许本地读写，禁止前台等待远端。
- `isOnline=false`：暂停远端处理，保留队列。
- `isSyncing=true`：后台正在处理队列，不阻塞 UI。
- `pendingCount>0`：仍有 ActionQueue 或 RetryQueue 待收口，不推进完整恢复语义。
- `hasConflict=true`：存在需要用户或策略解决的数据冲突。

## 6. 幂等与冲突处理策略

幂等策略：

- 每个 `QueuedAction` 必须有唯一 `operationId`。
- 调用方传入 `operationId` 时必须保留；未传入时由 `createSyncOperationId()` 生成。
- 同一 `operationId` 重复入队时复用已有 action，不重复创建。
- 同一实体连续 update 合并为最新快照，同时保留原 action `id`、`operationId`、`timestamp` 和 `localCommittedAt`。
- create 后 update 保留 create 语义；update 后 delete 折叠为 delete；create 后 delete 取消未同步 create。
- 项目保存通过 `ProjectSaveFlightCoordinatorService` 做 `(userId, projectId)` single-flight，飞行中后续请求折叠为最新排队快照。

冲突策略：

- 常规字段按 `updatedAt` / `updated_at` 做 LWW。
- 删除使用 `deletedAt` / tombstone / `baseUpdatedAt` / `taskDeleteBaseUpdatedAtMap` 防止旧删除或旧更新复活数据。
- 服务端返回 stale 或 terminal conflict 时必须进入 conflict 或 dead-letter 路径。
- 无法自动合并时必须保存本地与远端副本，交给 `SyncCoordinatorConflictService` 和冲突 UI 处理。
- 冲突解决可以选择 local、remote、merge 或字段级 plan；解决后通过后台 persist 收口。

## 7. 实际代码改造

本次实际改造是收口型改造，不新增并行同步系统：

- 新增架构合同文档，明确当前项目的正式 Offline-first / Local-first 数据流、风险清单、状态机、幂等与冲突策略。
- 新增合同测试，防止后续重构删除或弱化该架构合同。
- 加固 `NetworkAwarenessService`：刷新和连接变化时优先尊重浏览器离线状态，避免离线时由 stale `effectiveType=4g` 把网络质量误判为 `high`。
- 加固 `MobileSyncStrategyService`：`shouldAllowSync()` 同时检查 `isOnline`；批量刷新在离线、弱网自动同步关闭或后台暂停时保留队列并延后刷新，网络恢复后的下一次调度自动继续，不把后台同步失败回滚到前台操作。
- 加固 `ActionQueueDeadLetterNotifier`：failure callback provider 或 dead-letter queue provider 抛错时只记录错误并继续执行 dead-letter breadcrumb 与日志，避免通知层异常让同步失败证据静默消失。
- 加固附件离线上传队列：`queuePendingLocalAttachmentUpload()` 将 Blob outbox 写入作为 ActionQueue enqueue 的前置条件；`savePendingUpload()` 失败时返回 `附件上传队列持久化失败`，并跳过 ActionQueue、上传进度和无意义清理。
- 加固附件上传 processor：`src/services/action-queue-attachment-processors.service.ts` 在上传成功后立即把远程附件 materialize 到本地任务；如果同一 action 因崩溃或刷新重放，已存在远程附件时只补 durable task update，不重复上传。Blob outbox 的删除边界是 follow-up task update durable 入队成功后才清理 Blob；失败时依靠固定 storage path 幂等重放重建附件元数据。
- 加固未分配文本任务草稿保存：`src/app/features/text/components/text-unassigned.component.ts` 的 `persistTaskDraft()` 从并发 `Promise.all([updateTaskTitle, updateTaskContent])` 改为一次 `updateTaskDraft()`；`src/services/task-operation-adapter.service.ts`、`src/services/task-operation.service.ts` 和 `src/services/task-attribute.service.ts` 暴露同一条 durable 写路径，通过一次 `recordAndUpdateDurably()` 同时保存 title/content，避免同一实体连续字段修改被 `TaskRecordTrackingService` 的更新中互斥挡掉第二个字段。
- 加固 active project refresh：`src/services/sync-coordinator-project-refresh.service.ts` 在 `loadFullProjectOptimized()` 返回后重新读取当前本地项目 watermark；若本地 watermark 与请求开始时不同，说明用户在弱网等待期间已有新本地写入，直接返回 `local-project-changed-during-refresh`，不再执行 `smartMerge()`、`updateProjects()`、`saveOfflineSnapshotAndWait()` 或 cursor commit。合并过程之后、应用结果之前还会再次检查本地 watermark，覆盖 merge 期间出现新本地写入的窗口，确保旧远端结果不会落入 UI、离线快照或 cursor。
- 加固 download merge：`src/services/sync-coordinator-project-refresh.service.ts` 在创建 download merge context 时记录 `id:watermark` 组成的本地项目集合签名；合并和 metadata 壳补齐后、`applyDownloadedProjects()` 前重新计算当前签名。签名变化说明用户在后台 merge 期间已有新本地写入，系统只记录 info 并跳过旧合并结果，禁止晚到后台刷新覆盖 UI 和离线快照。
- 加固 task sync RPC probe rejection：`src/app/core/services/sync/task-sync-push.service.ts` 在 `probe 判定客户端已过期` 时复用 `safeAddToRetryQueue()`，把 task upsert、owner、`writeIntent` 与调用方 `operationId` 保留下来；对应规格使用 `queued-op-task-probe-rejected` 验证不会 direct table upsert，也不会丢失远端重放任务。
- 加固带 operationId 的 task upsert RPC 不可用路径：同一服务在 `shouldUseSyncRpc()` 为 false 且请求已有 `operationId` 时直接入 RetryQueue 并返回未推送，禁止把 ActionQueue/ProjectSave 已生成幂等键的任务写入静默降级为无幂等 direct table upsert；对应规格使用 `queued-op-task-rpc-unavailable` 锁定该行为。
- 加固带 operationId 的 connection upsert RPC 不可用路径：`src/app/core/services/sync/connection-sync-operations.service.ts` 在 `shouldUseConnectionSyncRpc()` 为 false 且请求已有 `operationId` 时，非 RetryQueue 来源直接入 RetryQueue 并返回未推送，禁止把 ActionQueue/ProjectSave 已生成幂等键的连接写入静默降级为无幂等 direct table upsert；`src/app/core/services/simple-sync-runtime.controller.ts` 为真实 RetryQueue connection replay 传入 `requireSyncRpc=true`，让队列项在 RPC 不可用时保留原项等待重试；对应规格使用 `connection-rpc-unavailable-operation-id`、`pushConnection 从 RetryQueue 重放且 sync RPC 不可用时应保留原队列项并禁止直接 table upsert` 和 `connection retry handler should require sync RPC to preserve operationId idempotency` 锁定该行为。
- 加固带 operationId 的 project metadata upsert RPC 不可用路径：`src/app/core/services/sync/project-push.service.ts` 在 `shouldUseSyncRpc()` 为 false 且请求已有 `operationId` 时调用 durable retry handoff 并返回未推送，禁止把 ActionQueue/ProjectSave 已生成幂等键的项目元数据写入静默降级为无幂等 `projects` table direct upsert；对应规格使用 `project-rpc-unavailable-operation-id` 锁定该行为。
- 加固带 operationId 的 project delete RPC 不可用路径：`src/app/core/services/sync/project-delete-coordinator.service.ts` 在 `shouldUseSyncRpc()` 为 false 且请求已有 `operationId` 时返回 `sync-rpc-unavailable` deferred retry failure，禁止把 ActionQueue 已生成幂等键的项目删除静默降级为无幂等 `soft_delete_project` RPC；对应规格使用 `deleteProjectFromCloud 带 operationId 且 sync RPC 不可用时应保留重试且不调用旧删除 RPC` 锁定该行为。
- 加固带 operationId 的 task purge RPC 不可用路径：`src/app/core/services/sync/task-sync-delete.service.ts` 在 `purgeTasksFromCloudDetailed()` 中检测到 `shouldUseSyncRpc()` 为 false 且请求已有 `operationId` 时直接入 RetryQueue 并返回 retry-tracked rejected result，禁止把 ActionQueue/ProjectSave 已生成幂等键的任务删除静默降级为 legacy purge RPC 或 per-row soft delete；对应规格使用 `task-delete-rpc-unavailable` 锁定 `purgeTasksFromCloudDetailed 带 operationId 且 sync RPC 不可用` 行为。
- 加固带 operationId 的 batch soft delete RPC 不可用路径：同一服务在 `softDeleteTasksBatch()` 中检测到 `shouldUseSyncRpc()` 为 false 且请求已有 `operationId` 时先写本地 tombstone，再把删除意图入 RetryQueue 并返回 `-1`，禁止降级到无幂等键的 `safe_delete_tasks` 或 per-row update；对应规格使用 `op-soft-delete-rpc-unavailable` 锁定 `softDeleteTasksBatch 带 operationId 且 sync RPC 不可用` 行为。
- 加固 batch soft delete RPC rejected handoff：同一服务在 `softDeleteTasksViaSyncRpc()` 中把 `operationId ?? createSyncRpcOperationId()` 和 `buildTaskBaseUpdatedAtMap()` 结果保存为本次 RPC 的 effective context；若 RPC 返回拒绝态，`handleRejectedTaskDeleteRpc()` 会收到同一 `operationId` 和同一 base map，避免 RetryQueue 重放生成新幂等键或使用过期 TaskStore 基线；对应规格使用 `op-soft-delete-rpc-conflict` 锁定 `softDeleteTasksBatch sync RPC 拒绝时应沿用调用方 operationId 与 baseUpdatedAtMap 入队` 行为。
- 加固 batch soft delete client rejected handoff：`handleSoftDeleteSyncRpcClientRejected()` 接收 `baseUpdatedAtMap` 与 `operationId`，在保留本地 tombstone 与清理依赖后将带幂等键的删除意图写入 RetryQueue；对应规格使用 `op-soft-delete-client-rejected` 锁定 `softDeleteTasksBatch 在 sync RPC client rejected 且带 operationId 时应保留 RetryQueue` 行为。
- 加固旧批量连接删除弱网重试：`src/services/task-repository-batch.service.ts` 的 `deleteConnections()` 保持 endpoint-pair 软删除兼容路径，但每条删除都通过 `retryConnectionOperation()` 执行；临时 5xx / 弱网失败会先重试，重试耗尽后才返回 `success: false`，避免可恢复抖动被当作永久同步失败。
- 加固 ProjectSave task purge 幂等键传播：`src/app/core/services/sync/project-save-batch-executor.service.ts` 在 `purgeDeletedTasks()` 中通过 `purgeTasksWithBaseUpdatedAtMap()` / `purgeTasksWithoutBaseUpdatedAtMap()` 条件传递 `context.operationId`，让项目保存批次中的任务删除子写入继续沿用 ActionQueue 生成的幂等键；对应规格使用 `queued-project-task-purge-op` 锁定回调第 5 个参数。
- 加固 ProjectSave position-only 幂等路径：`src/app/core/services/sync/project-save-task-batch.service.ts` 在 `pushTaskForProjectSaveBatch()` 中检测到 `context.operationId` 时跳过 `pushTaskPosition()`，改用 `pushTaskWithOptionalOperationId()` 透传同一个项目级幂等键；对应规格使用 `queued-project-position-op` 锁定不会进入无幂等位置直写。
- 加固 ActionQueue auth pending 分支：`src/services/action-queue-task-focus-processors.service.ts` 的 `preference:update`、`focus-session:*`、`routine-task:*` 与 `routine-completion:*` 在认证状态暂不可用时统一返回 `SYNC_AUTH_PENDING` deferred result，和 task/connection 一样交给队列层持久化为 `blocked_by_auth`；对应规格使用 `non-task-auth-pending-defer` 锁定非任务/连接写入不会因为 session 过渡期返回 `false` 而消耗 retry budget 或进入 dead-letter。
- 加固 project delete auth pending 分支：`src/services/action-queue-project-processors.service.ts` 的 `project:delete` 在认证状态暂不可用时不再返回裸 `false`，而是使用 `SYNC_AUTH_PENDING` deferred result 保留 `projectId` / `operationId` 所属队列项；对应规格使用 `project-delete-auth-pending-defer` 锁定未登录窗口不会调用远端删除、不会清理同项目挂起 mutation，也不会消耗 retry budget。
- 加固旧 owner successful / project delete 收口：`src/services/action-queue-owner-storage.service.ts` 的 `settleSuccessfulActionForOwner()` 与 `settleProjectDeleteSuccessForOwner()` 改用 `persistQueueMutationForOwner()`，让成功 action 移除和删除成功后的关联 action 清理都基于最新 owner 持久化队列执行；对应规格使用 `owner-successful-settlement-atomic` 与 `owner-project-delete-settlement-atomic` 锁定 stale localStorage 不会覆盖 IndexedDB-only 新操作。
- 加固旧 owner failed / dead-letter 收口：`src/services/action-queue-owner-storage.service.ts` 的 `settleFailedActionForOwner()` 会先通过 IndexedDB 优先的 mutation base 定位待收口 action，retry 路径再用 `persistQueueMutationForOwner()` 只更新该 action 的 retry 状态；dead-letter 路径先持久化 dead-letter 记录，成功后才用 `persistQueueMutationForOwner()` 删除原 action，dead-letter 保存失败时保持原 action 不被移除。对应规格使用 `owner-failed-settlement-atomic`、`owner-dead-letter-settlement-atomic` 与 `dead-letter 保存失败` 锁定 stale localStorage 不会擦掉 IndexedDB-only 新操作，也不会在死信写入失败时静默丢失原操作。
- 加固 RetryQueue IndexedDB 成功持久化：`src/app/core/services/sync/retry-queue-storage.service.ts` 的 `saveToIdb()` 改为先 `getAll()` 当前 store，再通过 `mergeStoredRetryQueueItems()` 按 `sourceUserId::id` 合并现有项和当前内存项；`locallyRemovedRetryItemIds` 中的项不会复活，当前项覆盖同 id 旧项。对应规格 `persistNow 写入 IndexedDB 时应合并未本地移除的已有项，避免 clear+put 覆盖其它标签队列` 锁定多标签 stale writer 场景。
- 加固 sync writer lease 默认策略：`src/services/sync-writer-lease.service.ts` 的 `readFeatureFlag()` 改为显式 `false` 才关闭；未设置时默认启用 single-writer lease，优先走 Web Locks，失败时降级 IndexedDB lease，最后才进入 `memory-only fallback`。`scripts/set-env.cjs` 与 `scripts/ensure-env-files.cjs` 同步把 `NG_APP_SYNC_LEASE_ENABLED` fallback 改为 `true`，避免本地/CI 生成环境继续关闭跨标签写入门禁。
- 加固灾难备份数据安全包：`DisasterBackupService` 的 `localState.attachmentUploadOutbox` 会把未上传附件 Blob 编码为 base64 JSON 记录，与本地快照、ActionQueue、RetryQueue、dead letters 和冲突记录一起导出；`restoreAttachmentUploadOutboxFromBackup()` 可把该记录恢复回 `AttachmentUploadOutboxService.savePendingUpload()`，避免恢复包只含附件元数据而丢失二进制本体。
- 加固 ActionQueue 启动恢复：`ActionQueueOwnerStorageService` 在发起 IndexedDB 备份恢复时记录 runtime 队列身份；若恢复回来前队列未变化，继续用 IndexedDB 替换 stale localStorage 镜像；若恢复等待期间用户产生前台写入，则通过 `mergeRestoredQueuedActions()` 按 `operationId` / `id` 合并，保留当前队列并只追加缺失操作。
- 加固本地备份文件恢复：`restoreActionQueueFromBackup()` 从 `BackupLocalState.actionQueue` 提取合法 `QueuedAction`，通过 `QueueBackupService.updateQueue()` 原子合并到 owner-scoped IndexedDB Outbox；同一 `operationId` 不重复恢复，`syncing` 等中断态恢复为可重试 pending 状态。
- 加固 RetryQueue 本地备份恢复：`restoreRetryQueueFromBackup()` 委托 `RetryQueueService.restoreFromBackupItems()`，只恢复当前 owner 的合法备份项，按 `operationId` / `id` 去重，过滤过期、超过 retry 上限、非法 UUID 与跨账号项，持久化失败时回滚内存队列。
- 加固 DeadLetters 本地备份恢复：`restoreDeadLettersFromBackup()` 委托 `ActionQueueStorageService.restoreDeadLettersFromBackupItems()`，按 `operationId` / action id 去重，过滤过期或跨账号记录，保存到 owner-scoped dead-letter storage，并同步运行时 signal 与 Sentry context。
- 加固本地恢复 UI：`LocalBackupUIService` 在项目导入成功后恢复附件上传 outbox、ActionQueue outbox、RetryQueue 与 dead letters，并在成功文案中显示恢复的待上传附件数、待同步操作数、待重试同步操作数和同步失败记录数。

已有代码已经覆盖的关键能力：

- 本地持久化：`project-offline-snapshot.service.ts`、`action-queue-storage.service.ts`、`retry-queue-storage.service.ts`。
- Repository / Operation 边界：`project-operation.service.ts`、任务/连接/附件 processors。
- 任务本地优先写路径：`task-record-tracking.service.ts` 在 durable Outbox 或 local-only 快照前置成功后才暴露 UI 变更，避免“UI 已变但本地恢复证据未落盘”的半提交。
- Outbox：`action-queue.service.ts`。
- Sync Engine：`simple-sync-runtime.controller.ts`、`batch-sync.service.ts`、`project-save-flight-coordinator.service.ts`。
- Network Monitor / Recovery：`connectivity-recovery.service.ts`、`realtime-transport-circuit.service.ts`。
- Retry Scheduler：`retry-queue.service.ts` 及其 runner/storage/circuit layers。
- Conflict Resolver：`sync-coordinator-conflicts.service.ts`、`conflict-resolution.service.ts`、`conflict-storage.service.ts`。
- 同步状态管理：`sync-state.service.ts`。
- 异常日志：`LoggerService`、Sentry lazy loader、ActionQueue breadcrumb/context。
- 附件二进制 Outbox：`attachment-upload-outbox.service.ts`、`attachment-upload-queue.helpers.ts`。
- 数据安全包：`disaster-backup.service.ts`、`disaster-backup-data-safety.helpers.ts`。

## 8. 自动化测试

本次新增：

- `src/tests/contracts/offline-first-architecture.contract.spec.ts`
- `src/services/network-awareness.service.spec.ts`
- `src/services/mobile-sync-strategy.service.spec.ts`
- `src/services/action-queue-dead-letter-notifier.spec.ts`
- `src/services/attachment-upload-queue.helpers.spec.ts`
- `src/services/disaster-backup.service.spec.ts`
- `src/services/import-backup-conversion.helpers.spec.ts`
- `src/services/action-queue-storage.service.spec.ts`
- `src/app/shared/modals/settings-modal/local-backup-ui.service.spec.ts`
- `src/services/sync-writer-lease.service.spec.ts` 中的 `未显式配置 feature flag 时默认启用 single-writer lease`

相关既有测试：

- `src/tests/contracts/foreground-supabase-write-boundary.contract.spec.ts`
- `src/tests/contracts/local-first-write-path.contract.spec.ts`
- `src/services/task-record-tracking.service.spec.ts` 中的 `should persist local-only snapshots before exposing task mutations to UI`
- `src/services/action-queue.service.spec.ts`
- `src/services/action-queue-outbox-state.spec-helpers.ts`
- `src/services/attachment-upload-outbox.service.spec.ts`
- `src/app/features/text/components/text-unassigned.component.spec.ts`
- `src/services/task-operation-adapter.service.spec.ts`
- `src/services/task-operation.service.spec.ts`
- `src/services/sync-coordinator.service.spec.ts` 中的 `refreshActiveProjectSilent 远端加载期间出现新的本地编辑时不应用旧本地快照合并结果`
- `src/services/sync-coordinator.service.spec.ts` 中的 `downloadAndMerge 在合并期间出现新的本地编辑时不应应用旧合并结果`
- `src/app/core/services/sync/task-sync-operations.service.spec.ts` 中的 `pushTask 在 probe 判定客户端已过期时应保留本地写入到 RetryQueue 且不回退直接 table upsert`
- `src/app/core/services/sync/task-sync-operations.service.spec.ts` 中的 `pushTask 带 operationId 且 sync RPC 不可用时应保留 RetryQueue 并禁止直接 table upsert`
- `src/app/core/services/sync/task-sync-operations.service.spec.ts` 中的 `purgeTasksFromCloudDetailed 带 operationId 且 sync RPC 不可用时应保留 RetryQueue 并禁止 legacy fallback`
- `src/app/core/services/sync/task-sync-operations.service.spec.ts` 中的 `softDeleteTasksBatch 带 operationId 且 sync RPC 不可用时应保留 RetryQueue 并禁止 legacy fallback`
- `src/app/core/services/sync/task-sync-operations.service.spec.ts` 中的 `softDeleteTasksBatch sync RPC 拒绝时应沿用调用方 operationId 与 baseUpdatedAtMap 入队`
- `src/app/core/services/sync/task-sync-operations.service.spec.ts` 中的 `softDeleteTasksBatch 在 sync RPC client rejected 且带 operationId 时应保留 RetryQueue`
- `src/app/core/services/sync/connection-sync-operations.service.spec.ts` 中的 `pushConnection 带 operationId 且 sync RPC 不可用时应保留 RetryQueue 并禁止直接 table upsert`
- `src/app/core/services/sync/connection-sync-operations.service.spec.ts` 中的 `pushConnection 从 RetryQueue 重放且 sync RPC 不可用时应保留原队列项并禁止直接 table upsert`
- `src/app/core/services/simple-sync-runtime.controller.spec.ts` 中的 `connection retry handler should require sync RPC to preserve operationId idempotency`
- `src/app/core/services/simple-sync.service.spec.ts` 中的 `pushProject 带 operationId 且 sync RPC 不可用时应保留 RetryQueue 并禁止直接 projects table upsert`
- `src/app/core/services/simple-sync.service.spec.ts` 中的 `deleteProjectFromCloud 带 operationId 且 sync RPC 不可用时应保留重试且不调用旧删除 RPC`
- `src/services/black-box-sync.service.spec.ts` 中的 `should keep operationId black box pushes pending when sync RPC is unavailable`
- `src/app/core/services/sync/batch-sync.service.spec.ts` 中的 `saveProjectToCloud 应将调用方 operationId 透传给 task purge 回调`
- `src/app/core/services/sync/batch-sync.service.spec.ts` 中的 `position-only 带 operationId 时应走完整 task upsert 而不是无幂等位置直写`
- `src/services/task-repository-batch.service.spec.ts` 中的 `should report failure when connection diff sync has unrecovered batch errors`
- `src/services/task-repository-batch.service.spec.ts` 中的 `should upsert new connections by id so retries are idempotent`
- `src/services/task-repository-batch.service.spec.ts` 中的 `should retry transient connection delete failures before reporting failure`
- `src/services/action-queue-storage.service.spec.ts` 中的 `should defer sync RPC capability gaps without consuming retry budget`
- `src/services/action-queue-storage.service.spec.ts` 中的 `classifies sync RPC capability gaps as deferred`
- `src/app/core/services/sync/retry-queue.service.spec.ts` 中的 `persistNow 写入 IndexedDB 时应合并未本地移除的已有项，避免 clear+put 覆盖其它标签队列`
- `src/app/core/services/sync/retry-queue.service.spec.ts`
- `src/app/core/services/sync/batch-sync.service.spec.ts`
- `src/app/core/services/sync/project-save-plan.spec.ts`
- `src/tests/contracts/offline-first-architecture.contract.spec.ts` 中的 `keeps sync writer lease enabled by default in generated environments`
- `e2e/critical-paths/offline-mode.spec.ts`
- `e2e/critical-paths/sync-flow.spec.ts`

建议持续运行：

```bash
npm run test:contract-specs
npm run test:run:services
npm run test:e2e -- e2e/critical-paths/offline-mode.spec.ts e2e/critical-paths/sync-flow.spec.ts
```

## 9. 手动验收步骤

1. 断网后刷新应用，确认页面从本地快照进入可读状态，无白屏、无限 Loading 或阻塞弹窗。
2. 断网时新增项目、编辑项目、删除项目，确认 UI 立即变化，ActionQueue pending count 增加。
3. 断网时新增、编辑、删除任务，拖拽排序或移动任务，确认 UI 立即变化且刷新后仍在。
4. 断网时上传附件或触发附件相关操作，确认附件 outbox 保留待上传 Blob，ActionQueue 附件元数据引用同一个 `blobKey`。
5. 模拟附件 Blob 持久化失败或浏览器配额耗尽，确认 UI 返回受控失败，不出现 ActionQueue 有附件元数据但 outbox 没有 Blob 的半成功状态。
6. 导出灾难备份数据安全包，确认 `localState` 中包含本地快照、ActionQueue、RetryQueue、dead letters、冲突记录以及 `attachmentUploadOutbox` 的 base64 附件二进制记录；使用恢复 helper 验证该 base64 记录可重新写回附件上传 outbox，`localState.actionQueue` 可按 `operationId` 合并回 owner-scoped IndexedDB Outbox，`localState.retryQueue` 可通过 RetryQueue 服务恢复并过滤非法或跨账号项。
7. 关闭浏览器后重新打开，确认本地快照、ActionQueue、RetryQueue 和 sync cursor 可恢复。
8. 联网后等待后台同步，确认 pending count 自动下降，不要求用户手动触发。
9. 模拟请求 5xx、429、timeout，确认操作进入 RetryQueue 或后台 notice，不回滚已提交本地操作。
10. 模拟鉴权过期，确认非安全写入停止重试且本地队列保留，重新登录后可恢复。
11. 用同一 `operationId` 重放同一操作，确认不会重复创建远端数据。
12. 制造本地和远端同时修改，确认能自动 LWW 或生成冲突记录，双方数据不被静默丢弃。

## 10. 尚未解决的边界问题和后续优化建议

- 为所有实体补齐统一的字段级 conflict policy 表，减少只依赖 LWW 的区域。
- 为数据安全包补齐可视化恢复向导和选择性导入流程；当前导出层已覆盖 ActionQueue、RetryQueue、离线快照、dead letters、冲突与附件上传 outbox，附件 outbox、ActionQueue、RetryQueue 与 dead letters 已具备可复用恢复 helper，但还缺少面向普通用户的选择性恢复界面和逐项预览。
- 增加跨标签并发写入压力测试，覆盖 owner bucket、lease、IDB mutation 与队列折叠。
- 将 active project refresh / download merge 的 local watermark 或 generation gate 扩展到其它后台 refresh 和未来新增远端读合并入口。
- 将 sync writer lease 作为生产默认能力；ActionQueue owner settlement 已改为原子 mutation，RetryQueue IDB `clear+put` 已先合并未移除项，但仍可继续演进为 item-level upsert/delete 以减少写放大，并防止未来新增 full-snapshot 写入入口回退。
- 为请求 timeout 引入 AbortSignal 或 `unknownOutcome` reconcile 状态，避免底层写已成功但客户端按普通失败重复提交。
- 为剩余 REST/direct sync fallback 补 operationId 幂等日志或 payload equality success 判定；无法保证幂等时应 fail closed。当前带 `operationId` 的 task upsert、connection upsert、project metadata upsert、project delete、task purge/delete 与 batch soft delete 已 fail-closed 到 RetryQueue / deferred retry，真实 RetryQueue connection replay 已要求 sync RPC，ProjectSave task purge 已透传 `operationId`，ProjectSave position-only 带 `operationId` 时已改走完整 task upsert，后续重点是 legacy 无 operationId 兼容路径和其它剩余降级入口。
- 鉴权过期时允许 task/connection 以 `paused-auth` 状态 durable 入队，session restored 后再恢复处理。
- 增加大附件离线队列配额测试，验证 storage_frozen、导出、恢复文案和二进制 outbox 行为。
- 为后台 Sync Engine 增加可视化 explain log：最近一次本地写入、operationId、队列状态、RPC 结果、冲突决策、lastSyncTime 变化。
- 增加弱网 E2E：频繁 online/offline、请求超时、服务端 5xx/429、页面挂起恢复和移动端后台恢复。
