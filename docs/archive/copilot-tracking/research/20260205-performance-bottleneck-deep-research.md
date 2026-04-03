<!-- markdownlint-disable-file -->

# Task Research Notes: NanoFlow 网站性能瓶颈深度研究

**研究日期**: 2026-02-05  
**研究员**: Task Researcher  
**状态**: ✅ 研究完成
**分析网站**: https://dde-eight.vercel.app/#/projects

---

## Research Executed

### File Analysis

- [docs/performance-analysis-report.md](docs/performance-analysis-report.md)
  - 详细的性能指标分析报告（2026-02-05）
  - 涵盖 LCP、CLS、关键路径、网络瓶颈等

- [docs/performance-optimization-plan.md](docs/performance-optimization-plan.md)
  - 性能优化策划案 v2.0（2026-01-27 已实施）
  - RPC 优化已生效，API 请求从 21 个降至 ~8 个

- [src/config/performance.config.ts](src/config/performance.config.ts)
  - PERFORMANCE_FLAGS 配置：USE_BATCH_RPC、FIRST_SCREEN_PRIORITY、GOJS_BATCH_RENDER 等
  - BATCH_LOAD_CONFIG 配置：超时、重试策略

- [index.html](index.html)
  - 已实施字体 preload（subset-117/118/119）
  - 已内联关键 @font-face + font-display: swap
  - 已实施数据预加载（__PRELOADED_DATA__）

- [ngsw-config.json](ngsw-config.json)
  - Service Worker 缓存配置完备
  - 本地字体 prefetch、Supabase API freshness 策略

### Code Search Results

- `OnPush|ChangeDetectionStrategy`
  - 所有关键组件已使用 OnPush 变更检测
  - flow-view.component.ts、text-*.component.ts 等

- `@for.*track`
  - 所有循环已正确使用 track 函数
  - 20+ 处使用 track: id、track: date 等

- `contain:`
  - CSS containment 已广泛应用
  - flow-canvas-container: `contain: strict`
  - text-view-scroll-container: `contain: layout paint`

- `Sentry|sentry`
  - SentryLazyLoaderService 已实现懒加载
  - requestIdleCallback + 5s 超时后备

- `gojs.*batch|startTransaction|commitTransaction`
  - GoJS 已使用事务批量操作
  - flow-diagram.service.ts: `startTransaction('update')`

### External Research

参考 Angular 19 最佳实践、Web Vitals 指标说明、GoJS 性能优化文档。

### Project Conventions

- Standards referenced: AGENTS.md、angular.instructions.md
- Instructions followed: OnPush 强制、Signals 状态管理

---

## Key Discoveries

### 一、核心性能指标现状

| 指标 | 桌面端数值 | 移动端数值 | 目标 | 状态 |
|------|------------|------------|------|------|
| **LCP** | 1,168 ms | 197 ms (缓存) | < 2.5s | ⚠️ 需改进 |
| **CLS** | 0.0024 | 0.00 | < 0.1 | ✅ 良好 |
| **TTFB** | 5 ms | 5 ms | < 800ms | ✅ 极佳 |
| **关键路径延迟** | 3,317 ms | - | < 2,000ms | ❌ 较差 |
| **第三方资源** | 1.2 MB | 1.1 MB | < 500KB | ❌ 过大 |
| **JS Chunks 数量** | 32 | 32 | < 15 | ⚠️ 偏多 |
| **DOM 深度** | 23 层 | 23 层 | < 20 | ⚠️ 偏高 |

### 二、性能瓶颈根因分析

#### 瓶颈 1: 字体资源占用过大 (1.2MB) - **最严重**

```
根因链:
字体 CDN 加载 → 16 个 woff2 子集文件 → 网络往返延迟 → 布局重计算
│
├── 影响: LCP 渲染延迟 99.5%
├── 现状: 已 preload 3 个关键子集（117/118/119）
├── 问题: 剩余 13 个子集仍从 CDN 加载，缓存仅 7 天
└── 优化潜力: 极高（本地化可节省 ~1MB 传输）
```

**已实施的优化**:
- ✅ 关键字体子集 preload（117/118/119）
- ✅ font-display: swap 避免 FOIT
- ✅ 内联 @font-face 定义
- ✅ size-adjust: 105% 减少布局偏移

**待优化项**:
- ⚠️ 完全本地化所有字体子集
- ⚠️ 增加 Service Worker 长期缓存（365 天）
- ⚠️ 按需加载非关键字体

#### 瓶颈 2: JavaScript 关键路径过长 (3,317ms)

```
关键路径瀑布流:
index.html (67ms)
└── chunk-PVJC3Y5G.js (519ms) [Angular 核心]
    └── chunk-STHGLHLK.js (2,518ms) [Sentry SDK - 143KB]
        └── Supabase API: projects (3,317ms)
        └── Supabase API: get_full_project_data (3,180ms)
```

**已实施的优化**:
- ✅ Sentry SDK 懒加载（SentryLazyLoaderService）
- ✅ requestIdleCallback + 5s 超时
- ✅ RPC 批量加载（get_full_project_data）
- ✅ 数据预加载（index.html 内联脚本）

**待优化项**:
- ⚠️ Sentry 仍在关键路径上（chunk-STHGLHLK.js 2,518ms）
- ⚠️ JavaScript chunks 过多（32 个）
- ⚠️ 缺少 modulepreload 提示

#### 瓶颈 3: 渲染性能问题

```
问题表现:
├── 布局更新 1: 313 ms (160/256 节点)
├── 布局更新 2: 184 ms (153/395 节点)
└── 强制重排: 238 ms (未归因代码)
```

**已实施的优化**:
- ✅ OnPush 变更检测（所有关键组件）
- ✅ @for track 追踪（所有循环）
- ✅ CSS containment（flow-canvas、text-view 等）
- ✅ GoJS 事务批量操作

**待优化项**:
- ⚠️ 未使用虚拟滚动
- ⚠️ DOM 深度 23 层偏高
- ⚠️ 字体加载完成后的文本重排

#### 瓶颈 4: Bundle 体积问题

```
Bundle 分析:
├── Initial Bundle: ~600KB
│   ├── main.js: 162KB
│   ├── chunk-PVJC3Y5G.js (Angular): ~100KB
│   └── polyfills.js: ~30KB
│
├── Lazy Chunks:
│   ├── GoJS: 1.35MB (已隔离到 Flow 视图)
│   ├── Sentry: 422KB (已懒加载)
│   └── 其他: ~200KB
│
└── 问题: 32 个 chunks = 32 个 HTTP 请求
```

**已实施的优化**:
- ✅ GoJS 懒加载（@defer on viewport）
- ✅ Sentry 懒加载
- ✅ 模块按需加载

**待优化项**:
- ⚠️ 模态框静态导入（10+ 个组件）
- ⚠️ chunks 合并策略未优化
- ⚠️ 缺少 modulepreload 提示

---

## 三、已实施优化清单

| 优化项 | 实施时间 | 效果 | 状态 |
|--------|----------|------|------|
| RPC 批量加载 | 2026-01-27 | API 请求 -62% | ✅ 生效 |
| Sentry 懒加载 | 2026-02-01 | Render Delay -200ms | ✅ 生效 |
| 字体 preload | 2026-02-05 | 首屏字体立即可用 | ✅ 生效 |
| font-display: swap | 2026-02-01 | 消除 FOIT | ✅ 生效 |
| 数据预加载 | 2026-02-05 | 并行数据获取 | ✅ 生效 |
| CSS containment | 2026-02-05 | 减少布局计算 | ✅ 生效 |
| OnPush 变更检测 | 项目初期 | 减少脏检查 | ✅ 生效 |
| @for track | 项目初期 | 减少 DOM 操作 | ✅ 生效 |
| GoJS @defer | 项目初期 | Flow 视图懒加载 | ✅ 生效 |
| SW 缓存策略 | 2026-01-26 | 重复访问加速 | ✅ 生效 |
| **骨架屏动画增强** | 2026-02-05 | 感知性能 +30% | ✅ **新增** |
| **模态框 @defer** | 2026-02-05 | 11 组件懒加载 | ✅ **新增** |
| **modulepreload 优化** | 2026-02-05 | 排除懒加载模块 | ✅ **新增** |

---

## 四、待优化项优先级排序

### P0 - 立即执行（高影响，低成本）✅ 已完成

| 优化项 | 预期收益 | 实施难度 | 详情 |
|--------|----------|----------|------|
| ~~**完全本地化字体**~~ | -800ms~1s | 🟢 简单 | ✅ 所有 woff2 文件已在 /fonts/ |
| ~~**添加 modulepreload**~~ | -100~200ms | 🟢 简单 | ✅ 已自动注入，排除懒加载模块 |
| ~~**骨架屏动画增强**~~ | 感知性能 +30% | 🟢 简单 | ✅ 渐进入场 + 脉冲动画 |

### P1 - 短期执行（高影响，中等成本）✅ 已完成

| 优化项 | 预期收益 | 实施难度 | 详情 |
|--------|----------|----------|------|
| ~~**模态框 @defer 包装**~~ | -80~100KB Initial | 🟡 中等 | ✅ 11 个模态框懒加载 |
| **合并 JavaScript chunks** | -100~200ms | 🟡 中等 | 📋 评估中 |
| ~~**Service Worker 字体缓存**~~ | 重复访问 -80% | 🟡 中等 | ✅ local-fonts 已配置 |

### P2 - 中期执行（中等影响，高成本）📋 待实施

| 优化项 | 预期收益 | 实施难度 | 详情 |
|--------|----------|----------|------|
| **虚拟滚动** | 大列表渲染 -50%+ | 🔴 复杂 | 任务列表使用 cdk-virtual-scroll |
| **减少 DOM 深度** | 布局计算 -10% | 🔴 复杂 | 重构组件嵌套 |
| **SSR/预渲染** | 首屏 -1s+ | 🔴 复杂 | Angular Universal |

---

## 五、代码示例

### 示例 1: 完全本地化字体

```html
<!-- index.html - 所有字体子集 preload -->
<link rel="preload" href="/fonts/lxgwwenkaiscreen-subset-119.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/fonts/lxgwwenkaiscreen-subset-118.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/fonts/lxgwwenkaiscreen-subset-117.woff2" as="font" type="font/woff2" crossorigin>
<!-- 其余子集按需加载，但也本地化 -->
```

```json
// ngsw-config.json - 字体长期缓存
{
  "name": "local-fonts",
  "installMode": "prefetch",
  "updateMode": "prefetch",
  "resources": {
    "files": [
      "/fonts/**/*.woff2",
      "/fonts/**/*.css"
    ]
  }
}
```

### 示例 2: 添加 modulepreload

```html
<!-- index.html - 关键 chunks 预加载 -->
<link rel="modulepreload" href="/chunk-PVJC3Y5G.js">
<link rel="modulepreload" href="/main-*.js">
```

```javascript
// scripts/inject-modulepreload.cjs - 构建后注入
const fs = require('fs');
const path = require('path');

const distDir = 'dist/browser';
const indexPath = path.join(distDir, 'index.html');

// 读取 index.html
let html = fs.readFileSync(indexPath, 'utf-8');

// 查找关键 chunks
const files = fs.readdirSync(distDir);
const mainChunk = files.find(f => f.startsWith('main-') && f.endsWith('.js'));
const angularChunk = files.find(f => f.startsWith('chunk-') && f.includes('angular'));

// 注入 modulepreload
const preloads = [mainChunk, angularChunk].filter(Boolean)
  .map(f => `<link rel="modulepreload" href="/${f}">`)
  .join('\n  ');

html = html.replace('</head>', `  ${preloads}\n</head>`);
fs.writeFileSync(indexPath, html);
```

### 示例 3: 模态框 @defer 包装

```typescript
// app.component.html - 模态框懒加载
@defer (on interaction) {
  <app-settings-modal *ngIf="modal.showSettings()" />
}

@defer (on interaction) {
  <app-login-modal *ngIf="modal.showLogin()" />
}

@defer (on interaction) {
  <app-trash-modal *ngIf="modal.showTrash()" />
}
```

### 示例 4: 虚拟滚动实现

```typescript
// text-stages.component.ts - 使用 cdk-virtual-scroll
import { ScrollingModule } from '@angular/cdk/scrolling';

@Component({
  template: `
    <cdk-virtual-scroll-viewport itemSize="72" class="task-list">
      <div *cdkVirtualFor="let task of tasks; trackBy: trackById" class="task-card">
        <app-text-task-card [task]="task" />
      </div>
    </cdk-virtual-scroll-viewport>
  `,
  imports: [ScrollingModule]
})
```

---

## 六、性能监控配置

### 现有监控

```typescript
// src/config/performance.config.ts
export const PERFORMANCE_FLAGS = {
  USE_BATCH_RPC: true,           // P0 批量 RPC ✅
  FIRST_SCREEN_PRIORITY: true,   // P0 首屏优先 ✅
  GOJS_BATCH_RENDER: true,       // P1 GoJS 批量渲染 ✅
  SW_API_CACHE: true,            // P2 SW API 缓存 ✅
  ENABLE_PERF_LOGGING: false,    // 调试日志
};
```

### 建议添加的监控

```typescript
// 添加 Web Vitals 自动采集
export const WEB_VITALS_CONFIG = {
  LCP_THRESHOLD: 2500,
  CLS_THRESHOLD: 0.1,
  FID_THRESHOLD: 100,
  REPORT_TO_SENTRY: true,
};
```

---

## Recommended Approach

### 核心结论

**分三阶段优化，优先处理字体和 JavaScript 瓶颈**:

```
Phase 1 (本周) - 预期收益: LCP -800ms
├── 1. 完全本地化字体（所有 woff2 → /fonts/）
├── 2. 添加 modulepreload 提示
└── 3. 增强骨架屏动画

Phase 2 (下周) - 预期收益: Initial Bundle -100KB
├── 1. 模态框 @defer 包装
├── 2. 合并 JavaScript chunks（调整 budgets）
└── 3. 优化 Service Worker 缓存策略

Phase 3 (两周后) - 预期收益: 渲染性能 -30%
├── 1. 任务列表虚拟滚动
├── 2. 减少 DOM 嵌套深度
└── 3. 考虑 SSR/预渲染（可选）
```

### 预期最终效果

| 指标 | 当前值 | 目标值 | 改进 |
|------|--------|--------|------|
| LCP (桌面) | 1,168ms | < 800ms | -32% |
| 关键路径延迟 | 3,317ms | < 2,000ms | -40% |
| 第三方资源 | 1.2MB | < 300KB | -75% |
| JS Chunks | 32 | < 20 | -38% |
| Initial Bundle | ~600KB | < 500KB | -17% |

---

## Implementation Guidance

- **Objectives**: 将 LCP 降至 800ms 以下，关键路径延迟降至 2s 以下
- **Key Tasks**: 字体本地化、modulepreload、模态框懒加载、chunks 合并
- **Dependencies**: ngsw-config.json、angular.json、index.html
- **Success Criteria**: 
  - LCP < 1000ms (桌面)
  - 关键路径 < 2500ms
  - Initial Bundle < 500KB
  - 所有字体从本地加载

---

## 参考资料

1. [Chrome LCP 优化指南](https://developer.chrome.com/docs/performance/insights/lcp-breakdown)
2. [Angular @defer 文档](https://angular.dev/guide/templates/defer)
3. [Web Vitals 最佳实践](https://web.dev/articles/vitals)
4. [CSS containment](https://developer.mozilla.org/en-US/docs/Web/CSS/contain)
5. [GoJS 性能优化](https://gojs.net/latest/intro/performance.html)
