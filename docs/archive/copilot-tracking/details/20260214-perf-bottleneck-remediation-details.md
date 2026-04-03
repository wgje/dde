<!-- markdownlint-disable-file -->

# Task Details: 2026-02-14 线上性能瓶颈修复

## Research Reference

- `.copilot-tracking/research/20260214-perf-bottleneck-remediation-research.md`
- `docs/deep-performance-audit-2026-02-14.md`

---

## Phase 1: 阻断 black_box_entries 重复拉取（P0-3）

### Task 1.1: BlackBoxSyncService 增加 single-flight + freshness window

在 `src/services/black-box-sync.service.ts` 中为 `pullChanges()` 增加防重复机制：

1. 增加私有属性 `pullInFlight: Promise<void> | null = null`（进行中的拉取 Promise）
2. 增加私有属性 `lastPullTime = 0`（上次成功拉取的时间戳）
3. 在 `pullChanges()` 入口增加守卫：
   - 如果 `Date.now() - this.lastPullTime < FRESHNESS_WINDOW`（建议 30s），直接 return
   - 如果 `this.pullInFlight !== null`，return `this.pullInFlight`（复用进行中的请求）
4. 拉取成功后更新 `this.lastPullTime = Date.now()`
5. 在 `finally` 块中清理 `this.pullInFlight = null`

**配置常量**: 在 `src/config/sync.config.ts` 中添加 `BLACKBOX_PULL_FRESHNESS_WINDOW: 30_000`

- **Files**:
  - `src/services/black-box-sync.service.ts` — 修改 `pullChanges()` 方法，在 `doPullChanges()` 外层包裹 single-flight + freshness 守卫
  - `src/config/sync.config.ts` — 新增 `BLACKBOX_PULL_FRESHNESS_WINDOW` 配置
- **Success**:
  - 同一会话内 30s 窗口内只发出 1 次 `black_box_entries` 请求
  - 并发调用 `pullChanges()` 不会产生重复请求
- **Research References**:
  - `.copilot-tracking/research/20260214-perf-bottleneck-remediation-research.md` (Lines 98-116) — single-flight 模式参考
  - `docs/deep-performance-audit-2026-02-14.md` 第 5.3 节 — BlackBox 增量起点过于保守
- **Dependencies**:
  - 无前置依赖

### Task 1.2: FocusMode 初始化优先使用本地缓存

修改 `src/app/features/focus/focus-mode.component.ts` 的 `initializeAndCheckGate()` 方法：

1. 改为先从本地 IndexedDB 读取 black-box 数据（`loadFromLocal()`）
2. 基于本地数据立即执行 `checkGateOnStartup()`
3. 然后异步后台调用 `pullChanges()`（不阻塞 gate 检查）
4. `pullChanges()` 完成后如有新数据再更新 gate 状态

这样 FocusMode 不再阻塞在远端拉取上，且 pullChanges 由 single-flight 守卫兜底。

- **Files**:
  - `src/app/features/focus/focus-mode.component.ts` — 修改 `initializeAndCheckGate()` 方法：先本地 → 后异步远端
- **Success**:
  - FocusMode 初始化不再等待远端 `pullChanges()` 完成
  - gate 检查基于本地缓存立即执行，无首屏阻塞
  - `pullChanges()` 仍在后台执行，但被 single-flight 守卫保护
- **Research References**:
  - `.copilot-tracking/research/20260214-perf-bottleneck-remediation-research.md` (Lines 76-91) — focus-mode 初始化分析
- **Dependencies**:
  - Task 1.1 完成（single-flight 机制已就位）

### Task 1.3: 验证重复拉取已消除

1. 启动本地开发环境或使用线上环境
2. 登录后用 DevTools Network 面板过滤 `black_box_entries`
3. 确认同一会话 30s 内只出现 ≤ 1 次请求
4. 确认 FocusMode gate 功能仍正常工作

- **Files**: 无代码修改
- **Success**:
  - 登录后首 10s 内 `black_box_entries` 请求 ≤ 1 次
  - FocusMode gate 弹窗在需要时仍正常触发
- **Dependencies**:
  - Task 1.1 + Task 1.2 完成

---

## Phase 2: 消除 RPC 400 + 无效回退链路（P0-2）

### Task 2.1: ProjectDataService RPC 错误分类处理

修改 `src/app/core/services/sync/project-data.service.ts` 的 `loadFullProjectOptimized()` 方法：

1. 在 `if (error)` 分支中增加 Access Denied 错误识别：
   ```typescript
   const isAccessDenied = error.code === 'P0001' || error.message?.includes('Access denied');
   ```
2. Access Denied 时：
   - 记录 warn 日志：`'项目访问被拒绝，跳过该项目'`
   - 直接返回 `null`，**不走 `this.loadFullProject(projectId)` fallback**
3. 其他错误仍保留原有 fallback 逻辑

- **Files**:
  - `src/app/core/services/sync/project-data.service.ts` — 修改 `loadFullProjectOptimized()` L85-L89
- **Success**:
  - RPC 返回 `P0001 Access denied` 时不再触发 fallback 顺序加载
  - 其他 RPC 错误（网络、超时等）仍正常回退
  - 日志中可观测到 Access Denied 跳过记录
- **Research References**:
  - `.copilot-tracking/research/20260214-perf-bottleneck-remediation-research.md` (Lines 118-130) — RPC 错误分类处理模式
  - `docs/deep-performance-audit-2026-02-14.md` 第 5.4 节 — 后台当前项目加载触发 RPC 400
- **Dependencies**:
  - 无前置依赖

### Task 2.2: UserSessionService 清理无效 activeProjectId

修改 `src/services/user-session.service.ts` 登录后同步逻辑：

1. 在策略 1（Delta Sync）和策略 2（全量回退）中捕获 Access Denied 场景
2. 当检测到项目不可访问时：
   - 清除当前 `activeProjectId`（设为 null 或空）
   - 日志记录：`'清理不可访问的 activeProjectId'`
   - 跳过该项目的后续同步，继续策略 3（元数据同步）
3. 确保 UI 正确响应 activeProjectId 清除（回到项目列表）

- **Files**:
  - `src/services/user-session.service.ts` — 修改 L366-L401 同步逻辑，处理 Access Denied 回退
- **Success**:
  - 缓存残留的无效 projectId 被自动清理
  - 不再产生 RPC 400 + 回退请求链
  - 用户被引导回项目列表而非卡在无效项目
- **Research References**:
  - `.copilot-tracking/research/20260214-perf-bottleneck-remediation-research.md` (Lines 100-112) — user-session 同步链路分析
- **Dependencies**:
  - Task 2.1 完成（ProjectDataService 已能正确区分 Access Denied）

### Task 2.3: 验证 RPC 400 消除

1. 使用测试账号登录，设置 activeProjectId 为一个不可访问的项目 ID
2. 重新登录，观察网络请求
3. 确认不再出现 RPC 400 + 回退请求链路
4. 确认 activeProjectId 被正确清除

- **Files**: 无代码修改
- **Success**:
  - `get_full_project_data` 不再返回 400
  - 无效项目 ID 场景下请求数显著减少
- **Dependencies**:
  - Task 2.1 + Task 2.2 完成

---

## Phase 3: 桌面 Flow chunk 延迟加载（P0-1）

### Task 3.1: 将 Flow @defer 改为用户意图触发

修改 `src/app/core/shell/project-shell.component.ts` 的 Flow 组件 `@defer` 触发策略：

**方案选择**（推荐方案 A）：

**方案 A**: 改用 `when` 条件 + 用户交互信号
```html
@defer (when flowTabActivated(); prefetch on idle) {
  <app-flow-view ...></app-flow-view>
}
```
- 新增一个 signal `flowTabActivated` 表示用户主动切换到 Flow tab
- Flow chunk 在 idle 时预取代码但不执行，直到用户切换 tab 才实例化

**方案 B**: 改用 `on interaction` 触发
```html
@defer (on interaction; prefetch on idle) {
  <app-flow-view ...></app-flow-view>
}
```
- 用户在 placeholder 区域交互时触发加载

**推荐方案 A**，因为它允许预取但延迟实例化，首次 Flow 体验更流畅。

- **Files**:
  - `src/app/core/shell/project-shell.component.ts` — 修改 L248 `@defer` 触发策略
- **Success**:
  - 桌面端登录后首屏不触发 GoJS chunk 执行
  - 用户切换到 Flow tab 时 GoJS 正常加载和显示
  - 预取仍在 idle 时进行（网络层不变），但不阻塞主线程
- **Research References**:
  - `.copilot-tracking/research/20260214-perf-bottleneck-remediation-research.md` (Lines 36-52) — @defer 触发分析
  - `docs/deep-performance-audit-2026-02-14.md` 第 5.1 节 — 桌面 Flow chunk 自动加载
  - AGENTS.md 5.3 — GoJS 必须 @defer 懒加载
- **Dependencies**:
  - 需要确认 project-shell 中是否已有 tab 切换信号机制

### Task 3.2: 验证桌面端首屏不执行 GoJS chunk

1. 构建生产版本并启动
2. 桌面端登录后检查 Network + Performance 面板
3. 确认 GoJS chunk 可能被预取（prefetch）但不被执行/解析
4. 切换到 Flow tab 后确认 GoJS 正常加载和渲染

- **Files**: 无代码修改
- **Success**:
  - 桌面 vs 移动的 JS 执行量差异显著缩小
  - Long Task 在首屏阶段减少
  - Flow 功能在切换后仍完全可用
- **Dependencies**:
  - Task 3.1 完成

---

## Phase 4: 字体加载策略优化（P1-1）

### Task 4.1: 收敛首屏字体预加载

修改 `index.html` 的字体加载策略：

1. **保留** subset-119 的 `preload`（首屏关键字符集）
2. **移除** subset-118 和 subset-117 的 `prefetch`（减少首阶段并发请求）
3. **延后** 异步字体 CSS 加载时机：
   - 从当前 `<link rel="stylesheet" media="print" onload="this.media='all'">` 改为
   - 通过 `window.addEventListener('load', () => requestIdleCallback(...))` 动态注入
4. 保留内联 @font-face 的 subset-119 定义（确保首屏文字渲染不 FOUT）

- **Files**:
  - `index.html` — 修改 L65-L72 preload/prefetch + L126-L128 异步 CSS 加载方式
- **Success**:
  - 首屏阶段字体请求数从 3 降至 1（只 preload subset-119）
  - 完整字体 CSS 在首屏完成后通过 requestIdleCallback 加载
  - 弱网场景下 JS 与字体带宽竞争降低
- **Research References**:
  - `.copilot-tracking/research/20260214-perf-bottleneck-remediation-research.md` (Lines 139-157) — 字体延后加载模式
  - `docs/deep-performance-audit-2026-02-14.md` 第 5.5 节 — 字体策略与首阶段资源竞争
- **Dependencies**:
  - 无前置依赖，可与 Phase 1-3 并行实施

### Task 4.2: 验证字体加载行为

1. 构建生产版本
2. 使用 Chrome DevTools Network > Font 过滤器观察加载时序
3. 确认首屏只发出 1 个字体请求（subset-119）
4. 确认页面完全加载后其余子集按需加载
5. 弱网模拟下确认无文字闪烁/布局偏移

- **Files**: 无代码修改
- **Success**:
  - 首屏字体请求 ≤ 1
  - 完整字体集在 idle 后异步加载
  - CLS 不因字体策略变更而恶化
- **Dependencies**:
  - Task 4.1 完成

---

## Phase 5: FocusMode/BlackBox 初始化解耦（P1-2）

### Task 5.1: FocusMode @defer 添加条件守卫

修改 `src/app.component.html` 中的 FocusMode `@defer`：

1. 在 `app.component.ts` 中新增一个 computed signal `coreDataLoaded`：
   - 表示首屏核心数据（项目列表 + 当前项目数据）已加载完毕
   - 可以基于现有的同步状态（如 `syncState` / `projectsLoaded`）派生
2. 将 FocusMode `@defer` 从 `(on idle)` 改为 `(when coreDataLoaded())`：
   ```html
   @defer (when coreDataLoaded()) {
     <app-focus-mode></app-focus-mode>
   }
   ```
3. 确保 `coreDataLoaded` 在首屏数据加载完成后变为 true

- **Files**:
  - `src/app.component.html` — 修改 L98-L101 `@defer` 条件
  - `src/app.component.ts` — 新增 `coreDataLoaded` computed signal
- **Success**:
  - FocusMode 不再在 idle 时立即初始化
  - 首屏数据加载完成后才触发 FocusMode 及其 BlackBox 同步
  - 登录后前 5-10s 并发请求峰值降低
- **Research References**:
  - `.copilot-tracking/research/20260214-perf-bottleneck-remediation-research.md` (Lines 132-137) — @defer 条件守卫模式
  - `docs/deep-performance-audit-2026-02-14.md` 第 4.4 节 — 架构层瓶颈
- **Dependencies**:
  - 需确认 app.component.ts 中可用的同步状态信号

### Task 5.2: 验证初始化时序

1. 登录后观察 Network 面板请求时序
2. 确认 FocusMode 相关请求在核心数据加载完成之后才发出
3. 确认 Focus gate 功能仍正常

- **Files**: 无代码修改
- **Success**:
  - 登录后请求时序呈现清晰的阶段分离（先核心数据 → 后 Focus/BlackBox）
  - Focus gate 功能不受影响
- **Dependencies**:
  - Task 5.1 完成 + Phase 1 的 single-flight 机制

---

## Phase 6: 监控与回归门禁（P2）

### Task 6.1: 增加弱网性能预算 CI 检查

在 E2E 测试或 CI pipeline 中添加弱网场景性能检查：

1. 在 `lighthouserc.js` 或独立脚本中增加弱网预算：
   - LCP < 6,000ms（弱网+4xCPU）
   - Long Task 总时长 < 3,000ms
   - 首阶段 fetch 数 < 15
2. 在 `playwright.config.ts` 中增加弱网 E2E 场景配置
3. 创建 `e2e/weak-network-budget.spec.ts` 性能门禁测试

- **Files**:
  - `lighthouserc.js` — 增加弱网预算配置
  - `playwright.config.ts` — 可选：增加弱网 project 配置
  - `e2e/weak-network-budget.spec.ts` — 新增弱网性能门禁 E2E
- **Success**:
  - CI 中有弱网场景的性能回归检测
  - LCP / Long Task / 请求数超标时 CI 报警
- **Research References**:
  - `docs/deep-performance-audit-2026-02-14.md` 第 6.3 节 — P2 治理与监控
- **Dependencies**:
  - Phase 1-5 完成（需要优化后的基线数据）

### Task 6.2: 增加同步链路异常告警

在 Sentry 或日志系统中增加以下告警规则：

1. RPC 400 错误率告警：`get_full_project_data` 400 率 > 1%
2. 重复拉取告警：同一会话 30s 内 `black_box_entries` 拉取 > 1 次
3. 告警渠道配置（Sentry Alert / Email）

- **Files**:
  - `src/app/core/services/sync/project-data.service.ts` — 增加 Sentry breadcrumb/metric
  - `src/services/black-box-sync.service.ts` — 增加重复拉取计数上报
- **Success**:
  - RPC 400 和重复拉取可在 Sentry 仪表盘中观测
  - 超阈值时产生告警
- **Dependencies**:
  - Phase 1-2 完成（修复后的基线应无告警）

---

## Phase 7: 全量验证与回归测试

### Task 7.1: 三场景性能复测

按审计报告定义的三场景执行性能复测：

1. 桌面常规（desktop-normal）
2. 移动端常规（mobile-normal）
3. 桌面弱网+4xCPU（desktop-throttled）

采集指标：Core Web Vitals（LCP/CLS/INP）、Long Task 分布、Fetch 时序/状态码、资源 Top（transferSize）

- **Files**: 无代码修改
- **Success**:
  - 桌面常规 LCP < 1,200ms
  - 弱网+4xCPU LCP < 6,000ms
  - `black_box_entries` 拉取 ≤ 1 次
  - `get_full_project_data` 400 = 0 次
- **Dependencies**:
  - Phase 1-5 全部完成

### Task 7.2: 执行现有测试套件

运行所有测试确保无回归：

```bash
npm run test:run
npm run test:run:services
npm run test:run:components
npm run lint
```

- **Files**: 可能需要更新受影响的测试文件
- **Success**:
  - 所有测试通过
  - Lint 无新增错误
- **Dependencies**:
  - Phase 1-5 全部完成

### Task 7.3: E2E 关键路径验证

```bash
npm run test:e2e
```

重点关注：
- 登录流程正常
- 项目加载正常
- Flow 视图切换正常
- Focus mode gate 功能正常
- 离线写入 + 同步正常

- **Files**: 无代码修改（除非测试因功能改动需更新）
- **Success**:
  - E2E 测试全部通过
  - Flow/Focus/Sync 关键路径无回归
- **Dependencies**:
  - Task 7.2 完成

---

## Dependencies

- Angular 19.2.x（@defer / Signals）
- Supabase 2.84+（RPC / black_box_entries 表）
- Vitest 4.0.x（单元测试）
- Playwright 1.48+（E2E 测试 + 性能采样）
- Sentry 10.32+（告警配置）

## Success Criteria

- 桌面常规 LCP < 1,200ms（当前 ~668ms 保持）
- 弱网+4xCPU LCP < 6,000ms（当前 ~26,172ms，需大幅降低）
- 登录后 `black_box_entries` 重复拉取消除（≤ 1 次）
- `get_full_project_data` 400 消除（0 次）
- 桌面首屏不执行 GoJS chunk
- 首屏字体请求 ≤ 1
- 所有测试通过，无功能回归
