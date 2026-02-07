# Service Refactoring Analysis — 2026-02-06

## 概览

| # | 文件 | 行数 | 超标 | 任务 |
|---|------|------|------|------|
| 1 | conflict-resolution.service.ts | 1036 | +236 | 3.8 |
| 2 | simple-sync.service.ts | 1032 | +232 | 3.8 |
| 3 | migration.service.ts | 1018 | +218 | 3.8 |
| 4 | dashboard-modal.component.ts | 902 | +102 | 3.9 |
| 5 | change-tracker.service.ts | 899 | +99 | 3.9 |
| 6 | user-session.service.ts | 895 | +95 | 3.9 |
| 7 | flow-overview.service.ts | 887 | +87 | 3.9 |
| 8 | task-sync-operations.service.ts | 872 | +72 | 3.9 |
| 9 | minimap-math.service.ts | 869 | +69 | 3.9 |
| 10 | undo.service.ts | 829 | +29 | 3.9 |
| 11 | text-view-drag-drop.service.ts | 829 | +29 | 3.9 |
| 12 | attachment-export.service.ts | 818 | +18 | 3.9 |
| **总计** | | **10,886** | | |

> 目标上限：800 行/文件

---

## Task 3.8 — Sync 层深度分析

### 1. conflict-resolution.service.ts (1036 行)

**依赖注入 (7):**
- `SentryLazyLoaderService`, `SimpleSyncService`, `LayoutService`, `ToastService`, `ChangeTrackerService`, `LoggerService`

**方法分类:**

| 类别 | 方法 | 行范围 | 行数 |
|------|------|--------|------|
| **冲突检测 (状态)** | `hasConflict` (computed) | L62 | 1 |
| | `conflictData` (computed) | L65 | 1 |
| **冲突策略执行** | `resolveConflict()` | L76-153 | 77 |
| | `resolveKeepBoth()` | L168-237 | 69 |
| **合并核心 (smartMerge)** | `smartMerge()` | L270-470 | 200 |
| | `mergeTaskFields()` | L495-680 | 185 |
| | `mergeConnections()` | L910-975 | 65 |
| **合并辅助** | `isRealContentConflict()` | L700-745 | 45 |
| | `calculateSimilarity()` | L750-770 | 20 |
| | `mergeTextContent()` | L775-810 | 35 |
| | `mergeLines()` | L815-850 | 35 |
| | `mergeTagsWithIntent()` | L990-1037 | 47 |
| **离线重连合并** | `mergeOfflineDataOnReconnect()` | L855-905 | 50 |
| **工具方法** | `generateShortId()` | L242-250 | 8 |
| | `validateAndRebalance()` | L978-982 | 4 |

**建议拆分为 2 个文件:**

| 新文件 | 包含方法 | 预估行数 |
|--------|----------|----------|
| `conflict-resolution.service.ts` (主) | `resolveConflict`, `resolveKeepBoth`, `mergeOfflineDataOnReconnect`, 状态 computed, `validateAndRebalance` | ~300 |
| `conflict-merge.service.ts` (新) | `smartMerge`, `mergeTaskFields`, `mergeConnections`, `isRealContentConflict`, `calculateSimilarity`, `mergeTextContent`, `mergeLines`, `mergeTagsWithIntent`, `generateShortId` | ~650→优化后~550 |

**拆分后预估:** 主文件 ~300 行，合并服务 ~550 行

---

### 2. simple-sync.service.ts (1032 行)

**依赖注入 (16!):**
- `SupabaseClientService`, `LoggerService`, `ToastService`, `RequestThrottleService`, `ClockSyncService`, `EventBusService`, `DestroyRef`
- 子服务 (9): `TombstoneService`, `RealtimePollingService`, `SessionManagerService`, `SyncOperationHelperService`, `UserPreferencesSyncService`, `ProjectDataService`, `BatchSyncService`, `TaskSyncOperationsService`, `ConnectionSyncOperationsService`, `SentryLazyLoaderService`

**方法分类 — 可委托 vs 需保留:**

| 类别 | 方法 | 行范围 | 可委托? |
|------|------|--------|---------|
| **网络/生命周期** | `setupNetworkListeners()` | L254-285 | ❌ 保留 |
| | `startRetryLoop()` | L287-295 | ❌ 保留 |
| | `cleanup()` | L297-308 | ❌ 保留 |
| **熔断器** | `checkCircuitBreaker()` | L300-315 | ✅ → SyncOperationHelperService |
| | `recordCircuitSuccess()` | L317-325 | ✅ → SyncOperationHelperService |
| | `recordCircuitFailure()` | L327-345 | ✅ → SyncOperationHelperService |
| **任务委托 (已是透传)** | `pushTask`, `pullTasks` 等 13 个 | L347-407 | ✅ 已委托，可删除透传 |
| **连接委托** | `pushConnection`, `getConnectionTombstoneIds` | L410-420 | ✅ 已委托 |
| **项目同步** | `pushProject()` | L425-480 | ⚠️ 有内联逻辑，可委托 |
| | `pullProjects()` | L482-500 | ⚠️ 可委托给 ProjectDataService |
| **重试队列** | `loadRetryQueueFromStorage()` | L505-525 | ✅ → RetryQueueService |
| | `saveRetryQueueToStorage()` | L527-545 | ✅ → RetryQueueService |
| | `addToRetryQueue()` | L550-590 | ✅ → RetryQueueService |
| | `checkQueueCapacityWarning()` | L595-660 | ✅ → RetryQueueService |
| | `getQueueTypeBreakdown()` | L665-672 | ✅ → RetryQueueService |
| | `processRetryQueue()` | L680-800 | ✅ → RetryQueueService |
| | `clearRetryQueue()` | L820-828 | ✅ → RetryQueueService |
| **Realtime 透传** | 10 个方法 | L830-900 | ✅ 已委托 |
| **用户偏好透传** | 2 个方法 | L905-915 | ✅ 已委托 |
| **Delta Sync** | `checkForDrift()` | L920-960 | ⚠️ 可委托 |
| **项目加载透传** | 8 个方法 | L975-1020 | ✅ 已委托 |
| **会话管理** | `resetSessionExpired`, `destroy` | L1020-1033 | ❌ 保留 |

**建议拆分:**

1. **重试队列逻辑 (~250行)** → 现有 `RetryQueueService` 已存在但未被使用
   - `loadRetryQueueFromStorage`, `saveRetryQueueToStorage`, `addToRetryQueue`, `processRetryQueue`, `checkQueueCapacityWarning`, `clearRetryQueue`
2. **熔断器逻辑 (~50行)** → `SyncOperationHelperService`
3. **项目同步 (~80行)** → `ProjectDataService`（`pushProject`, `pullProjects`）
4. **删除纯透传方法** — 让调用方直接注入子服务

**拆分后预估:** 主文件 ~400 行（门面 + 状态 + 网络 + 初始化）

---

### 3. migration.service.ts (1018 行)

**依赖注入 (4):**
- `SentryLazyLoaderService`, `SimpleSyncService`, `ToastService`, `LoggerService`

**方法分类:**

| 类别 | 方法 | 行范围 | 行数 |
|------|------|--------|------|
| **迁移检测** | `checkMigrationNeeded()` | L64-97 | 33 |
| | `showMigrationOptions()` | L100-104 | 4 |
| | `getMigrationSummary()` | L720-740 | 20 |
| **迁移执行** | `executeMigration()` | L112-230 | 118 |
| **迁移策略** | `migrateLocalToCloud()` | L370-440 | 70 |
| | `mergeLocalAndRemote()` | L445-520 | 75 |
| | `mergeProjects()` | L525-590 | 65 |
| **快照管理** | `saveMigrationSnapshot()` | L240-290 | 50 |
| | `offerSnapshotDownload()` | L295-320 | 25 |
| | `clearMigrationSnapshot()` | L325-335 | 10 |
| | `recoverFromSnapshot()` | L340-368 | 28 |
| **访客数据管理** | `saveGuestData()` | L595-615 | 20 |
| | `getLocalGuestData()` | L620-670 | 50 |
| | `clearLocalGuestData()` | L690-694 | 4 |
| | `migrateLocalData()` | L675-690 | 15 |
| **v5.9 状态跟踪** | `updateMigrationStatus()` | L755-785 | 30 |
| | `getMigrationStatus()` | L790-800 | 10 |
| | `clearMigrationStatus()` | L805-815 | 10 |
| | `hasUnfinishedMigration()` | L820-825 | 5 |
| | `statusToPhase()` | L830-845 | 15 |
| **数据完整性** | `validateDataIntegrity()` | L850-960 | 110 |
| | `verifyMigrationSuccess()` | L965-1018 | 53 |

**建议拆分为 2 个文件:**

| 新文件 | 包含方法 | 预估行数 |
|--------|----------|----------|
| `migration.service.ts` (主) | 迁移检测 + 执行 + 策略 + 访客数据 | ~450 |
| `migration-integrity.service.ts` (新) | `validateDataIntegrity`, `verifyMigrationSuccess`, 快照管理 (save/offer/clear/recover), 状态跟踪 (update/get/clear/has/statusToPhase) | ~400 |

**拆分后预估:** 主文件 ~450 行，完整性服务 ~400 行

---

## Task 3.9 — 边界文件快速评估

### 4. dashboard-modal.component.ts (902 行)

**依赖 (7):** `ActionQueueService`, `SimpleSyncService`, `AuthService`, `ConflictStorageService`, `ConflictResolutionService`, `SyncCoordinatorService`, `ToastService`

**评估:** 组件混合了同步状态展示 + 冲突列表 + 死信队列管理 + 重同步操作。
**建议:** 提取 `DashboardConflictResolver` 辅助服务 (~200行: `loadConflicts`, `resolveUseLocal/Remote/KeepBoth`, `mapConflictToItem`, `calculateTaskDiffs`)。
**拆分后预估:** 组件 ~650 行，辅助服务 ~250 行

### 5. change-tracker.service.ts (899 行)

**依赖 (1):** `LoggerService`

**评估:** 单一职责但体量过大。方法可分为 3 组：(1) 变更跟踪 CRUD ~300行, (2) 变更验证/报告 ~250行 (`validateChanges`, `generateChangeReport`, `detectDataLossRisks`), (3) 字段锁 ~200行 (`lockTaskField`, `unlockTaskField`, 等)。
**建议:** 提取 `field-lock.service.ts` (~200行) 和 `change-validator.service.ts` (~250行)。
**拆分后预估:** 主文件 ~350 行，字段锁 ~200 行，验证器 ~250 行

### 6. user-session.service.ts (895 行)

**依赖 (12):** `LoggerService`, `AuthService`, `SyncCoordinatorService`, `UndoService`, `UiStateService`, `ProjectStateService`, `AttachmentService`, `MigrationService`, `LayoutService`, `ToastService`, `SupabaseClientService`, `DestroyRef`

**评估:** 过多职责: 用户切换 + 项目加载 + 云端合并 (LWW) + 缓存/种子 + 迁移触发 + 附件监控。
**建议:** 提取 `project-loader.service.ts` (~350行: `loadProjects`, `mergeTasksWithLWW`, `mergeConnectionsWithLWW`, `applyMergedProjects`, `loadFromCacheOrSeed`, `seedProjects`, `migrateProject`)。
**拆分后预估:** 主文件 ~400 行，项目加载 ~400 行

### 7. flow-overview.service.ts (887 行)

**依赖 (5):** `LoggerService`, `NgZone`, `ThemeService`, `FlowTemplateService`, `FlowDiagramConfigService`

**评估:** GoJS Overview 初始化 + 视口绑定更新 + 手动拖拽 Box + 主题更新。大量闭包内联逻辑。
**建议:** 提取 `overview-drag-handler.ts` (~300行: `beginManualBoxDrag`, `applyManualBoxDrag`, `endManualBoxDrag`, 触摸/鼠标事件处理)。
**拆分后预估:** 主文件 ~550 行，拖拽处理 ~300 行

### 8. task-sync-operations.service.ts (872 行)

**依赖 (9):** `SentryLazyLoaderService`, `SupabaseClientService`, `LoggerService`, `ToastService`, `RequestThrottleService`, `ClockSyncService`, `SyncOperationHelperService`, `SessionManagerService`, `TombstoneService`, `ProjectDataService`

**评估:** 已从 SimpleSyncService 拆出。职责集中。`softDeleteTasksBatch` (L497-575, ~80行) 和 `purgeTasksFromCloud` (L576-692, ~116行) 逻辑较密集，但整体可接受。
**建议:** 将 tombstone 本地管理 (`loadLocalTombstones`, `saveLocalTombstones`, `getLocalTombstones`, `addLocalTombstones`, L700-830, ~130行) 移到 `TombstoneService`。
**拆分后预估:** 主文件 ~700 行，TombstoneService 吸收 ~130 行

### 9. minimap-math.service.ts (869 行)

**依赖 (0):** 无注入 — 纯计算服务

**评估:** 全部是纯数学函数（坐标变换、边界计算、拖拽插值）。完美的纯函数候选。
**建议:** 拆成 `minimap-math-core.ts` (纯函数: `calculateScaleRatio`, `worldToMinimap`, `minimapToWorld`, `calculateIndicator`, `unionBounds`, `calculateBoundsFromPoints`, `clampIndicatorPosition`, ~400行) 和 `minimap-drag-math.ts` (拖拽: `updateDragBoundsRealtime`, `updateDragBoundsImmediate`, `endDragSession`, `lerpBoundsEased`, `computeRealtimeMinimapTransform`, ~350行)。无需 `@Injectable`。
**拆分后预估:** core ~400 行，drag ~350 行

### 10. undo.service.ts (829 行)

**依赖 (3):** `ToastService`, `UiStateService`, `LoggerService`

**评估:** 职责清晰（撤销/重做栈管理 + 批量操作 + 持久化）。勉强超标。
**建议:** 提取 `undo-persistence.service.ts` (~150行: `schedulePersist`, `persistToStorage`, `restoreFromStorage`, `clearPersistedData`, `serializeUndoAction`, `deserializeUndoAction`)。
**拆分后预估:** 主文件 ~650 行，持久化 ~150 行

### 11. text-view-drag-drop.service.ts (829 行)

**依赖 (1):** `LoggerService`

**评估:** 桌面鼠标拖拽 + 触摸拖拽 + 幽灵元素 + 自动滚动 + 阶段折叠/展开。
**建议:** 提取 `text-touch-drag.service.ts` (~300行: `startTouchDrag`, `activateDrag`, `handleTouchMove`, `endTouchDrag`, `createDragGhost`, `removeDragGhost`, 触摸自动滚动) 和 `text-auto-scroll.service.ts` (~100行)。
**拆分后预估:** 主文件 ~450 行，触摸拖拽 ~300 行，自动滚动 ~100 行

### 12. attachment-export.service.ts (818 行)

**依赖 (2):** `LoggerService`, `ToastService`

**评估:** 附件收集 + 下载 + ZIP 打包（手动实现 ZIP 格式: `createLocalFileHeader`, `createCentralDirectoryHeader`, `createEndOfCentralDirectory`, `crc32`）。
**建议:** 提取 `zip-builder.ts` 纯工具类 (~250行: ZIP 格式相关方法 + `crc32`)。
**拆分后预估:** 主文件 ~550 行，ZIP 构建 ~250 行

---

## 优先级排序

| 优先级 | 文件 | 超标 | 难度 | 收益 |
|--------|------|------|------|------|
| **P0** | simple-sync.service.ts | +232 | 中 | 高（16 个依赖注入!） |
| **P0** | conflict-resolution.service.ts | +236 | 低 | 高（清晰的 detect/merge 边界） |
| **P1** | migration.service.ts | +218 | 低 | 中（快照/完整性独立性强） |
| **P1** | user-session.service.ts | +95 | 中 | 高（12 依赖，职责过多） |
| **P1** | change-tracker.service.ts | +99 | 低 | 中（字段锁是独立关注点） |
| **P2** | dashboard-modal.component.ts | +102 | 中 | 中 |
| **P2** | flow-overview.service.ts | +87 | 高 | 中（闭包密集难拆） |
| **P2** | minimap-math.service.ts | +69 | 低 | 低（纯函数拆分简单） |
| **P3** | task-sync-operations.service.ts | +72 | 低 | 低（移 tombstone 到已有服务） |
| **P3** | undo.service.ts | +29 | 低 | 低（仅提取持久化） |
| **P3** | text-view-drag-drop.service.ts | +29 | 中 | 低 |
| **P3** | attachment-export.service.ts | +18 | 低 | 低（仅提取 ZIP 工具） |

---

## 预期结果

拆分完成后：
- **新增文件:** ~8–10 个
- **所有文件 ≤ 800 行:** ✅
- **总代码行数变化:** +约 200 行（import/export 开销）
- **测试影响:** 新文件需要对应的 `.spec.ts`，但因为是纯移动代码，可以迁移现有测试
