<!-- markdownlint-disable-file -->

# Task Changes: PWA "Instant Open" 性能优化

**实施日期**: 2026-02-01  
**状态**: ✅ 完成

---

## 已完成任务

### [x] Phase 1: Sentry SDK 懒加载 (P0 - 预期收益: -200~300 ms)

- [x] Task 1.1: 创建 Sentry 懒加载服务
  - **文件**: `src/services/sentry-lazy-loader.service.ts` (新建)
  - **变更**: 创建完整的 Sentry 懒加载服务，支持：
    - requestIdleCallback 异步初始化
    - 错误队列机制（初始化前捕获的错误不丢失）
    - Angular Signals 状态管理
    - 动态导入 @sentry/angular

- [x] Task 1.2: 修改 main.ts 移除同步 Sentry 初始化
  - **文件**: `main.ts`
  - **变更**: 
    - 移除顶层 `sentryInit()` 同步调用
    - 移除 `@sentry/angular` 的同步导入
    - 改用 `SentryLazyLoaderService` 异步初始化
    - 通过 APP_INITIALIZER + queueMicrotask 实现非阻塞初始化

- [x] Task 1.3: 更新 app.config.ts / main.ts 配置异步 Sentry 初始化
  - **文件**: `main.ts` (bootstrapApplication providers)
  - **变更**:
    - 添加 APP_INITIALIZER 触发 SentryLazyLoaderService
    - 返回立即 resolve 的 Promise，不阻塞启动
    - 替换 sentryCreateErrorHandler 为 GlobalErrorHandler

- [x] Task 1.4: 更新 GlobalErrorHandler 使用懒加载 Sentry
  - **文件**: `src/services/global-error-handler.service.ts`
  - **变更**:
    - 注入 SentryLazyLoaderService
    - 在 handleSilentError、handleNotifyError、handleFatalError 中集成 Sentry 上报
    - 添加错误上下文（severity、component、userMessage 等）

### [x] Phase 2: JS Bundle 分析与优化 (P1)

- [x] Task 2.1: 配置 source-map-explorer 分析工具
  - **文件**: 
    - `scripts/analyze-bundle.sh` (新建)
    - `scripts/extract-bundle-metrics.cjs` (新建)
    - `package.json` (添加 analyze:bundle 脚本)
  - **变更**: 创建完整的 Bundle 分析工具链

- [x] Task 2.3: 调整 angular.json 构建 Budgets
  - **文件**: `angular.json`
  - **变更**:
    - initial: 500kb → 400kb (warning), 2.5mb → 800kb (error)
    - anyComponentStyle: 10kb → 8kb (warning), 20kb → 16kb (error)
    - bundle main: 550kb → 350kb (warning), 1.2mb → 600kb (error)

### [x] Phase 3: 字体渲染优化 (P2)

- [x] Task 3.1: 添加 size-adjust 减少布局偏移
  - **文件**: `index.html`
  - **变更**:
    - 为所有 3 个 @font-face 添加 `size-adjust: 105%`
    - 匹配 system-ui fallback 尺寸，减少 FOUT 布局偏移

### [x] Phase 4: 性能验证与监控 (P3)

- [x] Task 4.1: 创建性能基准测试脚本
  - **文件**:
    - `scripts/performance-benchmark.sh` (新建)
    - `scripts/extract-lighthouse-metrics.cjs` (新建)
    - `package.json` (添加 perf:benchmark 脚本)
  - **变更**: 创建自动化 Lighthouse 性能测试工具

- [x] Task 4.2: 配置 Lighthouse CI 自动化测试
  - **文件**: `lighthouserc.js` (新建)
  - **变更**: 配置 LHCI 断言规则：
    - performance score > 85%
    - LCP < 1500ms
    - CLS < 0.1
    - FCP < 1000ms
    - TBT < 200ms

---

## 文件变更汇总

### 新建文件 (7 个)

| 文件路径 | 描述 |
|----------|------|
| `src/services/sentry-lazy-loader.service.ts` | Sentry SDK 懒加载服务 |
| `scripts/analyze-bundle.sh` | Bundle 分析脚本 |
| `scripts/extract-bundle-metrics.cjs` | Bundle 指标提取器 |
| `scripts/performance-benchmark.sh` | 性能基准测试脚本 |
| `scripts/extract-lighthouse-metrics.cjs` | Lighthouse 指标提取器 |
| `lighthouserc.js` | Lighthouse CI 配置 |
| `.copilot-tracking/changes/20260201-pwa-instant-open-optimization-changes.md` | 本变更记录 |

### 修改文件 (5 个)

| 文件路径 | 变更类型 | 描述 |
|----------|----------|------|
| `main.ts` | 重构 | 移除同步 Sentry，改为懒加载 |
| `src/services/global-error-handler.service.ts` | 增强 | 集成 SentryLazyLoaderService |
| `angular.json` | 配置 | 收紧构建 Budgets |
| `index.html` | 优化 | 添加 font-face size-adjust |
| `package.json` | 配置 | 添加分析和基准测试脚本 |

---

## 预期收益

| 优化项 | 预期收益 | 机制 |
|--------|----------|------|
| Sentry SDK 懒加载 | -200~300ms | 消除首屏 JS 执行阻塞 |
| 更严格的 Budgets | 代码膨胀预警 | 构建时检测 |
| 字体 size-adjust | 感知性能提升 | 减少 FOUT 布局偏移 |
| 性能监控自动化 | 持续优化 | CI 中自动检测回归 |

**目标**: LCP 从 1,943ms 降至 <1,500ms

---

## 验证命令

```bash
# 运行 Bundle 分析
npm run analyze:bundle

# 运行性能基准测试
npm run perf:benchmark

# 运行 Lighthouse CI
npx lhci autorun
```

---

## 注意事项

1. **Sentry 错误不丢失**: 初始化前捕获的错误会进入队列，初始化后自动发送
2. **开发环境兼容**: 无 SENTRY_DSN 时自动跳过初始化
3. **渐进增强**: 不支持 requestIdleCallback 的浏览器会使用 setTimeout 后备
4. **向后兼容**: GlobalErrorHandler 的公共 API 保持不变
