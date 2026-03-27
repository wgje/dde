# PWA 秒开与数据完整性修复策划案

> 版本：v1.0 | 日期：2026-03-27  
> 目标：点击 PWA 图标后秒开并显示文本栏真实界面，数据完整加载无丢失  
> 约束：符合 NanoFlow Hard Rules（offline-first、LWW、Signals、不造轮子）

---

## 一、现状故障全景

### 用户表象

| # | 表象 | 持续时间 | 严重度 |
|---|------|---------|--------|
| S1 | 点击 PWA 图标后，"正在恢复你的工作区" 启动壳长时间占据界面 | 3-8 秒 | P0 |
| S2 | 启动壳消失后，真实工作区无法加载用户数据 | 永久（需刷新） | P0 |
| S3 | 用户数据被种子数据覆盖（"数据被吞"） | 永久 | P0 |

### 目标指标

| 指标 | 当前值 | 目标值 |
|------|--------|--------|
| PWA 冷启动 → 真实文本视图可见 | 3-8s | < 1s |
| 启动壳最长停留时间 | 8s (safety timeout) | < 1.5s |
| 数据加载成功率 | ~80%（弱网下更低） | 100%（离线也能显示缓存） |
| 数据被种子覆盖概率 | > 0 | 0 |

---

## 二、根因深度分析

### 故障 S1 — 启动壳卡死

**根因链（串行瀑布）：**

```
T=0ms     index.html #snapshot-shell 渲染 "正在恢复你的工作区"
T=200ms   Angular 启动 → LaunchShellComponent 挂载（同样显示 "正在恢复你的工作区"）
T=300ms   WorkspaceShellComponent.ngOnInit()
          └─ authCoord.scheduleSessionBootstrap()
          └─ 等待 'nanoflow:boot-stage' 事件或 2500ms fallback
T=300ms   ngAfterViewInit()
          └─ handoffCoordinator.markLayoutStable()
          └─ 启动 8s 安全超时计时器
T=~350ms  bootstrapSession() 启动
          └─ isCheckingSession = true
          └─ auth.checkSession()（Supabase 网络请求）
                                    ┌──────────────────────────────┐
                                    │ 在此期间 handoff 被阻塞：    │
                                    │ resolveHandoffResult() 检查：│
                                    │  authConfigured=true         │
                                    │  hasProjects=false           │
                                    │  isCheckingSession=true      │
                                    │  → 返回 { kind: 'pending' } │
                                    │  → handoff 永远无法调度       │
                                    └──────────────────────────────┘
T=1-3s    checkSession() 完成
          └─ setCurrentUser(userId)（无 forceLoad!）
          └─ loadUserData() → loadProjects()
              └─ Phase 1: IndexedDB/localStorage 读取
T=1-4s    projects 加载完成 → hasProjects=true
          └─ isCheckingSession=false
          └─ handoff 终于可以 resolve 为非 pending
T=4-8s    安全超时兜底（若上述流程超时）
          └─ 强制 handoff → 启动壳终于消失
```

**核心阻塞点（[handoff-coordinator.service.ts](../src/services/handoff-coordinator.service.ts#L76-L81)）：**

```typescript
if (
  input.authConfigured &&        // ← 始终 true（已配置 Supabase）
  !input.hasProjects &&          // ← true（项目尚未从缓存加载）
  (input.isCheckingSession ||    // ← true（bootstrapSession 进行中）
   input.authRuntimeState === 'idle' ||
   input.authRuntimeState === 'pending')
) {
  return { kind: 'pending', degradeReason: null };  // ← 阻塞 handoff！
}
```

**关键问题：Auth 检查与数据加载是串行的，而 handoff 同时依赖两者完成。**

localStorage 中的 `nanoflow.launch-snapshot.v2` 已有项目/任务数据（用于启动壳渲染），但从未被用来预填充 Store 状态，导致 `hasProjects` 在整个 auth→data 串行链完成前始终为 false。

---

### 故障 S2/S3 — 数据丢失与种子覆盖

**根因 1：bootstrapSession 未传 `forceLoad: true`**

[app-auth-coordinator.service.ts#L231](../src/app/core/services/app-auth-coordinator.service.ts#L231):
```typescript
// 冷启动路径 — 缺少 forceLoad!
const loadPromise = this.userSession.setCurrentUser(result.userId);  // ← 无 { forceLoad: true }
```

对比登录路径（[#L343](../src/app/core/services/app-auth-coordinator.service.ts#L343)）:
```typescript
// 登录路径 — 正确传入 forceLoad
const loadPromise = this.userSession.setCurrentUser(userId, { forceLoad: true });
```

**影响**：在冷启动时，如果 `previousUserId` 恰好等于 `result.userId`（例如 auth guard 快速路径已提前设置了 currentUserId），则 `isUserChange=false`。同时如果种子数据已存在（`hasProjects=true`），则满足条件跳过 `loadUserData()`：

```typescript
// user-session.service.ts#L149
if (forceLoad || !hasProjects || isUserChange) {
  await this.loadUserData(userId);  // ← 三个条件全 false → 跳过！
}
```

**根因 2：Phase 2 全量覆盖**

`loadProjects()` 的 Phase 2（后台同步）使用 `setProjects()` 做**完全替换**而非合并：

```
Phase 1: loadFromCacheOrSeed() → setProjects([缓存/种子数据])  ← UI 立即可见
Phase 2: startBackgroundSync() → setProjects([云端数据])        ← 完全覆盖！
```

如果 Phase 1 加载了种子数据（缓存为空），Phase 2 云端同步失败，用户就永久停留在种子数据上 = "数据被吞"。

**根因 3：bootstrap 超时切断数据加载**

`BOOTSTRAP_DATA_LOAD_TIMEOUT_MS = 3000ms`。如果 `loadUserData()` 超过 3s（移动端弱网常见），bootstrap 继续但 `isCheckingSession` 被设为 false，handoff 尝试 resolve，此时 `hasProjects` 可能仍为 false → 进入 `empty-workspace` 状态 → 种子数据被创建。

---

## 三、解决策划案

### 3.1 总体策略

```
                 Phase A                    Phase B                Phase C
              (阻塞消除)                  (数据保障)             (体验精打磨)
          ┌─────────────────┐      ┌────────────────────┐    ┌──────────────────┐
          │ A1: 快照预填充   │      │ B1: forceLoad 修复  │    │ C1: 启动壳淡入淡出│
          │ A2: 解耦 handoff │      │ B2: 合并代替覆盖    │    │ C2: 骨架屏优化    │
          │ A3: 安全超时缩短 │      │ B3: 种子保护策略    │    │ C3: 性能监控增强  │
          └─────────────────┘      │ B4: 超时恢复加固    │    └──────────────────┘
                                   └────────────────────┘
```

---

### 3.2 Phase A — 阻塞消除（启动壳秒退）

#### A1: 快照预填充 Store（关键改动）

**目标**：在 Angular 首次渲染时，从 `nanoflow.launch-snapshot.v2` 预填充 `ProjectStore` / `TaskStore`，使 `hasProjects=true` 立即成立。

**改动范围**：
- `src/services/user-session.service.ts` — 新增 `prehydrateFromSnapshot()` 方法
- `src/app/core/shell/workspace-shell.component.ts` — 在 `constructor()` 或 `ngOnInit()` 最早时机调用

**实现思路**：
```typescript
// user-session.service.ts 新增
prehydrateFromSnapshot(): boolean {
  // 1. 读取 window.__NANOFLOW_LAUNCH_SNAPSHOT__ 或 localStorage
  const snapshot = window.__NANOFLOW_LAUNCH_SNAPSHOT__
    ?? this.launchSnapshotService.read();
  if (!snapshot?.projects?.length) return false;

  // 2. 仅当 Store 为空时预填充（避免干扰已有的真实数据）
  if (this.projectState.projects().length > 0) return true;

  // 3. 从快照构建轻量 Project 对象（只含 id、name、基础任务列表）
  const projects = snapshot.projects.map(sp => ({
    id: sp.id,
    name: sp.name,
    tasks: (sp.recentTasks ?? []).map(t => ({
      id: t.id,
      content: t.content,
      // ... 最小必要字段
    })),
    connections: [],
    // 标记为快照来源，后续真实数据加载时需要合并
    _fromSnapshot: true,
  }));

  // 4. 填充 Store（使 hasProjects 立即为 true）
  this.projectState.setProjects(projects);
  this.projectState.setActiveProjectId(
    snapshot.activeProjectId ?? projects[0]?.id ?? null
  );
  return true;
}
```

**调用时机**：`WorkspaceShellComponent.constructor()` 中，在 `setupSignalEffects()` 之前。

**风险控制**：
- 快照数据是只读脱水副本，不含完整 updatedAt 等同步字段
- `loadUserData()` 成功后会覆盖快照数据（但需用合并策略，见 B2）
- 如果快照不存在/损坏 → 回退到现有逻辑（无副作用）

**效果**：handoff 在 Angular 首次渲染后 < 100ms 即可 resolve 为非 pending。

---

#### A2: 解耦 Handoff 条件（允许快照满足 hasProjects）

**目标**：当快照数据已预填充 Store 时，handoff 不再等待 auth 完成。

**改动范围**：
- `src/services/handoff-coordinator.service.ts` — 修改 `resolveHandoffResult()` 的阻塞条件

**现在的阻塞逻辑**：
```typescript
// hasProjects=false + auth 未完成 → pending
if (authConfigured && !hasProjects && (isCheckingSession || authRuntimeState !== 'ready')) {
  return { kind: 'pending' };
}
```

**修改为**：
```typescript
// 仅在 hasProjects=false 时才因 auth 阻塞
// hasProjects=true（快照预填充或缓存已加载）→ 直接放行
if (authConfigured && !input.hasProjects) {
  if (input.isCheckingSession || input.authRuntimeState === 'idle' || input.authRuntimeState === 'pending') {
    return { kind: 'pending', degradeReason: null };
  }
}
```

**效果**：配合 A1 快照预填充后，handoff 条件中 `hasProjects` 已为 true，auth 检查不再阻塞 handoff。Auth 结果（登录态/登出）在 handoff 后通过壳层 effect 异步处理。

**兼容性**：`applyNonBlockingLoginFallback()` 已处理 `hasProjects=true + showLoginRequired=true` 的情况，会返回 `kind: 'full', degradeReason: 'login-required-nonblocking'`，不会出现安全问题。

---

#### A3: 缩短安全超时

**改动范围**：
- `src/services/handoff-coordinator.service.ts` — `HANDOFF_SAFETY_TIMEOUT_MS`

**当前值**：`8000ms`  
**建议值**：`3000ms`

```typescript
// handoff-coordinator.service.ts#L109
private readonly HANDOFF_SAFETY_TIMEOUT_MS = 3000;  // 从 8s 降至 3s
```

**理由**：
- A1+A2 实施后，正常场景下 handoff 在 < 500ms 完成
- 3s 兜底仅覆盖极端异常（快照损坏 + 缓存丢失 + 网络超时）
- 8s 对于移动端 PWA 体验是灾难性的，3s 已足够覆盖极端场景

**测试影响**：需更新 `handoff-coordinator.service.spec.ts` 中与 8s 相关的测试用例。

---

### 3.3 Phase B — 数据完整性保障

#### B1: bootstrapSession 添加 `forceLoad: true`

**改动范围**：
- `src/app/core/services/app-auth-coordinator.service.ts#L231`

**修改**：
```typescript
// 修改前（冷启动路径缺少 forceLoad）
const loadPromise = this.userSession.setCurrentUser(result.userId);

// 修改后
const loadPromise = this.userSession.setCurrentUser(result.userId, { forceLoad: true });
```

**理由**：
- 登录路径（#L343）和会话恢复路径（#L400）都已使用 `{ forceLoad: true }`
- 唯独冷启动 bootstrap 路径遗漏了，导致存在跳过 `loadUserData()` 的竞态窗口
- 此修改确保冷启动后 **始终** 从缓存或云端加载用户真实数据

**测试影响**：`app-auth-coordinator.service.spec.ts` 需新增用例验证 bootstrapSession 传 `forceLoad: true`。

---

#### B2: Phase 2 合并代替全量覆盖

**目标**：后台云端同步不再使用 `setProjects()` 全量覆盖，改为增量合并。

**改动范围**：
- `src/services/user-session.service.ts` — `startBackgroundSync()` 及其调用链

**策略**：

```
当前行为：
  Phase 1: setProjects([缓存])  →  Phase 2: setProjects([云端])  ← 全量覆盖！

期望行为：
  Phase 1: setProjects([缓存/快照])
  Phase 2: mergeProjects([云端])  ← 增量合并！
    ├─ 新项目 → 添加
    ├─ 已有项目 → LWW 合并（updatedAt 更新者胜出）
    ├─ 本地新增任务（未同步）→ 保留
    └─ 本地已删除但云端存在 → 以本地 tombstone 为准
```

**实现思路**：在 `ProjectStateService` 新增 `mergeProjectsFromCloud()` 方法：

```typescript
mergeProjectsFromCloud(cloudProjects: Project[]): void {
  const localMap = new Map(this.projects().map(p => [p.id, p]));

  for (const cloudProject of cloudProjects) {
    const local = localMap.get(cloudProject.id);
    if (!local) {
      // 新项目：直接添加
      localMap.set(cloudProject.id, cloudProject);
    } else {
      // 已有项目：合并任务（LWW）
      const mergedTasks = this.mergeTasksLWW(local.tasks, cloudProject.tasks);
      localMap.set(cloudProject.id, { ...cloudProject, tasks: mergedTasks });
    }
  }

  this.setProjects(Array.from(localMap.values()));
}
```

**风险控制**：
- 合并使用现有的 LWW 逻辑（`updatedAt` 大者胜出）
- 本地 RetryQueue 中的待推送操作不会被覆盖
- 如果合并逻辑出错，回退到全量覆盖（已验证的现有逻辑）

---

#### B3: 种子数据保护策略

**目标**：确保用户真实数据永远不会被种子数据替代。

**改动范围**：
- `src/services/user-session.service.ts` — `loadFromCacheOrSeed()`

**现状问题**：
```typescript
// 当前逻辑
if (cached.length === 0) {
  projects = this.seedProjects();  // ← 无条件创建种子数据
}
```

**修改策略**：

```typescript
// 修改后
if (cached.length === 0) {
  // 仅在确认用户从未有数据时才创建种子（新用户场景）
  // 如果用户已登录且云端有数据 → 不创建种子，等待后台同步
  const isAuthenticatedUser = !!this.authService.currentUserId();
  if (isAuthenticatedUser) {
    // 已登录用户缓存为空：可能是缓存清理或首次设备登录
    // 不创建种子数据，保持空状态等后台同步填充
    // 设置加载标志让 UI 显示 "正在加载数据..."
    this.logger.warn('已登录用户无本地缓存，跳过种子数据，等待后台同步');
    projects = [];
  } else {
    // 未登录/离线模式：创建种子数据供离线体验
    projects = this.seedProjects();
    usedSeed = true;
  }
}
```

**效果**：已登录用户的数据永远不会被种子覆盖。最坏情况用户看到空列表 + "正在加载" 提示，几秒后后台同步填充真实数据。

---

#### B4: Bootstrap 超时恢复加固

**目标**：`BOOTSTRAP_DATA_LOAD_TIMEOUT_MS` 超时后，确保后台加载完成时数据能正确显示。

**改动范围**：
- `src/app/core/services/app-auth-coordinator.service.ts` — 超时续传逻辑

**现状问题**：
```typescript
// 当前：超时后 loadPromise 在后台继续，但出错只日志记录
void loadPromise.then(() => { ... }).catch((error) => {
  this.logger.error('[Bootstrap] 后台数据加载失败', error);
  // ← 没有任何恢复措施！
});
```

**修改策略**：
```typescript
void loadPromise.then(() => {
  const backgroundElapsed = Date.now() - loadStartTime;
  this.logger.info(`[Bootstrap] 后台数据加载完成 (耗时 ${backgroundElapsed}ms)`);
}).catch((error: unknown) => {
  this.logger.error('[Bootstrap] 后台数据加载失败，尝试离线缓存恢复', error);
  // 降级策略：尝试从缓存加载
  this.userSession.loadFromCacheOrSeedSafe().catch(fallbackError => {
    this.logger.error('[Bootstrap] 缓存恢复也失败', fallbackError);
    this.toastService.error('数据加载失败', '请检查网络并刷新页面');
  });
});
```

---

### 3.4 Phase C — 体验精打磨

#### C1: 启动壳淡入淡出过渡

**目标**：启动壳到真实界面的切换不再是硬切，加入 200ms 淡出动画。

**改动范围**：
- `src/launch-shell.component.ts` — 添加 CSS transition
- `src/app.component.ts` — `showLaunchShell` 信号配合动画状态

**说明**：当 handoff 触发后，launch shell 先加一个 `fading-out` class（200ms opacity 过渡），动画结束后再从 DOM 移除。这消除了视觉"闪烁"感。

---

#### C2: 骨架屏与真实数据无缝过渡

**目标**：快照预填充的轻量数据在真实数据加载后无缝替换，无视觉跳动。

**改动范围**：
- `src/app/features/text/` — text view 组件

**说明**：快照数据预填充后，text view 已可渲染任务列表。当 `loadUserData()` 完成真实数据合并后，Signals dirty check（`isTaskEqual()`）会精确控制只有** 实际变化的行**才触发重渲染，避免整页跳动。

---

#### C3: 启动性能监控增强

**目的**：为新的启动路径添加可观测性。

**改动范围**：
- `src/utils/startup-trace.ts` — 新增追踪点

**新增追踪点**：
```
startup.snapshot_prehydrate        — 快照预填充耗时与结果
startup.handoff_resolve_first      — handoff 首次 resolve 的时间和结果
startup.data_load_phase1_complete  — Phase 1 缓存加载完成时间
startup.data_load_phase2_complete  — Phase 2 云端合并完成时间
startup.data_merge_stats           — 合并统计（新增/更新/保留/删除）
```

---

## 四、改动矩阵

| ID | 改动 | 文件 | 风险 | 优先级 |
|-----|------|------|------|--------|
| A1 | 快照预填充 Store | user-session.service.ts, workspace-shell.component.ts | 中 | P0 |
| A2 | 解耦 handoff 条件 | handoff-coordinator.service.ts | 低 | P0 |
| A3 | 安全超时 8s→3s | handoff-coordinator.service.ts | 低 | P0 |
| B1 | bootstrapSession 加 forceLoad | app-auth-coordinator.service.ts | 低 | P0 |
| B2 | Phase 2 合并代替覆盖 | user-session.service.ts, project-state.service.ts | 中 | P0 |
| B3 | 种子数据保护 | user-session.service.ts | 低 | P1 |
| B4 | 超时恢复加固 | app-auth-coordinator.service.ts | 低 | P1 |
| C1 | 启动壳淡出动画 | launch-shell.component.ts, app.component.ts | 低 | P2 |
| C2 | 骨架屏无缝过渡 | text view 组件 | 低 | P2 |
| C3 | 启动监控增强 | startup-trace.ts | 低 | P2 |

---

## 五、实施顺序与验收标准

### 阶段 1（P0 — 预计改动量：~150 行）

**执行顺序**：B1 → A1 → A2 → A3 → B2

**理由**：B1 最小且最安全（单行修改），A1 是核心改动，A2/A3 依赖 A1 的预填充效果，B2 确保合并安全。

**验收标准**：
- [ ] PWA 冷启动（有缓存）→ 真实文本视图 < 1s 可见
- [ ] PWA 冷启动（无缓存、已登录）→ 空列表 + 加载提示 < 1.5s → 数据在 3s 内填充
- [ ] 离线冷启动 → 显示缓存数据，无种子覆盖
- [ ] `npm run test:run:services` 全部通过
- [ ] Handoff safety timeout 测试用例适配 3s
- [ ] bootstrapSession 调用 `setCurrentUser(userId, { forceLoad: true })` 有测试覆盖

### 阶段 2（P1 — 预计改动量：~80 行）

**执行顺序**：B3 → B4

**验收标准**：
- [ ] 已登录用户数据永不被种子替代（边界测试）
- [ ] bootstrap 超时后数据最终能恢复

### 阶段 3（P2 — 预计改动量：~60 行）

**执行顺序**：C1 → C2 → C3

**验收标准**：
- [ ] 启动壳 → 真实界面无视觉闪烁
- [ ] Sentry 可追踪新增启动指标

---

## 六、预期效果时间线（优化后）

```
T=0ms      PWA 点击 → index.html #snapshot-shell 立即显示
T=~150ms   Angular 启动 → LaunchShellComponent 渲染
T=~250ms   WorkspaceShellComponent.constructor()
           └─ prehydrateFromSnapshot() → Store 预填充 → hasProjects=true ✅
T=~280ms   ngAfterViewInit()
           └─ markLayoutStable()
           └─ resolve(): hasProjects=true → kind='degraded-to-text' 或 'full'
           └─ scheduleHandoffIfReady() → rAF 调度
T=~300ms   markWorkspaceHandoffReady() → 启动壳开始淡出
T=~500ms   真实文本视图完全可见 ✅（用户看到快照数据）
T=~500ms   scheduleSessionBootstrap() → bootstrapSession() 异步开始
T=~1-3s    auth.checkSession() + loadUserData({ forceLoad: true })
           └─ Phase 1: 从 IndexedDB 加载完整缓存 → mergeProjectsFromCloud()
T=~2-5s    Phase 2: 后台增量同步 → mergeProjectsFromCloud()
           └─ Dirty check 确保仅变化行更新 → 无视觉跳动
```

**结果**：从 T=0 到用户看到可交互的文本视图 < 500ms（目前 3-8s）。

---

## 七、风险与回滚策略

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|---------|
| 快照数据过期（用户在其他设备修改） | 中 | 低 | Phase 2 合并会覆盖过期数据，Dirty check 确保无跳动 |
| 快照格式损坏导致 Store 污染 | 低 | 中 | `prehydrateFromSnapshot()` 内做 schema 校验，失败静默跳过 |
| Auth 延后导致安全窗口 | 低 | 低 | `applyNonBlockingLoginFallback()` 已处理，敏感操作仍走 auth 拦截 |
| Phase 2 合并逻辑引入新 bug | 中 | 中 | Feature flag 控制：`SNAPSHOT_PREHYDRATE_V1`，可一键回退到全量覆盖 |

**回滚方案**：
- 所有新增行为通过 Feature Flag `SNAPSHOT_PREHYDRATE_V1` 控制
- 关闭 flag 后完全回退到当前行为（串行 auth→load→handoff）
- Flag 定义在 `src/config/feature-flags.config.ts`，可通过 `window.__NANOFLOW_BOOT_FLAGS__` 运行时覆盖

---

## 八、不在此次改动范围

- Service Worker 预缓存策略调整（当前已足够优化）
- GoJS 懒加载优化（不影响移动端文本视图启动）
- Sentry 初始化优化（已是 queueMicrotask 非阻塞）
- Font 加载策略调整（已有三级延迟策略）
- IndexedDB 读取性能优化（通常 < 50ms，非瓶颈）
