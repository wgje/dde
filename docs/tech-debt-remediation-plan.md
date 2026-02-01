# NanoFlow 技术债务清理策划案

> **文档版本**: 1.3  
> **创建日期**: 2026-01-31  
> **审查日期**: 2026-01-31  
> **深度验证日期**: 2026-01-31  
> **最后更新**: 2026-01-31 (进度更新)  
> **审查状态**: ✅ 深度审查完成（数据已验证）  
> **基于**: Gilfoyle 代码审查报告 + AI 深度研究

---

## 📊 实施进度跟踪（2026-02-01 更新）

### 完成状态

| 文件 | 初始行数 | 当前行数 | 目标 | 状态 | 减少行数 |
|------|----------|----------|------|------|----------|
| StorePersistenceService | 1551 | 790 | ≤800 | ✅ 完成 | -761 |
| SyncCoordinatorService | 1466 | 826 | ≤800 | ✅ 接近目标 | -640 |
| TaskOperationService | 2060 | 1673 | ≤800 | 🔄 进行中 | -387 |
| FlowViewComponent | 2555 | 988 | ≤800 | ✅ 接近目标 | -1567 |
| SimpleSyncService | 4945 | 4627 | ≤800 | 🔄 基础设施就位 | -318 |

### 新增子服务

| 服务 | 行数 | 用途 |
|------|------|------|
| SubtreeOperationsService | 430 | 子树操作（从 TaskOperationService 提取） |
| TaskCreationService | 266 | 任务创建（预备，尚未集成） |
| ProjectSyncOperationsService | 322 | 项目同步操作（从 SyncCoordinatorService 提取） |
| DeltaSyncCoordinatorService | 185 | Delta Sync 协调（从 SyncCoordinatorService 提取） |
| FlowDiagramRetryService | 205 | GoJS 图表重试逻辑（从 FlowViewComponent 提取） |
| FlowBatchToolbarComponent | 83 | 批量操作工具栏（从 FlowViewComponent 提取） |
| SyncOperationHelperService | 411 | 同步操作包装器（Session/Auth 处理） |

### sync 子服务架构

SimpleSyncService (4627 行) 的子服务已就位，待逐步委托：

| 服务 | 行数 | 状态 | 用途 |
|------|------|------|------|
| TaskSyncService | 509 | ✅ 已创建 | 任务同步（pushTask, pullTasks, deleteTask） |
| ProjectSyncService | 178 | ✅ 已创建 | 项目同步 |
| ConnectionSyncService | 217 | ✅ 已创建 | 连接同步 |
| TombstoneService | 355 | ✅ 已创建 | 墓碑管理 |
| RetryQueueService | 663 | ✅ 已创建 | 重试队列 |
| SessionManagerService | 197 | ✅ 已创建 | 会话管理 |
| SyncStateService | 201 | ✅ 已创建 | 同步状态 |
| RealtimePollingService | 391 | ✅ 已创建 | 实时订阅 |
| SyncOperationHelperService | 411 | ✅ 新增 | 操作包装器 |

**SimpleSyncService 重构策略**：
1. ✅ 子服务已注入但未委托（Sprint 7-9）
2. ✅ SyncOperationHelperService 提供统一的 Auth/Session 处理
3. ⏳ 下一步：将 pushTask/pushConnection/pushProject 委托给子服务
4. ⏳ 预计可减少 ~2000 行代码

### Git 提交记录

- `3f5d574` - refactor: extract SubtreeOperationsService from TaskOperationService
- `8ef28dd` - refactor: extract ProjectSyncOperationsService from SyncCoordinatorService

---

## ⚠️ 审查发现摘要（2026-01-31）

> **审查结论**：计划草案存在 **严重低估问题**，实际技术债务规模约为计划描述的 **2-3 倍**。

### 🔴 数据验证偏差

| 指标 | 计划声称 | 实际值 | 偏差 |
|------|----------|--------|------|
| console.* 调用 | 50+ | **343** | +586% ⚠️ |
| setTimeout 使用 | "多处" | **191** | 未量化 |
| @deprecated 方法 | 20+ | **27** | +35% |
| any 类型 | 30+ | **36** | +20% |
| 超 800 行文件 | 4 个 | **27 个** | +575% ⚠️ |
| ESLint 抑制 | 未提及 | **4处生产+27处测试** | 遗漏（已澄清口径） |
| 不安全类型转换 | 未提及 | **41** | 遗漏 |

### 🔴 遗漏的致命级问题

| ID | 遗漏项 | 行数 | 严重程度 | 建议优先级 |
|----|--------|------|----------|------------|
| C-07 | FlowViewComponent | **2555** | 🔴 致命 | P1 |
| C-08 | store-persistence.service.ts | **1550** | 🔴 致命 | P1 |
| C-09 | sync-coordinator.service.ts | **1463** | 🔴 致命 | P0 |
| C-10 | task-operation-adapter.service.ts | **1453** | 🔴 致命 | P1 |
| C-11 | action-queue.service.ts | **1429** | 🔴 致命 | P1 |
| C-12 | task-repository.service.ts | **1236** | 🔴 致命 | P2 |
| C-13 | flow-template.service.ts | **1231** | 🔴 致命 | P2 |
| C-14 | text-view.component.ts | **1206** | 🔴 致命 | P2 |

### 🟠 遗漏的严重级问题

| ID | 遗漏项 | 数量 | 严重程度 |
|----|--------|------|----------|
| S-05 | ESLint 禁用注释 | 4处生产+27处测试 | 🟠 严重 |
| S-06 | 不安全类型转换 (as unknown/as any) | 41 | 🟠 严重 |
| S-07 | prompt 文件 tools: 语法错误 | 8 个文件 | 🟡 中等 |
| S-08 | injector.get() hack 绕过 DI | 5 处 | 🟠 严重 |

### 工作量重新估算

| 阶段 | 原估算 | 修正后估算 | 增幅 |
|------|--------|------------|------|
| 致命级 | 15-20 人天 | **35-45 人天** | +130% |
| 严重级 | 8-10 人天 | **15-20 人天** | +100% |
| 中等级 | 5-8 人天 | **8-12 人天** | +50% |
| 设计级 | 10-15 人天 | **18-24 人天** | +60% |
| **总计** | **38-53 人天** | **100-130 人天** | +145% |

> ⚠️ **深度验证后调整**：考虑到遗漏项（14个800-1200行文件）和20%缓冲，总工作量调整为 100-130 人天（约 20-26 周）

### 循环依赖验证

```typescript
// 确认存在的 injector hack（task-operation-adapter.service.ts:1170）
const StoreService = this.injector.get('StoreService' as unknown as Type<{ undo: () => void }>);
// 这是典型的循环依赖绕过手段，验证计划中 C-05 的准确性
```

### ESLint 现状

```javascript
// 当前 eslint.config.js 配置
'@typescript-eslint/no-explicit-any': 'warn',  // 仅警告，非错误
'no-console': 'off',                            // 完全关闭！
```

> **计划声称要添加这些规则，但实际上规则已存在但被设为宽松模式。需要改为 'error' 级别而非添加新规则。**

---

## 目录

1. [执行摘要](#执行摘要)
2. [问题清单与优先级](#问题清单与优先级)
3. [Phase 1: 致命级问题修复](#phase-1-致命级问题修复)
4. [Phase 2: 严重问题修复](#phase-2-严重问题修复)
5. [Phase 3: 中等问题修复](#phase-3-中等问题修复)
6. [Phase 4: 设计问题重构](#phase-4-设计问题重构)
7. [实施时间线（修正后）](#实施时间线修正后)
8. [风险评估与回滚策略](#风险评估与回滚策略)
9. [验收标准](#验收标准)

---

## 执行摘要

### 问题统计

| 严重级别 | 原问题数量 | 修正后数量 | 修正后工作量 |
|----------|------------|------------|--------------|
| 🔴 致命级 (CRITICAL) | 6 | **14** | 35-45 人天 |
| 🟠 严重级 (SEVERE) | 4 | **8** | 15-20 人天 |
| 🟡 中等级 (MODERATE) | 5 | **6** | 8-12 人天 |
| 🔵 设计级 (DESIGN) | 4 | 4 | 15-20 人天 |
| **总计** | **19** | **32** | **73-97 人天** |

### 核心原则

1. **渐进式重构**: 不做大爆炸式重写，每次修改保持系统可运行
2. **测试先行**: 任何重构前确保有足够的测试覆盖
3. **向后兼容**: 保留旧 API 并标记 deprecated，给迁移留出时间
4. **可回滚**: 每个 Phase 独立可回滚

---

## 问题清单与优先级

### 优先级矩阵

| ID | 问题 | 严重度 | 影响范围 | 修复难度 | 优先级 |
|----|------|--------|----------|----------|--------|
| C-01 | SimpleSyncService 4918 行 | 🔴 致命 | 核心同步 | 高 | P0 |
| C-02 | FlowDiagramService 2385 行 | 🔴 致命 | 流程图 | 高 | P1 |
| C-03 | TaskOperationService 2279 行 | 🔴 致命 | 任务操作 | 中 | P1 |
| C-04 | AppComponent 1499 行 | 🔴 致命 | 全局 | 中 | P1 |
| C-05 | 循环依赖问题 | 🔴 致命 | 架构 | 高 | P0 |
| C-06 | @deprecated 方法堆积 (27个) | 🔴 致命 | 全局 | 低 | P2 |
| **C-07** | **FlowViewComponent 2555 行** ⚠️新增 | 🔴 致命 | 流程图 | 高 | P1 |
| **C-08** | **store-persistence 1550 行** ⚠️新增 | 🔴 致命 | 状态 | 中 | P1 |
| **C-09** | **sync-coordinator 1463 行** ⚠️新增 | 🔴 致命 | 同步 | 高 | P0 |
| **C-10** | **task-operation-adapter 1453 行** ⚠️新增 | 🔴 致命 | 任务 | 中 | P1 |
| **C-11** | **action-queue 1429 行** ⚠️新增 | 🔴 致命 | 同步 | 中 | P1 |
| **C-12** | **task-repository 1236 行** ⚠️新增 | 🔴 致命 | 持久化 | 中 | P2 |
| **C-13** | **flow-template 1231 行** ⚠️新增 | 🔴 致命 | 流程图 | 中 | P2 |
| **C-14** | **text-view 1206 行** ⚠️新增 | 🔴 致命 | 文本视图 | 中 | P2 |
| S-01 | console.* 满天飞 (**343个!**) | 🟠 严重 | 全局 | 低 | P2 |
| S-02 | any 类型泛滥 (36个) | 🟠 严重 | 测试 | 中 | P2 |
| S-03 | setTimeout 滥用 (**191个!**) | 🟠 严重 | UI | 中 | P3 |
| S-04 | 空实现的简化方法 | 🟠 严重 | 同步 | 低 | P3 |
| **S-05** | **ESLint禁用注释 (4处生产代码+27处测试)** ⚠️澄清 | 🟠 严重 | 全局 | 低 | P2 |
| **S-06** | **不安全类型转换 (41个)** ⚠️新增 | 🟠 严重 | 类型安全 | 中 | P2 |
| **S-07** | **prompt 文件 tools: 语法错误 (8个)** ⚠️更新 | 🟡 中等 | 开发工具 | 低 | P3 |
| **S-08** | **injector.get() hack (5处)** ⚠️新增 | 🟠 严重 | 架构 | 中 | P1 |
| M-01 | AppComponent 模态框职责 | 🟡 中等 | 全局 | 中 | P2 |
| M-02 | StoreService 代理地狱 (944行/38+方法) | 🟡 中等 | 服务层 | 中 | P1 |
| M-03 | 配置文件膨胀 (468行) | 🟡 中等 | 配置 | 低 | P3 |
| M-04 | Result 模式不一致 | 🟡 中等 | 工具 | 低 | P3 |
| M-05 | prompt 文件配置错误 (8个) | 🟡 中等 | 开发工具 | 低 | P3 |
| D-01 | GoJS 服务过度封装 (17个) | 🔵 设计 | 流程图 | 高 | P2 |
| D-02 | 服务架构混乱 | 🔵 设计 | 全局 | 高 | P1 |
| D-03 | 内存泄漏风险 | 🔵 设计 | 性能 | 中 | P2 |
| D-04 | 测试架构问题 | 🔵 设计 | 测试 | 中 | P2 |

---

## Phase 1: 致命级问题修复

### C-01: SimpleSyncService 拆分方案

**当前状态**: 4919 行，单一文件包含 15+ 职责

**目标状态**: 拆分为 6-8 个专注的服务，每个 ≤ 500 行

#### 拆分策略

```
SimpleSyncService (4919 行)
    ├── SyncCoreService (~400 行)           // 核心同步逻辑
    ├── RetryQueueService (~500 行)         // 重试队列管理
    ├── CircuitBreakerService (~200 行)     // 熔断器（已存在，提取逻辑）
    ├── SyncCacheService (~300 行)          // 缓存管理
    ├── RealtimeService (~400 行)           // Realtime 订阅
    ├── PollingService (~300 行)            // 轮询逻辑
    ├── TombstoneService (~200 行)          // 软删除墓碑管理
    └── SyncStateService (~200 行)          // 同步状态管理
```

#### 详细实施步骤

**步骤 1: 创建新服务文件结构**

```
src/app/core/services/sync/
├── index.ts                      # 统一导出
├── sync-core.service.ts          # 核心同步逻辑
├── retry-queue.service.ts        # 重试队列（从 simple-sync 提取）
├── sync-cache.service.ts         # 离线缓存管理
├── realtime.service.ts           # Realtime 订阅逻辑
├── polling.service.ts            # 轮询逻辑
├── tombstone.service.ts          # Tombstone 管理
└── sync-state.service.ts         # 同步状态 Signal
```

**步骤 2: 提取 RetryQueue 逻辑**

从 `simple-sync.service.ts` 提取以下代码块：

| 行范围 | 提取内容 | 目标文件 |
|--------|----------|----------|
| L41-52 | RetryQueueItem 接口 | retry-queue.service.ts |
| L159-230 | 队列配置常量 | retry-queue.service.ts |
| L231-280 | IndexedDB 初始化 | retry-queue.service.ts |
| L280-450 | 队列操作方法 | retry-queue.service.ts |

**步骤 3: 提取 Realtime/Polling 逻辑**

| 行范围 | 提取内容 | 目标文件 |
|--------|----------|----------|
| L1800-2200 | Realtime 订阅 | realtime.service.ts |
| L2200-2600 | 轮询逻辑 | polling.service.ts |

**步骤 4: 保持向后兼容**

```typescript
// simple-sync.service.ts - 重构后
@Injectable({ providedIn: 'root' })
export class SimpleSyncService {
  // 组合新服务
  private readonly core = inject(SyncCoreService);
  private readonly retryQueue = inject(RetryQueueService);
  private readonly cache = inject(SyncCacheService);
  
  // 保留旧 API 作为代理，标记 deprecated
  /** @deprecated 使用 inject(RetryQueueService) 替代 */
  addToRetryQueue(item: RetryQueueItem): void {
    return this.retryQueue.add(item);
  }
}
```

**步骤 5: 迁移测试**

- 将 `simple-sync.service.spec.ts` 拆分为对应的测试文件
- 确保 100% 的公共方法有测试覆盖

#### 验收标准

- [ ] SimpleSyncService ≤ 500 行
- [ ] 每个新服务 ≤ 500 行
- [ ] 所有现有测试通过
- [ ] 无循环依赖
- [ ] 无运行时错误

---

### C-02: FlowDiagramService 拆分方案

**当前状态**: 2386 行

**目标状态**: ≤ 600 行（核心职责 + 委托）

#### 拆分策略

当前 FlowDiagramService 已经有一些委托服务，但核心文件仍然过大。

**需要进一步提取的职责**:

| 职责 | 当前行数 | 目标服务 |
|------|----------|----------|
| Overview/小地图管理 | ~400 行 | FlowOverviewService |
| 视图状态保存/恢复 | ~200 行 | FlowViewStateService |
| 导出功能 | ~150 行 | FlowExportService |
| 主题变化处理 | ~100 行 | 移入 FlowTemplateService |
| 调试日志逻辑 | ~100 行 | 删除或移入 LoggerService |

#### 详细实施步骤

**步骤 1: 创建 FlowOverviewService**

```typescript
// src/app/features/flow/services/flow-overview.service.ts
@Injectable({ providedIn: 'root' })
export class FlowOverviewService {
  // 提取 L85-180 的 overview 相关状态
  private overview: go.Overview | null = null;
  private overviewContainer: HTMLDivElement | null = null;
  // ... 所有 overview 相关逻辑
}
```

**步骤 2: 创建 FlowViewStateService**

```typescript
// src/app/features/flow/services/flow-view-state.service.ts
@Injectable({ providedIn: 'root' })
export class FlowViewStateService {
  // 提取视图状态保存/恢复逻辑
  saveViewState(projectId: string, state: ViewState): void { }
  restoreViewState(projectId: string): ViewState | null { }
}
```

**步骤 3: 删除调试代码**

| 行号 | 内容 | 操作 |
|------|------|------|
| L104-108 | overviewDebugLastLogAt 等 | 删除或条件编译 |
| 所有 `this.logger.debug(...)` | 调试日志 | 保留但确保生产环境不输出 |

---

### C-03: TaskOperationService 拆分方案

**当前状态**: 2280 行

**目标状态**: ≤ 500 行

#### 拆分策略

```
TaskOperationService (2280 行)
    ├── TaskCrudService (~400 行)           // 增删改查
    ├── TaskMoveService (~300 行)           // 移动/排序
    ├── TaskTrashService (~200 行)          // 回收站（已存在）
    ├── TaskRankService (~300 行)           // Rank 计算
    └── TaskValidationService (~200 行)     // 验证逻辑
```

#### 详细实施步骤

**步骤 1: 提取 Rank 计算逻辑**

```typescript
// src/services/task-rank.service.ts
@Injectable({ providedIn: 'root' })
export class TaskRankService {
  computeInsertRank(stage: number, tasks: Task[], beforeId: string | null): number { }
  applyRefusalStrategy(task: Task, candidateRank: number): Result<number> { }
  needsRebalance(stage: number, tasks: Task[]): boolean { }
}
```

**步骤 2: 提取移动逻辑**

```typescript
// src/services/task-move.service.ts
@Injectable({ providedIn: 'root' })
export class TaskMoveService {
  moveTask(params: MoveTaskParams): Result<void> { }
  insertBetween(params: InsertBetweenParams): Result<void> { }
  assignToStage(taskId: string, stage: number): Result<void> { }
}
```

---

### C-04: AppComponent 拆分方案

**当前状态**: 1500 行

**目标状态**: ≤ 400 行

#### 拆分策略

| 职责 | 当前行数 | 目标组件/服务 |
|------|----------|---------------|
| 模态框容器 | ~300 行 | ModalContainerComponent |
| 键盘快捷键 | ~150 行 | KeyboardShortcutService |
| 启动流程 | ~200 行 | BootstrapService |
| 认证状态 UI | ~200 行 | AuthStatusComponent |
| 搜索逻辑 | ~100 行 | 已有 SearchService |
| PWA 更新 | ~100 行 | PwaUpdateService |

#### 详细实施步骤

**步骤 1: 创建 ModalContainerComponent**

```typescript
// src/app/shared/components/modal-container.component.ts
@Component({
  selector: 'app-modal-container',
  standalone: true,
  imports: [
    SettingsModalComponent,
    LoginModalComponent,
    // ... 所有模态框
  ],
  template: `
    @if (modalService.settingsOpen()) { <app-settings-modal /> }
    @if (modalService.loginOpen()) { <app-login-modal /> }
    <!-- ... -->
  `
})
export class ModalContainerComponent {
  readonly modalService = inject(ModalService);
}
```

**步骤 2: 创建 KeyboardShortcutService**

```typescript
// src/services/keyboard-shortcut.service.ts
@Injectable({ providedIn: 'root' })
export class KeyboardShortcutService {
  private shortcuts: Map<string, () => void> = new Map();
  
  register(combo: string, handler: () => void): void { }
  unregister(combo: string): void { }
  
  // 在 constructor 中设置 document 监听器
}
```

**步骤 3: 创建 BootstrapService**

```typescript
// src/services/bootstrap.service.ts
@Injectable({ providedIn: 'root' })
export class BootstrapService {
  async bootstrap(): Promise<void> {
    // 提取 app.component.ts L770-840 的启动逻辑
  }
}
```

---

### C-05: 循环依赖解决方案

**当前状态**: StoreService ↔ TaskOperationAdapterService 循环依赖

**问题根源**:
- `StoreService` 注入 `TaskOperationAdapterService`
- `TaskOperationAdapterService` 需要调用 `StoreService.undo()`

#### 解决方案 1: 事件总线模式

```typescript
// src/services/event-bus.service.ts
@Injectable({ providedIn: 'root' })
export class EventBusService {
  private readonly undoRequest$ = new Subject<void>();
  private readonly redoRequest$ = new Subject<void>();
  
  readonly onUndoRequest = this.undoRequest$.asObservable();
  readonly onRedoRequest = this.redoRequest$.asObservable();
  
  requestUndo(): void { this.undoRequest$.next(); }
  requestRedo(): void { this.redoRequest$.next(); }
}
```

**修改 TaskOperationAdapterService**:

```typescript
// 移除循环依赖
// 之前:
private getStore(): StoreService { ... } // 延迟注入 hack

// 之后:
private readonly eventBus = inject(EventBusService);

private triggerUndo(): void {
  this.eventBus.requestUndo();  // 不再直接调用 StoreService
}
```

**修改 StoreService**:

```typescript
constructor() {
  // 订阅事件总线
  this.eventBus.onUndoRequest.pipe(
    takeUntilDestroyed(this.destroyRef)
  ).subscribe(() => this.undo());
}
```

#### 解决方案 2: 接口抽象

```typescript
// src/services/undo-provider.interface.ts
export interface UndoProvider {
  undo(): void;
  redo(): void;
  canUndo(): boolean;
  canRedo(): boolean;
}

export const UNDO_PROVIDER = new InjectionToken<UndoProvider>('UndoProvider');
```

```typescript
// app.config.ts
providers: [
  { provide: UNDO_PROVIDER, useExisting: UndoService }
]
```

**推荐**: 方案 1（事件总线），因为更符合解耦原则

---

### C-06: @deprecated 方法清理方案

**当前状态**: 20+ 个 deprecated 方法

#### 清理策略

**阶段 1: 标记并记录** (当前 Sprint)

创建迁移追踪文件：

```typescript
// src/migrations/deprecated-api-tracking.ts
export const DEPRECATED_API_REMOVAL_SCHEDULE = {
  'StoreService.updateViewState': {
    deprecatedAt: '2026-01-31',
    removeAt: '2026-03-01',
    replacement: 'ProjectStateService.updateViewState',
    usageCount: 0,  // 通过 grep 更新
  },
  // ... 其他 deprecated 方法
};
```

**阶段 2: 添加运行时警告** (下个 Sprint)

```typescript
/** @deprecated 请直接注入 ProjectStateService */
updateViewState(...) {
  if (typeof ngDevMode !== 'undefined' && ngDevMode) {
    console.warn('[DEPRECATED] StoreService.updateViewState 将在 2026-03-01 移除');
  }
  return this.project.updateViewState(...);
}
```

**阶段 3: 批量删除** (2026-03-01)

执行脚本删除所有 deprecated 方法和相关代码

#### 具体删除清单

| 文件 | 方法 | 替代 API | 删除日期 |
|------|------|----------|----------|
| store.service.ts | updateViewState | ProjectStateService.updateViewState | 2026-03-01 |
| store.service.ts | updateTaskContent | TaskOperationAdapterService.updateTaskContent | 2026-03-01 |
| store.service.ts | updateTaskTitle | TaskOperationAdapterService.updateTaskTitle | 2026-03-01 |
| store.service.ts | updateTaskPosition | TaskOperationAdapterService.updateTaskPosition | 2026-03-01 |
| store.service.ts | deleteTask | TaskOperationAdapterService.deleteTask | 2026-03-01 |
| store.service.ts | toggleView | UiStateService.toggleView | 2026-03-01 |
| sync-coordinator.service.ts | initRealtimeSubscription | this.core.initRealtimeSubscription | 2026-03-01 |
| sync-coordinator.service.ts | teardownRealtimeSubscription | this.core.teardownRealtimeSubscription | 2026-03-01 |
| sync-coordinator.service.ts | saveOfflineSnapshot | this.core.saveOfflineSnapshot | 2026-03-01 |
| sync-coordinator.service.ts | loadOfflineSnapshot | this.core.loadOfflineSnapshot | 2026-03-01 |
| sync-coordinator.service.ts | clearOfflineCache | this.core.clearOfflineCache | 2026-03-01 |
| sync-coordinator.service.ts | loadProjectsFromCloud | this.core.loadProjectsFromCloud | 2026-03-01 |
| sync-coordinator.service.ts | saveProjectSmart | this.core.saveProjectSmart | 2026-03-01 |
| task-operation-adapter.service.ts | completeUnfinishedItem | this.core.completeUnfinishedItem | 2026-03-01 |
| task-operation-adapter.service.ts | updateTaskPositionWithRankSync | this.core.updateTaskPositionWithRankSync | 2026-03-01 |
| task-operation-adapter.service.ts | addTaskTag | this.core.addTaskTag | 2026-03-01 |
| task-operation-adapter.service.ts | removeTaskTag | this.core.removeTaskTag | 2026-03-01 |
| guards/auth.guard.ts | authGuard | requireAuthGuard | 已删除 |

---

## Phase 2: 严重问题修复

### S-01: console.log 清理方案

**当前状态**: 50+ 个 console.log 语句

#### 清理策略

**步骤 1: 创建 ESLint 规则**

```javascript
// eslint.config.js 添加
rules: {
  'no-console': ['error', { 
    allow: ['warn', 'error'] 
  }]
}
```

**步骤 2: 将调试日志迁移到 LoggerService**

```typescript
// 之前
console.log('[Bootstrap] 步骤 1/3: 调用 auth.checkSession()...');

// 之后
this.logger.debug('Bootstrap 步骤 1/3: 调用 auth.checkSession()');
```

**步骤 3: 批量替换**

| 文件 | console 调用数 | 操作 |
|------|----------------|------|
| app.component.ts | 15 | 替换为 LoggerService |
| text-view-drag-drop.service.ts | 10 | 替换为 LoggerService，生产环境禁用 |
| auth.service.ts | 5 | 替换为 LoggerService |

**步骤 4: LoggerService 增强**

```typescript
// src/services/logger.service.ts
@Injectable({ providedIn: 'root' })
export class LoggerService {
  private isProduction = environment.production;
  
  debug(message: string, context?: Record<string, unknown>): void {
    if (!this.isProduction) {
      console.log(`[DEBUG] ${message}`, context);
    }
    // 可选：发送到 Sentry breadcrumb
    Sentry.addBreadcrumb({ message, data: context, level: 'debug' });
  }
}
```

---

### S-02: any 类型修复方案

**当前状态**: 30+ 个 any 类型使用

#### 修复策略

**步骤 1: 为测试 Mock 创建类型**

```typescript
// src/tests/mocks/service-mocks.ts
export interface MockLoggerService {
  debug: ReturnType<typeof vi.fn>;
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  category: ReturnType<typeof vi.fn>;
}

export function createMockLoggerService(): MockLoggerService {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    category: vi.fn().mockReturnThis(),
  };
}

export interface MockSyncCoordinator {
  isSyncing: Signal<boolean>;
  isOnline: Signal<boolean>;
  // ... 完整类型定义
}

export function createMockSyncCoordinator(): MockSyncCoordinator {
  return {
    isSyncing: signal(false),
    isOnline: signal(true),
    // ...
  };
}
```

**步骤 2: 批量替换测试文件**

```typescript
// 之前
let mockLogger: any;

// 之后
import { MockLoggerService, createMockLoggerService } from '@tests/mocks';
let mockLogger: MockLoggerService;

beforeEach(() => {
  mockLogger = createMockLoggerService();
});
```

**步骤 3: 添加 ESLint 规则**

```javascript
// eslint.config.js
rules: {
  '@typescript-eslint/no-explicit-any': 'error',
  '@typescript-eslint/no-unsafe-assignment': 'warn',
}
```

---

### S-03: setTimeout 滥用修复方案

**当前状态**: 多处使用 setTimeout 替代正确的异步模式

#### 修复策略

**模式 1: 替换为 Angular Signals/Effects**

```typescript
// 之前
setTimeout(() => {
  this.someValue = newValue;
}, 50);

// 之后
// 使用 Angular 的变更检测
queueMicrotask(() => {
  this.someValue.set(newValue);
});
```

**模式 2: 使用 RxJS 操作符**

```typescript
// 之前
setTimeout(() => resolve(), 50);

// 之后
import { timer, firstValueFrom } from 'rxjs';
await firstValueFrom(timer(50));
```

**模式 3: 使用 requestAnimationFrame**

```typescript
// 之前
setTimeout(() => {
  // UI 更新
}, 16);

// 之后
requestAnimationFrame(() => {
  // UI 更新
});
```

**具体修复清单**

| 文件 | 行号 | 当前代码 | 修复方案 |
|------|------|----------|----------|
| text-view.component.ts | L449 | `setTimeout(() => resolve(), 50)` | `firstValueFrom(timer(50))` |
| text-view.component.ts | L370 | `setTimeout(focusTimer, ...)` | 使用 `afterNextRender` |
| text-task-editor.component.ts | L476 | `setTimeout(() => {...}, 0)` | `queueMicrotask()` |

---

### S-04: 空实现方法清理方案

**当前状态**: 6+ 个空实现的"简化"方法

#### 清理策略

**选项 A: 删除空方法** (推荐)

```typescript
// 删除以下方法
// sync-coordinator.service.ts
- async initSyncPerception(_userId: string): Promise<void> { }
- async stopSyncPerception(): Promise<void> { }
- async createSyncCheckpoint(_memo?: string): Promise<void> { }
- async setPerceptionEnabled(_enabled: boolean): Promise<void> { }
```

**选项 B: 如果需要保留 API 兼容性**

```typescript
/**
 * @deprecated 此功能已在 LWW 简化中移除，调用将被忽略
 * @see https://docs.nanoflow.app/migration/lww-simplification
 */
async initSyncPerception(_userId: string): Promise<void> {
  this.logger.warn('initSyncPerception 已被移除，此调用无效');
}
```

**步骤**: 检查所有调用点，确认无使用后删除

---

## Phase 3: 中等问题修复

### M-01: AppComponent 模态框职责迁移

见 [C-04: AppComponent 拆分方案](#c-04-appcomponent-拆分方案)

---

### M-02: StoreService 代理地狱解决方案

**当前状态**: StoreService 有 50+ 个代理方法

#### 解决策略

**阶段 1: 停止添加新代理方法**

添加 ESLint 规则禁止向 StoreService 添加新方法：

```javascript
// eslint-plugin-local-rules
{
  'local-rules/no-new-store-service-methods': 'error'
}
```

**阶段 2: 文档化迁移路径**

更新 StoreService 顶部注释，添加完整的迁移指南：

```typescript
/**
 * ============================================================================
 * 【完整迁移指南】
 * ============================================================================
 * 
 * | 原方法 | 新服务 | 新方法 |
 * |--------|--------|--------|
 * | store.addTask() | TaskOperationAdapterService | taskOps.addTask() |
 * | store.updateTaskContent() | TaskOperationAdapterService | taskOps.updateTaskContent() |
 * | store.projects() | ProjectStateService | projectState.projects() |
 * | store.activeProject() | ProjectStateService | projectState.activeProject() |
 * | store.isSyncing() | SyncCoordinatorService | sync.isSyncing() |
 * | store.theme() | PreferenceService | pref.theme() |
 * 
 * ============================================================================
 */
```

**阶段 3: 渐进式移除** (3 个 Sprint)

每个 Sprint 移除 15-20 个代理方法，直到 StoreService 仅保留：
- 跨服务协调的复杂方法（如果有）
- 启动/初始化逻辑

---

### M-03: 配置文件拆分方案

**当前状态**: sync.config.ts 469 行

#### 拆分策略

```
src/config/sync.config.ts (469 行)
    ├── sync/core.config.ts (~100 行)        // 核心同步配置
    ├── sync/retry.config.ts (~80 行)        // 重试队列配置
    ├── sync/realtime.config.ts (~60 行)     // Realtime 配置
    ├── sync/polling.config.ts (~60 行)      // 轮询配置
    ├── sync/field-select.config.ts (~80 行) // 字段筛选配置
    └── sync/index.ts                        // 统一导出
```

---

### M-04: Result 模式一致性修复

**问题**: `unwrap()` 函数违背了 Result 模式的初衷

#### 修复方案

**选项 A: 移除 unwrap** (推荐)

```typescript
// 删除 unwrap 函数
// - export function unwrap<T>(result: Result<T>): T { ... }

// 强制调用方处理错误
const result = someOperation();
if (!result.ok) {
  // 必须处理错误
  return;
}
// 使用 result.value
```

**选项 B: 重命名并添加警告**

```typescript
/**
 * 将 Result 转换为值，失败时抛出异常
 * 
 * ⚠️ 警告：此函数会抛出异常，破坏 Result 模式的类型安全性
 * 仅在以下场景使用：
 * - 测试代码中断言结果
 * - 确定不会失败的操作（如内部初始化）
 * 
 * 生产代码应使用 if (result.ok) 模式
 */
export function unwrapUnsafe<T>(result: Result<T, OperationError>): T {
  if (result.ok) return result.value;
  throw new Error(`Unwrap failed: ${result.error.message}`);
}
```

---

### M-05: Prompt 文件配置修复

**问题**: `.github/prompts/` 中的工具配置语法错误（VS Code Copilot 不支持 `tools:` 语法）

**受影响文件（8个，已验证）**:
1. `.github/prompts/Bug Context Fixer.prompt.md`
2. `.github/prompts/gilfoyle.prompt.md`
3. `.github/prompts/implement.prompt.md`
4. `.github/prompts/refactor-clean.prompt.md`
5. `.github/prompts/research-technical-spike.prompt.md`
6. `.github/prompts/sql-optimization.prompt.md`
7. `.github/prompts/task-planner.agent.prompt.md`
8. `.github/prompts/task-researcher.prompt.md`

#### 修复方案

```yaml
# 之前（错误的 YAML-in-Markdown）
tools: ['search/changes', 'findTestFiles', ...]

# 之后（移除或使用正确语法）
# 移除 tools 行，因为这不是有效的 prompt 语法
```

**工作量**: 1d（已从 0.5d 上调）

---

## Phase 4: 设计问题重构

### D-01: GoJS 服务整合方案

**当前状态**: 17 个 GoJS 相关服务

#### 整合策略

**保留的核心服务** (6 个):

| 服务 | 职责 |
|------|------|
| FlowDiagramService | 核心生命周期 |
| FlowTemplateService | 节点/连接模板 |
| FlowEventService | 事件处理 |
| FlowLayoutService | 布局算法 |
| FlowSelectionService | 选择管理 |
| FlowZoomService | 缩放控制 |

**合并的服务**:

| 合并前 | 合并后 |
|--------|--------|
| FlowTouchService + FlowDragDropService | FlowInteractionService |
| MinimapMathService + ReactiveMinimapService | FlowMinimapService |
| FlowDiagramConfigService | 合并入 FlowDiagramService |
| FlowCommandService | 合并入 FlowEventService |
| MobileDrawerGestureService | 合并入 FlowInteractionService |

**移除的服务**:

| 服务 | 原因 |
|------|------|
| flow-template-events.ts | 可合并入 FlowEventService |

---

### D-02: 服务架构重新设计

**目标架构**:

```
┌─────────────────────────────────────────────────────────────────┐
│                         应用层 (App Layer)                       │
│  AppComponent, ShellComponent, 页面组件                          │
└─────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Feature 服务层 (Feature Services)            │
│  FlowDiagramService, TextViewService, FocusModeService          │
└─────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│                     领域服务层 (Domain Services)                  │
│  TaskOperationService, ProjectOperationService, SearchService   │
└─────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│                     基础设施层 (Infrastructure)                   │
│  SyncCoreService, AuthService, StorageService, LoggerService    │
└─────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│                     状态层 (State Layer)                         │
│  TaskStore, ProjectStore, UiStateService (Signals)              │
└─────────────────────────────────────────────────────────────────┘
```

**规则**:
- 上层可以注入下层
- 同层可以相互注入（需谨慎）
- 下层禁止注入上层

---

### D-03: 内存泄漏防护方案

**当前风险点**:

| 组件/服务 | 风险 | 修复 |
|-----------|------|------|
| FlowDiagramService | GoJS 事件监听器未清理 | 使用 DestroyRef 统一管理 |
| TextViewComponent | setTimeout 定时器 | 使用 pending timers 数组 |
| SimpleSyncService | Realtime 订阅 | 确保 teardown 被调用 |

**防护措施**:

```typescript
// 1. 创建统一的清理工具
// src/utils/cleanup.ts
export class CleanupManager {
  private cleanups: (() => void)[] = [];
  
  add(cleanup: () => void): void {
    this.cleanups.push(cleanup);
  }
  
  addTimer(timer: ReturnType<typeof setTimeout>): void {
    this.add(() => clearTimeout(timer));
  }
  
  addInterval(interval: ReturnType<typeof setInterval>): void {
    this.add(() => clearInterval(interval));
  }
  
  addSubscription(sub: Subscription): void {
    this.add(() => sub.unsubscribe());
  }
  
  cleanup(): void {
    this.cleanups.forEach(fn => fn());
    this.cleanups = [];
  }
}

// 2. 在组件/服务中使用
@Injectable()
export class MyService {
  private readonly cleanup = new CleanupManager();
  private readonly destroyRef = inject(DestroyRef);
  
  constructor() {
    this.destroyRef.onDestroy(() => this.cleanup.cleanup());
  }
  
  startPolling(): void {
    const timer = setInterval(() => { ... }, 5000);
    this.cleanup.addInterval(timer);
  }
}
```

---

### D-04: 测试架构改进方案

**当前问题**:
- Mock 使用 `any` 类型
- 测试文件散落各处
- 缺少统一的测试工具

#### 改进方案

**1. 创建测试工具库**

```
src/tests/
├── mocks/
│   ├── index.ts
│   ├── service-mocks.ts          # 服务 Mock
│   ├── component-mocks.ts        # 组件 Mock
│   └── store-mocks.ts            # Store Mock
├── fixtures/
│   ├── task.fixtures.ts          # 任务测试数据
│   ├── project.fixtures.ts       # 项目测试数据
│   └── user.fixtures.ts          # 用户测试数据
├── helpers/
│   ├── test-bed.helper.ts        # TestBed 辅助
│   ├── signal.helper.ts          # Signal 测试辅助
│   └── async.helper.ts           # 异步测试辅助
└── setup/
    ├── test-setup.ts             # 全局设置
    └── vitest.setup.ts           # Vitest 设置
```

**2. 创建类型安全的 Mock 工厂**

```typescript
// src/tests/mocks/service-mocks.ts
import { Signal, signal } from '@angular/core';

export interface TypedMock<T> {
  instance: T;
  spies: { [K in keyof T]: T[K] extends (...args: any[]) => any ? ReturnType<typeof vi.fn> : never };
}

export function createTypedMock<T>(config: Partial<T>): TypedMock<T> {
  // 实现...
}
```

---

## 实施时间线（修正后）

> ⚠️ **注意**: 原计划 6 个 Sprint（12 周）不足，修正后需要 **10-13 个 Sprint（20-26 周）**
> 
> 📊 **总工作量**: 100-130 人天（含 20% 缓冲）

### Sprint 1 (Week 1-2): 基础设施与验证

| 任务 | 优先级 | 工作量 |
|------|--------|--------|
| 修复 prompt 文件 tools: 语法错误 (8个) | P3 | 1d |
| **ESLint 规则升级为 error 级别** ⚠️修正 | P2 | 0.5d |
| 创建测试 Mock 类型库 | P2 | 2d |
| **验证并记录所有 343 处 console 调用** ⚠️新增 | P2 | 1d |
| **清理 ESLint 禁用注释 (4处生产代码优先)** ⚠️新增 | P2 | 1d |

### Sprint 2 (Week 3-4): 循环依赖与架构

| 任务 | 优先级 | 工作量 |
|------|--------|--------|
| 创建 EventBusService | P0 | 1d |
| 解决循环依赖 (含 injector hack) | P0 | 3d |
| 创建 BootstrapService | P1 | 1d |
| 创建 KeyboardShortcutService | P1 | 1d |

### Sprint 3 (Week 5-6): SimpleSyncService 拆分

| 任务 | 优先级 | 工作量 |
|------|--------|--------|
| 创建 sync/ 目录结构 | P0 | 0.5d |
| 提取 RetryQueueService | P0 | 2d |
| 提取 SyncCacheService | P0 | 1d |
| 提取 RealtimeService | P0 | 2d |
| 提取 PollingService | P0 | 1d |

### Sprint 4 (Week 7-8): sync-coordinator 拆分

| 任务 | 优先级 | 工作量 |
|------|--------|--------|
| **sync-coordinator.service.ts 拆分** ⚠️新增 | P0 | 3d |
| **action-queue.service.ts 拆分** ⚠️新增 | P1 | 2d |
| **store-persistence.service.ts 拆分** ⚠️新增 | P1 | 2d |

### Sprint 5 (Week 9-10): 其他服务拆分

| 任务 | 优先级 | 工作量 |
|------|--------|--------|
| FlowDiagramService 拆分 | P1 | 3d |
| TaskOperationService 拆分 | P1 | 2d |
| **task-operation-adapter 拆分** ⚠️新增 | P1 | 2d |

### Sprint 6 (Week 11-12): 组件拆分

| 任务 | 优先级 | 工作量 |
|------|--------|--------|
| AppComponent 拆分 | P1 | 2d |
| **FlowViewComponent 拆分 (2555行!)** ⚠️新增 | P1 | 3d |
| **text-view.component.ts 拆分** ⚠️新增 | P2 | 2d |

### Sprint 7 (Week 13-14): console/any 清理

| 任务 | 优先级 | 工作量 |
|------|--------|--------|
| **console.* 批量替换 (343处)** ⚠️修正工作量 | P2 | 3d |
| **any 类型修复 (36处)** | P2 | 2d |
| **不安全类型转换修复 (41处)** ⚠️新增 | P2 | 2d |

### Sprint 8 (Week 15-16): setTimeout 清理与整合

| 任务 | 优先级 | 工作量 |
|------|--------|--------|
| **setTimeout 滥用修复 (191处)** ⚠️新增 | P3 | 4d |
| 删除空实现方法 | P3 | 0.5d |
| 清理 @deprecated 方法 (第一批) | P2 | 1d |

### Sprint 9 (Week 17-18): GoJS 与 Store 整合

| 任务 | 优先级 | 工作量 |
|------|--------|--------|
| GoJS 服务整合 (17→10) | P2 | 3d |
| StoreService 代理方法清理 | P1 | 2d |
| **flow-template.service.ts 拆分** ⚠️新增 | P2 | 2d |

### Sprint 10 (Week 19-20): 验证与文档

| 任务 | 优先级 | 工作量 |
|------|--------|--------|
| 全面回归测试 | - | 3d |
| 性能基准测试 | - | 1d |
| 更新架构文档 | - | 1d |
| 更新 AGENTS.md | - | 0.5d |
| **清理剩余 @deprecated 方法** ⚠️新增 | P2 | 1d |

---

## 风险评估与回滚策略

### 高风险操作（修正后）

| 操作 | 风险 | 缓解措施 |
|------|------|----------|
| SimpleSyncService 拆分 | 同步功能中断 | 功能开关控制新旧实现 |
| **sync-coordinator 拆分** ⚠️新增 | 同步协调中断 | 保留原文件作为外观 |
| 循环依赖修复 | DI 错误 | 充分的单元测试 |
| AppComponent 拆分 | 模态框不工作 | 保持旧代码路径可用 |
| **FlowViewComponent 拆分** ⚠️新增 | 流程图功能中断 | 分步迁移 + 功能测试 |
| **console 批量替换** ⚠️新增 | 遗漏关键日志 | 先分类再替换 |

### 回滚策略

每个 Phase 完成后创建 Git Tag：

```bash
git tag -a phase-1-complete -m "Phase 1: Critical fixes complete"
git tag -a phase-2-complete -m "Phase 2: Severe issues fixed"
# ...
```

回滚命令：

```bash
git checkout phase-1-complete
```

### 功能开关

```typescript
// src/config/feature-flags.config.ts
export const REFACTOR_FLAGS = {
  USE_NEW_SYNC_ARCHITECTURE: false,    // Phase 1 完成后启用
  USE_EVENT_BUS: false,                 // 循环依赖修复后启用
  USE_MODAL_CONTAINER: false,           // AppComponent 拆分后启用
};
```

---

## 验收标准

### Phase 1 验收标准（修正后）

- [ ] SimpleSyncService ≤ 500 行
- [ ] **sync-coordinator.service.ts ≤ 500 行** ⚠️新增
- [ ] **所有超 800 行文件 ≤ 600 行** ⚠️新增
- [ ] 无循环依赖警告
- [ ] **无 injector.get() hack** ⚠️新增
- [ ] 所有 deprecated 方法有移除日期
- [ ] 所有现有测试通过
- [ ] E2E 测试通过

### Phase 2 验收标准（修正后）

- [ ] 无 console.* 语句（ESLint 'error' 级别通过）
- [ ] 无 `: any` 类型（ESLint 'error' 级别通过）
- [ ] **无 `as unknown` / `as any` 类型转换** ⚠️新增
- [ ] 无裸 setTimeout（除非有注释说明原因）
- [ ] **setTimeout 使用 ≤ 50 处** ⚠️新增
- [ ] **无 ESLint 禁用注释 或 全部有文档说明** ⚠️新增

### Phase 3 验收标准

- [ ] AppComponent ≤ 400 行
- [ ] StoreService ≤ 300 行
- [ ] 配置文件每个 ≤ 150 行
- [ ] **FlowViewComponent ≤ 600 行** ⚠️新增
- [ ] **text-view.component.ts ≤ 600 行** ⚠️新增

### Phase 4 验收标准

- [ ] GoJS 服务 ≤ 10 个
- [ ] 服务分层清晰
- [ ] 无内存泄漏（Chrome DevTools 验证）
- [ ] 测试覆盖率 ≥ 80%
- [ ] **prompt 文件语法正确** ⚠️新增

---

## 附录 A: 审查发现的新增问题详细方案

### 遗漏的 800-1200 行文件（深度验证发现）

以下 14 个文件（800-1200 行）未在原计划中，建议纳入 Phase 3 或 Phase 4 处理：

| 文件 | 行数 | 建议优先级 | 建议处理方式 |
|------|------|------------|--------------|
| flow-task-detail.component.ts | 1143 | P2 | 提取子组件 |
| flow-link.service.ts | 1123 | P2 | 职责拆分 |
| migration.service.ts | 1074 | P3 | 保持（迁移逻辑复杂） |
| conflict-resolution.service.ts | 1057 | P2 | 策略模式拆分 |
| minimap-math.service.ts | 967 | P3 | 保持（数学计算） |
| change-tracker.service.ts | 958 | P2 | 提取辅助类 |
| store.service.ts | 944 | P1 | 继续删除代理方法 |
| dashboard-modal.component.ts | 902 | P3 | 提取子组件 |
| user-session.service.ts | 895 | P2 | 职责拆分 |
| indexeddb-health.service.ts | 838 | P3 | 保持 |
| undo.service.ts | 827 | P2 | 提取历史记录管理 |
| attachment-export.service.ts | 817 | P3 | 保持 |
| text-view-drag-drop.service.ts | 809 | P2 | 合并到统一交互服务 |
| recovery-modal.component.ts | 803 | P3 | 保持 |

> **预估额外工作量**: 7-10 人天（已计入总估算 100-130 人天）

---

### C-07: FlowViewComponent 拆分方案

**当前状态**: 2555 行（比 FlowDiagramService 还大！）

**问题分析**: FlowViewComponent 包含了过多职责，包括：
- 工具栏管理
- 选择状态
- 右键菜单
- 详情面板
- 小地图交互
- 导出功能

**拆分策略**:

```
FlowViewComponent (2555 行)
    ├── FlowToolbarComponent (~200 行)      // 已存在，迁移更多逻辑
    ├── FlowContextMenuComponent (~150 行)  // 新建
    ├── FlowMinimapPanel (~200 行)          // 新建
    ├── FlowExportManager (~150 行)         // 新建服务
    └── FlowViewComponent (~500 行)         // 核心视图逻辑
```

---

### C-09: sync-coordinator.service.ts 拆分方案

**当前状态**: 1463 行

**问题分析**: 与 SimpleSyncService 职责重叠，需要明确边界

**拆分策略**:

1. 将协调逻辑保留在 SyncCoordinatorService
2. 将具体同步操作委托给 SimpleSyncService（拆分后的子服务）
3. 删除重复的代理方法

---

### S-05: ESLint 禁用注释清理

**当前状态（已验证）**: 
- 生产代码: 4 处 eslint-disable 注释
- 测试代码: 27 处 eslint-disable 注释
- 总计: 31 处

**清理策略**:

1. **优先处理生产代码** (4 处)：逐一审查，修复根本问题
2. **测试代码**：评估必要性，部分 `@ts-expect-error` 在测试中是合理的
3. 创建 `.eslintrc.overrides` 文件记录必要的例外

**验证命令**:
```bash
# 生产代码 ESLint 禁用
grep -rn "eslint-disable\|@ts-ignore\|@ts-expect-error" src --include="*.ts" | grep -v spec | wc -l
# 结果: 4

# 测试代码 ESLint 禁用
grep -rn "eslint-disable\|@ts-ignore\|@ts-expect-error" src --include="*.spec.ts" | wc -l
# 结果: 27
```

---

### S-06: 不安全类型转换修复

**当前状态**: 41 处 `as unknown` 或 `as any`

**修复策略**:

```typescript
// 之前
const result = data as unknown as MyType;

// 之后 - 使用类型守卫
function isMyType(data: unknown): data is MyType {
  return typeof data === 'object' && data !== null && 'requiredProp' in data;
}

if (isMyType(data)) {
  // 类型安全使用
}
```

---

### S-08: injector.get() hack 修复

**发现位置**:
- `task-operation-adapter.service.ts:1170`
- `auth.service.ts:615`
- `flow-view.component.ts:699`
- 其他测试文件

**修复方案**: 使用事件总线模式（见 C-05 方案）彻底解决循环依赖

---

## 附录 B: 验证命令（修正后）

```bash
# 检查所有超 800 行的生产文件
find src -name "*.ts" -not -name "*.spec.ts" -exec wc -l {} + | awk '$1 > 800 {print}' | sort -rn

# 验证 console.* 调用（实际 343 处）
grep -rn "console\." src --include="*.ts" | wc -l

# 验证 any 类型（实际 36 处）
grep -rn ": any\b" src --include="*.ts" | wc -l

# 验证 setTimeout（实际 191 处）
grep -rn "setTimeout" src --include="*.ts" | wc -l

# 验证 deprecated（实际 27 处）
grep -rn "@deprecated" src --include="*.ts" | wc -l

# 验证 ESLint 禁用（实际 31 处）
grep -rn "eslint-disable\|@ts-ignore\|@ts-expect-error" src --include="*.ts" | wc -l

# 验证不安全类型转换（实际 41 处）
grep -rn "as unknown\|as any" src --include="*.ts" | grep -v "spec.ts" | wc -l

# 验证 injector hack
grep -rn "injector\.get\|inject(Injector)" src --include="*.ts" | grep -v "spec.ts"

# 检查循环依赖
npm run build 2>&1 | grep -i "circular"
```

---

## 附录

### A. 受影响文件清单

```
src/
├── app/
│   ├── core/
│   │   └── services/
│   │       └── simple-sync.service.ts  ★ 重构
│   └── features/
│       └── flow/
│           └── services/
│               └── flow-diagram.service.ts  ★ 重构
├── services/
│   ├── store.service.ts  ★ 清理
│   ├── sync-coordinator.service.ts  ★ 清理
│   ├── task-operation.service.ts  ★ 拆分
│   └── task-operation-adapter.service.ts  ★ 修复循环依赖
└── app.component.ts  ★ 拆分
```

### B. 新增文件清单

```
src/
├── app/
│   ├── core/
│   │   └── services/
│   │       └── sync/
│   │           ├── index.ts
│   │           ├── sync-core.service.ts
│   │           ├── retry-queue.service.ts
│   │           ├── sync-cache.service.ts
│   │           ├── realtime.service.ts
│   │           ├── polling.service.ts
│   │           └── tombstone.service.ts
│   └── shared/
│       └── components/
│           └── modal-container.component.ts
├── services/
│   ├── bootstrap.service.ts
│   ├── keyboard-shortcut.service.ts
│   ├── event-bus.service.ts
│   ├── task-rank.service.ts
│   └── task-move.service.ts
├── tests/
│   ├── mocks/
│   │   ├── index.ts
│   │   └── service-mocks.ts
│   └── fixtures/
│       └── task.fixtures.ts
└── utils/
    └── cleanup.ts
```

### C. 命令行工具

```bash
# 检查代码行数
find src -name "*.ts" -exec wc -l {} + | sort -n | tail -20

# 查找 console.log
grep -rn "console\." src --include="*.ts" | wc -l

# 查找 any 类型
grep -rn ": any" src --include="*.ts" | wc -l

# 查找 deprecated
grep -rn "@deprecated" src --include="*.ts" | wc -l

# 查找循环依赖警告
npm run build 2>&1 | grep -i "circular"
```

---

**文档结束**

> *"计划永远赶不上变化，但没有计划的变化就是混乱。"*  
> *— 某个不是 Gilfoyle 的人*
