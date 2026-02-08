# NanoFlow 深度性能审计报告

> **审计日期**: 2026-02-07  
> **审计 URL**: https://dde-eight.vercel.app/#/projects  
> **测试账号**: 1@qq.com  
> **测试环境**: Headless Chrome 144 / Ubuntu 24.04 / 无 CPU/网络节流  
> **框架版本**: Angular 19.2.x + GoJS 3.1.x + Supabase 2.84+

---

## 目录

1. [执行摘要](#1-执行摘要)
2. [Core Web Vitals 评分](#2-core-web-vitals-评分)
3. [网络请求分析](#3-网络请求分析)
4. [JavaScript Bundle 分析](#4-javascript-bundle-分析)
5. [关键渲染路径分析](#5-关键渲染路径分析)
6. [运行时性能分析](#6-运行时性能分析)
7. [源码级深度分析](#7-源码级深度分析)
8. [API 请求与后端交互](#8-api-请求与后端交互)
9. [字体加载策略评估](#9-字体加载策略评估)
10. [Service Worker 矛盾问题](#10-service-worker-矛盾问题)
11. [页面卡死根因分析](#11-页面卡死根因分析)
12. [问题严重性分级](#12-问题严重性分级)
13. [优化建议清单](#13-优化建议清单)
14. [附录：原始数据](#14-附录原始数据)

---

## 1. 执行摘要

### 发现的关键问题

| 严重性 | 数量 | 概述 |
|--------|------|------|
| 🔴 致命 | 3 | 页面卡死/GoJS 桌面端无效懒加载/SW 矛盾 |
| 🟡 严重 | 5 | 401 API 错误/FocusMode 静态加载/每秒 IDB 写入/同步服务急切初始化/Budget 过高 |
| 🟢 警告 | 3 | namedChunks 生产未关/字体 prefetch 浪费/构建依赖错放 |

### 致命发现：页面完全卡死

在性能录制完成后，**页面进入完全无响应状态**：
- `evaluate_script` 超时：无法执行任何 JavaScript
- `take_snapshot` 超时：无法获取 accessibility tree
- `take_screenshot` 失败：Internal error
- 重新加载页面超时（10s 内无响应，30s 后勉强重载）
- **新建标签页打开同一 URL 也会卡死**

这是一个**致命的运行时性能问题**，表明存在 Main Thread 长期阻塞或无限循环。

---

## 2. Core Web Vitals 评分

### 实验室指标 (Lab Data)

| 指标 | 值 | 评估 | 目标 |
|------|-----|------|------|
| **CLS** (Cumulative Layout Shift) | **0.00** | ✅ 优秀 | < 0.1 |
| **LCP** (Largest Contentful Paint) | 未能测量 | ❌ 页面卡死 | < 2.5s |
| **INP** (Interaction to Next Paint) | 未能测量 | ❌ 页面卡死 | < 200ms |
| **FCP** (First Contentful Paint) | 未能测量 | ❌ 页面卡死 | < 1.8s |
| **TTFB** (Time to First Byte) | 未能测量 | ❌ 页面卡死 | < 800ms |

> CrUX 真实用户数据：**无数据**（尚未收录到 Chrome User Experience Report）

### Trace 录制窗口

| 属性 | 值 |
|------|-----|
| 录制时长 | ~5.0s (25286114822 → 25291833767 µs) |
| 导航 URL | `https://dde-eight.vercel.app/#/projects` |
| CPU 节流 | 无 |
| 网络节流 | 无 |

---

## 3. 网络请求分析

### 请求总览

| 类别 | 数量 | 说明 |
|------|------|------|
| HTML 文档 | 1 | `index.html` (12,186 bytes br) |
| CSS 样式表 | 2 | `styles-*.css` (19,195 B) + `lxgw-wenkai-screen.css` (5,907 B) |
| JavaScript | 23 | main + polyfills + 21 chunks |
| 字体文件 | 7 | LXGW WenKai Screen 子集 (woff2) |
| API 请求 | 2 | Supabase REST API (均 **401 失败**) |
| Manifest | 1 | `manifest.webmanifest` (**pending 卡住**) |
| **总计** | **36** | |

### JavaScript Chunk 传输大小

| 文件 | 压缩大小 (bytes) | 类型 | 加载阶段 |
|------|-------------------|------|----------|
| `main-JWXSOBPV.js` | **173,938** (170KB) | 主包 | 阻塞 |
| `styles-6BNJ5VFR.css` | **19,195** (19KB) | 样式 | 阻塞 |
| `chunk-SNMFP53O.js` | **14,361** (14KB) | 依赖 chunk | 预加载 |
| `polyfills-E6HVSKTL.js` | **13,171** (13KB) | polyfills | 阻塞 |
| `project-shell.component-DOX676BV.js` | **8,181** (8KB) | 路由懒加载 | 导航后 |
| `chunk-OGZDGGUX.js` | 5,012 | 依赖 chunk | 预加载 |
| `chunk-2UBXLB7N.js` | 2,886 | 依赖 chunk | 预加载 |
| `chunk-AOWKABWN.js` | 1,701 | 依赖 chunk | 预加载 |
| `chunk-C6B2DRSA.js` | **⚠️ PENDING** | 疑似 GoJS | 卡住 |

### 关键发现

1. **`main.js` 体积偏大 (170KB br)**：解压后预估 ~600-800KB，包含 Angular Runtime + AppComponent + FocusModeComponent + Supabase Client
2. **`chunk-C6B2DRSA.js` 永久 PENDING**：由 `project-shell.component` 发起请求，但始终未完成下载。这极可能是**页面卡死的直接原因**
3. **Supabase API 均 401**：`get_server_time` 和 `projects` 列表请求均返回 401，但不影响页面渲染（Offline-first 策略从 IndexedDB 加载）

### 请求瀑布流分析

```
Timeline (ms):  0                500              1000             1500             2000
                |                 |                 |                 |                |
index.html      ████             |                 |                 |                |
fonts/css       ░░████           |                 |                 |                |
styles.css       ░░████          |                 |                 |                |
chunks (10x)     ░░░░████████████|                 |                 |                |
polyfills.js      ░░░████        |                 |                 |                |
main.js           ░░░░░████████████████            |                 |                |
font-118/117       ░░░░░░████    |                 |                 |                |
lazy chunks         ░░░░░░░░░████████              |                 |                |
project-shell        ░░░░░░░░░░░████               |                 |                |
chunk-C6B2DRSA       ░░░░░░░░░░░░░████████████████████████████ ... PENDING ⛔
Supabase APIs         ░░░░░░░░░░░░░░██ (401)       |                 |                |
font-116/115/114       ░░░░░░░░░░░░░░░████         |                 |                |

████ = 下载中  ░░░ = 等待/排队  ⛔ = 卡住
```

---

## 4. JavaScript Bundle 分析

### 依赖体积预估

| 依赖 | Minified + Gzip 预估 | Tree-shaking 有效? | 进入 main bundle? |
|------|----------------------|--------------------|--------------------|
| **GoJS** 3.1.x | ~250-350KB | ❌ (单一模块) | 部分泄漏可能 |
| **@supabase/supabase-js** | ~50-80KB | 部分 | ✅ 是 |
| **Angular Runtime** | ~50-60KB | ✅ | ✅ 是 |
| **@sentry/angular** | ~40-80KB | ✅ | ❌ 懒加载 |
| **Zone.js** | ~13KB | ❌ | ✅ polyfills |
| **rxjs** | ~10-20KB | ✅ tree-shake | ✅ 是 |
| **DOMPurify** | ~10KB | ❌ | ✅ 是 |
| **idb-keyval** | ~1KB | ✅ | ✅ 是 |

### Bundle 分块策略

| Chunk 类型 | 策略 | 评估 |
|------------|------|------|
| main.js | 入口包 | 🟡 170KB br 偏大 |
| polyfills.js | Zone.js | ✅ 13KB 合理 |
| project-shell.js | 路由懒加载 | ✅ 8KB 合理 |
| chunk-C6B2DRSA.js | 疑似 GoJS 懒加载 | ⛔ 下载卡住 |
| 其他 chunks | esbuild 自动分割 | ✅ 粒度合理 |

### `inject-modulepreload.cjs` 排除规则

```javascript
const EXCLUDED_PATTERNS = [
  /sentry/i,      // Sentry 懒加载
  /worker/i,      // Web Worker
  /chunk-[A-Z0-9]+-gojs/i,  // GoJS chunk
  /^flow-/i,      // Flow 视图
  /^text-/i,      // Text 视图
  /^index-/i,     // 索引
  /project-shell/i,  // 项目 Shell
  /reset-password/i  // 重置密码
];
```

> ✅ GoJS chunk 被正确排除在 modulepreload 之外  
> ⚠️ 但 esbuild 生成的 chunk 名可能不匹配 `chunk-XXX-gojs` 正则，需要验证

---

## 5. 关键渲染路径分析

### HTML Head 资源加载顺序

| # | 资源 | 类型 | 阻塞渲染? | 大小 |
|---|------|------|-----------|------|
| 1 | CSP / theme-color meta | meta | ❌ | - |
| 2 | Preconnect jsdelivr + Supabase | link | ❌ | - |
| 3 | DNS-prefetch Sentry | link | ❌ | - |
| 4 | **Preload font-119** | link | ❌ (高优先级) | 36KB |
| 5 | Prefetch font-118, font-117 | link | ❌ | 100KB |
| 6 | **内联 CSS (@font-face + 骨架屏)** | `<style>` | **✅ 阻塞** | ~8KB |
| 7 | 异步字体 CSS | link media="print" | ❌ | - |
| 8 | **Anti-FOUC 脚本** | `<script>` | **✅ 阻塞** | ~0.5KB |
| 9 | **数据预加载脚本** | `<script>` | **✅ 阻塞** | ~3KB |
| 10 | 调试脚本 | `<script>` | **✅ 阻塞** | ~0.2KB |
| 11 | **骨架屏 CSS (~300行)** | `<style>` | **✅ 阻塞** | ~15KB |
| 12 | manifest / icon | link | ❌ | - |

### 阻塞渲染的资源总计

- **内联 CSS**: ~23KB (字体声明 + 骨架屏样式)
- **同步脚本**: ~4KB (Anti-FOUC + 数据预加载定义 + 调试)
- **Angular main.js**: 170KB (br) → ~600-800KB (解压后解析执行)

### 首屏关键路径时序 (预估)

```
0ms      HTML 解析完成 (12KB br → ~30KB)
5ms      内联 CSS 解析 (23KB)
8ms      Anti-FOUC 脚本执行 (读取 localStorage → 设置 dark class)
15ms     骨架屏渲染 ← FCP 目标点
~200ms   main.js 下载完成 (170KB br, CDN)
~400ms   main.js 解析 + 执行 (600-800KB JS)
~450ms   Angular bootstrapApplication 开始
         ├── APP_INITIALIZER (Sentry 非阻塞 ✅)
         ├── AppComponent 实例化
         │    ├── SyncCoordinatorService 构造 → 启动 1s 定时器
         │    │    └── 级联创建 10+ 子服务
         │    └── FocusModeComponent 静态加载 ⚠️
         └── Router 初始化
~500ms   导航到 /projects → 懒加载 project-shell.js (8KB)
~600ms   ProjectShellComponent 加载 → 触发 @defer
~700ms   chunk-C6B2DRSA.js 请求发出...⛔ PENDING
         ↓↓↓ 页面卡在这里 ↓↓↓
```

---

## 6. 运行时性能分析

### Performance Trace 发现

#### 6.1 第三方脚本影响

| 第三方 | 传输大小 | 主线程时间 | 影响 |
|--------|----------|-----------|------|
| supabase.co | 396 B | 0ms | ✅ 极小 |

> ✅ 第三方脚本影响极小，Supabase REST API 仅传输少量响应头

#### 6.2 强制回流 (Forced Reflow)

| 问题 | 耗时 | 来源 |
|------|------|------|
| 未归因的强制回流 | **38ms** | [unattributed] |

> 38ms 的强制回流发生在某个未能归因的调用栈中。虽然单次 38ms 不严重，但如果在交互过程中频繁触发，会导致 jank。

#### 6.3 页面卡死的 Main Thread 分析

在页面登录成功加载后，观察到：
- **所有 Chrome DevTools Protocol 调用超时**（包括 `Runtime.evaluate`、`Accessibility.getFullAXTree`、`Page.captureScreenshot`）
- 这意味着 **Main Thread 被完全阻塞**，无法处理任何 CDP 消息
- 阻塞持续 **超过 30 秒以上**（多次重试均超时）

### 定时器与轮询分析

| 定时器 | 服务 | 间隔 | 风险 |
|--------|------|------|------|
| `setInterval` 本地自动保存 | `SyncCoordinatorService` | **1000ms** | 🟡 每秒写 IndexedDB |
| `setInterval` 请求缓存清理 | `RequestThrottleService` | 10000ms | 🟢 低 |
| `setInterval` Tab 心跳 | `TabSyncService` | 动态 | 🟢 低 |
| `setTimeout` 指数退避重试 | 多个同步服务 | 动态 | 🟢 合理 |

---

## 7. 源码级深度分析

### 7.1 🔴 GoJS 桌面端"懒加载无效"问题

**位置**: `src/app/core/shell/project-shell.component.ts` L211-L232

```html
<!-- 桌面端：Flow Column 始终可见 -->
@if (!uiState.isMobile() || uiState.activeView() === 'flow') {
  <div class="flow-column">
    @defer (on viewport; prefetch on idle) {
      <app-flow-view ...></app-flow-view>
    }
  </div>
}
```

**问题**: 桌面端 `.flow-column` 始终在 DOM 中且始终可见，`@defer (on viewport)` 会在页面加载后 **立即触发**，等同于立即加载整个 GoJS (~800KB 未压缩)。

**影响**: GoJS 的下载、解析、实例化全部进入首屏关键路径，阻塞 LCP。

### 7.2 🔴 GoJS 服务全部 `providedIn: 'root'`

以下 20+ 个 Flow 服务均使用 `providedIn: 'root'`，且顶部有 `import * as go from 'gojs'`：

| 服务 | import gojs |
|------|-------------|
| `FlowDiagramService` | ✅ |
| `FlowTemplateService` | ✅ |
| `FlowSelectionService` | ✅ |
| `FlowZoomService` | ✅ |
| `FlowEventService` | ✅ |
| `FlowTouchService` | ✅ |
| `FlowLayoutService` | ✅ |
| `FlowLinkService` | ✅ |
| `FlowDragDropService` | ✅ |
| ...其他 10+ 服务 | ✅ |

**额外泄漏路径**: `src/models/gojs-boundary.ts` L21 有 `import * as go from 'gojs'`。如果它被 `models/index.ts` barrel 导出且被 eagerly loaded 的代码引用，GoJS 会被拉入 main bundle。

### 7.3 🟡 FocusModeComponent 静态加载

**位置**: `src/app.component.ts` L42

```typescript
@Component({
  imports: [
    // ...
    FocusModeComponent,  // ⚠️ 静态导入
  ]
})
export class AppComponent { ... }
```

FocusModeComponent 及其依赖（GateService、SpotlightService、BlackBoxService、StrataService 等）全部进入 main bundle，增加首屏 JS 解析时间。

### 7.4 🟡 SyncCoordinatorService 急切初始化

**位置**: `src/services/sync-coordinator.service.ts` L189-L205

```typescript
constructor() {
  this.actionQueueProcessors.setupProcessors();  // 注册 7+ 处理器
  this.validateRequiredProcessors();              // 验证
  this.startLocalAutosave();                      // ⚠️ 启动 1s 定时器
  this.setupSyncModeCallback();                   // 同步回调
}
```

`startLocalAutosave()` (L380) 启动 `setInterval` 每 **1000ms** 执行 `saveOfflineSnapshot`（写入 IndexedDB）。且触发级联创建 10+ 子服务：
- `SimpleSyncService`
- `ActionQueueService`
- `DeltaSyncCoordinatorService`
- `BatchSyncService`
- `RetryQueueService`
- `SessionManagerService`
- `SyncStateService`
- ...等

### 7.5 🟡 FlowViewComponent 注入 22 个服务

**位置**: `src/app/features/flow/components/flow-view.component.ts` L84-L110

该组件是整个应用中**注入最多服务的组件**。一旦 `@defer` 触发实例化，会同时创建和初始化所有服务。

### 7.6 FlowDiagramService.initialize() 重量级初始化

**位置**: `src/app/features/flow/services/flow-diagram.service.ts` L127-L221

初始化流程：
1. 检查 GoJS 可用性
2. 设置 GoJS License
3. **创建 `go.Diagram` 实例** (CPU 密集 — 内部创建 Canvas + ToolManager)
4. 配置 contextMenuTool
5. 设置 node/link 模板 (复杂的 `go.GraphObject.make()` 调用链)
6. 配置桌面端/移动端交互工具
7. 初始化 GraphLinksModel
8. 设置删除键拦截
9. 设置事件监听
10. 设置 ResizeObserver
11. 恢复视图状态
12. 传递 diagram 给 6 个子服务
13. 设置画布背景色

---

## 8. API 请求与后端交互

### 登录后 API 请求

| 请求 | 方法 | 状态 | 响应时间 |
|------|------|------|----------|
| `/rest/v1/rpc/get_server_time` | POST | **401 Unauthorized** | ~500ms |
| `/rest/v1/projects?select=id,title,updated_at&order=updated_at.desc` | GET | **401 Unauthorized** | ~500ms |

### 401 错误分析

两个请求均携带了有效的 Authorization Bearer Token (JWT)：
- `iss`: Supabase Auth
- `sub`: `f413335a-68b8-4894-b383-c6e227551bbd`
- `email`: `1@qq.com`
- `exp`: `1770471323` (有效期内)
- `role`: `authenticated`

**但服务器返回 401**。可能原因：
1. **JWT Token 与 RLS 策略不匹配**：`get_server_time` RPC 可能需要特定权限
2. **Supabase 项目配置变更**：API key 或 JWT 密钥可能已更新
3. **Token 时间戳漂移**：客户端和服务器时钟不同步

### 影响评估

由于采用 Offline-first 架构，401 错误**不影响页面渲染**（从 IndexedDB 读取本地数据），但会：
- 阻止云端同步
- 产生控制台错误日志
- 可能触发 RetryQueue 反复重试

---

## 9. 字体加载策略评估

### 策略总览

| 策略 | 实施 | 评估 |
|------|------|------|
| 自托管字体 | ✅ | 避免外部 CDN 延迟 |
| Unicode Range 子集化 | ✅ 14 子集 | 按需加载字符集 |
| `font-display: swap` | ✅ 所有 @font-face | 避免 FOIT |
| `size-adjust: 105%` | ✅ | 减少 FOUT 布局偏移 |
| Preload 最高频子集 | ✅ subset-119 (36KB) | 确保首帧字体可用 |
| Prefetch 次高频子集 | ✅ subset-118, 117 | 后台预加载 |
| 异步加载其余子集 | ✅ `media="print" onload` | 完全非阻塞 |

### 字体文件清单

| 子集 | 大小 | 加载方式 |
|------|------|----------|
| subset-119 | 36KB | 🔴 Preload |
| subset-118 | 47KB | 🟡 Prefetch |
| subset-117 | 53KB | 🟡 Prefetch |
| subset-116 | — | 🟢 异步 CSS |
| subset-115 | — | 🟢 异步 CSS |
| subset-114 | — | 🟢 异步 CSS |
| 其余 8 子集 | ~500KB 合计 | 🟢 异步 CSS |
| **总计** | ~**784KB** | |

### 评估: ✅ 优秀

字体加载策略是整个应用中**做得最好的部分**，采用了业界最佳实践的组合。

---

## 10. Service Worker 矛盾问题

### 问题描述

**注册 SW** (`main.ts` L244-L249):
```typescript
provideServiceWorker('ngsw-worker.js', {
  enabled: !isDevMode(),
  registrationStrategy: 'registerWhenStable:30000'
})
```

**注销所有 SW** (`main.ts` L283-L292):
```typescript
// runPostBootstrapMaintenance → unregisterAllServiceWorkers
async function unregisterAllServiceWorkers() {
  const registrations = await navigator.serviceWorker.getRegistrations();
  await Promise.all(registrations.map(reg => reg.unregister()));
}
```

### 矛盾链路

```
Angular stabilize
  → 注册 ngsw-worker.js
    → SW install 事件
      → 预取所有 ngsw-config.json 中定义的资产:
        - 14 个字体文件 (784KB)
        - 所有 JS chunks
        - styles.css
  → ⏳ 空闲时
    → unregisterAllServiceWorkers()
      → 所有 SW 注销
      → 缓存可能被清除
```

### 影响

1. **浪费带宽**: SW 安装时 prefetch 大量资源 (~2MB+)，之后被注销
2. **ngsw-config.json 配置**: `installMode: "prefetch"` 对所有资源，进一步加剧浪费
3. **用户困惑**: SW 生命周期不稳定可能导致缓存行为不可预测

---

## 11. 页面卡死根因分析

### 现象

登录成功后，页面短暂显示项目数据（可看到任务列表），随后 **Main Thread 完全阻塞**：
- 无法执行任何 JavaScript (evaluate_script 超时)
- 无法获取 DOM 信息 (take_snapshot 超时)
- 无法截图 (take_screenshot Internal Error)
- 页面刷新超时 (10s+)
- 新标签页打开同 URL 也卡死

### 可能根因分析 (按可能性排序)

#### 假设 1: GoJS chunk 加载卡住导致 JS 执行阻塞 (🔴 最可能)

证据：
- `chunk-C6B2DRSA.js` 持续处于 **PENDING** 状态
- 该 chunk 由 `project-shell.component` 发起，由 `@defer (on viewport)` 触发
- 桌面端 Flow Column 始终可见 → `@defer` 立即触发 → 等待 chunk 下载
- 如果该 chunk 是 GoJS 库（~800KB），CDN 超时或网络波动可能导致长时间等待
- **Angular 的 `@defer` 内部可能在等待 chunk 加载完成时阻塞了变更检测循环**

#### 假设 2: 无限循环的 Signal effect (🟡 可能)

证据：
- `FlowDiagramEffectsService` 注册了 7 个 effect (tasks/connections/search/theme/selection/center/retry)
- 如果某个 effect 的触发导致 signal 更新，可能形成环形依赖 → 无限循环
- `SyncCoordinatorService` 每 1s 执行 `saveOfflineSnapshot`，可能触发 signal 更新

#### 假设 3: Supabase Realtime 重连风暴 (🟡 可能)

证据：
- 401 API 错误可能触发认证重刷
- 认证重刷可能触发重新加载项目数据
- 数据加载可能触发 Signal 更新 → FlowDiagram 重绘 → 触发更多 effect

#### 假设 4: IndexedDB 锁竞争 (🟢 低可能)

证据：
- 每秒 setInterval 写入 IndexedDB
- 多个服务可能同时读写 IndexedDB
- 但 IndexedDB 操作是异步的，通常不会阻塞 Main Thread

### 综合诊断

最可能的场景是 **假设 1 + 假设 2 的组合**：
1. GoJS chunk 加载缓慢/卡住
2. 页面仍尝试初始化 FlowDiagram
3. Signal effects 在等待 GoJS 可用和处理数据之间形成死锁或无限循环
4. Main Thread 完全被占用

---

## 12. 问题严重性分级

### 🔴 致命 (P0) — 必须立即修复

| # | 问题 | 位置 | 影响 |
|---|------|------|------|
| P0-1 | **页面卡死** — Main Thread 完全阻塞超过 30s | 运行时 | 用户无法使用应用 |
| P0-2 | **GoJS 桌面端无效懒加载** — `@defer(on viewport)` 等同立即加载 | `project-shell.component.ts` L211-L232 | ~800KB JS 进入首屏路径 |
| P0-3 | **Service Worker 注册/注销矛盾** — 注册后空闲时注销 | `main.ts` L244 vs L283 | 浪费 ~2MB 带宽 |

### 🟡 严重 (P1) — 需要尽快修复

| # | 问题 | 位置 | 影响 |
|---|------|------|------|
| P1-1 | **Supabase API 401 错误** — 登录后 API 请求全部失败 | 运行时 | 云端同步不可用 |
| P1-2 | **FocusModeComponent 静态加载** — 进入 main bundle | `app.component.ts` L42 | 增加首屏 JS 体积 |
| P1-3 | **每秒 IndexedDB 写入** — 1000ms setInterval | `sync-coordinator.service.ts` L380 | CPU/IO 占用 |
| P1-4 | **SyncCoordinator 急切初始化** — 构造函数中启动定时器 | `sync-coordinator.service.ts` L189 | 级联创建 10+ 子服务 |
| P1-5 | **Budget 阈值过高** — initial 2.5MB error | `angular.json` L54-L65 | 无法有效约束体积 |

### 🟢 警告 (P2) — 建议优化

| # | 问题 | 位置 | 影响 |
|---|------|------|------|
| P2-1 | **namedChunks 生产未关** — chunk 文件名泄露组件信息 | `angular.json` | 安全+体积微增 |
| P2-2 | **ngsw-config fonts prefetch** — 784KB 字体在 SW 安装时预取 | `ngsw-config.json` L33-L40 | 浪费带宽 |
| P2-3 | **构建依赖错放 dependencies** — @angular/build, @angular/cli 等 | `package.json` | Docker 镜像增大 |

---

## 13. 优化建议清单

### P0-1: 修复页面卡死

```
1. 调查 chunk-C6B2DRSA.js 的内容和加载失败原因
2. 为 @defer 添加 loading/error 模板，避免 chunk 加载失败导致状态不一致
3. 在 FlowDiagramEffectsService 的 effects 中添加 guard 条件，
   确保 GoJS diagram 已初始化后才执行数据同步
4. 添加 effect 执行次数监控，检测无限循环
```

### P0-2: 修复 GoJS 桌面端懒加载

**当前**:
```html
@defer (on viewport; prefetch on idle) {
  <app-flow-view></app-flow-view>
}
```

**建议**:
```html
<!-- 选项 A: 用户交互触发 -->
@defer (on interaction(flowColumn); prefetch on idle) {
  <app-flow-view></app-flow-view>
} @placeholder {
  <flow-placeholder></flow-placeholder>
}

<!-- 选项 B: 空闲时加载但不阻塞首屏 -->
@defer (on idle; prefetch on idle) {
  <app-flow-view></app-flow-view>
} @placeholder {
  <flow-placeholder></flow-placeholder>
} @loading (minimum 200ms) {
  <flow-skeleton></flow-skeleton>
} @error {
  <flow-error-fallback></flow-error-fallback>
}
```

### P0-3: 解决 Service Worker 矛盾

```typescript
// 方案 A: 移除 SW (推荐，如不需要离线缓存)
// 删除 provideServiceWorker() 调用
// 删除 unregisterAllServiceWorkers() 调用
// 删除 ngsw-config.json

// 方案 B: 保留 SW 但移除注销逻辑
// 删除 runPostBootstrapMaintenance 中的 unregisterAllServiceWorkers
// 将 ngsw-config fonts 改为 installMode: "lazy"
```

### P1-2: FocusModeComponent 改为懒加载

```html
<!-- app.component.html -->
@defer (when focusPreferences.enabled(); prefetch on idle) {
  <app-focus-mode></app-focus-mode>
} @placeholder {
  <!-- 空 -->
}
```

### P1-3/P1-4: 同步服务延迟初始化

```typescript
// sync-coordinator.service.ts
constructor() {
  // 仅注册处理器，不启动定时器
  this.actionQueueProcessors.setupProcessors();
  this.validateRequiredProcessors();
}

// 认证完成后才启动
startSync() {
  this.startLocalAutosave();  // 改为 3s debounce 而非 1s interval
  this.setupSyncModeCallback();
}
```

### P1-5: 收紧 Budget

```json
{
  "budgets": [
    { "type": "initial", "maximumWarning": "800kb", "maximumError": "1.2mb" },
    { "type": "anyComponentStyle", "maximumWarning": "8kb", "maximumError": "16kb" }
  ]
}
```

---

## 14. 附录：原始数据

### A. 控制台消息

| 级别 | 消息 |
|------|------|
| `log` | `[NanoFlow] Main.ts Loaded: 2025-12-04-v19-TOGGLE-ALIGN` |
| `issue` | `A form field element should have an id or name attribute` |
| `error` | `Failed to load resource: the server responded with a status of 401 ()` (x2) |

### B. HTTP 缓存策略

| 资源类型 | Cache-Control | 评估 |
|----------|---------------|------|
| HTML (index.html) | `public, max-age=0, must-revalidate, s-maxage=600, stale-while-revalidate=86400` | ✅ 合理 |
| JS chunks | `public, max-age=31536000, immutable` | ✅ 长期缓存 + 哈希 |
| CSS | `public, max-age=31536000, immutable` | ✅ 长期缓存 + 哈希 |
| Fonts (woff2) | `public, max-age=31536000, immutable` | ✅ 长期缓存 |
| Supabase API | 无缓存 | ✅ 动态 API 不缓存 |

### C. CDN 性能

| 指标 | 值 |
|------|-----|
| CDN 提供商 | Vercel Edge Network |
| 缓存命中 | 所有静态资源均为 `x-vercel-cache: HIT` |
| 边缘节点 | `bom1` (孟买) |
| 协议 | HTTP/2 (h2) |
| 压缩 | Brotli (br) |

### D. 安全头部

| 头部 | 值 | 评估 |
|------|-----|------|
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains; preload` | ✅ |
| `X-Content-Type-Options` | `nosniff` | ✅ |
| `X-Frame-Options` | `SAMEORIGIN` | ✅ |
| `X-XSS-Protection` | `1; mode=block` | ✅ (虽已废弃但无害) |

### E. 生产依赖列表

| 依赖 | 版本 | 分类 |
|------|------|------|
| @angular/core | ^19.2.18 | 框架 |
| @angular/common | ^19.2.18 | 框架 |
| @angular/compiler | ^19.2.18 | 框架 |
| @angular/forms | ^19.2.18 | 框架 |
| @angular/platform-browser | ^19.2.18 | 框架 |
| @angular/platform-browser-dynamic | ^19.2.18 | 框架 |
| @angular/router | ^19.2.18 | 框架 |
| @angular/service-worker | ^19.2.18 | 框架 |
| @sentry/angular | ^10.32.1 | 监控 |
| @supabase/supabase-js | ^2.84.0 | 后端 |
| gojs | ^3.1.1 | 流程图 |
| dompurify | ^3.3.1 | 安全 |
| idb-keyval | ^6.2.2 | 离线存储 |
| rxjs | ^7.8.2 | 响应式 |
| web-vitals | ^5.1.0 | 性能指标 |
| zone.js | ^0.15.0 | Angular |
| **@angular/build** | ^19.2.18 | ⚠️ 应为 devDep |
| **@angular/cli** | ^19.2.18 | ⚠️ 应为 devDep |
| **@angular/compiler-cli** | ^19.2.18 | ⚠️ 应为 devDep |
| **dotenv** | ^17.2.3 | ⚠️ 应为 devDep |
| **esbuild** | 0.25.4 | ⚠️ 应为 devDep |

---

## 总结

NanoFlow 应用存在一个 **致命的页面卡死问题**，根因最可能是 GoJS chunk 加载失败/超时与 Signal effects 的组合导致 Main Thread 死锁。

字体加载策略、Sentry 懒加载、路由懒加载、骨架屏等方面做得**非常出色**，但 GoJS 桌面端懒加载策略失效、Service Worker 矛盾、FocusModeComponent 静态加载等问题严重抵消了这些优化效果。

**最优先修复项**: 调查并修复页面卡死问题（P0-1），然后修复 GoJS 桌面端懒加载（P0-2）。
