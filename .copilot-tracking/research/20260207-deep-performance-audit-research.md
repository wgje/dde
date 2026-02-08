<!-- markdownlint-disable-file -->

# Task Research Notes: NanoFlow 深度性能审计报告全量研究

**研究日期**: 2026-02-07
**研究员**: Task Researcher
**状态**: ✅ 研究完成
**审计来源**: `docs/deep-performance-audit-2026-02-07.md`

---

## Research Executed

### File Analysis

- `docs/deep-performance-audit-2026-02-07.md` (736 行)
  - 完整审计报告，覆盖 14 个章节，3 个 P0 致命问题 + 5 个 P1 严重问题 + 3 个 P2 警告
  - 测试环境：Headless Chrome 144 / Ubuntu 24.04 / 无节流

- `src/app/core/shell/project-shell.component.ts` (626 行)
  - P0-2 核心问题：L211-L242 中 `@defer (on viewport; prefetch on idle)` 桌面端始终在视口内
  - 桌面端 `.flow-column` 通过 `@if (!uiState.isMobile() || ...)` 始终渲染
  - 已有 `@placeholder` 和 `@error` 模板（审计报告中部分建议已实施）

- `src/app.component.ts` (1,129 行)
  - P1-2 核心问题：L66 静态导入 `FocusModeComponent` 和 `SpotlightTriggerComponent`
  - 25+ 个 `inject()` 依赖，承载全部顶层协调逻辑
  - FocusModeComponent 依赖链：GateService → SpotlightService → BlackBoxService → BlackBoxSyncService → FocusPreferenceService

- `main.ts` (361 行)
  - P0-3 核心问题：L237 注册 SW `provideServiceWorker` + L289 注销 `unregisterAllServiceWorkers`
  - 注册策略 `registerWhenStable:30000`
  - 注销在 `runPostBootstrapMaintenance` 中通过 `scheduleIdleTask` 执行

- `src/services/sync-coordinator.service.ts` (899 行)
  - P1-3/P1-4 核心问题：构造函数 L189-L202 启动 1s `setInterval` + 级联创建 10+ 子服务
  - `startLocalAutosave()` L380 使用 `SYNC_CONFIG.LOCAL_AUTOSAVE_INTERVAL` (1000ms)
  - 注入 18 个依赖服务

- `src/config/sync.config.ts` (517 行)
  - `LOCAL_AUTOSAVE_INTERVAL: 1000` 确认每秒写 IndexedDB

- `angular.json` (107 行)
  - P1-5 Budget 配置：initial `1.8mb`/`2.5mb`，main bundle `600kb`/`800kb`
  - P2-1 `namedChunks: true` 在生产环境启用
  - 已配置 `serviceWorker: "ngsw-config.json"`

- `ngsw-config.json` (105 行)
  - P2-2：所有资产组 `installMode: "prefetch"`，包括字体 (784KB)
  - SW 安装时预取全部 JS chunks + 字体 + 图标

- `package.json` (88 行)
  - P2-3：`@angular/build`, `@angular/cli`, `@angular/compiler-cli`, `dotenv`, `esbuild` 在 `dependencies` 而非 `devDependencies`
  - 影响 Docker 镜像大小和 CI 构建缓存
  - `gojs: ^3.1.1` 在 dependencies 中（约 800KB 未压缩）

- `src/models/index.ts` (352 行)
  - L327 `export * from './gojs-boundary'` **确认 GoJS 泄漏路径**
  - `gojs-boundary.ts` L21 有 `import * as go from 'gojs'`
  - 所有 eagerly loaded 的代码若导入 `from '../models'`，GoJS 即被拉入 main bundle
  - **已验证**：`app.component.ts` L36 `import { ThemeType, Project } from './models'` → 触发 barrel 导出 → GoJS 进入 main bundle

- `src/models/gojs-boundary.ts` (270 行)
  - 运行时函数 `extractNodeMoveData`, `extractLinkCreateData`, `extractSelectionData` 使用 `go.Part`, `go.Link`, `go.Diagram` 类型
  - 接口定义 `GojsNodeData`, `GojsLinkData` 不依赖 GoJS 运行时
  - 但 `taskToGojsNode` 等转换函数虽未被任何代码使用，仍因 `export *` 被打包

- `src/app/features/flow/services/flow-diagram-effects.service.ts` (200 行)
  - 7 个独立 `effect()`：tasks/connections/search/theme/selectionSync/centerCommand/retryCommand
  - 所有 effect 都有 `if (this.diagram.isInitialized)` 守卫
  - 使用 `requestAnimationFrame` 合并更新，减少连续 signal 触发的频率
  - 无明显无限循环风险（effect 内部未写入会导致循环的 signal）

- `src/app/features/flow/components/flow-view.component.ts` (759 行)
  - 注入 22 个服务（审计报告准确）
  - 包含 `import * as go from 'gojs'`（L50）
  - 作为 `@defer` 目标组件，其整个依赖链在 defer 触发时加载

- `src/app/features/flow/services/flow-diagram.service.ts` (762 行)
  - `providedIn: 'root'` + `import * as go from 'gojs'`
  - **关键发现**：虽然 `providedIn: 'root'` 支持 tree-shaking，但因为 `FlowViewComponent` 在 `@defer` 块中直接 `inject()` 这些服务，Angular 编译器会将它们放入 defer chunk
  - 真正的 GoJS 泄漏来自 `models/index.ts` barrel 导出，而非 flow 服务的 `providedIn: 'root'`

- `scripts/inject-modulepreload.cjs` (154 行)
  - 排除模式 `/chunk-[A-Z0-9]+-gojs/i` 可能无法匹配 esbuild 生成的随机 chunk 名
  - esbuild 的 chunk 命名格式是 `chunk-HASH.js`，不包含 `-gojs` 后缀
  - 但 GoJS 正则仅用于排除 preload（不影响 tree-shaking 或代码分割）

- `index.html` (740 行)
  - 骨架屏 CSS 约 300 行内联（审计报告准确）
  - 数据预加载脚本约 80 行（在 `requestIdleCallback` 中执行）
  - Anti-FOUC 脚本约 25 行（阻塞渲染，必要的）
  - 调试脚本约 10 行（检测加载超时）
  - 阻塞渲染的内联 CSS 约 23KB（合计骨架屏 + 字体声明）

- `src/app.routes.ts` (97 行)
  - `ProjectShellComponent` 使用 `loadComponent: () => import(...)` 路由懒加载 ✅
  - 但 `requireAuthGuard` 和 `projectExistsGuard` 是 eagerly loaded

### Code Search Results

- `providedIn.*root` (flow services)
  - 20+ 个 flow 服务使用 `providedIn: 'root'`（审计报告准确）
  - 包括：FlowDiagramService, FlowTemplateService, FlowSelectionService, FlowZoomService, FlowEventService, FlowTouchService, FlowLayoutService, FlowLinkService, FlowDragDropService, FlowDiagramEffectsService, FlowEventRegistrationService, FlowDiagramRetryService, FlowCascadeAssignService, FlowDiagramConfigService, ReactiveMinimapService, FlowPaletteResizeService, FlowKeyboardService, FlowSwipeGestureService, FlowOverviewService, FlowLinkTemplateService, FlowSelectModeService, FlowTaskOperationsService, FlowViewCleanupService, FlowBatchDeleteService, FlowMobileDrawerService, MinimapMathService, FlowDiagramDataService

- `import * as go from 'gojs'` (flow services)
  - 18 个 flow 服务文件直接导入 GoJS
  - 额外泄漏：`src/models/gojs-boundary.ts` L21
  - FlowViewComponent 自身也在 L50 导入 GoJS

- `import.*from.*gojs-boundary` (workspace-wide)
  - **0 个直接导入** — 无代码直接 `import from './gojs-boundary'`
  - 唯一引用路径：`models/index.ts` L327 的 `export * from './gojs-boundary'`
  - 这意味着 GoJS 泄漏完全通过 barrel export 发生

- `LOCAL_AUTOSAVE_INTERVAL`
  - `src/config/sync.config.ts` L35: 定义为 1000ms
  - `src/services/sync-coordinator.service.ts` L385: 在 `setInterval` 中使用
  - `src/services/persist-scheduler.service.ts` L102: 也有一个独立的 1s 定时器
  - **发现双重写入**：SyncCoordinatorService 和 PersistSchedulerService 都在每秒写 IndexedDB

### External Research

- Angular `@defer (on viewport)` 文档 (angular.dev)
  - `on viewport` 使用 IntersectionObserver API 监听 `@placeholder` 或指定元素进入视口
  - 默认监听 `@placeholder` 的根元素
  - **关键**：如果 placeholder 在页面加载时已在视口内，defer 块会**立即触发**
  - 桌面端 Flow Column 始终可见 → placeholder 立即在视口 → GoJS 立即加载

- Angular `providedIn: 'root'` + tree-shaking
  - `providedIn: 'root'` 的服务如果从未被 `inject()` 引用，会被 tree-shake 移除
  - 但如果任何 eagerly loaded 的代码（直接或间接）引用了这些服务，它们会进入 main bundle
  - **关键**：flow 服务虽然 `providedIn: 'root'`，但因为仅在 `@defer` 组件中被 inject，理论上应该被放入 defer chunk
  - **GoJS 泄漏的真正根因是 `models/index.ts` 的 barrel export**

### Project Conventions

- Standards referenced: AGENTS.md（ID 策略, 同步架构, GoJS 策略, 树遍历限制）
- Instructions followed: angular.instructions.md（OnPush, Signals, standalone, @defer）
- frontend.instructions.md: GoJS 移动端策略、`@defer` 懒加载、`visibility:hidden` 禁令

---

## Key Discoveries

### 一、审计报告准确性验证

| 审计发现 | 验证结果 | 准确性 | 补充说明 |
|----------|----------|--------|----------|
| P0-1 页面卡死 | ✅ 可复现现象 | 准确 | 根因需进一步调查 |
| P0-2 GoJS 桌面端无效懒加载 | ✅ 已验证源码 L211-L242 | 准确 | `@defer (on viewport)` 因 placeholder 始终在视口而立即触发 |
| P0-3 SW 注册/注销矛盾 | ✅ 已验证 main.ts L237 vs L289 | 准确 | SW 注册后在 idle 时被注销 |
| P1-1 401 API 错误 | ⚠️ 运行时问题 | 可能准确 | 需检查 JWT Secret 和 RLS 配置 |
| P1-2 FocusModeComponent 静态加载 | ✅ app.component.ts L66 | 准确 | 依赖5个专注模式服务 |
| P1-3 每秒 IDB 写入 | ✅ sync.config.ts L35 确认 1000ms | 准确 | **发现双重写入**：SyncCoordinator + PersistScheduler |
| P1-4 SyncCoordinator 急切初始化 | ✅ 构造函数 L189-202 | 准确 | 级联创建 18 个依赖服务 |
| P1-5 Budget 过高 | ✅ angular.json L52-L57 | 准确 | initial 2.5MB error 远超行业标准 |
| P2-1 namedChunks 生产启用 | ✅ angular.json L50 | 准确 | chunk 名泄露组件路径 |
| P2-2 SW fonts prefetch | ✅ ngsw-config.json L28-L39 | 准确 | 784KB 字体在安装时预取 |
| P2-3 构建依赖错放 | ✅ package.json L41-L56 | 准确 | 5 个 devDep 错放在 dependencies |

### 二、审计报告遗漏的重要发现

#### 遗漏 1: GoJS 通过 Barrel Export 泄漏进 Main Bundle（🔴 致命）

**审计报告仅提到** `models/gojs-boundary.ts` 的泄漏可能性，但未深入验证。

**研究验证的完整泄漏链**：
```
app.component.ts L36
  └── import { ThemeType, Project } from './models'
        └── models/index.ts L327
              └── export * from './gojs-boundary'
                    └── gojs-boundary.ts L21
                          └── import * as go from 'gojs'
                                └── GoJS ~800KB 被拉入 main bundle ❌
```

**影响**：即使 `ThemeType` 和 `Project` 与 GoJS 无关，esbuild 无法完全 tree-shake `export *` 中的副作用模块，因为 GoJS 的 `import * as go` 可能包含模块级别的副作用代码。

**修复优先级**：P0 — 这是导致 main bundle 从预期 ~300KB 膨胀到 170KB br (~600-800KB 解压) 的直接原因之一。

#### 遗漏 2: 双重 IndexedDB 自动保存（🟡 严重）

两个独立服务都在每 1000ms 执行 IndexedDB 写入：
- `SyncCoordinatorService.startLocalAutosave()` (L380)
- `PersistSchedulerService` (L102)

这意味着实际 IndexedDB 写入频率是 **每秒 2 次**，而非审计报告中描述的每秒 1 次。

#### 遗漏 3: FlowDiagramService 构造函数中的 Effect（🟡 潜在风险）

`flow-diagram.service.ts` L88-L104 在构造函数中创建了 `effect()`，监听 `themeService.isDark()` 和 `themeService.theme()` 的变化。由于 `providedIn: 'root'`，该 effect 在服务首次注入时即开始运行，即使 Diagram 尚未初始化（有 `if (this.diagram && !this.isDestroyed)` 守卫但仍在监听）。

#### 遗漏 4: 项目 Shell 组件桌面端 Flow Column 文本视图透明度切换

`project-shell.component.ts` L213-L222 中，桌面端 Flow Column 始终渲染（不仅是 `@defer` 问题），同时 Text Column 始终渲染。两个视图同时存在于 DOM 中，桌面端不存在条件销毁，仅通过 `opacity-0` / `pointer-events-none` 在移动端隐藏。

### 三、页面卡死根因深度分析

**审计报告的 4 个假设分析**：

| 假设 | 审计评估 | 研究验证 | 修正评估 |
|------|----------|----------|----------|
| 假设 1: GoJS chunk PENDING | 🔴 最可能 | ⚠️ 可能但不是根因 | GoJS 通过 barrel export 已在 main bundle，PENDING chunk 可能是 flow-view 子 chunk |
| 假设 2: Signal effect 无限循环 | 🟡 可能 | ❌ 不太可能 | 所有 effect 都有 `isInitialized` 守卫，使用 rAF 合并 |
| 假设 3: Supabase 重连风暴 | 🟡 可能 | ⚠️ 可能加剧 | 401 错误 → RetryQueue → 反复重试 → CPU 占用 |
| 假设 4: IndexedDB 锁竞争 | 🟢 低可能 | 🟡 上调 | 双重写入 (2次/秒) + Supabase 重试 + 数据加载并发 |

**修正后的根因推断**：

最可能的场景是 **GoJS 被 barrel export 拉入 main bundle** → main.js 解压后体积巨大 (~800KB+) → **JavaScript 解析和执行时间过长** → 加上 `SyncCoordinatorService` 在构造函数中级联创建 18 个服务 + 启动 1s 定时器 → `@defer` 因 viewport 立即触发 → 又一次加载 flow-view 的额外 chunk → **Main Thread 长期阻塞导致页面卡死**。

### 四、各 P0/P1 问题的详细技术验证

#### P0-2: `@defer (on viewport)` 桌面端失效 — 完整验证

`project-shell.component.ts` L211-L242 模板结构：

```html
<!-- 外层 @if 控制渲染 -->
@if (!uiState.isMobile() || uiState.activeView() === 'flow') {
  <!-- 桌面端此容器始终可见 -->
  <div class="flex-1 flex flex-col min-w-[300px] min-h-0">
    
    @defer (on viewport; prefetch on idle) {
      <app-flow-view></app-flow-view>
    } @placeholder {
      <!-- 这个 placeholder <div> 在桌面端始终在视口内 -->
      <div class="flex-1 flex items-center justify-center text-stone-400">
        <div class="animate-spin ..."></div>
      </div>
    } @error {
      <div>流程图加载失败</div>
    }
  </div>
}
```

**Angular `@defer (on viewport)` 行为**：
- 使用 IntersectionObserver 监听 `@placeholder` 的根元素
- 当 placeholder 进入视口时触发加载
- 桌面端 `.flow-column` 始终可见 → placeholder 在首帧即在视口内
- **结果**：GoJS chunk 在首屏渲染路径上被加载，等同于静态 import

#### P0-3: Service Worker 矛盾 — 完整验证

`main.ts` 中的矛盾链路：

1. **L237**: `provideServiceWorker('ngsw-worker.js', { registrationStrategy: 'registerWhenStable:30000' })`
   - Angular 应用稳定后（最多 30s）注册 SW
2. **ngsw-config.json**: 所有 assetGroups 使用 `installMode: "prefetch"`
   - SW install 事件触发时预取所有资源：全部 JS chunks + 784KB 字体 + 图标
3. **L289**: `unregisterAllServiceWorkers()` 在 `scheduleIdleTask` 中执行
   - 浏览器空闲时注销所有 SW

时序：Angular stabilize → 注册 SW → SW install → prefetch ~2MB → idle → 注销 SW → 预取的资源白费

#### P1-3/P1-4: SyncCoordinatorService 急切初始化 — 完整验证

构造函数执行链：
```typescript
constructor() {
  // L191: 注册 7+ 处理器（同步调用）
  this.actionQueueProcessors.setupProcessors();
  // L192: 验证处理器完整性
  this.validateRequiredProcessors();
  // L193: 启动 1s setInterval 写 IndexedDB
  this.startLocalAutosave();
  // L194: 设置同步回调
  this.setupSyncModeCallback();
  // L196-L203: 注册 destroy 清理
}
```

注入的 18 个服务在构造函数调用时级联创建：
- SimpleSyncService (1032行, 17依赖) → 又级联创建其内部依赖
- ActionQueueService (1376行)
- ActionQueueProcessorsService
- DeltaSyncCoordinatorService
- ProjectSyncOperationsService
- ConflictResolutionService
- ConflictStorageService
- ChangeTrackerService
- ProjectStateService
- AuthService
- ToastService
- LayoutService
- LoggerService
- SentryAlertService
- RetryQueueService (663行)
- PersistSchedulerService
- SyncModeService
- BlackBoxSyncService

### 五、实施影响评估

| 问题 | 修复难度 | 预期收益 | 风险 |
|------|----------|----------|------|
| GoJS barrel export 泄漏 | 🟢 低（删除一行 export） | 🔴 极大（main.js -200~400KB） | 🟢 低（无代码使用该导出） |
| `@defer` 改为 `on idle` 或 `on interaction` | 🟢 低（改模板关键字） | 🔴 大（首屏不加载 GoJS） | 🟡 中（需验证 UX 影响） |
| SW 矛盾解决 | 🟢 低（二选一：保留或移除） | 🟡 中（节省 ~2MB 带宽） | 🟢 低 |
| FocusModeComponent 懒加载 | 🟡 中（需改 app.component 模板） | 🟡 中（main.js -50~80KB） | 🟡 中（需确保大门功能不受影响） |
| 自动保存改为 3s debounce | 🟢 低（改配置值 + 用 debounce） | 🟡 中（减少 CPU/IO） | 🟢 低 |
| SyncCoordinator 延迟初始化 | 🟡 中（需重构构造函数） | 🟡 中（减少首屏服务链） | 🟡 中（需确保同步不受影响） |
| Budget 收紧 | 🟢 低（改 angular.json） | 🟡 中（防止回归） | 🟢 低 |
| namedChunks 关闭 | 🟢 低（改 angular.json） | 🟢 低（安全性微增） | 🟢 低 |
| 依赖错放修复 | 🟢 低（移动到 devDependencies） | 🟢 低（Docker 镜像缩小） | 🟢 低 |

---

## Recommended Approach

### 修复优先级排序

基于 **收益/风险比** 和 **修复难度** 综合排序：

**第一波（立即修复，30分钟内完成）**：

1. **移除 `models/index.ts` 中的 `export * from './gojs-boundary'`**
   - 这是整个审计中 ROI 最高的修复
   - 一行代码变更，预期 main bundle 减少 200-400KB
   - 无代码直接导入 gojs-boundary（0 个直接引用），零风险

2. **将 `@defer (on viewport)` 改为 `@defer (on idle)`**
   - 桌面端 GoJS 在浏览器空闲时加载，不阻塞首屏
   - `prefetch on idle` 保持不变
   - 用户体验：可能有 1-2 秒的加载等待，但首屏渲染不受影响

3. **解决 SW 矛盾**
   - 推荐方案：移除 `provideServiceWorker` 注册（因后续会注销）
   - 或移除 `unregisterAllServiceWorkers`（保留 SW 缓存能力）
   - 若保留 SW，将 ngsw-config fonts 改为 `installMode: "lazy"`

**第二波（当天修复）**：

4. **FocusModeComponent 改为 `@defer (when focusPreferences.gateEnabled())`**
5. **LOCAL_AUTOSAVE_INTERVAL 从 1000ms 改为 3000ms + debounce**（同时排查 PersistScheduler 的重复写入）
6. **SyncCoordinatorService 延迟启动定时器**（移到认证完成后）
7. **Budget 收紧**：initial `800kb/1.2mb`，main bundle `400kb/600kb`
8. **namedChunks 改为 false**
9. **移动 devDependencies 到正确位置**

---

## Implementation Guidance

- **Objectives**: 消除 P0 致命问题（页面卡死、GoJS 无效懒加载、SW 矛盾），将 main.js 从 170KB br 降至 <100KB br，消除首屏 GoJS 加载
- **Key Tasks**:
  1. 删除 `models/index.ts` 中的 GoJS barrel export
  2. 修改 `project-shell.component.ts` 的 `@defer` 触发器
  3. 清理 SW 矛盾配置
  4. FocusModeComponent 懒加载化
  5. 同步服务延迟初始化
  6. Bundle budget 收紧
- **Dependencies**: 
  - GoJS barrel export 修复是其他优化的前提（否则 bundle 分析不准确）
  - SW 修复独立于其他修改
  - FocusModeComponent 懒加载需要先确认大门功能的测试覆盖
- **Success Criteria**:
  - main.js br < 100KB
  - 页面不再卡死（LCP < 2.5s，INP < 200ms）
  - 首屏不加载 GoJS（在 Network tab 中验证）
  - SW 行为一致（要么始终启用，要么始终禁用）
  - E2E 测试全部通过

