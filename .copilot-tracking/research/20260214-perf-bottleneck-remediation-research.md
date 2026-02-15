<!-- markdownlint-disable-file -->

# Task Research Notes: 2026-02-14 线上性能瓶颈修复研究

**研究日期**: 2026-02-14
**研究员**: Task Researcher
**状态**: ✅ 研究完成
**审计来源**: `docs/deep-performance-audit-2026-02-14.md`

---

## Research Executed

### 审计报告概要

审计环境：Playwright 1.58.0 + Chromium 145 headless，针对线上站点 `https://dde-eight.vercel.app/#/projects`。
三场景采样：桌面常规 / 移动常规 / 桌面弱网+4xCPU。

核心发现（按优先级）：

| 编号 | 级别 | 问题 | 证据 |
|------|------|------|------|
| P0-1 | 高 | 桌面端登录后自动触发 Flow/GoJS chunk 加载（364,875 B 传输） | 桌面 vs 移动 JS 差值完全对齐 chunk-LFLKK2NT.js |
| P0-2 | 高 | `get_full_project_data` RPC 400 + 回退顺序加载 | 线上观测 `Access denied to project ...` |
| P0-3 | 高 | `black_box_entries` 登录阶段重复拉取（同会话 2 次） | 请求时序 817ms + 1887ms |
| P1-1 | 中 | 字体子集命中 14 个 .woff2，累计 ~761 KB | transferSize 明细 |
| P1-2 | 中 | Focus/BlackBox idle 初始化与主加载并行 | @defer(on idle) 触发链路分析 |
| P2-1 | 低 | 缺少弱网专项预算与 CI 回归 | 无门禁 |
| P2-2 | 低 | 缺少 RPC 错误率 + 重复拉取告警 | 无告警 |

### 性能基线数据

| 场景 | LCP | CLS | Long Task 次数/总时长/最大 |
|------|-----|-----|--------------------------|
| desktop-normal | 508ms | 0.0049 | 5 / 367ms / 115ms |
| mobile-normal | 608ms | 0.0203 | 1 / 93ms / 93ms |
| desktop-throttled | 26,172ms | 0.0011 | 16 / 1,829ms / 421ms |

桌面常规中位 LCP: ~668ms
弱网 LCP 目标: < 6,000ms

---

## File Analysis

### 1. `src/app/core/shell/project-shell.component.ts` (664 行)

- **L248**: `@defer (on idle; prefetch on idle)` — 桌面端 Flow 组件懒加载触发器
- **问题**: `on idle` 在 Angular 启动后立即触发（浏览器一进入空闲），桌面端首次登录后 GoJS chunk 被过早拉取
- **需要改造为**: 用户意图驱动触发（`on interaction` 或 tab 切换信号）
- **相关代码**:
  ```html
  @defer (on idle; prefetch on idle) {
    <app-flow-view class="flex-1 min-h-0 overflow-hidden relative" (goBackToText)="switchToText()"></app-flow-view>
  }
  ```

### 2. `src/app.component.html` (547 行)

- **L98-L101**: FocusMode `@defer (on idle)` 加载
- **问题**: 首屏渲染后立刻触发 FocusMode 初始化，该组件会调用 `blackBoxSyncService.pullChanges()`
- **需要改造为**: 延迟到首屏核心同步完成后（或用 `when` 条件守卫）
- **相关代码**:
  ```html
  @defer (on idle) {
    <app-focus-mode></app-focus-mode>
  }
  ```

### 3. `src/app/features/focus/focus-mode.component.ts` (171 行)

- **L134-L149**: `initializeAndCheckGate()` 无条件调用 `pullChanges()`
- **问题**: 无 freshness 判断，无 single-flight 控制，与主同步链路可能同时拉取 `black_box_entries`
- **需要改造为**: 增加 freshness window（如 30s 内已拉取则跳过） + 先读本地缓存
- **相关代码**:
  ```typescript
  private async initializeAndCheckGate(): Promise<void> {
    try {
      await this.blackBoxSyncService.pullChanges();
      this.checkGateOnStartup();
    } catch (error) {
      this.checkGateOnStartup();
    }
  }
  ```

### 4. `src/services/black-box-sync.service.ts` (599 行)

- **L505-L530**: `doPullChanges()` 核心拉取逻辑
- **L511**: `const lastSync = this.lastSyncTime || '1970-01-01T00:00:00Z'` — 无 lastSync 时全量拉取
- **问题 1**: 首次登录或缓存丢失时从 epoch 拉取全表，无 limit
- **问题 2**: 无 single-flight 机制，多处并发调用会产生重复请求
- **需要改造为**:
  1. 增加 single-flight / mutex（同一时刻只允许一个 pullChanges 在执行）
  2. 增加 freshness window（上次成功拉取 N 秒内不重复调用）
  3. 首次拉取考虑加 limit 或时间窗口限制
- **相关代码**:
  ```typescript
  const lastSync = this.lastSyncTime || '1970-01-01T00:00:00Z';
  const { data, error } = await client
    .from('black_box_entries')
    .select('id,project_id,...')
    .gt('updated_at', lastSync)
    .order('updated_at', { ascending: true });
  ```

### 5. `src/services/user-session.service.ts` (832 行)

- **L366-L401**: 登录后后台同步的三阶段策略
  - 策略 1: Delta Sync（activeProjectId + DELTA_SYNC_ENABLED）
  - 策略 2: 全量回退（loadSingleProjectFromCloud → RPC）
  - 策略 3: 项目列表元数据同步
- **L380**: `performDeltaSync` 失败后进入全量回退，最终到 `loadFullProjectOptimized` → RPC 400
- **问题**: `activeProjectId` 可能是过期或无权限的 ID（缓存残留），导致 RPC Access denied
- **需要改造为**: RPC 前校验 activeProjectId 有效性；RPC 400 Access denied 不走同路径 fallback（避免无效重试链路）

### 6. `src/app/core/services/sync/project-data.service.ts` (601 行)

- **L77-L105**: `loadFullProjectOptimized()` RPC 调用入口
- **L85**: `client.rpc('get_full_project_data', { p_project_id: projectId })`
- **L89**: `if (error)` → 回退到 `this.loadFullProject(projectId)` — 产生 4+ 次顺序请求
- **问题**: Access denied 类型的错误也会触发 fallback，产生无效请求链
- **需要改造为**: 区分 Access denied（P0001）与其他错误；Access denied 直接返回 null 并清理无效 activeProjectId
- **相关代码**:
  ```typescript
  if (error) {
    this.logger.warn('RPC 调用失败，回退到顺序加载', { error: error.message });
    return this.loadFullProject(projectId);  // ← Access denied 也走这里
  }
  ```

### 7. `index.html` (761 行)

- **L65-L72**: 字体 preload/prefetch
  - L65: `preload` subset-119（关键首屏子集）
  - L66: `prefetch` subset-118
  - L67: `prefetch` subset-117
- **L74-L81**: 内联 @font-face 定义（subset-119/118/117）
- **L126-L128**: 异步 CSS 加载 `lxgw-wenkai-screen.css`（`media="print" onload="this.media='all'"`）
- **问题**: 页面中文内容丰富时，CSS 联动触发 14 个 .woff2 子集按需请求，累计 ~761 KB，弱网下与 JS 争抢带宽
- **需要改造为**: 
  1. 首屏只保留 subset-119 的 preload
  2. 其余子集延后（从 prefetch 改为 requestIdleCallback 触发或 IntersectionObserver）
  3. 考虑字体 CSS 加载时机后移（等首屏 JS 加载完）

---

## 与 2026-02-07 审计的差异

| 维度 | 2026-02-07 审计 | 2026-02-14 审计 |
|------|----------------|----------------|
| GoJS barrel export 泄漏 | P0（main bundle 含 GoJS） | 已修复（2026-02-07 后已处理） |
| @defer on viewport 桌面失效 | P0-2（on viewport 桌面即加载） | 已改为 on idle，但 idle 过早触发（P0-1） |
| SW 注册/注销矛盾 | P0-3 | 不在本次审计范围 |
| FocusMode 静态导入 | P1-2（静态 import） | 已改为 @defer，但 on idle 仍过早（P1-2） |
| RPC 400 + fallback | 未发现 | **新问题** P0-2 |
| black_box_entries 重复拉取 | 未发现 | **新问题** P0-3 |
| 字体策略 | ngsw-config prefetch 全部 | 仍存在首阶段带宽争抢（P1-1） |
| 弱网场景覆盖 | 无弱网数据 | **新增** 弱网+4xCPU 场景暴露退化 |

---

## 实现模式参考

### single-flight 模式（防止重复拉取）

```typescript
private pullInFlight: Promise<void> | null = null;
private lastPullTime = 0;
private readonly FRESHNESS_WINDOW = 30_000; // 30s

async pullChanges(): Promise<void> {
  // freshness 检查
  if (Date.now() - this.lastPullTime < this.FRESHNESS_WINDOW) {
    return;
  }
  // single-flight
  if (this.pullInFlight) {
    return this.pullInFlight;
  }
  this.pullInFlight = this.doPullChanges().finally(() => {
    this.pullInFlight = null;
    this.lastPullTime = Date.now();
  });
  return this.pullInFlight;
}
```

### RPC 错误分类处理模式

```typescript
if (error) {
  const isAccessDenied = error.code === 'P0001' || error.message?.includes('Access denied');
  if (isAccessDenied) {
    this.logger.warn('项目访问被拒绝，跳过该项目', { projectId });
    return null; // 不走 fallback
  }
  // 其他错误仍走 fallback
  return this.loadFullProject(projectId);
}
```

### @defer 条件守卫模式

```html
<!-- 延迟到核心同步完成后 -->
@defer (when coreDataLoaded(); prefetch on idle) {
  <app-focus-mode></app-focus-mode>
}
```

### 字体延后加载模式

```html
<!-- 首屏只 preload 关键子集 -->
<link rel="preload" href="/fonts/lxgwwenkaiscreen-subset-119.woff2" as="font" type="font/woff2" crossorigin>
<!-- 其余子集不 prefetch，等首屏完成后通过 JS 动态加载字体 CSS -->
<script>
  // 首屏关键资源加载完成后再注入字体 CSS
  window.addEventListener('load', () => {
    requestIdleCallback(() => {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = '/fonts/lxgw-wenkai-screen.css';
      document.head.appendChild(link);
    });
  });
</script>
```

---

## Supabase RPC 函数分析

### `get_full_project_data` 触发 Access Denied 的可能原因

1. **RLS 策略拦截**: RPC 函数内部查询 projects 表时 RLS 不允许当前用户访问该 projectId
2. **函数内显式校验**: RPC 函数体内 `IF NOT FOUND THEN RAISE EXCEPTION 'Access denied to project ...'`
3. **缓存残留 activeProjectId**: 用户删除或退出共享项目后，本地 activeProjectId 仍指向该项目

### 修复方向

- 调用 RPC 前先做轻量级 `projects?id=eq.xxx&select=id` 校验
- 或 RPC 400 时判断 `code === 'P0001'` 直接清理 activeProjectId，不走 fallback

---

## 验收基线（审计报告定义）

| 维度 | 当前基线 | 验收目标 |
|------|---------|---------|
| 桌面常规 LCP | ~668ms | < 1,200ms |
| 弱网+4xCPU LCP | ~26,172ms | < 6,000ms |
| 弱网 nav->登录弹窗 | ~36,168ms | < 5,000ms |
| 登录后重复 black_box_entries 拉取 | 2 次 | ≤ 1 次 |
| get_full_project_data 400 | 发生 | 0 次 |
