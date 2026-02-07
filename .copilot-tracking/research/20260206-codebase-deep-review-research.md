<!-- markdownlint-disable-file -->

# Task Research Notes: NanoFlow 代码库深度审查

## Research Executed

### File Analysis

- 总代码量：84,699 行（236 个非测试 TypeScript 文件）
- 超过 800 行的文件：**23 个**（违反项目规范上限 800 行）
- 测试文件数量：53 个 spec 文件（覆盖 234 个源文件中的 49%）
- 配置文件总量：2,744 行（16 个配置文件）
- node_modules 体积：361MB（381 个包）

### Code Search Results

- `@deprecated` 标记：22 处（非测试代码）
- `as any` 使用：116 处（测试代码），1 处（生产代码）
- `.find()` 线性搜索：164 处（非测试），其中 132 处为 `.find(t => t.id)` 模式
- `TODO/FIXME/HACK/WORKAROUND`：13 处
- `技术债` 注释：38 处（非测试），14 处（测试）
- `catch` 后 `return null/undefined/[]/{}`：34 处（错误吞噬）
- `new Map(map)` 完整克隆：20 处
- `setCallbacks` 调用：20 处
- `recordAndUpdate` 使用：64 处
- `getActiveProject()` 调用：28 处
- RxJS Subject 实例：11 个 vs Signal 使用：265 处
- `JSON.stringify` 用于比较：4 处
- `navigator.onLine` 直接检查：7 处
- 纯代理方法（无逻辑透传）：21 处
- `@Injectable` 总数：121 个服务

### Project Conventions

- Standards referenced: AGENTS.md, `.github/instructions/general.instructions.md`, `.github/instructions/angular.instructions.md`
- 声明的规范：单文件 200-400 行为宜，最大不超过 800 行；函数不超过 50 行；嵌套不超过 4 层
- 声明的状态管理：Angular Signals（非 RxJS Store）
- 声明的错误处理：Result 模式而非 try/catch

## Key Discoveries

### 1. 文件行数违规（P0 - 架构问题）

**23 个文件超过 800 行上限**，最严重的 Top 15：

| # | 文件 | 行数 | 超出 |
|---|------|------|------|
| 1 | `types/supabase.ts`（自动生成） | 1,492 | N/A |
| 2 | `app.component.ts` | 1,475 | +84% |
| 3 | `task-operation-adapter.service.ts` | 1,423 | +78% |
| 4 | `action-queue.service.ts` | 1,376 | +72% |
| 5 | `task-repository.service.ts` | 1,198 | +50% |
| 6 | `flow-template.service.ts` | 1,169 | +46% |
| 7 | `text-view.component.ts` | 1,162 | +45% |
| 8 | `flow-task-detail.component.ts` | 1,147 | +43% |
| 9 | `flow-link.service.ts` | 1,123 | +40% |
| 10 | `flow-diagram.service.ts` | 1,098 | +37% |
| 11 | `flow-view.component.ts` | 1,037 | +30% |
| 12 | `conflict-resolution.service.ts` | 1,036 | +30% |
| 13 | `simple-sync.service.ts` | 1,032 | +29% |
| 14 | `migration.service.ts` | 1,018 | +27% |
| 15 | `dashboard-modal.component.ts` | 902 | +13% |

**根因分析**：
- `app.component.ts`：25 个 inject() 依赖，承担了项目管理、搜索、认证、模态框协调、Service Worker 更新等全部顶层逻辑
- `task-operation-adapter.service.ts`：适配器模式导致大量代理方法（21 个纯透传方法 + 回调桥接）
- `action-queue.service.ts`：1,376 行实现了完整的离线操作队列，包含 IndexedDB 备份、死信队列、处理器注册

### 2. 服务层膨胀（P0 - 架构问题）

**121 个 @Injectable 服务**，分布如下：

| 层级 | 数量 | 示例 |
|------|------|------|
| `src/services/` 顶层 | 69 | 核心业务服务 |
| `src/app/core/services/` | 14 | 同步子服务 |
| `src/app/core/state/` | 9 | 状态管理 |
| `src/app/features/flow/services/` | 31 | GoJS 图表服务 |

**同步相关服务链（26+ 个服务）**：

```
SimpleSyncService (1032行, 17个依赖)
├── TaskSyncOperationsService (872行)
├── ConnectionSyncOperationsService
├── BatchSyncService
├── RetryQueueService (663行)
├── ProjectDataService
├── RealtimePollingService
├── SessionManagerService
├── SyncOperationHelperService
├── TombstoneService
├── UserPreferencesSyncService
├── RequestThrottleService (402行)
├── ClockSyncService
└── EventBusService

SyncCoordinatorService (788行, 18个依赖)
├── SimpleSyncService
├── ActionQueueService (1376行)
├── ActionQueueProcessorsService
├── DeltaSyncCoordinatorService
├── ProjectSyncOperationsService
├── ConflictResolutionService (1036行)
├── ConflictStorageService
├── ChangeTrackerService (899行)
├── SyncModeService
└── PersistSchedulerService

辅助服务:
├── TabSyncService (728行)
├── MobileSyncStrategyService
├── RemoteChangeHandlerService (667行)
├── NetworkAwarenessService (414行)
├── BlackBoxSyncService
└── OfflineIntegrityService
```

**核心矛盾**：AGENTS.md 声明"不要造轮子"，但 Supabase Realtime 被禁用（`REALTIME_ENABLED: false`），取而代之的是 26+ 个服务手工实现了轮询 + LWW + 熔断 + 重试的完整同步基础设施。

### 3. 回调模式横行（P1 - 设计缺陷）

**20 处 `setCallbacks` 调用**，形成以下回调传递链：

```
TaskOperationAdapterService.constructor()
  → TaskOperationService.setCallbacks()
    → TaskTrashService.setCallbacks()
    → TaskCreationService.setCallbacks()
    → TaskMoveService.setCallbacks()
    → TaskAttributeService.setCallbacks()
    → TaskConnectionService.setCallbacks()

SimpleSyncService.constructor()
  → BatchSyncService.setCallbacks()
  → TaskSyncOperationsService.setCallbacks()
  → ConnectionSyncOperationsService.setCallbacks()
```

**问题**：
- 服务之间不通过 DI 直接注入，而是通过运行时回调传递引用
- 回调注册发生在 constructor 中，但依赖的服务可能尚未初始化
- 64 处 `recordAndUpdate` 调用全部依赖回调链正常工作
- AGENTS.md 已规划"纯状态驱动架构"作为替代，但从未实施

### 4. 错误处理双标（P1 - 代码质量）

**已建立的 Result 模式**（360 行，包含完整工具函数）：
- `success()`, `failure()`, `wrapWithResult()`, `tryCatch()`, `tryCatchAsync()`
- ESLint 规则明确禁止 `catch { return null }` 模式

**实际违规 34 处**：

| 文件 | 违规数 | 模式 |
|------|--------|------|
| `conflict-storage.service.ts` | 1 | `return null` |
| `export.service.ts` | 2 | `// 忽略存储错误` |
| `preference.service.ts` | 1 | `return null` |
| `action-queue.service.ts` | 1 | `return null` |
| `clock-sync.service.ts` | 1 | `return null` |
| `data-preloader.service.ts` | 3 | `{ /* 忽略错误 */ }` + 空 `.catch()` |
| `migration.service.ts` | 2 | `return null` |
| `theme.service.ts` | 1 | `{ /* ignore */ }` |
| `attachment.service.ts` | 2 | `return null` |
| `store-persistence.service.ts` | 1 | `return null` |
| `project-data.service.ts` | 1 | `return null` |
| `batch-sync.service.ts` | 1 | `return null` |
| 其他 | ~17 | 类似模式 |

### 5. 测试覆盖率严重不足（P1 - 质量风险）

**服务层测试覆盖率：49%**（69 个服务文件中 35 个无测试）

关键**无测试**服务：

| 风险等级 | 文件 | 行数 | 职责 |
|----------|------|------|------|
| **极高** | `task-move.service.ts` | 734 | 任务移动（核心操作） |
| **极高** | `task-creation.service.ts` | N/A | 任务创建（核心操作） |
| **极高** | `subtree-operations.service.ts` | N/A | 子树操作（核心操作） |
| **极高** | `user-session.service.ts` | 895 | 用户会话管理 |
| **高** | `layout.service.ts` | 784 | 布局计算 |
| **高** | `local-backup.service.ts` | 742 | 本地备份（数据保护） |
| **高** | `migration.service.ts` | 1018 | 数据迁移 |
| **高** | `attachment.service.ts` | 705 | 附件管理 |
| **高** | `supabase-client.service.ts` | N/A | Supabase 客户端 |
| **高** | `virus-scan.service.ts` | 649 | 安全防护 |
| **中** | `logger.service.ts` | 300 | 日志系统 |
| **中** | `preference.service.ts` | N/A | 偏好设置 |
| **中** | `clock-sync.service.ts` | N/A | 时钟同步 |
| **中** | `event-bus.service.ts` | 214 | 事件总线 |
| **中** | `connection-adapter.service.ts` | N/A | 连接适配 |

**测试中的 `as any` 问题**：116 处通过 `(service as any).privateMethod` 访问私有成员，说明测试与实现耦合。

### 6. 性能问题（P1 - 运行时影响）

#### 6.1 Map 克隆风暴
`stores.ts` 中每次 signal 更新都完整克隆 Map（20 处 `new Map(map)`）：
- `setTask()`: 2 次 Map 克隆（tasksMap + tasksByProject）
- `setTasks()`: 2 次 Map 克隆
- `removeTask()`: 2 次 Map 克隆
- `clearProject()`: 2 次 Map 克隆

批量操作 N 个任务 = 2N 次 Map 克隆。

#### 6.2 O(n) 线性搜索
132 处 `.find(t => t.id === taskId)` 模式，尽管已有 `TaskStore.getTask(id)` 的 O(1) 查找。高频调用路径包括：
- `flow-view.component.ts`: `projectState.tasks().find(t => t.id === id)`
- `text-view.component.ts`: 至少 8 处线性搜索
- `task-operation.service.ts`: `project.tasks.find(t => t.id === taskId)`
- `conflict-resolution.service.ts`: 多种合并路径中使用线性搜索

#### 6.3 JSON.stringify 比较
4 处使用 `JSON.stringify()` 做深比较，最热的路径在 `task-operation-adapter.service.ts` 的变更检测中重复调用。

### 7. 构建配置矛盾（P2 - DevOps 问题）

所有构建脚本（`start`, `build`, `build:strict`, `build:dev`）均设置：
```
NG_BUILD_TYPE_CHECK=0
NG_BUILD_MAX_WORKERS=1
NG_BUILD_PARALLEL_TS=0
ESBUILD_WORKER_THREADS=0
```

- `tsconfig.json` 启用了 `strict: true` + 全部严格检查
- 但 `NG_BUILD_TYPE_CHECK=0` 在构建期间完全禁用了类型检查
- 这意味着 TypeScript strict mode 仅在 IDE 中生效，CI/CD 构建绕过了所有类型安全
- `MAX_WORKERS=1` 和 `PARALLEL_TS=0` 限制了构建性能，可能是内存问题的 workaround

### 8. 安全隐患（P2 - 安全问题）

#### 8.1 Navigator Lock 被禁用
`supabase-client.service.ts:77-81` 完全绕过了 Supabase Auth 的锁机制：
```typescript
lock: async <T>(_name: string, _acquireTimeout: number, fn: () => Promise<T>): Promise<T> => {
    return await fn();
}
```
后果：多标签页同时刷新 token 可能导致会话冲突、token 竞争。

#### 8.2 全局 120 秒 fetch 超时
每个 Supabase 请求都创建 AbortController + 120s 超时。简单查询也允许挂起 2 分钟。

#### 8.3 data-preloader.service.ts 内联脚本
`getPreloadScript()` 返回包含 API Key 的内联 `<script>` 模板字符串，存在 copy-paste 泄露风险。

### 9. 依赖关系混乱（P2 - 架构问题）

跨层引用统计：
- `src/services/` → `src/app/core/`: 17 处（服务层引用核心层）
- `src/app/core/` → `src/services/`: 70 处（核心层引用服务层）

**问题**：`services/` 和 `app/core/services/` 之间没有明确的层级关系，互相引用。`SyncCoordinatorService`（在 services/）注入了 `SimpleSyncService`（在 app/core/services/），而后者又引用了多个 services/ 下的服务。

### 10. @deprecated 死代码（P3 - 代码卫生）

22 处 `@deprecated` 标记，分布在：
- `task-operation.service.ts`: 6 处（"内部实现已迁移到 TaskTrashService，保留此接口兼容性"）
- `task-operation-adapter.service.ts`: 6 处（"使用 this.core.xxx 替代"）
- `task-operation.service.ts`: 2 处 interface（"使用 XxxService 的 XxxParams"）
- `sync-coordinator.service.ts`: 1 处（"使用 this.core 替代"）
- `auth.guard.ts`: 1 处

这些标记最早可追溯到"Sprint 9 技术债务修复"，至今未清理。

## Recommended Approach

### 优先级矩阵

| 优先级 | 问题类别 | 影响度 | 修复难度 | 建议行动 |
|--------|----------|--------|----------|----------|
| **P0-1** | 文件行数违规 Top 5 | 高 | 中 | 拆分 app.component / task-operation-adapter / action-queue |
| **P0-2** | 服务层膨胀（同步） | 高 | 高 | 评估启用 Supabase Realtime 替代手工轮询 |
| **P1-1** | 回调模式 → 状态驱动 | 高 | 高 | 渐进消除 setCallbacks，改用直接 DI |
| **P1-2** | 错误吞噬 34 处 | 中 | 低 | 逐个替换为 Result 模式或 wrapWithResult |
| **P1-3** | 测试覆盖率 49% | 高 | 中 | 优先补全 task-move / task-creation / subtree-operations / user-session |
| **P1-4** | O(n) 线性搜索 132 处 | 中 | 低 | 替换为 TaskStore.getTask(id) 的 O(1) 查找 |
| **P2-1** | 构建类型检查禁用 | 中 | 低 | 在 CI 中恢复 NG_BUILD_TYPE_CHECK=1 |
| **P2-2** | Navigator Lock 禁用 | 中 | 中 | 评估 Supabase Auth 锁的兼容方案 |
| **P2-3** | 依赖层级混乱 | 中 | 高 | 定义 services/ vs app/core/ 的单向依赖规则 |
| **P3-1** | @deprecated 清理 | 低 | 低 | 使用 knip 工具批量检测并删除死代码 |
| **P3-2** | Map 克隆优化 | 低 | 中 | 评估 immer 或 structuredClone 替代方案 |

### 最高优先级行动建议

**Phase 1 — 低风险快赢（1-2 周）**
1. 清理 22 处 @deprecated 死代码
2. 替换 34 处错误吞噬为 Result 模式
3. 在 CI 中恢复类型检查 (`NG_BUILD_TYPE_CHECK=1`)
4. 将 `.find(t => t.id)` 热路径替换为 Store 的 O(1) 查找

**Phase 2 — 结构性改善（2-4 周）**
5. 拆分 app.component.ts（提取模态框协调器、搜索管理器、认证协调器）
6. 补全关键服务测试（task-move, task-creation, subtree-operations, user-session）
7. 消除 TaskOperationService 的回调模式（直接注入 ProjectStateService）

**Phase 3 — 架构级优化（1-2 月）**
8. 评估同步架构简化：Supabase Realtime vs 手工轮询
9. 定义层级依赖规则（services/ → 不可引用 → app/core/services/）
10. 统一 Signal/RxJS 策略：将 11 个 Subject 迁移到 Signal

## Implementation Guidance

- **Objectives**: 将代码库从 121 个服务的过度工程状态，沿着项目自身规范收敛到可维护水平
- **Key Tasks**: (1) 消除文件行数违规 (2) 提升测试覆盖率到 70%+ (3) 统一错误处理模式 (4) 简化同步架构
- **Dependencies**: Phase 2 依赖 Phase 1 的死代码清理；Phase 3 依赖 Phase 2 的测试覆盖
- **Success Criteria**: (1) 0 个文件超过 800 行 (2) 0 处 catch-return-null (3) 服务测试覆盖率 ≥70% (4) 0 个 @deprecated 标记

---

## GoJS 服务文件深度分析（拆分重构专项）

> 分析日期: 2026-02-06 | 四个文件合计 **4,427 行**，均超过 800 行规范上限

---

### 1. FlowTemplateService (`flow-template.service.ts`)

| 属性 | 值 |
|------|-----|
| **总行数** | **1,169** |
| **超标** | +369 行（上限 800） |

#### 依赖注入

| 服务 | 用途 |
|------|------|
| `UiStateService` | 移动端判断 |
| `FlowDiagramConfigService` | GoJS 配置 |
| `LoggerService` | 日志 |
| `ThemeService` | 主题/暗色模式 |

#### 方法清单与分类

| # | 方法 | 行范围 | 行数 | 分类 |
|---|------|--------|------|------|
| 1 | `getCurrentFlowStyles()` | L60-65 | 6 | 🔧 共用工具 |
| 2 | `getNodeStyleConfig()` | L68-79 | 12 | 🟢 节点模板 |
| 3 | `getLinkStyleConfig()` | L81-95 | 15 | 🔵 连接线模板 |
| 4 | `getPortConfigs()` | L97-104 | 8 | 🟢 节点模板 |
| 5 | `ensureDiagramLayers()` | L111-133 | 23 | 🔧 共用工具 |
| 6 | `computePerimeterIntersection()` | L136-188 | 53 | 🔧 几何算法 |
| 7 | `computeNodeEdgePoint()` | L190-223 | 34 | 🔧 几何算法 |
| 8 | `setupNodeTemplate()` | L226-396 | **171** | 🟢 节点模板 |
| 9 | `setupLinkTemplate()` | L410-471 | 62 | 🔵 连接线模板（入口） |
| 10 | `createGetLinkPointFunction()` | L474-595 | **122** | 🔵 连接线模板 |
| 11 | `configureLinkingTool()` | L597-729 | **133** | 🔵 连接线模板 |
| 12 | `configureRelinkingTool()` | L731-946 | **216** | 🔵 连接线模板 |
| 13 | `createConnectionLabelPanel()` | L949-1077 | **129** | 🔵 连接线模板 |
| 14 | `setupOverviewNodeTemplate()` | L1079-1117 | 39 | 🟡 Overview 模板 |
| 15 | `setupOverviewLinkTemplate()` | L1119-1143 | 25 | 🟡 Overview 模板 |
| 16 | `setupOverviewBoxStyle()` | L1146-1161 | 16 | 🟡 Overview 模板 |
| 17 | `getLinkCurveConfig()` | L1163-1168 | 6 | 🔵 连接线模板 |

#### 分类统计

| 分类 | 方法数 | 总行数 |
|------|--------|--------|
| 🟢 **节点模板** | 3 | ~191 |
| 🔵 **连接线模板** | 7 | ~683 |
| 🟡 **Overview 模板** | 3 | ~80 |
| 🔧 **共用工具/几何** | 4 | ~116 |

#### 建议拆分方案

| 新文件 | 内容 | 预计行数 |
|--------|------|----------|
| `flow-template.service.ts`（保留） | 节点模板 + 共用工具 + 几何算法 | ~380 |
| `flow-link-template.service.ts`（新建） | 连接线模板全部方法 | ~700 |
| `flow-overview-template.service.ts`（新建）或合入已有 `FlowOverviewService` | Overview 模板方法 | ~80 |

> ⚠️ **连接线模板仍超 700 行**，可进一步拆分 `configureRelinkingTool()`（216 行）为 `flow-relink-tool.service.ts`，使两个文件各约 350-400 行。

---

### 2. FlowLinkService (`flow-link.service.ts`)

| 属性 | 值 |
|------|-----|
| **总行数** | **1,123** |
| **超标** | +323 行 |

#### 依赖注入

| 服务 | 用途 |
|------|------|
| `ProjectStateService` | 任务/项目数据 |
| `TaskOperationAdapterService` | 任务 CRUD |
| `LoggerService` | 日志 |
| `ToastService` | 提示 |
| `NgZone` | Angular Zone |
| `DestroyRef` | 自动清理 |

#### 方法清单与分类

| # | 方法 | 行范围 | 行数 | 分类 |
|---|------|--------|------|------|
| 1 | `toggleLinkMode()` | L96-102 | 7 | 🔗 连接模式 |
| 2 | `cancelLinkMode()` | L104-108 | 5 | 🔗 连接模式 |
| 3 | `handleLinkModeClick()` | L114-147 | 34 | 🔗 连接模式 |
| 4 | `showLinkTypeDialog()` | L149-177 | 29 | 📋 对话框 |
| 5 | `confirmParentChildLink()` | L179-218 | 40 | 🔨 连接 CRUD |
| 6 | `confirmCrossTreeLink()` | L220-240 | 21 | 🔨 连接 CRUD |
| 7 | `cancelLinkCreate()` | L242-244 | 3 | 📋 对话框 |
| 8 | `handleLinkGesture()` | L256-354 | **99** | ✅ 连接验证/路由 |
| 9 | `handleTaskToUnassignedLink()` | L356-419 | **64** | 🔨 连接 CRUD |
| 10 | `handleParentChildRelink()` | L421-517 | **97** | 🔄 重连逻辑 |
| 11 | `handleParentChildRelinkToEnd()` | L519-609 | **91** | 🔄 重连逻辑 |
| 12 | `handleCrossTreeRelink()` | L622-691 | **70** | 🔄 重连逻辑 |
| 13 | `handleMoveSubtreeToRoot()` | L693-737 | 45 | 🔄 重连逻辑 |
| 14 | `collectSubtreeIds()` | L739-751 | 13 | 🔧 工具方法 |
| 15 | `openConnectionEditor()` | L759-821 | **63** | 📝 编辑器 UI |
| 16 | `closeConnectionEditor()` | L822-826 | 5 | 📝 编辑器 UI |
| 17 | `saveConnectionContent()` | L832-845 | 14 | 📝 编辑器 UI |
| 18 | `deleteCurrentConnection()` | L849-865 | 17 | 📝 编辑器 UI |
| 19 | `getConnectionTasks()` | L867-877 | 11 | 📝 编辑器 UI |
| 20 | `startDragConnEditor()` | L881-906 | 26 | 📝 编辑器拖动 |
| 21 | `updateDiagramBounds()` | L908-924 | 17 | 📝 编辑器拖动 |
| 22 | `onDragConnEditor` (箭头函数) | L929-972 | 44 | 📝 编辑器拖动 |
| 23 | `stopDragConnEditor` (箭头函数) | L977-983 | 7 | 📝 编辑器拖动 |
| 24 | `showLinkDeleteHint()` | L982-1010 | 29 | 🗑️ 连接删除 |
| 25 | `confirmLinkDelete()` | L1011-1028 | 18 | 🗑️ 连接删除 |
| 26 | `cancelLinkDelete()` | L1029-1031 | 3 | 🗑️ 连接删除 |
| 27 | `deleteLink()` | L1036-1054 | 19 | 🗑️ 连接删除 |
| 28 | `handleDeleteCrossTreeLinks()` | L1058-1069 | 12 | 🗑️ 连接删除 |
| 29 | `dispose()` | L1075-1087 | 13 | 🔧 生命周期 |
| 30 | `activate()` | L1092-1094 | 3 | 🔧 生命周期 |
| 31 | `deleteLinkInternal()` | L1101-1123 | 23 | 🗑️ 连接删除 |

#### 分类统计

| 分类 | 方法数 | 总行数 |
|------|--------|--------|
| 🔗 **连接模式管理** | 3 | ~46 |
| 📋 **对话框** | 2 | ~32 |
| 🔨 **连接 CRUD** | 3 | ~125 |
| ✅ **连接验证/路由** | 1 | ~99 |
| 🔄 **重连逻辑** | 4 | ~303 |
| 📝 **编辑器 UI + 拖动** | 8 | ~187 |
| 🗑️ **连接删除** | 6 | ~104 |
| 🔧 **工具/生命周期** | 4 | ~32 |

#### 建议拆分方案

| 新文件 | 内容 | 预计行数 |
|--------|------|----------|
| `flow-link.service.ts`（保留） | 连接模式 + 对话框 + CRUD + 验证路由 + 删除 | ~450 |
| `flow-link-relink.service.ts`（新建） | 全部重连逻辑 (4 个方法) | ~320 |
| `flow-connection-editor.service.ts`（新建） | 编辑器 UI + 拖动 (8 个方法) | ~200 |

> 拆分后 3 个文件约 450 + 320 + 200 = 970 行（含 import/class boilerplate），全部低于 500 行。

---

### 3. FlowDiagramService (`flow-diagram.service.ts`)

| 属性 | 值 |
|------|-----|
| **总行数** | **1,098** |
| **超标** | +298 行 |

#### 依赖注入

| 服务 | 用途 |
|------|------|
| `SentryLazyLoaderService` | 错误上报 |
| `ProjectStateService` | 项目/任务数据 |
| `UiStateService` | UI 状态 |
| `TaskOperationAdapterService` | 任务操作 |
| `SyncCoordinatorService` | 同步调度 |
| `LoggerService` | 日志 |
| `ToastService` | 提示 |
| `NgZone` | Angular Zone |
| `FlowDiagramConfigService` | 配置 |
| `ThemeService` | 主题 |
| `FlowLayoutService` | 布局 |
| `FlowSelectionService` | 选择 |
| `FlowZoomService` | 缩放 |
| `FlowEventService` | 事件 |
| `FlowTemplateService` | 模板 |
| `FlowOverviewService` | 小地图 |
| `MinimapMathService` | 小地图计算 |

> **注意**: 17 个依赖！这是代码膨胀的直接原因。

#### 方法清单与分类

| # | 方法 | 行范围 | 行数 | 分类 |
|---|------|--------|------|------|
| 1 | `initialize()` | L164-269 | **106** | 🚀 初始化 |
| 2 | `setupDesktopPanAndSelectTools()` | L271-313 | 43 | 🚀 初始化（工具配置） |
| 3 | `setupMultiSelectClickTool()` | L320-423 | **104** | 🚀 初始化（多选） |
| 4 | `suspend()` | L425-453 | 29 | ⏸️ 生命周期 |
| 5 | `resume()` | L455-499 | 45 | ⏸️ 生命周期 |
| 6 | `initializeOverview()` | L509-521 | 13 | 🗺️ 小地图 |
| 7 | `applyCanvasBackground()` | L523-531 | 9 | 🎨 主题 |
| 8 | `disposeOverview()` | L537-541 | 5 | 🗺️ 小地图 |
| 9 | `refreshOverview()` | L547-550 | 4 | 🗺️ 小地图 |
| 10 | `dispose()` | L552-580 | 29 | ⏸️ 生命周期 |
| 11 | `exportToPng()` | L585-617 | 33 | 📤 导出 |
| 12 | `exportToSvg()` | L619-651 | 33 | 📤 导出 |
| 13 | `getExportFileName()` | L653-658 | 6 | 📤 导出 |
| 14 | `downloadBlob()` | L660-668 | 9 | 📤 导出 |
| 15 | `removeLink()` | L676-690 | 15 | 🔨 图表操作 |
| 16 | `selectNode()` | L692-694 | 3 | 🔨 图表操作 |
| 17 | `getLastInputViewPoint()` | L699-701 | 3 | 🔨 图表操作 |
| 18 | `onFlowActivated()` | L706-727 | 22 | 🔨 图表操作 |
| 19 | `detectStructuralChange()` | L730-773 | 44 | 📊 数据同步 |
| 20 | `updateDiagram()` | L775-890 | **116** | 📊 数据同步 |
| 21 | `setupDropHandler()` | L894-932 | 39 | 🖱️ 拖放 |
| 22 | `setupDeleteKeyInterception()` | L943-967 | 25 | 🚀 初始化 |
| 23 | `setupResizeObserver()` | L969-990 | 22 | 🚀 初始化 |
| 24 | `saveViewState()` | L992-1017 | 26 | 💾 视图状态 |
| 25 | `restoreViewState()` | L1019-1063 | 45 | 💾 视图状态 |
| 26 | `clearAllTimers()` | L1065-1082 | 18 | ⏸️ 生命周期 |
| 27 | `handleError()` | L1084-1089 | 6 | 🔧 工具 |
| 28 | `setOverviewFixedBounds()` | L1092-1098 | 7 | 🗺️ 小地图 |

#### 分类统计

| 分类 | 方法数 | 总行数 |
|------|--------|--------|
| 🚀 **初始化（含工具配置）** | 5 | ~300 |
| ⏸️ **生命周期（suspend/resume/dispose）** | 4 | ~121 |
| 🗺️ **小地图** | 4 | ~29 |
| 📤 **导出** | 4 | ~81 |
| 🔨 **图表操作** | 4 | ~43 |
| 📊 **数据同步** | 2 | ~160 |
| 💾 **视图状态** | 2 | ~71 |
| 🖱️ **拖放** | 1 | ~39 |
| 🎨 **主题** | 1 | ~9 |
| 🔧 **工具** | 1 | ~6 |

#### 建议拆分方案

| 新文件 | 内容 | 预计行数 |
|--------|------|----------|
| `flow-diagram.service.ts`（保留） | 初始化 + 生命周期 + 小地图委托 + 图表操作 | ~550 |
| `flow-diagram-data.service.ts`（新建） | `updateDiagram` + `detectStructuralChange` + `setupDropHandler` | ~260 |
| `flow-diagram-export.service.ts`（新建） | 4个导出方法 | ~100 |
| `flow-diagram-view-state.service.ts`（新建）或合入已有 | `saveViewState` + `restoreViewState` + `onFlowActivated` | ~150 |

> 也可以更简单的两文件方案：保留主服务 ~600 行 + 提取 `flow-diagram-data-sync.service.ts` ~350 行（数据同步 + 导出 + 视图状态）。

---

### 4. FlowViewComponent (`flow-view.component.ts`)

| 属性 | 值 |
|------|-----|
| **总行数** | **1,037** |
| **超标** | +237 行 |

#### 依赖注入

| 服务 | 用途 |
|------|------|
| `UiStateService` | UI 状态 |
| `ProjectStateService` | 项目数据 |
| `ToastService` | 提示 |
| `LoggerService` | 日志 |
| `NgZone` | Angular Zone |
| `ElementRef` | DOM 引用 |
| `Injector` | 注入器 |
| `FlowCommandService` | 命令协调 |
| `FlowDiagramService` | 图表核心 |
| `FlowZoomService` | 缩放 |
| `FlowSelectionService` | 选择 |
| `FlowLayoutService` | 布局 |
| `FlowDragDropService` | 拖放 |
| `FlowTouchService` | 触摸 |
| `FlowLinkService` | 连接 |
| `FlowTaskOperationsService` | 任务操作 |
| `FlowSwipeGestureService` | 滑动手势 |
| `FlowCascadeAssignService` | 级联分配 |
| `FlowKeyboardService` | 快捷键 |
| `FlowPaletteResizeService` | 调色板缩放 |
| `FlowBatchDeleteService` | 批量删除 |
| `FlowSelectModeService` | 框选模式 |
| `FlowMobileDrawerService` | 移动端抽屉 |
| `TaskOperationAdapterService` | 任务适配 |
| `FlowDiagramEffectsService` | 响应式 effects |
| `FlowEventRegistrationService` | 事件注册 |
| `FlowViewCleanupService` | 清理 |
| `FlowDiagramRetryService` | 重试 |

> **注意**: 28 个依赖注入！组件仍然承担了大量委托协调逻辑。

#### 方法清单与分类

| # | 方法 | 行范围 | 行数 | 分类 |
|---|------|--------|------|------|
| 1 | `onWindowResize()` | L223-236 | 14 | 📐 窗口事件 |
| 2 | `onOrientationChange()` | L240-249 | 10 | 📐 窗口事件 |
| 3 | `constructor()` | L250-291 | 42 | 🚀 初始化 |
| 4 | `scheduleRafDiagramUpdate()` | L294-315 | 22 | 🔄 图表更新 |
| 5 | `scheduleDrawerHeightUpdate()` | L319-335 | 17 | 📱 移动端 |
| 6 | `ngAfterViewInit()` | L338-340 | 3 | 🔄 生命周期 |
| 7 | `ngOnDestroy()` | L342-373 | 32 | 🔄 生命周期 |
| 8 | `scheduleDiagramInit()` | L376-382 | 7 | 🚀 初始化 |
| 9 | `onDiagramInitialized()` | L384-403 | 20 | 🚀 初始化 |
| 10 | `initDiagram()` | L406-441 | 36 | 🚀 初始化 |
| 11 | `installMobileDiagramDragGhostListeners()` | L443-459 | 17 | 📱 移动端 |
| 12 | `uninstallMobileDiagramDragGhostListeners()` | L461-477 | 17 | 📱 移动端 |
| 13 | `initOverview()` | L481-507 | 27 | 🗺️ 小地图 |
| 14 | `toggleOverviewCollapse()` | L511-529 | 19 | 🗺️ 小地图 |
| 15 | `onOverviewTogglePointerDown()` | L530-536 | 7 | 🗺️ 小地图 |
| 16 | `retryInitDiagram()` | L540-548 | 9 | 🚀 初始化 |
| 17 | `resetAndRetryDiagram()` | L553-561 | 9 | 🚀 初始化 |
| 18-23 | `zoomIn/Out/applyAutoLayout/exportToPng/exportToSvg/saveToCloud` | L564-588 | 25 | 🎯 委托转发 |
| 24 | `centerOnNode()` | L593-595 | 3 | 🎯 委托转发 |
| 25 | `executeCenterOnNode()` | L601-612 | 12 | 🔨 图表操作 |
| 26 | `refreshLayout()` | L613-617 | 5 | 🎯 委托转发 |
| 27 | `refreshDiagram()` | L619-623 | 5 | 🔄 图表更新 |
| 28 | `onDragStart()` | L627-629 | 3 | 🖱️ 拖放 |
| 29 | `onUnassignedDrop()` | L631-682 | **52** | 🖱️ 拖放 |
| 30 | `handleDiagramDrop()` | L684-691 | 8 | 🖱️ 拖放 |
| 31 | `onUnassignedTouchStart()` | L694-696 | 3 | 📱 触摸 |
| 32 | `onUnassignedTouchMove()` | L698-704 | 7 | 📱 触摸 |
| 33 | `onUnassignedTouchEnd()` | L706-717 | 12 | 📱 触摸 |
| 34 | `onUnassignedTaskClick()` | L720-723 | 4 | 🖱️ 事件 |
| 35 | `confirmParentChildLink()` | L727-730 | 4 | 🎯 委托转发 |
| 36 | `confirmCrossTreeLink()` | L732-735 | 4 | 🎯 委托转发 |
| 37 | `showCascadeAssignDialog()` | L743-750 | 8 | 🎯 委托转发 |
| 38 | `confirmCascadeAssign()` | L754-759 | 6 | 🎯 委托转发 |
| 39 | `cancelCascadeAssign()` | L763-765 | 3 | 🎯 委托转发 |
| 40 | `saveConnectionDescription()` | L768-772 | 5 | 🎯 委托转发 |
| 41 | `deleteConnection()` | L773-780 | 8 | 🎯 委托转发 |
| 42 | `confirmLinkDelete()` | L782-790 | 9 | 🎯 委托转发 |
| 43 | `createUnassigned()` | L793-795 | 3 | 🎯 任务操作转发 |
| 44 | `addSiblingTask()` | L797-804 | 8 | 🎯 任务操作转发 |
| 45 | `addChildTask()` | L806-813 | 8 | 🎯 任务操作转发 |
| 46 | `archiveTask()` | L815-820 | 6 | 🎯 任务操作转发 |
| 47 | `deleteTask()` | L822-824 | 3 | 🎯 任务操作转发 |
| 48 | `confirmDelete()` | L826-842 | 17 | 🎯 任务操作转发 |
| 49 | `expandDrawerToOptimalHeight()` | L847-856 | 10 | 📱 移动端 |
| 50 | `requestBatchDelete()` | L864-872 | 9 | 🎯 委托转发 |
| 51 | `confirmBatchDelete()` | L875-886 | 12 | 🎯 委托转发 |
| 52 | `handleDeleteKeyPressed()` | L889-895 | 7 | 🎯 委托转发 |
| 53 | `toggleSelectMode()` | L901-903 | 3 | 🎯 委托转发 |
| 54 | `startPaletteResize()` | L907-910 | 4 | 🎯 委托转发 |
| 55 | `startPaletteResizeTouch()` | L912-915 | 4 | 🎯 委托转发 |
| 56 | `handleDiagramShortcut()` | L920-926 | 7 | ⌨️ 快捷键 |
| 57 | `emitToggleSidebar()` | L929-931 | 3 | 📐 窗口事件 |
| 58 | `onPaletteOpenChange()` | L934-940 | 7 | 📐 面板管理 |
| 59 | `onDrawerStateChange()` | L943-955 | 13 | 📱 移动端 |
| 60 | `onMobileDrawerCenterOnNode()` | L958-963 | 6 | 📱 移动端 |
| 61 | `onDrawerSwipeToSwitch()` | L970-979 | 10 | 📱 移动端 |
| 62 | `toggleRightPanel()` | L981-990 | 10 | 📐 面板管理 |
| 63 | `onDiagramAreaTouchStart()` | L994-996 | 3 | 📱 滑动手势 |
| 64 | `onDiagramAreaTouchMove()` | L998-1000 | 3 | 📱 滑动手势 |
| 65 | `onDiagramAreaTouchEnd()` | L1002-1014 | 13 | 📱 滑动手势 |
| 66 | `scheduleTimer()` | L1022-1036 | 15 | 🔧 工具 |

#### 分类统计

| 分类 | 方法数 | 总行数 |
|------|--------|--------|
| 🎯 **纯委托转发方法** | ~23 | ~115 |
| 🚀 **初始化** | 5 | ~81 |
| 📱 **移动端专用逻辑** | 10 | ~106 |
| 🖱️ **拖放处理** | 4 | ~66 |
| 🔄 **图表更新/生命周期** | 4 | ~62 |
| 🗺️ **小地图** | 3 | ~53 |
| 📐 **面板/窗口管理** | 5 | ~44 |
| 🎯 **任务操作转发** | 6 | ~45 |
| 其他 | 6 | ~40 |

#### 建议拆分方案

组件已经做了大量委托，**核心问题不是逻辑复杂，而是方法太多（66 个）**。

| 策略 | 内容 | 预计行数 |
|--------|------|----------|
| `flow-view.component.ts`（精简） | 生命周期 + 初始化 + 核心信号 + 模板绑定 | ~600 |
| **消除方式 1**: 将模板绑定改为直接调服务 | 去掉 ~23 个纯透传方法，模板中直接 `link.confirmParentChildLink()` | 减少 ~115 行 |
| **消除方式 2**: 提取 `onUnassignedDrop()` 逻辑到 `FlowDragDropService` | 52 行拖放逻辑移入已有服务 | 减少 ~52 行 |
| **消除方式 3**: 移动端方法合并到 `FlowMobileDrawerService` | 部分移动端逻辑（抽屉状态变化、滑动手势）已有对应服务 | 减少 ~40 行 |

> **最佳策略**: 消除方式 1 + 2 即可将行数降至 ~800 以内，且零破坏性（模板直接引用已 public 的服务）。

---

### 总览对比

| 文件 | 现行行数 | 方法数 | 依赖数 | 拆分后最大文件 |
|------|----------|--------|--------|----------------|
| `flow-template.service.ts` | 1,169 | 17 | 4 | ~400 |
| `flow-link.service.ts` | 1,123 | 31 | 6 | ~450 |
| `flow-diagram.service.ts` | 1,098 | 28 | 17 | ~550 |
| `flow-view.component.ts` | 1,037 | 66 | 28 | ~600 |

### 拆分优先级

| 优先级 | 文件 | 难度 | 理由 |
|--------|------|------|------|
| **P0** | `flow-template.service.ts` | ⭐ 低 | 节点模板 vs 连接线模板边界清晰，零耦合 |
| **P1** | `flow-link.service.ts` | ⭐⭐ 中低 | 编辑器 UI 和重连逻辑边界清晰 |
| **P2** | `flow-view.component.ts` | ⭐⭐ 中低 | 删除透传方法无需拆文件，只需改模板 |
| **P3** | `flow-diagram.service.ts` | ⭐⭐⭐ 中 | 17 个依赖需谨慎处理依赖传递 |
