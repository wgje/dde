<!-- markdownlint-disable-file -->

# Task Research Notes: sync-chain-layer2-deep-audit-2026-02-07

## Research Executed

### File Analysis

- `docs/sync-chain-layer2-deep-audit-2026-02-07.md`
  - 已逐条复核 12 个跨轮次问题（P0/P1）与运行时结论，主结论方向正确。
- `src/app/core/services/sync/batch-sync.service.ts`
  - `pushProject/pushConnection` 返回值未参与总成功判定，最终固定 `success: true`。
- `src/services/sync-coordinator.service.ts`
  - 下载合并仅遍历 remote 项目并覆盖 `setProjects()`；`finally` 无条件清 `hasPendingLocalChanges`。
- `src/app/core/services/sync/retry-queue.service.ts`
  - 满队列 `shift()`、配额压力 `shrinkQueue()` 删除最早项，存在主动淘汰写操作。
- `src/services/action-queue.service.ts`
  - 队列超限时淘汰低优先级和非关键操作，语义与 RetryQueue 不一致。
- `src/services/action-queue-storage.service.ts`
  - 配额不足时只保留最新 50%，并提示已清理较早操作记录。
- `src/services/change-tracker.service.ts`
  - `clearProjectChanges()` 仅定义未在生产路径调用，`clearTaskChange()` 仅覆盖 delete 清理。
- `src/services/remote-change-handler.service.ts`
  - 合并时依赖 `exportPendingChanges()` 保护脏字段，若脏记录不清理会长期偏向本地。
- `src/app/core/services/simple-sync.service.ts`
  - `taskChangeCallback` 仅赋值未派发；Delta Sync 直接把 snake_case 数据强转为领域模型并用 `nowISO()` 推进游标。
- `src/app/core/services/sync/realtime-polling.service.ts`
  - Realtime 切换时用空 `userId` 重新订阅；任务/连接事件始终回调到项目级 `onRemoteChange`。
- `src/app/core/services/sync/task-sync-operations.service.ts`
  - 拓扑排序采用递归 `visit()`；内建本地 tombstone 持久化实现（与其他服务重复）。
- `src/app/core/services/sync/project-data.service.ts`
  - 内建第二套 tombstone 缓存与本地持久化逻辑。
- `src/app/core/services/sync/tombstone.service.ts`
  - 内建第三套 tombstone 缓存与本地持久化逻辑。
- `src/models/supabase-types.ts`
  - 数据库行类型为 snake_case（`updated_at/deleted_at/parent_id`），与领域模型 camelCase 明确分层。
- `src/config/sync.config.ts`
  - 写明“永不主动丢弃用户数据”，与两队列实际淘汰策略冲突。

### Code Search Results

- `clearProjectChanges(`
  - 生产代码仅定义未调用（仅测试文件调用）；说明缺少“同步成功后项目级脏记录清理闭环”。
- `taskChangeCallback|setTaskChangeCallback`
  - 生产链路中仅定义与赋值，无事件派发；任务级回调链未接通。
- `getSupabaseClient()` + `catch { return null }`
  - 在 `simple-sync/batch-sync/task-sync-operations/project-data/connection-sync/realtime-polling` 等同步关键路径重复出现。
- `setProjects(mergedProjects)`
  - 下载合并最终直接覆盖本地全集，未保留 local-only 项目。
- `queue.length >= MAX_SIZE` / `shrinkQueue` / `slice(-Math.ceil(currentQueue.length / 2))`
  - RetryQueue、ActionQueue、ActionQueueStorage 三处独立淘汰策略并存。

### External Research

- #githubRepo:"supabase/realtime-js postgres_changes channel pattern"
  - 官方仓库示例与当前项目一致，基于 `channel().on('postgres_changes', ...)`，支持按表+过滤订阅。
- #fetch:https://supabase.com/docs/guides/realtime/postgres-changes
  - 官方限制明确：`DELETE` 事件不可过滤；启用 RLS 且 `replica identity full` 时，`old` 记录仅含主键。
- #fetch:https://www.postgresql.org/docs/current/sql-altertable.html#SQL-CREATETABLE-REPLICA-IDENTITY
  - PostgreSQL 定义 `REPLICA IDENTITY` 行为：`DEFAULT` 只记录主键旧值，`FULL` 记录整行旧值（逻辑复制场景）。
- #fetch:https://www.postgresql.org/docs/current/transaction-iso.html
  - Read Committed 下，`SELECT` 看到的是“语句开始时快照”；用客户端 `now` 推进游标会形成边界漏数窗口。
- #fetch:https://supabase.com/docs/reference/javascript/db-modifiers-select
  - Supabase JS 默认 `insert/update/upsert/delete` 不返回修改后的行；需要显式 `.select()`。
- #fetch:https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria
  - Web Storage 每 origin 约 10MiB；超限抛 `QuotaExceededError`；默认为 best-effort 存储并可能被浏览器回收。
- #fetch:https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Errors/Too_much_recursion
  - JS 递归过深会触发 `Maximum call stack size exceeded`，支持“深树递归存在栈风险”的审计结论。

### Project Conventions

- Standards referenced: `AGENTS.md`（离线优先、LWW、不丢写目标、树遍历必须迭代+深度限制、禁止 StoreService 依赖回流等）。
- Instructions followed: `.github/instructions/general.instructions.md`、`.github/instructions/angular.instructions.md`、`.github/instructions/testing.instructions.md`、`.github/instructions/docs.instructions.md`。

## Key Discoveries

### Project Structure

同步链路已形成“双核心并行”结构：

- `SimpleSyncService + RetryQueueService` 负责同步内核与重试。
- `SyncCoordinatorService + ActionQueueService` 负责业务层离线队列与调度。

该结构在“可用性”上有效，但在“单一真相源（source of truth）”上破碎：入队语义、淘汰策略、成功定义、脏标记清理均出现分叉，导致“看似已同步，实则部分丢写/未闭环”的系统性风险。

### Implementation Patterns

真实性复核矩阵（基于源码与运行时）：

- `SYNC-P0-001` 批量部分失败仍报成功：**确认**
- `SYNC-P0-002` 下载覆盖本地全集：**确认**
- `SYNC-P0-003` 队列容量/配额下主动丢写：**确认**
- `SYNC-P0-004` ChangeTracker 缺少成功清理闭环：**确认**
- `SYNC-P0-005` 任务级 Realtime 回调链路：**确认（链路未接通，现退化为项目级）**
- `SYNC-P1-001` finally 无条件清待同步标记：**确认**
- `SYNC-P1-002` Realtime 切换空 `userId`：**确认**
- `SYNC-P1-003` Delta 映射/游标推进：**确认**
- `SYNC-P1-004` 拓扑排序递归违背硬规则：**确认**
- `SYNC-P1-005` Tombstone 三套本地实现并存：**确认**
- `SYNC-CROSS-011` `catch { return null }` 吞错：**确认**
- `SYNC-CROSS-012` ActionQueue/RetryQueue 语义分叉：**确认**

运行时复核（2026-02-07，当前工作区实测）：

- `npm run test:run:services`：失败（3 文件失败，27 失败，585 通过，63 跳过）
- `npm run lint`：失败（92 问题，82 errors，10 warnings）
- `npm run build`：失败（`Could not resolve "dompurify"`）

关键观察：当前自动化失败簇与审计文档中提及的核心簇一致，且均与“同步可靠性护栏未闭环”直接或间接相关。

### Complete Examples

```ts
// 推荐的批量同步“失败闭合”结果聚合器（示意）
interface BatchAggregateResult {
  success: boolean;
  projectPushed: boolean;
  failedTaskIds: string[];
  failedConnectionIds: string[];
  retryEnqueued: string[];
}

async function saveProjectToCloudStrict(project: Project): Promise<BatchAggregateResult> {
  const failedTaskIds: string[] = [];
  const failedConnectionIds: string[] = [];
  const retryEnqueued: string[] = [];

  const projectPushed = await pushProject(project);
  if (!projectPushed) retryEnqueued.push(`project:${project.id}`);

  for (const task of topologicalSortTasks(project.tasks)) {
    const ok = await pushTask(task, project.id, true);
    if (!ok) {
      failedTaskIds.push(task.id);
      addToRetryQueue('task', 'upsert', task, project.id);
      retryEnqueued.push(`task:${task.id}`);
    }
  }

  for (const conn of project.connections) {
    const ok = await pushConnection(conn, project.id, true, true);
    if (!ok) {
      failedConnectionIds.push(conn.id);
      addToRetryQueue('connection', 'upsert', conn, project.id);
      retryEnqueued.push(`connection:${conn.id}`);
    }
  }

  const success = projectPushed && failedTaskIds.length === 0 && failedConnectionIds.length === 0;
  return { success, projectPushed, failedTaskIds, failedConnectionIds, retryEnqueued };
}
```

### API and Schema Documentation

- Supabase `TaskRow/ConnectionRow` 为 snake_case；当前全量加载路径通过 `rowToTask/rowToConnection` 做映射，Delta 路径未映射直接强转，存在字段语义错配风险。
- Realtime `DELETE` 事件天然存在过滤限制；若业务依赖删除细粒度处理，应采用“事件触发 + 主动拉取”而非直接信任 payload。
- PostgreSQL Read Committed 快照语义说明：游标推进应使用“本次实际看到的最大服务端时间戳”，避免用客户端当前时间跳跃推进。

### Configuration Examples

```ts
// src/config/sync.config.ts（当前）
SYNC_CONFIG = {
  DEBOUNCE_DELAY: 3000,
  REALTIME_ENABLED: false,
  POLLING_INTERVAL: 300_000,
  POLLING_ACTIVE_INTERVAL: 60_000,
  DELTA_SYNC_ENABLED: false,
  MAX_RETRY_QUEUE_SIZE: 100
}
```

```ts
// 研究建议：新增“数据耐久优先”开关，替代直接淘汰
SYNC_DURABILITY_CONFIG = {
  DROP_POLICY: 'disabled', // disabled | low-priority-only | aggressive
  STORAGE_PRESSURE_MODE: 'readonly-sync-writes', // 仅阻断新写，不删除历史待同步
  CURSOR_STRATEGY: 'max-server-updated-at' // 禁止 client-now 推进
}
```

### Technical Requirements

- 必须满足离线优先目标：写入不丢、状态不误报成功、删除不复活。
- 必须满足项目硬规则：树遍历改迭代并设置 `MAX_SUBTREE_DEPTH=100`。
- 必须统一“待同步真相源”：单队列、单成功语义、单脏记录清理闭环。
- 必须保留 `content` 字段保护与 tombstone 防复活保护。
- 必须将 `catch { return null }` 替换为可观测的分类错误（离线/未配置/运行时异常）。

## Recommended Approach

选择单一方案：**Durability-First Sync Core（以数据耐久为先的同步内核收敛方案）**。

核心思想：

1. 先修“成功口径”与“不丢写”两条主干，再做架构收敛。
2. 将双队列收敛为“单写入队列 + 明确优先级”，禁止默认淘汰历史操作。
3. 以服务端事实推进游标，以统一映射层做 snake_case→camelCase 转换。
4. 把任务级 Realtime 回调链彻底打通，或明确删除该分支并统一到项目级增量流程（二选一，禁止半接线状态）。
5. Tombstone 本地缓存收敛到单服务（`TombstoneService`），其余服务只调用接口，不维护私有副本。

执行顺序（唯一推荐）：

- Stage A（P0 立即修复）
  - 修正 `BatchSyncService` 总成功判定，返回结构化失败详情。
  - 修正 `downloadAndMerge`，保留 local-only 项目并显式冲突处理。
  - 停用默认队列淘汰；在存储压力下进入“只告警/只读同步写入”模式。
- Stage B（一致性闭环）
  - 同步成功后补齐 `ChangeTracker` 项目级清理闭环。
  - 移除 `finally` 无条件清 `hasPendingLocalChanges`，改为仅在远端确认成功后清理。
- Stage C（链路收敛）
  - 完成 Realtime 任务级链路接线或删除死分支。
  - Delta 路径统一走 `rowToTask/rowToConnection`，游标改为 `max(updated_at)`。
  - 拓扑排序改迭代+深度限制。
  - Tombstone 实现单点化。

## Implementation Guidance

- **Objectives**: 在不牺牲离线体验的前提下，消除“误报成功、主动丢写、删除复活、脏记录长期偏置”四类系统性风险。
- **Key Tasks**: 修复批量成功口径；修复下载合并覆盖；关闭队列淘汰；补齐 ChangeTracker 清理；修正 Realtime/Delta 关键路径；收敛 tombstone 与遍历算法。
- **Dependencies**: `SimpleSyncService`、`SyncCoordinatorService`、`BatchSyncService`、`RetryQueueService`、`ActionQueueService`、`ChangeTrackerService`、`RealtimePollingService`、`DeltaSyncCoordinatorService`、`TombstoneService`。
- **Success Criteria**: 同步失败不再返回成功；local-only 项目下载后不丢失；队列在配额压力下不主动删除关键写；脏记录在成功后可验证清空；Delta 不再出现字段错配与游标漏数；所有树遍历符合迭代+深度限制。
