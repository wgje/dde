# NanoFlow 全面代码审计报告

> **审计日期**: 2026-02-09  
> **审计范围**: 全代码库 — 状态管理、同步、安全、组件、配置、类型、测试、后端  
> **发现总计**: **120+ 个问题**，其中 P0 致命 12 个、P1 高危 22 个、P2 中危 45 个、P3 低危 40+ 个

---

## 目录

1. [P0 致命问题（必须立即修复）](#1-p0-致命问题必须立即修复)
2. [P1 高危问题（本周内修复）](#2-p1-高危问题本周内修复)
3. [P2 中危问题（下个迭代修复）](#3-p2-中危问题下个迭代修复)
4. [P3 低危问题（排入 Backlog）](#4-p3-低危问题排入-backlog)
5. [测试覆盖缺口](#5-测试覆盖缺口)
6. [修复优先级路线图](#6-修复优先级路线图)

---

## 1. P0 致命问题（必须立即修复）

### P0-01 — BackupService 8 处编译错误，备份/恢复完全不可用

**文件**: `src/app/core/state/persistence/backup.service.ts`

`IndexedDBService` 的 `getAllFromStore`、`getFromStore`、`clearStore` 方法要求 `db: IDBDatabase` 作为第一个参数，但 `BackupService` 漏传了 `db`。

```typescript
// ❌ 当前代码 — 参数错位
const allProjects = await this.indexedDB.getAllFromStore<Project>(DB_CONFIG.stores.projects);
// ✅ 应为
const db = await this.indexedDB.initDatabase();
const allProjects = await this.indexedDB.getAllFromStore<Project>(db, DB_CONFIG.stores.projects);
```

`restoreFromBackup()` 中 4 处 `clearStore` 同样缺少 `db` 参数。**备份和恢复功能在生产环境必然 crash**。

---

### P0-02 — `collectSubtreeIds` 缺循环防护，可致浏览器卡死

**文件**: `src/services/subtree-operations.service.ts`

```typescript
while (stack.length > 0) {
  const currentId = stack.pop()!;
  result.add(currentId);
  // ❌ 已访问节点不阻止重新入栈 → 循环引用时无限循环
  tasks.filter(t => t.parentId === currentId).forEach(child => {
    stack.push(child.id);
  });
}
```

**修复**: 添加 `if (result.has(currentId)) continue;`。此方法被 `TaskMoveService`、`TaskTrashService` 等多处调用。

---

### P0-03 — `detachTask` 将子任务 stage 设为 NaN

**文件**: `src/services/task-move.service.ts`

```typescript
const parent = parentId ? taskMap.get(parentId) : undefined;
if (parent?.stage !== null) {        // undefined !== null === true
  child.stage = parent!.stage + 1;   // undefined + 1 = NaN → 数据损坏
}
```

NaN stage 会穿透布局算法、渲染层和数据库同步。

---

### P0-04 — 双重同步状态源，UI 指示器永远过时

**文件**: `simple-sync.service.ts` vs `sync/batch-sync.service.ts`

`SimpleSyncService` 有自己的 `syncState` signal，`BatchSyncService` 注入的是 `SyncStateService` 并更新其 signal。UI 组件通过 `SimpleSyncService.syncState().isSyncing` 读取，**永远看不到 BatchSync 的进度**。

---

### P0-05 — RetryQueue `minifyItem` 丢失永久 shortId

**文件**: `src/app/core/services/sync/retry-queue.service.ts`

```typescript
data: { ...task, shortId: undefined }  // shortId 被删
```

重试推送时 `short_id: task.shortId` → `null` → **数据库中永久 ID 被覆盖为 null**。

---

### P0-06 — `pushConnection` 会话过期时数据静默丢失

**文件**: `src/app/core/services/sync/connection-sync-operations.service.ts`

```typescript
if (!userId) {
  return false;  // ❌ 不入重试队列，连接数据永久丢失
}
```

对比 `pushTask` 在同样场景下会入队重试。

---

### P0-07 — `mergeOfflineDataOnReconnect` 过滤软删除 → 删除操作丢失

**文件**: `src/services/conflict-resolution.service.ts`

```typescript
tasks: offlineProject.tasks.filter(t => !t.deletedAt)  // 过滤掉离线删除的任务
```

离线删除的任务被过滤 → 不会同步到服务器 → 下次拉取时任务复活。

---

### P0-08 — `smartMerge` 保守模式丢弃超 5 分钟的离线编辑

**文件**: `src/services/conflict-resolution.service.ts`

```typescript
if (taskAge > RECENT_THRESHOLD) {  // 5 分钟
  conservativeSkipCount++;
  continue;  // ❌ 用户数据被丢弃
}
```

tombstone 查询失败 + 编辑超过 5 分钟 = 数据被静默丢弃。

---

### P0-09 — Delta Sync 不检查 tombstone，已删除任务可被复活

**文件**: `src/services/delta-sync-coordinator.service.ts`

`mergeTasksDelta` 完全不查询本地 tombstone。服务器返回的已删除任务会被直接合入本地。

---

### P0-10 — `downloadAndMerge` 可能删除未同步的本地项目

**文件**: `src/services/sync-coordinator.service.ts`

```typescript
if (!hasPendingChanges) continue;  // 项目不加入 mergedProjects
this.projectState.setProjects(mergedProjects);  // 替换所有项目
```

服务器数据丢失时，`pendingSync=false` 的本地项目被静默删除。

---

### P0-11 — ViewState 类型定义冲突

**文件**: `src/models/core-types.ts` vs `src/models/index.ts`

```typescript
// core-types.ts: position?: { x: number; y: number }
// index.ts:      positionX: number; positionY: number
```

两个 `ViewState` 结构完全不同，通过不同路径导入会导致属性访问失败。

---

### P0-12 — `sanitizeProject` 丢弃 Connection 的 `title` 和 `updatedAt`

**文件**: `src/utils/validation.ts`

`updatedAt` 被丢失会破坏 LWW 冲突解决机制。`title`（联系块标题）被永久丢弃。

---

## 2. P1 高危问题（本周内修复）

| # | 问题 | 文件 | 影响 |
|---|------|------|------|
| P1-01 | IndexedDB `dbInitPromise` 失败后永久卡死 | `indexeddb.service.ts` | reject 后所有 IDB 操作永久失败 |
| P1-02 | Meta store keyPath 与使用方式矛盾 | `indexeddb.service.ts` / `store-persistence.service.ts` | `put(meta, 'meta')` 当 keyPath='key' 时违反规范 |
| P1-03 | `putToStore` 在事务提交前 resolve | `indexeddb.service.ts` | 数据可能未持久化就返回成功 |
| P1-04 | `doSaveProject` 不清理旧记录，校验永远失败 | `store-persistence.service.ts` | IndexedDB 数据只增不减 → 降级到 localStorage |
| P1-05 | `loadProject` 不过滤软删除连接 → 已删除连接复活 | `store-persistence.service.ts` | 刷新后软删除的连接重新出现 |
| P1-06 | Auth Guard localStorage 可被 XSS 注入绕过 | `auth.guard.ts` | XSS → 伪造 userId → 绕过认证 |
| P1-07 | `canSwitchProject` — Cancel 仍返回 proceed | `unsaved-changes.guard.ts` | 用户无法阻止项目切换 |
| P1-08 | SVG 上传不检查内嵌 `<script>` | `file-type-validator.service.ts` | XSS 通过恶意 SVG |
| P1-09 | 病毒扫描 fail-open + 超大文件绕过 | `virus-scan.service.ts` | 扫描失败 = 允许下载 |
| P1-10 | GoJS `diagram.div = null` 在 `clear()` 之前 | `flow-diagram.service.ts` | Canvas 事件监听器泄漏 |
| P1-11 | `setupDropHandler` 重复注册 DOM 监听器 | `flow-diagram.service.ts` | 每次重试追加 dragover/drop handler |
| P1-12 | GoJS 事务跨 setTimeout，组件销毁时事务悬空 | `flow-layout.service.ts` | GoJS 事务永远不提交 |
| P1-13 | `taskConnectionsMap` 不过滤软删除连接 | `project-state.service.ts` | UI 显示已删除的连接 |
| P1-14 | `deleteTasksBatch` 只返回第一个任务的删除计数 | `task-operation.service.ts` | Toast 显示数字不准 |
| P1-15 | `restoreTask` 不验证父任务是否还存在 | `task-trash.service.ts` | 恢复后成为孤儿节点 |
| P1-16 | 级联删除子任务连接未保存到 `deletedConnections` | `task-trash.service.ts` | 单独恢复子任务时连接丢失 |
| P1-17 | `pushTaskPosition` 失败不入队 | `task-sync-operations.service.ts` | 离线位置变更永久丢失 |
| P1-18 | `pushConnection` 缺少 Circuit Breaker 检查 | `connection-sync-operations.service.ts` | 熔断后连接仍推送 → 外键违规 |
| P1-19 | 本地连接 tombstone 不持久化 | `tombstone.service.ts` | 刷新后连接从服务器复活 |
| P1-20 | `addAttachmentFallback` TOCTOU 竞态 | `task-repository.service.ts` | 并发附件添加互相覆盖 |
| P1-21 | `UndoService.createProjectSnapshot` 浅拷贝 | `undo.service.ts` | 撤销快照被后续修改污染 |
| P1-22 | `detectAndFixCycles` 使用递归而非迭代 | `layout.service.ts` | 违反项目规范,长链栈溢出 |

---

## 3. P2 中危问题（下个迭代修复）

### 状态管理
| # | 问题 | 文件 |
|---|------|------|
| P2-01 | Signal 双更新非原子（tasksMap + tasksByProject 间存在不一致窗口） | `stores.ts` |
| P2-02 | `setTasks` 覆盖索引而非合并（与 `bulkSetTasks` 行为不一致） | `stores.ts` |
| P2-03 | `removeProject` 不级联清理 TaskStore/ConnectionStore | `stores.ts` |
| P2-04 | `saveTimers` 在 destroy 时未清理 | `store-persistence.service.ts` |
| P2-05 | `deleteBlackBoxEntry` 不更新日期索引 | `focus-stores.ts` |
| P2-06 | 浅拷贝 Map 后仍 mutate 内部 Set | `focus-stores.ts` |

### 安全
| # | 问题 | 文件 |
|---|------|------|
| P2-07 | Auth token 刷新竞态条件 | `auth.service.ts` |
| P2-08 | AbortController 死代码（signal 未传给 getSession） | `auth.service.ts` |
| P2-09 | 全局 fetch wrapper 覆盖调用方 signal | `supabase-client.service.ts` |
| P2-10 | `supabaseErrorToError` 直接 mutate 原始 Error | `supabase-error.ts` |
| P2-11 | Project Guard 缺少所有权验证 | `project.guard.ts` |
| P2-12 | `sanitizeAttachment` 不校验 URL 协议 | `validation.ts` |
| P2-13 | 7 天 Auth Cache 过期时间过长 | `auth.guard.ts` |
| P2-14 | sessionStorage 存储 Fatal Error 堆栈（信息泄露） | `global-error-handler.service.ts` |

### 同步
| # | 问题 | 文件 |
|---|------|------|
| P2-15 | ActionQueue 和 RetryQueue 双队列无去重 | 两个服务 |
| P2-16 | BatchSync 推送期间使用过时数据快照 | `batch-sync.service.ts` |
| P2-17 | RetryQueue `saveToStorage` 异步不等待 | `retry-queue.service.ts` |
| P2-18 | `doTaskPush` vs `pushTaskPosition` 使用不同时间源 | `task-sync-operations.service.ts` |
| P2-19 | CircuitBreaker 状态不持久化（刷新可绕过） | `circuit-breaker.service.ts` |
| P2-20 | softDeleteTasksBatch 缺少 tombstone 缓存失效 | `task-sync-operations.service.ts` |
| P2-21 | `getConnectionTombstoneIds` 未使用缓存 | `connection-sync-operations.service.ts` |

### 组件/GoJS
| # | 问题 | 文件 |
|---|------|------|
| P2-22 | `ProjectShellComponent` 缺少 OnPush | `project-shell.component.ts` |
| P2-23 | `currentFilterLabel()` 模板绑定方法而非 computed | `project-shell.component.ts` |
| P2-24 | `renderMarkdown()` 模板方法触发昂贵解析 | `text-task-card.component.ts` |
| P2-25 | 5+ 个共享组件缺少 OnPush | `toast-container` 等 |
| P2-26 | `connectionsEffect` 始终强制更新 | `flow-diagram-effects.service.ts` |
| P2-27 | `OfflineBannerComponent` timer 未在销毁时清理 | `offline-banner.component.ts` |
| P2-28 | Flow 服务为 root 单例但持有组件级状态 | 全部 Flow 服务 |
| P2-29 | 双重 NgZone.run（事件分发冗余） | `flow-event.service.ts` |
| P2-30 | `FlowDiagramConfigService.buildDiagramData` O(m·n) 复杂度 | `flow-diagram-config.service.ts` |
| P2-31 | HostListener resize 无防抖 | `flow-view.component.ts` |

### 类型/配置
| # | 问题 | 文件 |
|---|------|------|
| P2-32 | Task/Connection/Attachment 双源头类型不一致 | `core-types.ts` vs `index.ts` |
| P2-33 | `supabase-types.ts`（手动）比自动生成版缺少 5 张表 | `models/supabase-types.ts` |
| P2-34 | GoJS 类型重复定义且命名不一致 | `gojs-boundary.ts` vs `gojs-extended.d.ts` |
| P2-35 | `validation.ts` 硬编码常量与 config 重复 | `validation.ts` |
| P2-36 | `UNDO_CONFIG` 持久化上限(50)与桌面上限(150)不一致 | `task.config.ts` |
| P2-37 | `FEATURE_FLAGS` 与 `SYNC_CONFIG` 重复开关无联动 | 两个配置文件 |
| P2-38 | 子路由结构导致不必要的组件重建 | `app.routes.ts` |
| P2-39 | `SyncState.conflictData` 中 `remote` 与 `remoteData` 冗余 | `models/index.ts` |

### 任务操作
| # | 问题 | 文件 |
|---|------|------|
| P2-40 | `updateActiveProjectRaw` 名不副实，实际记录撤销 | `task-operation.service.ts` |
| P2-41 | `normalizeSearchQuery` 移除连字符，shortId 搜索失效 | `search.service.ts` |
| P2-42 | 搜索不包含 `displayId` 和 `shortId` | `search.service.ts` |
| P2-43 | `relinkCrossTreeConnection` 可创建重复连接 | `task-connection.service.ts` |
| P2-44 | 导入不验证内部引用完整性 | `import.service.ts` |
| P2-45 | 导入后不执行 rebalance/validateAndFixTree | `import.service.ts` |

---

## 4. P3 低危问题（排入 Backlog）

| # | 问题 | 文件 |
|---|------|------|
| P3-01 | IndexedDB 缺 `onversionchange` 处理 | `indexeddb.service.ts` |
| P3-02 | `saveAllProjects` 绕过防抖，可能双写 | `store-persistence.service.ts` |
| P3-03 | `pendingBlackBoxEntries` computed 依赖 `new Date()` 不自动更新 | `focus-stores.ts` |
| P3-04 | 模块级 signal 非 DI 管理 | `focus-stores.ts` |
| P3-05 | `getTasksUpdatedSince` 全表加载再过滤 | `delta-sync-persistence.service.ts` |
| P3-06 | 时间戳 `>` 可能漏掉同毫秒更新 | `delta-sync-persistence.service.ts` |
| P3-07 | `cleanupOrphanedData` 不修复 broken connections | `data-integrity.service.ts` |
| P3-08 | 逐条删除不用批量事务 | `data-integrity.service.ts` |
| P3-09 | Sentry ignoreErrors 过于宽泛 | `sentry-lazy-loader.service.ts` |
| P3-10 | `checkSession` 错误和无会话返回相同结果 | `auth.service.ts` |
| P3-11 | 文本格式文件跳过魔数验证 | `file-type-validator.service.ts` |
| P3-12 | `clearAllLocalData` 未清理 Supabase auth token | `user-session.service.ts` |
| P3-13 | PermanentFailureError.toJSON 包含完整堆栈 | `permanent-failure-error.ts` |
| P3-14 | 错误分类规则顺序敏感导致误分类 | `global-error-handler.service.ts` |
| P3-15 | `detectSessionInUrl` 可能泄露 auth 码到 Sentry | `supabase-client.service.ts` |
| P3-16 | 多处使用装饰器而非函数 API（违反 Angular 19 规范） | 多个组件 |
| P3-17 | 流程图区域缺少 ARIA 属性和键盘导航 | `flow-view.component.ts` |
| P3-18 | 过滤器下拉缺少 ARIA 属性 | `project-shell.component.ts` |
| P3-19 | 触摸状态机缺少超时保护 | `flow-touch.service.ts` |
| P3-20 | TabSync remoteEditLocks 无限增长 | `tab-sync.service.ts` |
| P3-21 | BroadcastChannel postMessage 无 try-catch | `tab-sync.service.ts` |
| P3-22 | CircuitBreaker 仅抽样前 10 个任务 | `circuit-breaker.service.ts` |
| P3-23 | Delta Sync content 保护可能屏蔽合法清空操作 | `delta-sync-coordinator.service.ts` |
| P3-24 | `ThemeType` 与 `FlowTheme` 重复定义 | `models/index.ts` vs `flow-styles.ts` |
| P3-25 | `DRAWER_CONFIG` 未用 `as const` | `drawer.config.ts` |
| P3-26 | `UndoService.endBatch` 仅检查位置变更 | `undo.service.ts` |
| P3-27 | `nowISO()` 单调时钟漂移未文档化 | `date.ts` |
| P3-28 | `withTimeout` abort listener 未清理 | `timeout.ts` |
| P3-29 | `restoreFromBackup` 清空+恢复非原子操作 | `backup.service.ts` |
| P3-30 | 附件 URL 刷新路径与上传路径不一致 | `attachment.service.ts` |
| P3-31 | `copyTask` 失败时仍以无效 rank 创建任务 | `task-creation.service.ts` |
| P3-32 | `recordAndUpdate` 操作失败时仍记录撤销 | 多处 |
| P3-33 | `local-backup.config.ts` 错误的类型断言 | `local-backup.config.ts` |
| P3-34 | HMR 已禁用但未留注释 | `angular.json` |
| P3-35 | `rebalance` rank 级联只处理 stage 1 根 | `layout.service.ts` |

---

## 5. 测试覆盖缺口

### 整体覆盖率

| 模块 | 有测试文件比例 | 风险评级 |
|------|--------------|---------|
| 主服务层 (`src/services/`) | ~63% (53/68) | 中 |
| Core Sync 子服务 | **8%** (1/12) | **极高** |
| Core State/Persistence | 33% (2/6) | **高** |
| Flow Services | **6%** (2/35) | **极高** |
| Flow Components | 17% (3/18) | 高 |
| Text View | **0%** | 高 |
| Focus Components | 8% (1/13) | 中 |
| Shared Components | 12% (1/8) | 中 |
| Shared Modals | **0%** | 中 |
| Utils | 33% (3/9) | 中 |

### 关键缺失

1. **Core Sync 子服务**（10 个文件零覆盖）— 同步是产品命脉
2. **持久化层** (IndexedDB/StorePersistence/DeltaSyncPersistence)
3. **task-connection / task-attribute / project-operation** — 核心 CRUD
4. **覆盖率 include 范围**仅含 `src/services/**`，遗漏 `src/app/core/**` 和 `src/utils/**`
5. **Flow 服务的可测试性基础设施** — GoJS mock 策略需升级

### E2E 缺失场景

| 缺失 | 风险 |
|------|------|
| 项目管理 CRUD（创建/删除/切换） | **高** |
| Flow 视图交互（拖拽连线、缩放、小地图） | **高** |
| Text 视图交互（阶段卡片拖拽） | **高** |
| 附件上传/下载/预览 | 中 |
| 撤销/重做操作 | 中 |
| 回收站操作 | 中 |
| 移动端响应式 | 中 |
| 多浏览器兼容性（仅配置了 Chromium） | 低 |

---

## 6. 修复优先级路线图

### 🔴 紧急修复（1-2 天）

| 优先级 | 问题 ID | 预估工时 |
|--------|---------|---------|
| 1 | P0-03 `detachTask` NaN stage | 15 min |
| 2 | P0-02 `collectSubtreeIds` 循环防护 | 10 min |
| 3 | P0-01 BackupService 参数错误 | 30 min |
| 4 | P0-12 `sanitizeProject` 丢失字段 | 15 min |
| 5 | P0-05 RetryQueue shortId 丢失 | 15 min |
| 6 | P0-06 pushConnection 不入队 | 20 min |
| 7 | P1-07 canSwitchProject 逻辑 bug | 10 min |
| 8 | P1-13 taskConnectionsMap 不过滤 deletedAt | 10 min |
| 9 | P1-10 GoJS dispose 顺序 | 5 min |

### 🟡 本周修复（3-5 天）

| 优先级 | 问题 ID | 预估工时 |
|--------|---------|---------|
| 10 | P0-04 双重同步状态源 | 2h |
| 11 | P0-07 mergeOfflineData 过滤软删除 | 1h |
| 12 | P0-08 smartMerge 丢弃数据 | 1h |
| 13 | P0-09 Delta Sync tombstone 检查 | 2h |
| 14 | P0-10 downloadAndMerge 项目保护 | 1h |
| 15 | P0-11 ViewState 类型统一 | 1h |
| 16 | P1-01~P1-05 IndexedDB 系列问题 | 3h |
| 17 | P1-06 Auth Guard XSS 防护 | 1h |
| 18 | P1-08 SVG XSS 验证 | 1h |
| 19 | P1-17 pushTaskPosition 入队 | 30min |
| 20 | P1-19 连接 tombstone 持久化 | 1h |
| 21 | P1-21 Undo 深拷贝 | 30min |

### 🟢 下个迭代

- P2 全部 45 个问题
- 测试覆盖率提升（Core Sync 零覆盖最优先）
- 类型系统统一（消除双源头）

### ⚪ Backlog

- P3 全部 35 个问题
- E2E 补全（Flow/Text 视图交互）
- A11Y 改进
- Angular 19 规范对齐（装饰器→函数 API）

---

## 附录：架构层面的系统性问题

### A. 双源头类型系统

`core-types.ts` 和 `models/index.ts` 中 Task/Connection/Attachment/ViewState 的重复定义是许多 bug 的根因。**建议**：统一为单一数据模型源，删除 `core-types.ts`。

### B. 同步状态分裂

`SimpleSyncService.syncState` vs `SyncStateService` 导致 UI 指示器、防抖调度、持久化触发全部基于不完整的状态视图。**建议**：统一为单一状态源。

### C. Tombstone 策略不完整

任务 tombstone 有本地持久化 + 服务器表 + 缓存策略，但连接 tombstone 仅在内存。**建议**：统一 tombstone 架构。

### D. IndexedDB 抽象层不完善

`IndexedDBService` 的通用方法（`putToStore`）用 `request.onsuccess` 而非 `transaction.oncomplete`；`store-persistence.service.ts` 中的代码则正确处理了事务。**建议**：修复并统一事务提交策略。

### E. 测试金字塔严重失衡

Core Sync 子服务（12 个文件）是系统中最复杂的部分，但测试覆盖率仅 8%。**建议**：优先为 `batch-sync`、`task-sync-operations`、`tombstone` 编写测试。
