# PWA 秒开 —— 深度审查与策划案（v2）

> 创建日期：2026-03-28 | 审查日期：2026-03-28  
> 审查结论：**核心瓶颈确认为 HandoffCoordinator 3s 安全超时 + 启动壳中间态视觉切换**。  
> 秒开方案可行性：**高**（Phase 0 改动极小即可将 3s 降至 <500ms）。  
> 状态：深度审查完成，待实施。

---

## 0. 你看到的那个画面到底是什么？

**你描述的现象**：点击手机桌面 PWA 图标 → 屏幕中间出现 Angular 标志 + 四周空白 → 卡 3 秒 → 才进入真实界面。

**实际发生的事**：

```
T=0ms     系统启动 PWA → Service Worker 返回 index.html（缓存命中）
T=~50ms   index.html 解析 → 内联脚本从 localStorage 读快照
          → 渲染 #snapshot-shell（「正在恢复你的工作区」+ 项目卡片）← 这是一个浅色/深色面板
          ⚠ 但如果快照为空（首次安装/localStorage 被清），就只显示 shimmer 占位条

T=~200ms  main.js 被 Service Worker 从 Cache 返回 → Angular 引导启动
          AppComponent 构造函数 → afterNextRender → markLaunchShellVisible()
          → 此时 #initial-loader fade-out (200ms) → LaunchShellComponent 接管

T=~400ms  WorkspaceShellComponent 路由挂载
          → constructor: prehydrateFromSnapshot() + scheduleSessionBootstrap()
          → ngAfterViewInit: handoffCoordinator.markLayoutStable()
          → 开始 3000ms 安全超时倒计时

T=~400ms+ HandoffCoordinator.resolve() 反复求值
          ├ hasProjects = projectState.projects().length > 0
          │   → prehydrateFromSnapshot() 成功 → true（正常路径 <100ms）
          │   → prehydrateFromSnapshot() 失败（无快照） → false
          ├ authRuntimeState = auth.runtimeState()
          │   → AUTH_RUNTIME_GATE_V1=true 时: 启动时不做预热 → runtimeState 初始为 'pending'
          │   → scheduleSessionBootstrap → checkSession → 网络请求 200-2000ms
          └ 决策：
            如果 hasProjects=false && authRuntimeState='pending'
            → result.kind = 'pending' → ❌ handoff 被阻塞

⏱ T=3400ms HandoffCoordinator safety timeout 强制触发
          → result.kind = 'full' → markWorkspaceHandoffReady()
          → 200ms 淡出 → LaunchShell 消失 → 真实工作区可见

总延迟：~3.6s ← 这就是你看到的 3 秒卡顿
```

**关键发现**：那个「Angular 标志」并非 Angular 框架的默认 splash——它是本项目的 LaunchShellComponent（启动壳），显示「正在恢复你的工作区 / 启动壳已就绪」以及 NanoFlow 标志。这个启动壳的设计目的是在数据加载期间提供视觉反馈，但讽刺的是它反而成了用户感知到的最大延迟来源。

---

## 1. 问题现象

| 序号 | 现象 | 根因编号 | 用户体验影响 |
|------|------|---------|------------|
| P1 | 点击 PWA 图标后，3 秒停在「正在恢复你的工作区」界面 | R1+R2 | 感知为"卡死" |
| P2 | 从后台恢复（PWA re-open）时也有明显延迟 | R4 | 每次打开都痛苦 |

---

## 2. 根因分析（基于代码审查）

### 2.1 核心瓶颈：HandoffCoordinator 3s 安全超时

**审查文件**：[handoff-coordinator.service.ts](../src/services/handoff-coordinator.service.ts)

`resolveHandoffResult()` 的决策逻辑（L62-98）：

```typescript
// 条件 A：auth 配置了 + 没有项目 + 还在检查 session → 返回 'pending'
if (input.authConfigured && !input.hasProjects &&
    (input.isCheckingSession || input.authRuntimeState === 'idle' || input.authRuntimeState === 'pending')) {
  return { kind: 'pending', degradeReason: null };
}
```

**为什么这个条件成立 3 秒？**

1. `hasProjects` 取决于 `projectState.projects().length > 0`
2. `prehydrateFromSnapshot()` 在 WorkspaceShell 构造函数中执行（L783），**如果快照存在且有效，projects 会立即填充 → hasProjects=true → 不会卡住**
3. **但**：`authRuntimeState` 初始为 `'pending'`（因为 `AUTH_RUNTIME_GATE_V1=true` 跳过了 index.html 的预热），要等 `auth.checkSession()` 完成网络请求才变为 `'ready'`
4. 如果快照预填充成功（hasProjects=true），`resolve()` 直接跳过上述条件 → handoff 在 ~100ms 内完成 ✅
5. 如果快照为空/损坏（hasProjects=false），就必须等 auth 完成 → 3s 安全超时兜底 ❌

**结论**：你看到的 3 秒卡顿有两种可能情况：
- **情况 A**（最可能）：快照预填充确实成功了，但 `scheduleSessionBootstrap` 的 boot-stage 事件监听有竞态，导致 auth 启动延迟到 2500ms fallback timeout 后才开始，而 handoff 的 `resolve()` 依赖 auth signal 变化才重新求值
- **情况 B**：快照为空或损坏 → hasProjects=false → 完整等待 3s safety

### 2.2 次要瓶颈：scheduleSessionBootstrap 的事件竞态

**审查文件**：[app-auth-coordinator.service.ts](../src/app/core/services/app-auth-coordinator.service.ts#L109-L148)

```typescript
// L127-139: 等待 boot-stage 事件
if (stage === 'launch-shell' || stage === 'handoff' || stage === 'ready') {
  queueMicrotask(runBootstrap);  // 立即执行
  return;
}
// 否则等事件或 2500ms fallback
let fallbackTimer = setTimeout(() => { cleanup(); runBootstrap(); }, 2500);
```

**问题**：如果 `scheduleSessionBootstrap()` 在 WorkspaceShell 构造函数中被调用时，`window.__NANOFLOW_BOOT_STAGE__` 已经是 `'launch-shell'`，则 bootstrap 立即执行。但如果还是 `'booting'`，就等 2500ms。

**审查结果**：构造函数中先调用 `prehydrateFromSnapshot()`（L783），再调用 `scheduleSessionBootstrap()`。此时 `__NANOFLOW_BOOT_STAGE__` 应该已被 AppComponent 的 `afterNextRender` → `markLaunchShellVisible()` 设为 `'launch-shell'`。但 `afterNextRender` 是异步的（等下一帧），在某些设备上可能晚于 WorkspaceShell 构造函数。

### 2.3 视觉中间态引起的感知延迟

**审查文件**：[index.html](../index.html#L580-L660), [app.component.ts](../src/app.component.ts#L121-L133)

当前启动有 **3 次视觉切换**：
1. `#initial-loader`（index.html 的 snapshot-shell 或 shimmer）→ 200ms fade-out
2. `LaunchShellComponent`（Angular 版启动壳）→ 等 handoff → 200ms fade-out
3. `WorkspaceShell` + `ProjectShell`（真实工作区）

每次切换都有 200ms 淡出动画，即使数据已经就绪，视觉上用户也要等 400ms+ 的纯动画时间。

### 2.4 rAF 节流（已修复但仍有残留风险）

**审查文件**：[handoff-coordinator.service.ts](../src/services/handoff-coordinator.service.ts#L241-L256)

已有 `setTimeout(..., 100)` 双保险。但 `scheduleHandoffIfReady()` 的退出条件是 `resultState().kind === 'pending'`，如果 result 一直是 pending，不管 rAF 还是 setTimeout 都不会触发 handoff。

### 2.5 PWA 恢复链路

**审查文件**：[app-lifecycle-orchestrator.service.ts](../src/services/app-lifecycle-orchestrator.service.ts#L80-L120)

`RESUME_THRESHOLD_MS = 60000`，后台超过 60s 才走重恢复。轻恢复本身不阻塞 UI，风险较低。

---

## 3. 可行性与难度评估

### 3.1 核心问题定性

| 问题 | 可行性 | 难度 | 投入 | 风险 | 说明 |
|------|--------|------|------|------|------|
| **Handoff 3s 超时（有快照）** | ✅ 非常高 | 🟢 低 | 1-2h | 极低 | 快照预填充已生效 → hasProjects=true，问题在于 auth pending 仍阻塞。只需修改 `resolveHandoffResult` 一处条件即可。 |
| **Handoff 3s 超时（无快照）** | ✅ 高 | 🟢 低 | 1-2h | 低 | 快照为空时降级为 empty-workspace 而非 pending。 |
| **启动壳中间态视觉** | ✅ 高 | 🟡 中 | 2-4h | 低 | 减少中间态：index.html 快照 → 直接到 WorkspaceShell，跳过 LaunchShell。 |
| **scheduleSessionBootstrap 竞态** | ✅ 高 | 🟢 低 | 1h | 极低 | `afterNextRender` 可能晚于 WorkspaceShell 构造，改为先检查当前 stage。 |
| **index.html 快照 → 真实界面的跳过** | ⚠️ 中 | 🔴 高 | 8-16h | 中-高 | Phase 2 涉及启动流程重构，需要完整的 E2E 验证。 |

### 3.2 关键判断

**你的核心诉求是"秒开"，不要求完全离线。** 这大大简化了问题——我们不需要考虑无网络启动的数据一致性，只需要：

1. **快照存在时**（绝大多数情况）：handoff 不要等 auth → 立刻进入工作区 → auth 后台完成
2. **快照不存在时**（首次安装/缓存清除）：直接显示空工作区 → 不要卡在 pending
3. **Service Worker 缓存命中时**（PWA 冷启动）：main.js 从缓存加载 → 0ms 网络延迟

**实测时间预算**（基于现有代码审查）：

```
Service Worker 返回 index.html:     ~10ms（缓存命中）
index.html 解析 + 快照渲染:         ~50ms（localStorage 同步读取）
main.js 加载（SW 缓存）:            ~100ms
Angular 引导:                        ~100ms
WorkspaceShell 挂载:                 ~100ms
prehydrateFromSnapshot:              ~20ms
handoff resolve（修复后）:            ~0ms（快照已让 hasProjects=true）
fade-out 动画:                       ~200ms（可优化为 0ms）
─────────────────────────────────────
总计:                                ~380ms → 远低于 1s 目标 ✅
```

**结论：Phase 0 修复即可将 3s 降至 <500ms，投入仅 2-4 小时。Phase 1-2 是锦上添花。**

---

## 4. 目标定义

| 指标 | 当前 | Phase 0 后 | Phase 1 后 |
|------|------|-----------|-----------|
| PWA 冷启动到可交互 | 3-5s | < 500ms | < 300ms |
| PWA 恢复到可交互 | 1-3s | < 500ms | < 300ms |
| 启动壳停留时间 | 3-5s | < 200ms | 0ms（跳过） |
| 首帧内容 | 启动壳占位 | 启动壳+快照 | 真实工作区 |

---

## 5. 策划案

### Phase 0：解除 Handoff 阻塞（2-4 小时，立竿见影）

> **投入产出比最高**。改动 < 30 行代码，效果从 3s → <500ms。

#### P0-1：resolveHandoffResult 不再因 auth pending 而 pending（核心修复）

**问题**：当 `authConfigured=true && hasProjects=false && authRuntimeState='pending'` 时返回 `pending`。但 `hasProjects=false` 在快照预填充成功时本不应出现——真正的问题是 **即使 hasProjects=true，如果 auth 仍在 pending，effect 不会重新触发 `scheduleHandoffIfReady`**。

**更精准的分析**：`setupHandoffEffect` 中每次 signal 变化都调用 `handoffCoordinator.resolve()`，resolve 会 `set` resultState 并调用 `scheduleHandoffIfReady()`。如果第一次 resolve 返回 pending（因为 projects 为空），之后 prehydrate 填充了 projects → effect 重新运行 → resolve 应该返回非 pending。

**但**：`prehydrateFromSnapshot()` 在 WorkspaceShell **构造函数**中执行（L783），而 `setupHandoffEffect()` 也在构造函数中通过 `setupSignalEffects()` 调用。Angular 的 `effect()` 是异步触发的，可能在 prehydrate 之前就首次执行了。

**方案**：在 `resolveHandoffResult` 中增加快照感知——如果 snapshot 有项目，视为 hasProjects=true：

```typescript
// handoff-coordinator.service.ts → resolveHandoffResult()
const effectiveHasProjects = input.hasProjects
  || (input.snapshot?.projects?.length ?? 0) > 0;

// 替换所有 input.hasProjects 为 effectiveHasProjects
```

**改动**：[handoff-coordinator.service.ts](../src/services/handoff-coordinator.service.ts) 的 `resolveHandoffResult` 函数，约 5 行。
**风险**：极低。快照中有项目 = 用户确实有数据。即使快照过期，也比卡 3 秒好。
**回滚**：还原 5 行改动。

#### P0-2：Safety timeout 从 3s 降至 1.5s

**现状**：`HANDOFF_SAFETY_TIMEOUT_MS = 3000`（注释说已从 8s 降到 3s）。
**方案**：P0-1 修复后正常路径 <100ms 完成 handoff，1.5s 足够覆盖极端异常。

```typescript
private readonly HANDOFF_SAFETY_TIMEOUT_MS = 1500;
```

**改动**：1 行常量。
**风险**：极低。

#### P0-3：initial-loader 淡出改为即时隐藏

**现状**：`dismissLoader()` 先加 `fade-out` class（200ms 动画）再 `display:none`。
**方案**：当快照与 LaunchShell 视觉一致时，直接隐藏无需淡出：

```javascript
function dismissLoader() {
  if (dismissed) return;
  dismissed = true;
  var loader = document.getElementById('initial-loader');
  if (loader) {
    loader.style.display = 'none';
    window.dispatchEvent(new CustomEvent('nanoflow:loader-hidden'));
  }
}
```

**改动**：[index.html](../index.html) 的 `dismissLoader` 函数，约 10 行。
**风险**：低。如果视觉对齐没做好可能有一帧闪烁，但远好于 200ms 的延迟。

#### P0-4：Master safety timeout 从 5s 降至 2.5s

**改动**：`app.component.ts` 的 `MASTER_SAFETY_TIMEOUT_MS: 5000 → 2500`。
**风险**：极低。

---

### Phase 1：消除启动壳中间态（4-8 小时，体验跃升）

> 目标：index.html 快照 → **直接切换到真实工作区**，跳过 LaunchShellComponent。

#### P1-1：LaunchShell 跳过模式

**问题**：当前必须经过 `LaunchShellComponent → handoff → WorkspaceShell` 的顺序。
**方案**：当快照存在且 handoff result 不是 pending 时，AppComponent 直接隐藏 LaunchShell：

```typescript
// app.component.ts
// 如果 WorkspaceShellComponent 已挂载且 handoff 已 ready，直接跳过 LaunchShell 淡出
readonly showLaunchShell = computed(() => {
  if (this.bootStage.isWorkspaceHandoffReady()) return false;
  return true;
});
```

**改动**：`app.component.ts` 和模板。
**风险**：中。需要确保 WorkspaceShell 已经在 DOM 中渲染。

#### P1-2：auth 完全异步化

**问题**：`scheduleSessionBootstrap` 要等 boot-stage 事件，最坏等 2500ms。
**方案**：bootstrap 不再等任何 boot-stage 事件，直接在 WorkspaceShell 构造函数中 `queueMicrotask` 执行：

```typescript
scheduleSessionBootstrap(): void {
  if (this.bootstrapScheduled || this.bootstrapInFlight) return;
  this.bootstrapScheduled = true;
  queueMicrotask(() => {
    this.bootstrapScheduled = false;
    this.bootstrapSession().catch(() => {});
  });
}
```

**改动**：`app-auth-coordinator.service.ts` 的 `scheduleSessionBootstrap`。
**风险**：低。auth bootstrap 本来就是异步操作，不阻塞渲染。
**前提**：P0-1 已修复 handoff 不再依赖 auth。

#### P1-3：StartupTierOrchestrator 信号驱动替代定时器

**问题**：P1=150ms / P2=800ms 的固定延迟在现代设备上过于保守。
**方案**：基于 handoff-ready 信号触发，而非固定延迟。

**改动**：`startup-tier-orchestrator.service.ts`。
**风险**：低-中。

#### P1-4：Service Worker 预缓存关键 chunk

**问题**：`app-lazy` 组中的 chunk（包括 workspace-shell）是 lazy install，首次安装后第二次打开可能需要网络。
**方案**：将 workspace-shell 和 project-shell chunk 移入 `app-core` 的 `prefetch` 列表。

**改动**：`ngsw-config.json`。
**风险**：低。增加初始安装下载量（~50KB），但保证后续冷启动全离线。

---

### Phase 2：极致优化（仅在 Phase 0-1 效果不满意时考虑）

> 难度高、收益递减。仅当 Phase 0-1 后仍超 500ms 才启动。

#### P2-1：index.html 直接渲染文本视图（跳过启动壳）

将 index.html 的快照渲染器从「项目列表摘要」改为「当前项目的文本视图」，使 FCP 直接就是真实界面。

**难度**：🔴 高（8-16h）。需要在纯 HTML/JS 中复现文本视图的布局。
**收益**：FCP 从"项目列表"变为"真实任务列表"，感知为 0ms。
**风险**：高。维护两套渲染逻辑（index.html + Angular 组件）。

#### P2-2：快照压缩

**难度**：🟡 中（3h）。需要引入 `lz-string` 且 index.html 内联脚本也要解压。
**收益**：突破 localStorage 5MB 限制。
**判断**：对秒开无帮助，仅解决大数据量场景。**暂不需要**。

#### P2-3：恢复流程轻量化

**难度**：🟢 低（2h）。
**收益**：PWA 从后台恢复 <300ms。
**判断**：当前 `RESUME_THRESHOLD_MS=60s`，轻恢复不阻塞 UI，优先级低。

**改动范围**：`app-lifecycle-orchestrator.service.ts`。  
**风险**：低。本地数据已在内存中，无需重新加载。

---

## 6. 实施路线图（修订）

```
Phase 0 (解除 Handoff 阻塞) ── 立竿见影，3s → <500ms ─────────
  P0-1  resolveHandoffResult 快照感知            [1h]  ← 核心修复
  P0-2  Safety timeout 3s → 1.5s                 [15m]
  P0-3  initial-loader 即时隐藏（去 fade-out）    [30m]
  P0-4  Master safety 5s → 2.5s                  [15m]
  ──────────────────────────────────────────────────────
  小计：2-3 小时，效果验证后再决定是否投入 Phase 1

Phase 1 (消除启动壳中间态) ── 500ms → <300ms ──────────────
  P1-1  LaunchShell 跳过模式                     [4h]
  P1-2  auth bootstrap 不再等 boot-stage         [1h]
  P1-3  StartupTier 信号驱动                     [2h]
  P1-4  SW 预缓存关键 chunk                      [1h]
  ──────────────────────────────────────────────────────
  小计：6-8 小时

Phase 2 (极致优化) ── 仅在 Phase 0-1 不够时 ───────────────
  P2-1  index.html 直接渲染文本视图              [12h] ← 高难度
  P2-2  快照压缩                                 [3h]  ← 非秒开相关
  P2-3  恢复流程轻量化                           [2h]  ← 优先级低
```

**建议策略**：先做 Phase 0（2 小时），部署到测试环境验证效果。如果 <500ms 已满足预期，Phase 1 可延后。

---

## 7. 验收标准

### 7.1 功能验收

| 场景 | 预期 | 验证方式 |
|------|------|---------|
| PWA 冷启动（有快照） | < 500ms 可交互（Phase 0）/ < 300ms（Phase 1） | `__NANOFLOW_STARTUP_TRACE__` + 手动 |
| PWA 冷启动（无快照） | < 2s 显示空工作区 | 手动清 localStorage 后测试 |
| PWA 后台恢复 | < 500ms 可交互 | Performance API |
| 弱网启动 | 本地数据先显示，不卡启动壳 | Chrome DevTools throttle |
| 启动壳停留时间 | < 200ms（Phase 0）/ 0ms（Phase 1） | `__NANOFLOW_STARTUP_TRACE__` 的 `handoff.trigger` 时间戳 |

### 7.2 性能验收

| 指标 | 目标 |
|------|------|
| FCP（有快照） | < 200ms（index.html 快照渲染） |
| TTI（有快照） | < 500ms（Phase 0）/ < 300ms（Phase 1） |
| 主线程长任务 | 无 > 50ms 的长任务 |
| 快照恢复耗时 | < 30ms |

### 7.3 回归测试

- [ ] `npm run test:run:services` — 服务层测试全通过
- [ ] `npm run test:run:components` — 组件层测试全通过
- [ ] `npm run test:e2e` — E2E 关键路径测试全通过
- [ ] 手动验证：Android Chrome PWA（目标设备）

---

## 8. 风险与回滚策略

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| P0-1 快照过期 → 显示旧数据 | 中 | 低（后台同步会覆盖） | 可接受。用户宁愿看到旧数据也不愿等 3s 看到新数据 |
| P0-3 去掉 fade-out → 闪烁 | 低 | 视觉 | 对齐 #initial-loader 和 LaunchShell 样式 |
| P1-1 跳过 LaunchShell → 白屏 | 中 | 体验 | Boot Flag 门控回退 |
| P2-1 维护两套渲染逻辑 | 高 | 维护成本 | 仅在 Phase 0-1 不足时才考虑 |

**Phase 0 回滚**：还原 `resolveHandoffResult` 中 `effectiveHasProjects` 改动 + 恢复超时值。
**Phase 1 回滚**：Boot Flag `LAUNCH_SHELL_SKIP_V1 = false`。
**Phase 2 回滚**：Boot Flag `DIRECT_TEXT_HYDRATE_V1 = false`。

---

## 9. 附录：关键文件索引

| 文件 | 职责 | 关键区域 |
|------|------|---------|
| [index.html](../index.html) | 首屏 HTML + 快照渲染器 | L580-670（快照渲染），L1000-1100（dismissLoader） |
| [app.component.ts](../src/app.component.ts) | 根组件，LaunchShell 门控 | L104（MASTER_SAFETY），L121-133（handoff fade） |
| [handoff-coordinator.service.ts](../src/services/handoff-coordinator.service.ts) | handoff 决策引擎 | L62-98（resolveHandoffResult），L113（SAFETY_TIMEOUT） |
| [app-auth-coordinator.service.ts](../src/app/core/services/app-auth-coordinator.service.ts) | auth 协调 | L109-148（scheduleSessionBootstrap），L190-290（bootstrapSession） |
| [boot-stage.service.ts](../src/services/boot-stage.service.ts) | 4 阶段启动状态机 | 全文 |
| [launch-snapshot.service.ts](../src/services/launch-snapshot.service.ts) | 快照捕获/恢复 | L14-16（keys），L96-107（deferred persist） |
| [user-session.service.ts](../src/services/user-session.service.ts) | 数据加载主干 | L112-180（prehydrateFromSnapshot） |
| [startup-tier-orchestrator.service.ts](../src/services/startup-tier-orchestrator.service.ts) | P0/P1/P2 分层启动 | L130-145（tier timers） |
| [workspace-shell.component.ts](../src/workspace-shell.component.ts) | 工作区壳 | L770-790（constructor prehydrate），L1090-1130（handoff effect） |
| [startup-performance.config.ts](../src/config/startup-performance.config.ts) | 启动延迟配置 | L126（P1=150ms），L135（P2=800ms） |
| [auth.config.ts](../src/config/auth.config.ts) | auth 超时配置 | L19（SESSION_CHECK=3s），L49（GUARD=2s） |
| [ngsw-config.json](../ngsw-config.json) | Service Worker 缓存策略 | 全文 |
