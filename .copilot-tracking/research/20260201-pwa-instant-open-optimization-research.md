<!-- markdownlint-disable-file -->

# Task Research Notes: PWA "Instant Open" 性能优化深度研究

**研究日期**: 2026-02-01  
**研究员**: Task Researcher  
**状态**: ✅ 研究完成

---

## Research Executed

### File Analysis

- [tailwind.config.js](tailwind.config.js)
  - **关键发现**: `font-sans` 默认配置为 `["LXGW WenKai Screen", "sans-serif"]`
  - **影响**: 整个应用的 `font-sans` 类都会触发 LXGW 字体加载

- [index.html](index.html) (L1-200)
  - **发现 1**: 已内联关键 @font-face 定义（subset-117, 118, 119）
  - **发现 2**: 已配置 `font-display: swap`
  - **发现 3**: 已使用 preload 预加载 3 个关键字体子集
  - **发现 4**: 已实现骨架屏 CSS（内联在 `<style>` 标签中）
  - **发现 5**: 字体样式表使用 `media="print" onload="this.media='all'"` 异步加载

- [ngsw-config.json](ngsw-config.json)
  - **发现 1**: `installMode: "prefetch"` 已正确配置
  - **发现 2**: jsdelivr CDN 字体已配置 `performance` 策略 + 365天缓存
  - **发现 3**: Supabase API 使用 `freshness` 策略 + 5分钟缓存

- [src/services/auth.service.ts](src/services/auth.service.ts) (L1-200)
  - **发现 1**: `isCheckingSession` 初始值已改为 `false`（优化于 2026-01-31）
  - **发现 2**: checkSession() 有 10 秒超时保护
  - **发现 3**: 开发环境支持自动登录

- [src/services/guards/auth.guard.ts](src/services/guards/auth.guard.ts)
  - **发现 1**: 本地模式立即放行（无需等待会话检查）
  - **发现 2**: waitForSessionCheck 有超时保护并支持超时后放行
  - **发现 3**: 离线缓存认证支持 7 天有效期

- [src/app/core/shell/project-shell.component.ts](src/app/core/shell/project-shell.component.ts) (L170-250)
  - **发现 1**: TextViewComponent 使用 `@defer (on immediate)` 立即加载
  - **发现 2**: FlowViewComponent 使用 `@defer (on viewport; prefetch on idle)` 懒加载
  - **关键**: GoJS 已正确配置为视口触发加载，不会阻塞首屏

### Performance Trace Analysis

**测量数据 (2026-02-01)**:

| 指标 | 值 | 评级 |
|------|-----|------|
| LCP | 1,943 ms | ⚠️ 需改进 |
| CLS | 0.00 | ✅ 优秀 |
| TTFB | 71 ms | ✅ 优秀 |

**LCP 分解**:

| 阶段 | 耗时 | 占比 |
|------|------|------|
| TTFB | 71 ms | 3.7% |
| **Render Delay** | **1,872 ms** | **96.3%** |

**LCP 元素**: `<H1 class='font-bold text-stone-800 dark:text-stone-100 tracking-tight font-serif'>`

### Code Search Results

- `font-serif` / `fontFamily`
  - [app.component.html](src/app.component.html#L118): 使用 `font-serif` 类
  - [tailwind.config.js](tailwind.config.js#L11): 定义 fontFamily 配置
  - **关键发现**: `font-serif` 是 Tailwind 内置类，非 LXGW 字体

- `LXGW WenKai Screen`
  - [flow-diagram-config.service.ts](src/app/features/flow/services/flow-diagram-config.service.ts): GoJS 节点使用 LXGW 字体
  - [flow-template.service.ts](src/app/features/flow/services/flow-template.service.ts): GoJS 模板使用 LXGW 字体
  - [text-view-drag-drop.service.ts](src/app/features/text/services/text-view-drag-drop.service.ts#L533): 拖拽预览使用 LXGW 字体

- `@defer` 使用情况
  - [project-shell.component.ts](src/app/core/shell/project-shell.component.ts#L181): TextViewComponent `@defer (on immediate)`
  - [project-shell.component.ts](src/app/core/shell/project-shell.component.ts#L232): FlowViewComponent `@defer (on viewport; prefetch on idle)`
  - [mobile-drawer-container.component.ts](src/app/features/flow/components/mobile-drawer-container.component.ts#L53): 移动端抽屉 `@defer (when condition)`

- `ResizeObserver` / 强制重排
  - [reactive-minimap.service.ts](src/app/features/flow/services/reactive-minimap.service.ts#L143): 使用 ResizeObserver 缓存尺寸
  - [flow-overview.service.ts](src/app/features/flow/services/flow-overview.service.ts#L300): ResizeObserver 管理
  - **已优化**: 代码中已使用 ResizeObserver 替代直接读取几何属性

### External Research

- #context7:"/websites/angular_dev" "@defer lazy loading performance"
  - Angular `@defer` 默认触发器为 `on idle`（浏览器空闲时）
  - 支持 `on viewport`、`on interaction`、`on immediate` 等触发器
  - `prefetch on idle` 可在空闲时预取但不执行

- #context7:"/websites/angular_dev" "service worker ngsw-config"
  - `installMode: "prefetch"` - 安装时预取所有资源
  - `updateMode: "prefetch"` - 更新时立即下载新资源
  - `registrationStrategy: "registerWhenStable:30000"` - 30秒后稳定时注册

### Project Conventions

- Standards referenced: [AGENTS.md](AGENTS.md), [copilot-instructions.md](.github/copilot-instructions.md)
- Instructions followed: [frontend.instructions.md](.github/instructions/frontend.instructions.md)

---

## Key Discoveries

### 1. 原假设验证结果

| 假设 | 验证结果 | 证据 |
|------|----------|------|
| Auth 阻塞导致慢 | ❌ **错误** | TTFB 71ms，isCheckingSession 初始 false |
| 网络等待是瓶颈 | ❌ **错误** | Service Worker 缓存已配置，资源从缓存加载 |
| 字体 FOIT 导致 LCP 延迟 | ⚠️ **部分正确** | 已配置 font-display: swap，但 1.2MB 字体仍需下载 |
| GoJS 阻塞首屏 | ❌ **错误** | 已使用 `@defer (on viewport)` 懒加载 |

### 2. 真正的瓶颈：Render Delay (1,872 ms)

**根本原因分析**:

1. **LCP 元素是 `<H1>` 标题**
   - 使用 `font-serif` 类（Tailwind 内置，非 LXGW）
   - 但 Tailwind 配置将 `font-sans` 设为 LXGW，可能影响其他元素

2. **96.3% 的 LCP 时间在 Render Delay**
   - 不是 TTFB（服务器响应快）
   - 不是资源下载（字体已预加载/缓存）
   - **是 JavaScript 执行和 Angular Hydration 时间**

3. **360 ms 布局更新**
   - DOM 结构：342 元素，23 层深度
   - 布局更新涉及 155-263 个节点
   - **主要来源**: Sentry SDK 初始化时的 DOM 检测（非 GoJS）

4. **Sentry SDK 贡献**
   - 性能报告显示 `chunk-5AFAIXVJ.js` (Sentry) 导致 320 ms 强制重排
   - 这是主要的布局抖动来源

### 3. 已实施的优化措施（项目现状）

| 优化项 | 状态 | 位置 |
|--------|------|------|
| font-display: swap | ✅ 已实施 | index.html 内联 @font-face |
| 关键字体 preload | ✅ 已实施 | index.html 3 个 woff2 预加载 |
| 字体样式异步加载 | ✅ 已实施 | media="print" 技巧 |
| Service Worker 缓存 | ✅ 已配置 | ngsw-config.json |
| GoJS 懒加载 | ✅ 已实施 | @defer (on viewport) |
| 骨架屏 | ✅ 已实施 | CSS 内联在 index.html |
| Auth 超时保护 | ✅ 已实施 | 10秒超时 + 立即放行 |
| 本地模式立即放行 | ✅ 已实施 | Guard 直接返回 true |
| RPC 批量加载 | ✅ 已实施 | get_full_project_data |

### 4. 尚未实施的优化项

| 优化项 | 状态 | 预期收益 | 复杂度 |
|--------|------|----------|--------|
| Sentry SDK 懒加载 | ❌ 未实施 | -200~300 ms | 中 |
| 关键 CSS 内联 | ⚠️ 部分 | -50~100 ms | 低 |
| SSR/SSG | ❌ 未实施 | -500~800 ms | 高 |
| 字体自托管 | ❌ 未实施 | 缓存 +365天 | 中 |
| 减少 JS Chunks | ⚠️ 需评估 | 待测量 | 中 |

---

## Implementation Patterns

### Pattern 1: Angular @defer 最佳实践

```typescript
// 已在项目中正确实现
// FlowViewComponent: 视口触发 + 空闲预取
@defer (on viewport; prefetch on idle) {
  <app-flow-view />
} @placeholder {
  <div class="skeleton-loader">Loading...</div>
}

// TextViewComponent: 立即加载（首屏需要）
@defer (on immediate) {
  <app-text-view />
}
```

### Pattern 2: Service Worker 缓存配置

```json
// 已在 ngsw-config.json 正确配置
{
  "assetGroups": [
    {
      "name": "app",
      "installMode": "prefetch",
      "resources": { "files": ["/*.js", "/*.css"] }
    }
  ],
  "dataGroups": [
    {
      "name": "jsdelivr-cdn-fonts",
      "urls": ["https://cdn.jsdelivr.net/npm/lxgw-wenkai*/**"],
      "cacheConfig": {
        "strategy": "performance",
        "maxAge": "365d"
      }
    }
  ]
}
```

### Pattern 3: 字体加载优化

```html
<!-- 已在 index.html 正确实现 -->
<!-- 1. Preconnect CDN -->
<link rel="preconnect" href="https://cdn.jsdelivr.net">

<!-- 2. Preload 关键字体子集 -->
<link rel="preload" href="...subset-119.woff2" as="font" type="font/woff2" crossorigin>

<!-- 3. 内联 @font-face + font-display: swap -->
<style>
  @font-face {
    font-family: 'LXGW WenKai Screen';
    font-display: swap;
    src: url('...') format('woff2');
    unicode-range: U+20-22, ...;
  }
</style>

<!-- 4. 异步加载完整字体样式表 -->
<link rel="stylesheet" href="...style.css" media="print" onload="this.media='all'">
```

---

## Recommended Approach

### 核心结论

**原方案中需要调整优先级的项目**:

| 原优先级 | 优化项 | 新优先级 | 理由 |
|----------|--------|----------|------|
| P1 | Auth 阻塞优化 | ⬇️ P3 | 已实施，TTFB 71ms |
| P1 | Service Worker 缓存 | ⬇️ P3 | 已正确配置 |
| P2 | font-display: swap | ⬇️ P3 | 已实施 |
| P2 | 字体预加载 | ⬇️ P3 | 已实施 |
| P3 | Sentry SDK 优化 | ⬆️ **P0** | 320ms 强制重排 |
| 未提及 | Angular Hydration 优化 | ⬆️ **P1** | 渲染延迟主因 |

### 推荐的新优化方案

#### P0: Sentry SDK 懒加载 (预期收益: -200~300 ms)

```typescript
// main.ts - 延迟 Sentry 初始化
// 当前：应用启动时同步初始化
// 建议：首屏渲染后异步初始化

// 方案 1: 使用 requestIdleCallback
if (typeof requestIdleCallback !== 'undefined') {
  requestIdleCallback(() => {
    import('@sentry/angular').then(Sentry => {
      Sentry.init({ /* ... */ });
    });
  });
} else {
  setTimeout(() => {
    import('@sentry/angular').then(Sentry => {
      Sentry.init({ /* ... */ });
    });
  }, 2000);
}

// 方案 2: 使用 Angular APP_INITIALIZER 异步
{
  provide: APP_INITIALIZER,
  useFactory: () => () => {
    // 返回空 Promise，不阻塞启动
    // Sentry 在后台初始化
    queueMicrotask(() => initSentry());
  },
  multi: true,
}
```

#### P1: 减少 Initial Bundle Size (预期收益: -100~200 ms)

```typescript
// angular.json - 调整 budgets
{
  "budgets": [
    {
      "type": "initial",
      "maximumWarning": "400kb",  // 从 500kb 降低
      "maximumError": "800kb"    // 从 1mb 降低
    }
  ]
}

// 使用 source-map-explorer 分析
// npm install source-map-explorer
// ng build --source-map
// npx source-map-explorer dist/browser/main-*.js
```

#### P2: 字体资源优化 (预期收益: 感知性能提升)

```css
/* 添加 size-adjust 减少布局偏移 */
@font-face {
  font-family: 'LXGW WenKai Screen';
  font-display: swap;
  size-adjust: 105%;  /* 匹配 fallback 字体尺寸 */
  /* ... */
}
```

#### P3: 考虑 SSR/SSG (长期方案)

对于需要 <500ms LCP 的场景，考虑：
- Angular SSR (Server-Side Rendering)
- 或静态预渲染关键页面

---

## Implementation Guidance

- **Objectives**: 
  1. 将 LCP 从 1,943ms 降至 <1,500ms
  2. 消除 Sentry 导致的 320ms 强制重排
  3. 保持 CLS = 0 的优秀成绩

- **Key Tasks**: 
  1. ✅ 验证现有优化措施（已完成）
  2. 🔄 实施 Sentry SDK 懒加载
  3. 🔄 分析 JS Bundle 组成
  4. 🔄 考虑 SSR 可行性评估

- **Dependencies**: 
  - Sentry SDK 懒加载需要测试错误捕获完整性
  - SSR 需要评估 Supabase 客户端兼容性

- **Success Criteria**: 
  - LCP < 1,500ms (P75)
  - Render Delay < 1,000ms
  - 保持现有功能不受影响

---

## Summary

**原方案评估**: 方向正确，但优先级需要根据实际数据调整。

**关键洞察**: 
1. 项目已实施了大部分推荐的优化措施
2. 真正的瓶颈是 **JavaScript 执行时间**，特别是 Sentry SDK
3. Auth/网络优化已经到位，不再是瓶颈
4. 字体优化已经完成（font-display: swap + preload）

**下一步行动**:
1. **立即**: 实施 Sentry SDK 懒加载
2. **短期**: 分析并优化 JS Bundle 组成
3. **长期**: 评估 SSR/SSG 可行性
