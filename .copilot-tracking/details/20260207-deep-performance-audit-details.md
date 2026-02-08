<!-- markdownlint-disable-file -->

# Task Details: NanoFlow 深度性能审计修复

## Research Reference

- .copilot-tracking/research/20260207-deep-performance-audit-research.md

---

## Phase 1: GoJS Bundle 泄漏修复（P0 — 最高优先级）

### Task 1.1: 移除 `models/index.ts` 中的 GoJS barrel export

**问题根因**：`src/models/index.ts` L327 的 `export * from './gojs-boundary'` 导致 GoJS ~800KB 被拉入 main bundle。完整泄漏链：

```
app.component.ts L36: import { ThemeType, Project } from './models'
  → models/index.ts L327: export * from './gojs-boundary'
    → gojs-boundary.ts L21: import * as go from 'gojs'
      → GoJS ~800KB 进入 main bundle ❌
```

**关键验证**：workspace 中 0 个文件直接 `import from './gojs-boundary'`（研究报告已确认），删除此行零风险。

**操作**：
1. 打开 `src/models/index.ts`
2. 删除 L327 `export * from './gojs-boundary'`
3. 确认没有其他文件通过 `from '../models'` 访问 `gojs-boundary` 中的类型

- **Files**:
  - `src/models/index.ts` — 删除 `export * from './gojs-boundary'` 这一行
- **Success**:
  - `grep -r "gojs-boundary" src/models/index.ts` 返回空
  - `ng build` 成功，无编译错误
  - 无代码破损（因为 0 个直接引用）
- **Research References**:
  - 研究报告 Lines 125-137 — GoJS barrel export 泄漏链验证
  - 研究报告 Lines 138-140 — 0 个直接导入确认
- **Dependencies**:
  - 无前置依赖

### Task 1.2: 清理 `gojs-boundary.ts` 中未使用的运行时导出

**问题**：`gojs-boundary.ts` 包含两类导出：
1. **纯类型接口**（`GojsNodeData`, `GojsLinkData` 等）— 无 GoJS 运行时依赖，可被其他代码安全使用
2. **运行时函数**（`taskToGojsNode`, `extractNodeMoveData` 等）— 依赖 `go.Part`, `go.Link`，需要 GoJS 运行时

**操作**：
1. 搜索 workspace 中哪些文件使用 `gojs-boundary.ts` 中的运行时函数
2. 如果仅有 flow 服务使用（预期如此），将运行时函数移入 `src/app/features/flow/` 目录
3. `gojs-boundary.ts` 仅保留纯类型接口（不依赖 GoJS 的类型），并移除 `import * as go from 'gojs'`
4. 如果纯类型接口也无外部使用，考虑将整个文件移入 flow 目录

- **Files**:
  - `src/models/gojs-boundary.ts` — 拆分：纯类型留此处，运行时函数移到 flow 目录
  - `src/app/features/flow/types/gojs-runtime.ts`（新建）— 承接运行时函数
  - 使用了运行时函数的 flow 服务文件 — 更新 import 路径
- **Success**:
  - `gojs-boundary.ts` 不再包含 `import * as go from 'gojs'`
  - 所有 flow 服务编译正常
  - `ng build` 成功
- **Research References**:
  - 研究报告 Lines 64-67 — gojs-boundary 运行时函数列举
  - 研究报告 Lines 68-69 — 纯接口 vs 运行时函数区分
- **Dependencies**:
  - Task 1.1 完成（barrel export 已移除）

### Task 1.3: 验证 GoJS 不再出现在 main bundle

**操作**：
1. 执行 `ng build --configuration production`
2. 使用 `npx esbuild-visualizer` 或 `source-map-explorer` 分析产物
3. 确认 main.js 中不包含 GoJS 代码
4. GoJS 应仅出现在 flow-view 的 defer chunk 中

**验证点**：
- main.js 体积显著下降（预期从 ~170KB br 降至 <130KB br，仅此一步）
- `grep -r "GoJS" dist/` 应仅在 lazy chunk 中出现
- `gojs` 字面量不出现在 main.*.js 文件名或内容中

- **Files**:
  - 无文件修改，纯验证任务
- **Success**:
  - main.js br < 130KB（仅此修复的效果）
  - GoJS 代码仅存在于 defer/lazy chunk 中
- **Research References**:
  - 研究报告 Lines 143-147 — P0 影响评估
- **Dependencies**:
  - Task 1.1 和 Task 1.2 完成

---

## Phase 2: @defer 触发器修复（P0-2）

### Task 2.1: 将桌面端 `@defer (on viewport)` 改为 `@defer (on idle)` 或 `@defer (on interaction)`

**问题根因**：`project-shell.component.ts` L211-L242 中 `@defer (on viewport; prefetch on idle)` 在桌面端失效。桌面端 `.flow-column` 始终在视口内，`@placeholder` 在首帧即被 IntersectionObserver 检测到，导致 GoJS chunk 在首屏渲染路径上被加载。

**推荐方案**（二选一，根据实际 UX 测试决定）：

**方案 A（推荐）：`@defer (on idle; prefetch on idle)`**
- 浏览器空闲时自动加载 GoJS
- 用户无需任何操作即可看到流程图（延迟 1-3 秒）
- `prefetch on idle` 保持不变，确保提前预取

**方案 B：`@defer (on interaction; prefetch on idle)`**
- 用户与 Flow Column 交互时才加载（如点击、鼠标悬停）
- 首屏完全不加载 GoJS
- 需要更好的 placeholder 提示用户交互

**操作**：
1. 打开 `src/app/core/shell/project-shell.component.ts`
2. 找到 L211-L242 的 `@defer` 块
3. 将 `@defer (on viewport; prefetch on idle)` 改为 `@defer (on idle; prefetch on idle)`
4. 优化 `@placeholder` 提供更好的加载过渡体验（可选：添加骨架屏样式）

```html
<!-- 修改前 -->
@defer (on viewport; prefetch on idle) {
  <app-flow-view></app-flow-view>
}

<!-- 修改后 -->
@defer (on idle; prefetch on idle) {
  <app-flow-view></app-flow-view>
}
```

- **Files**:
  - `src/app/core/shell/project-shell.component.ts` — 修改 `@defer` 触发条件
- **Success**:
  - 桌面端首屏不加载 flow-view chunk（Network tab 验证）
  - Flow 视图在浏览器空闲后正常显示（1-3 秒内）
  - 移动端行为不受影响（仍由 `@if` 控制）
- **Research References**:
  - 研究报告 Lines 183-202 — P0-2 完整验证
  - 研究报告 Lines 104-109 — Angular @defer on viewport 行为
- **Dependencies**:
  - Phase 1 完成（GoJS 不在 main bundle 后，defer 才有实际意义）

### Task 2.2: 验证桌面端首屏不加载 flow-view chunk

**操作**：
1. `ng serve` 启动开发服务器
2. 打开 Chrome DevTools → Network tab
3. 刷新页面，观察首屏加载的 JS 文件
4. 确认 flow-view 相关 chunk 在首屏不出现
5. 等待浏览器空闲后，确认 flow-view chunk 被预取和加载

- **Files**:
  - 无文件修改，纯验证任务
- **Success**:
  - 首屏 Network 请求中无 flow-view 相关 chunk
  - 浏览器空闲后 flow-view chunk 出现在 Network 中
  - 流程图正常渲染
- **Dependencies**:
  - Task 2.1 完成

---

## Phase 3: Service Worker 矛盾清理（P0-3）

### Task 3.1: 统一 SW 策略（移除注销逻辑，保留 SW 缓存能力）

**问题根因**：`main.ts` L237 注册 SW，但 L289 的 `unregisterAllServiceWorkers()` 在 `scheduleIdleTask` 中注销所有 SW，导致：
1. SW 注册成功 → install 事件触发 → prefetch ~2MB 资源
2. 浏览器空闲 → 注销 SW → 缓存失效 → 预取的资源白费

**推荐方案**：保留 SW 注册，移除 `unregisterAllServiceWorkers()` 调用。

**理由**：
- PWA 离线能力是项目核心需求（AGENTS.md: "PWA + IndexedDB"）
- SW 缓存可显著减少后续访问的网络请求
- 如果之前添加 unregister 是为了解决某个 SW 更新问题，应通过 `SwUpdate` API 正确处理

**操作**：
1. 打开 `main.ts`
2. 找到 `unregisterAllServiceWorkers()` 调用位置（约 L289）
3. 移除该调用，或将其改为仅在开发模式下执行
4. 确保 `provideServiceWorker` 配置正确
5. 搜索 `unregisterAllServiceWorkers` 定义位置，评估是否可以完全移除该函数

**注意事项**：
- 如果 `unregisterAllServiceWorkers` 是为了解决已知的 SW 缓存问题（如旧版 ngsw 残留），需要保留一个一次性清理逻辑
- 检查 git log 了解 `unregisterAllServiceWorkers` 的添加原因
- 如果确认是故意禁用 SW（项目当前不需要 PWA 离线），则应改为移除 `provideServiceWorker` 注册

- **Files**:
  - `main.ts` — 移除或条件化 `unregisterAllServiceWorkers()` 调用
- **Success**:
  - SW 注册后不再被注销
  - `navigator.serviceWorker.controller` 在页面加载后有值
  - 或两者都移除后，无 SW 注册/注销行为
- **Research References**:
  - 研究报告 Lines 204-219 — P0-3 完整验证
  - 研究报告 Lines 39-41 — main.ts 中 SW 配置
- **Dependencies**:
  - 无前置依赖（独立于其他修复）

### Task 3.2: 优化 ngsw-config.json 字体加载策略

**问题**：`ngsw-config.json` 中所有 assetGroups 使用 `installMode: "prefetch"`，包括 784KB 的字体文件。SW install 事件触发时会预取全部资源。

**操作**：
1. 打开 `ngsw-config.json`
2. 找到 fonts 相关的 assetGroup（约 L28-L39）
3. 将 fonts 的 `installMode` 从 `"prefetch"` 改为 `"lazy"`
4. `updateMode` 保持 `"prefetch"` 不变（确保更新时字体可用）

```json
{
  "name": "fonts",
  "installMode": "lazy",
  "updateMode": "prefetch",
  "resources": {
    "files": ["/**/*.woff2"]
  }
}
```

- **Files**:
  - `ngsw-config.json` — 修改 fonts assetGroup 的 installMode
- **Success**:
  - SW install 事件不再预取字体文件
  - 字体在首次访问时按需加载
  - 后续访问字体从 SW 缓存中提供
- **Research References**:
  - 研究报告 Lines 57-59 — ngsw-config fonts prefetch 确认
  - 研究报告 Lines 160 — 审计 P2-2 验证
- **Dependencies**:
  - Task 3.1 完成（SW 策略确定后再优化配置）

---

## Phase 4: FocusModeComponent 懒加载（P1-2）

### Task 4.1: 将 FocusModeComponent 和 SpotlightTriggerComponent 改为 `@defer` 懒加载

**问题根因**：`app.component.ts` L66 静态导入 `FocusModeComponent` 和 `SpotlightTriggerComponent`，导致专注模式的完整依赖链（GateService → SpotlightService → BlackBoxService → BlackBoxSyncService → FocusPreferenceService）在应用启动时全部加载。

**操作**：
1. 打开 `src/app.component.ts`
2. 将 `FocusModeComponent` 和 `SpotlightTriggerComponent` 从静态 `imports` 数组中移除
3. 在模板中使用 `@defer` 包裹这两个组件

**模板修改示例**：
```html
<!-- 修改前 -->
<app-focus-mode></app-focus-mode>
<app-spotlight-trigger></app-spotlight-trigger>

<!-- 修改后 -->
@defer (when focusModeEnabled()) {
  <app-focus-mode></app-focus-mode>
}

@defer (on idle) {
  <app-spotlight-trigger></app-spotlight-trigger>
}
```

4. 在组件类中添加 signal 判断条件（如果尚不存在）：
```typescript
// 利用已有的专注模式偏好 signal
readonly focusModeEnabled = computed(() =>
  this.focusPreferenceService.preferences()?.gateEnabled ?? false
);
```

5. 确保 `FocusModeComponent` 和 `SpotlightTriggerComponent` 的依赖服务不会因 eager 注入而被拉入 main bundle

- **Files**:
  - `src/app.component.ts` — 移除静态导入，改用 `@defer`
  - `src/app.component.html` — 包裹组件的 `@defer` 块
- **Success**:
  - `FocusModeComponent` 和 `SpotlightTriggerComponent` 不在 main bundle 中
  - 专注模式功能正常工作（在 defer 条件满足后加载）
  - main.js 体积进一步减少（预期 -50~80KB 解压）
- **Research References**:
  - 研究报告 Lines 31-33 — app.component.ts 静态导入确认
  - 研究报告 Lines 34-35 — FocusModeComponent 依赖链
- **Dependencies**:
  - Phase 1 完成（GoJS 不污染 main bundle 后，才能准确评估专注模式的 bundle 影响）

### Task 4.2: 验证大门（Gate）功能正常工作

**操作**：
1. 启动开发服务器
2. 启用专注模式中的大门功能
3. 验证 `GateOverlayComponent` 正常弹出
4. 验证大门交互（勾选完成、推迟提醒）功能正常
5. 验证 `SpotlightTriggerComponent` 在空闲后正常显示

- **Files**:
  - 无文件修改，纯验证任务
- **Success**:
  - 大门功能正常弹出和交互
  - SpotlightTrigger 正常显示
  - 无 `NullInjectorError` 或其他依赖注入错误
- **Dependencies**:
  - Task 4.1 完成

---

## Phase 5: 同步服务优化（P1-3, P1-4）

### Task 5.1: 将 LOCAL_AUTOSAVE_INTERVAL 从 1000ms 改为 3000ms 并使用 debounce

**问题根因**：`sync.config.ts` L35 定义 `LOCAL_AUTOSAVE_INTERVAL: 1000`，`SyncCoordinatorService` L380 使用 `setInterval(1000)` 每秒写入 IndexedDB。

**操作**：
1. 打开 `src/config/sync.config.ts`
2. 将 `LOCAL_AUTOSAVE_INTERVAL` 从 `1000` 改为 `3000`
3. 打开 `src/services/sync-coordinator.service.ts`
4. 找到 `startLocalAutosave()` 方法（约 L380）
5. 将 `setInterval` 改为基于变更检测的 debounce 机制：
   - 仅在有实际数据变更时才写入 IndexedDB
   - 使用 3s debounce 合并连续写入

```typescript
// 修改前（每秒无条件写入）
private startLocalAutosave(): void {
  this.autosaveTimer = setInterval(() => {
    this.saveToLocal();
  }, SYNC_CONFIG.LOCAL_AUTOSAVE_INTERVAL);
}

// 修改后（变更检测 + debounce）
private startLocalAutosave(): void {
  // 使用 effect() 监听数据变更，debounce 3s 后写入
  // 或保留 setInterval 但增加脏检查
  this.autosaveTimer = setInterval(() => {
    if (this.hasUnsavedChanges()) {
      this.saveToLocal();
    }
  }, SYNC_CONFIG.LOCAL_AUTOSAVE_INTERVAL);
}
```

- **Files**:
  - `src/config/sync.config.ts` — 修改 `LOCAL_AUTOSAVE_INTERVAL` 为 3000
  - `src/services/sync-coordinator.service.ts` — 添加脏检查逻辑
- **Success**:
  - IndexedDB 写入频率从每秒降至约每 3 秒（且仅在有变更时）
  - 数据保存功能不受影响（用户编辑后 3s 内保存）
  - Performance tab 中无高频 IDB 写入
- **Research References**:
  - 研究报告 Lines 48-50 — sync.config 中的 1000ms 确认
  - 研究报告 Lines 46-47 — SyncCoordinator 中 setInterval 使用
  - 研究报告 Lines 144-149 — 双重写入发现
- **Dependencies**:
  - 无前置依赖

### Task 5.2: 消除 PersistSchedulerService 的双重 IndexedDB 写入

**问题**：研究发现 `PersistSchedulerService` (L102) 也有一个独立的 1s 定时器写入 IndexedDB，与 `SyncCoordinatorService` 构成双重写入（实际 2次/秒）。

**操作**：
1. 打开 `src/services/persist-scheduler.service.ts`
2. 分析其 L102 附近的定时器逻辑
3. 确认 PersistScheduler 和 SyncCoordinator 的写入是否冗余
4. 方案选择：
   - **如果完全冗余**：移除 PersistScheduler 的定时器，统一由 SyncCoordinator 管理
   - **如果有不同职责**：协调两者共享同一个 debounce 定时器
5. 确保最终只有一个服务负责 IndexedDB 定期写入

- **Files**:
  - `src/services/persist-scheduler.service.ts` — 移除或协调重复的定时写入
  - 可能涉及 `src/app/core/state/store-persistence.service.ts` — 如果持久化由此服务管理
- **Success**:
  - IndexedDB 写入仅由一个服务管理
  - 写入频率与 SYNC_CONFIG.LOCAL_AUTOSAVE_INTERVAL (3000ms) 一致
  - 数据持久化功能正常
- **Research References**:
  - 研究报告 Lines 144-149 — 双重 IndexedDB 写入发现
  - 研究报告 Lines 50-51 — PersistScheduler 1s 定时器
- **Dependencies**:
  - Task 5.1 完成（先确定自动保存间隔）

### Task 5.3: SyncCoordinatorService 延迟初始化（认证完成后启动定时器）

**问题根因**：`SyncCoordinatorService` 构造函数 L189-L202 在服务创建时立即：
1. 注册 7+ 处理器
2. 验证处理器完整性
3. 启动 1s `setInterval`
4. 设置同步回调
5. 级联创建 18 个依赖服务

这发生在应用启动时（因为 `app.component.ts` 通过依赖链注入），导致 Main Thread 长时间阻塞。

**操作**：
1. 打开 `src/services/sync-coordinator.service.ts`
2. 将构造函数中的初始化逻辑移到一个 `initialize()` 方法中
3. 考虑使用 `afterNextRender()` 或在认证完成后调用 `initialize()`
4. 保留依赖注入在构造函数中，但延迟副作用（定时器、处理器注册）

```typescript
// 修改前
constructor() {
  this.actionQueueProcessors.setupProcessors();
  this.validateRequiredProcessors();
  this.startLocalAutosave();
  this.setupSyncModeCallback();
}

// 修改后
constructor() {
  // 仅注入依赖，不启动副作用
}

/** 认证完成后调用，启动同步服务 */
initialize(): void {
  if (this.isInitialized) return;
  this.isInitialized = true;
  this.actionQueueProcessors.setupProcessors();
  this.validateRequiredProcessors();
  this.startLocalAutosave();
  this.setupSyncModeCallback();
}
```

5. 在认证流程中调用 `syncCoordinator.initialize()`（如 `app.component.ts` 的认证完成回调中）

- **Files**:
  - `src/services/sync-coordinator.service.ts` — 重构构造函数，添加 `initialize()` 方法
  - `src/app.component.ts` 或认证完成回调位置 — 调用 `syncCoordinator.initialize()`
- **Success**:
  - 构造函数不再启动定时器或注册处理器
  - 认证完成后同步服务正常工作
  - 首屏加载时 Main Thread 阻塞时间减少
  - 所有同步功能正常（本地保存、云同步、冲突解决）
- **Research References**:
  - 研究报告 Lines 220-243 — SyncCoordinator 构造函数初始化链
  - 研究报告 Lines 243-255 — 18 个依赖服务列举
- **Dependencies**:
  - Task 5.1 和 Task 5.2 完成（先优化写入频率，再延迟初始化）

---

## Phase 6: 构建配置优化（P1-5, P2-1, P2-3）

### Task 6.1: 收紧 Bundle Budget

**问题**：`angular.json` L52-L57 的 budget 设置过于宽松：
- initial: warning 1.8MB / error 2.5MB
- main bundle: warning 600KB / error 800KB

**操作**：
1. 打开 `angular.json`
2. 找到 `budgets` 配置（约 L52-L57）
3. 修改为更严格的值：

```json
"budgets": [
  {
    "type": "initial",
    "maximumWarning": "600kb",
    "maximumError": "1.2mb"
  },
  {
    "type": "anyComponentStyle",
    "maximumWarning": "4kb",
    "maximumError": "8kb"
  }
]
```

4. 移除 main bundle 的单独限制（initial budget 已覆盖）

- **Files**:
  - `angular.json` — 修改 budgets 配置
- **Success**:
  - `ng build --configuration production` 在 initial > 1.2MB 时报 error
  - 当前构建在 Phase 1-4 修复后应通过新 budget
- **Research References**:
  - 研究报告 Lines 55-56 — angular.json budget 配置确认
  - 研究报告 Lines 161 — P1-5 审计验证
- **Dependencies**:
  - Phase 1-4 完成（先减小 bundle 体积，再收紧 budget）

### Task 6.2: 生产构建关闭 namedChunks

**问题**：`angular.json` L50 `namedChunks: true` 在生产环境启用，chunk 文件名泄露组件路径信息。

**操作**：
1. 打开 `angular.json`
2. 找到 production 配置中的 `namedChunks`（L50）
3. 将 `"namedChunks": true` 改为 `"namedChunks": false`

- **Files**:
  - `angular.json` — 修改 `namedChunks` 为 false
- **Success**:
  - 生产构建的 chunk 文件名不包含组件路径
  - 构建产物安全性微增
- **Research References**:
  - 研究报告 Lines 55-56 — angular.json namedChunks 确认
  - 研究报告 Lines 160 — P2-1 审计验证
- **Dependencies**:
  - 无前置依赖

### Task 6.3: 将构建依赖移到 devDependencies

**问题**：`package.json` L41-L56 中 5 个构建工具包被错放在 `dependencies`：
- `@angular/build`
- `@angular/cli`
- `@angular/compiler-cli`
- `dotenv`
- `esbuild`

**操作**：
1. 打开 `package.json`
2. 将以下包从 `dependencies` 移到 `devDependencies`：
   - `@angular/build`
   - `@angular/cli`
   - `@angular/compiler-cli`
   - `dotenv`
   - `esbuild`
3. 运行 `npm install` 确认依赖解析正常
4. 执行 `ng build` 确认构建正常

**注意**：
- 如果 Railway/Vercel 等部署平台在构建时仅安装 `dependencies`，则需要在部署配置中设置 `NPM_FLAGS="--include=dev"` 或保留构建依赖在 `dependencies` 中
- 检查 `railway.json` 和 `vercel.json` 的构建命令配置

- **Files**:
  - `package.json` — 移动 5 个包到 `devDependencies`
- **Success**:
  - `npm install --omit=dev` 后不安装构建工具
  - `npm install && ng build` 正常工作
  - Docker 镜像（如使用多阶段构建）体积减小
- **Research References**:
  - 研究报告 Lines 60-63 — package.json 依赖错放确认
  - 研究报告 Lines 162 — P2-3 审计验证
- **Dependencies**:
  - 无前置依赖

---

## Phase 7: 验证与回归测试

### Task 7.1: 执行 Bundle 分析，验证 main.js br < 100KB

**操作**：
1. 执行 `ng build --configuration production`
2. 记录 main.js 的 brotli 压缩大小
3. 使用 `npx source-map-explorer dist/**/*.js` 分析 bundle 组成
4. 或使用 `npm run analyze:bundle` 脚本
5. 确认以下指标：
   - main.js br < 100KB
   - GoJS 仅在 lazy chunk 中
   - FocusModeComponent 仅在 lazy chunk 中
   - initial bundle 总计 < 600KB warning / 1.2MB error

- **Files**:
  - 无文件修改，纯验证任务
- **Success**:
  - main.js brotli < 100KB
  - initial bundle 通过新 budget
  - 无意外的大型依赖进入 main bundle
- **Dependencies**:
  - Phase 1-6 全部完成

### Task 7.2: 运行 E2E 测试，确保无功能回归

**操作**：
1. 执行 `npm run test:e2e`
2. 逐一验证以下 E2E 测试：
   - `critical-paths.spec.ts` — 关键用户路径
   - `data-protection.spec.ts` — 数据保护
   - `focus-mode.spec.ts` — 专注模式（重点检查！）
   - `sync-integrity.spec.ts` — 同步完整性（重点检查！）
3. 如果有测试失败，分析是否由本次修改引起并修复

- **Files**:
  - 可能需要更新测试文件以适应新的 defer 行为
- **Success**:
  - 所有 E2E 测试通过
  - 专注模式 E2E 正常（大门弹出、语音转写）
  - 同步 E2E 正常（本地保存、云同步）
- **Dependencies**:
  - Phase 1-6 全部完成

### Task 7.3: Lighthouse 审计，验证 LCP < 2.5s

**操作**：
1. 使用 `npx lighthouse http://localhost:4200 --output=json --output=html`
2. 或运行 `npx lhci autorun`（使用 `lighthouserc.js` 配置）
3. 验证以下指标：
   - LCP < 2.5s（目标 < 1.5s）
   - INP < 200ms
   - FCP < 1.5s
   - Total Blocking Time < 200ms
4. 记录优化前后的对比数据

- **Files**:
  - 无文件修改，纯验证任务
- **Success**:
  - LCP < 2.5s
  - INP < 200ms
  - Performance Score > 80
  - 无严重的 Diagnostics 警告
- **Dependencies**:
  - Phase 1-6 全部完成
  - Task 7.1 和 7.2 通过

---

## Dependencies

- Angular CLI 19.2.x（`ng build`, `ng serve`）
- esbuild（Angular 默认构建器）
- source-map-explorer 或 esbuild-visualizer（bundle 分析）
- Vitest 4.0.x（单元测试）
- Playwright 1.48+（E2E 测试）
- Lighthouse（性能审计）
- Chrome DevTools（Network/Performance tab 手动验证）

## Success Criteria

- main.js brotli 压缩后 < 100KB（当前 ~170KB）
- 首屏 Network 请求中无 GoJS 相关 chunk
- LCP < 2.5s，INP < 200ms
- SW 行为一致（无注册/注销矛盾）
- IndexedDB 写入频率 ≤ 每 3 秒 1 次
- Bundle budget: initial error ≤ 1.2MB
- E2E 测试全部通过
- 无功能回归
