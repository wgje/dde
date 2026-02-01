---
applyTo: ".copilot-tracking/changes/20260201-pwa-instant-open-optimization-changes.md"
---

<!-- markdownlint-disable-file -->

# Task Checklist: PWA "Instant Open" 性能优化

## Overview

基于性能数据分析，优化 PWA 应用的 LCP 从 1,943ms 降至 <1,500ms，主要通过 Sentry SDK 懒加载和 JS Bundle 优化消除 Render Delay。

## Objectives

- 将 LCP 从 1,943ms 降至 <1,500ms (P75)
- 消除 Sentry SDK 导致的 320ms 强制重排
- 减少 Render Delay 从 1,872ms 降至 <1,000ms
- 保持 CLS = 0 的优秀成绩
- 保持现有功能完整性

## Research Summary

### Project Files

- [main.ts](main.ts) - 应用入口，Sentry SDK 初始化位置
- [src/app/app.config.ts](src/app/app.config.ts) - Angular 应用配置，APP_INITIALIZER 配置
- [angular.json](angular.json) - 构建配置，Budget 限制
- [ngsw-config.json](ngsw-config.json) - Service Worker 缓存配置（已优化）
- [index.html](index.html) - 字体预加载和骨架屏（已优化）

### External References

- #context7:"/websites/angular_dev" "@defer lazy loading performance" - Angular 懒加载最佳实践
- #context7:"/websites/angular_dev" "APP_INITIALIZER async" - 异步初始化模式
- Sentry 官方文档 - 懒加载 SDK 配置

### Performance Baseline

| 指标 | 当前值 | 目标值 |
|------|--------|--------|
| LCP | 1,943 ms | <1,500 ms |
| Render Delay | 1,872 ms | <1,000 ms |
| CLS | 0.00 | 保持 0 |
| TTFB | 71 ms | 保持 <100 ms |

## Implementation Checklist

### [ ] Phase 1: Sentry SDK 懒加载 (P0 - 预期收益: -200~300 ms)

- [ ] Task 1.1: 创建 Sentry 懒加载服务
  - Details: .copilot-tracking/details/20260201-pwa-instant-open-optimization-details.md (Lines 12-50)

- [ ] Task 1.2: 修改 main.ts 移除同步 Sentry 初始化
  - Details: .copilot-tracking/details/20260201-pwa-instant-open-optimization-details.md (Lines 52-85)

- [ ] Task 1.3: 更新 app.config.ts 配置异步 Sentry 初始化
  - Details: .copilot-tracking/details/20260201-pwa-instant-open-optimization-details.md (Lines 87-120)

- [ ] Task 1.4: 更新 GlobalErrorHandler 使用懒加载 Sentry
  - Details: .copilot-tracking/details/20260201-pwa-instant-open-optimization-details.md (Lines 122-160)

### [ ] Phase 2: JS Bundle 分析与优化 (P1 - 预期收益: -100~200 ms)

- [ ] Task 2.1: 配置 source-map-explorer 分析工具
  - Details: .copilot-tracking/details/20260201-pwa-instant-open-optimization-details.md (Lines 165-195)

- [ ] Task 2.2: 分析当前 Bundle 组成并生成报告
  - Details: .copilot-tracking/details/20260201-pwa-instant-open-optimization-details.md (Lines 197-230)

- [ ] Task 2.3: 调整 angular.json 构建 Budgets
  - Details: .copilot-tracking/details/20260201-pwa-instant-open-optimization-details.md (Lines 232-265)

- [ ] Task 2.4: 优化大型依赖的懒加载策略
  - Details: .copilot-tracking/details/20260201-pwa-instant-open-optimization-details.md (Lines 267-310)

### [ ] Phase 3: 字体渲染优化 (P2 - 预期收益: 感知性能提升)

- [ ] Task 3.1: 添加 size-adjust 减少布局偏移
  - Details: .copilot-tracking/details/20260201-pwa-instant-open-optimization-details.md (Lines 315-350)

- [ ] Task 3.2: 优化关键字体子集预加载策略
  - Details: .copilot-tracking/details/20260201-pwa-instant-open-optimization-details.md (Lines 352-385)

### [ ] Phase 4: 性能验证与监控 (P3)

- [ ] Task 4.1: 创建性能基准测试脚本
  - Details: .copilot-tracking/details/20260201-pwa-instant-open-optimization-details.md (Lines 390-430)

- [ ] Task 4.2: 配置 Lighthouse CI 自动化测试
  - Details: .copilot-tracking/details/20260201-pwa-instant-open-optimization-details.md (Lines 432-470)

- [ ] Task 4.3: 验证优化效果并生成对比报告
  - Details: .copilot-tracking/details/20260201-pwa-instant-open-optimization-details.md (Lines 472-510)

## Dependencies

- source-map-explorer (npm 包，用于 Bundle 分析)
- @lhci/cli (Lighthouse CI，可选)
- 现有 Sentry SDK (@sentry/angular)
- Angular 19.x (已安装)

## Success Criteria

- LCP < 1,500ms (使用 Lighthouse 测量)
- Render Delay < 1,000ms
- CLS 保持 = 0
- Sentry 错误捕获功能完整（首屏后启用）
- 所有现有功能正常工作
- 无新增运行时错误
