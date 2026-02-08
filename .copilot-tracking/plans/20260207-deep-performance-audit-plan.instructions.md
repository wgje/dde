---
applyTo: ".copilot-tracking/changes/20260207-deep-performance-audit-changes.md"
---

<!-- markdownlint-disable-file -->

# Task Checklist: NanoFlow 深度性能审计修复

## Overview

基于 2026-02-07 深度性能审计报告和全量研究，系统性修复 3 个 P0 致命问题、4 个 P1 严重问题和 3 个 P2 警告，目标将 main.js 从 170KB br 降至 <100KB br，消除首屏页面卡死。

## Objectives

- 消除 GoJS 通过 barrel export 泄漏进 main bundle 的致命问题（预期 main.js 减少 200-400KB 解压体积）
- 修复桌面端 `@defer (on viewport)` 无效懒加载，确保首屏不加载 GoJS
- 解决 Service Worker 注册/注销矛盾，统一 SW 策略
- 将 FocusModeComponent 改为懒加载，减少首屏依赖链
- 优化同步服务：消除双重 IndexedDB 写入，延迟 SyncCoordinator 初始化
- 收紧构建配置：Budget、namedChunks、devDependencies 归位
- 最终验证 main.js br < 100KB，LCP < 2.5s，E2E 测试全部通过

## Research Summary

### Project Files

- `src/models/index.ts` L327 — GoJS barrel export 泄漏根源
- `src/models/gojs-boundary.ts` L21 — `import * as go from 'gojs'` 触发 GoJS 打包
- `src/app/core/shell/project-shell.component.ts` L211-L242 — `@defer (on viewport)` 桌面端失效
- `src/app.component.ts` L66 — FocusModeComponent 静态导入
- `main.ts` L237/L289 — SW 注册/注销矛盾
- `src/services/sync-coordinator.service.ts` L189-L202 — 急切初始化 + 1s 定时器
- `src/services/persist-scheduler.service.ts` L102 — 双重 IndexedDB 写入
- `src/config/sync.config.ts` L35 — LOCAL_AUTOSAVE_INTERVAL: 1000
- `angular.json` L50-L57 — Budget 配置 + namedChunks
- `ngsw-config.json` L28-L39 — fonts prefetch 模式
- `package.json` L41-L56 — 构建依赖错放

### External References

- Angular `@defer` 官方文档 — `on viewport` 使用 IntersectionObserver，placeholder 在视口内时立即触发
- Angular `providedIn: 'root'` + tree-shaking 机制 — barrel export 会绕过 tree-shaking

### Standards References

- AGENTS.md — GoJS 移动端策略、`@defer` 懒加载、`visibility:hidden` 禁令
- angular.instructions.md — OnPush、Signals、standalone、性能优化
- frontend.instructions.md — GoJS 懒加载要求

## Implementation Checklist

### [ ] Phase 1: GoJS Bundle 泄漏修复（P0 — 最高优先级）

- [ ] Task 1.1: 移除 `models/index.ts` 中的 GoJS barrel export
  - Details: .copilot-tracking/details/20260207-deep-performance-audit-details.md (Lines 13-41)

- [ ] Task 1.2: 清理 `gojs-boundary.ts` 中未使用的运行时导出
  - Details: .copilot-tracking/details/20260207-deep-performance-audit-details.md (Lines 43-67)

- [ ] Task 1.3: 验证 GoJS 不再出现在 main bundle
  - Details: .copilot-tracking/details/20260207-deep-performance-audit-details.md (Lines 69-91)

### [ ] Phase 2: @defer 触发器修复（P0-2）

- [ ] Task 2.1: 将桌面端 `@defer (on viewport)` 改为 `@defer (on idle)` 或 `@defer (on interaction)`
  - Details: .copilot-tracking/details/20260207-deep-performance-audit-details.md (Lines 96-140)

- [ ] Task 2.2: 验证桌面端首屏不加载 flow-view chunk
  - Details: .copilot-tracking/details/20260207-deep-performance-audit-details.md (Lines 142-159)

### [ ] Phase 3: Service Worker 矛盾清理（P0-3）

- [ ] Task 3.1: 统一 SW 策略（移除注销逻辑，保留 SW 缓存能力）
  - Details: .copilot-tracking/details/20260207-deep-performance-audit-details.md (Lines 164-199)

- [ ] Task 3.2: 优化 ngsw-config.json 字体加载策略
  - Details: .copilot-tracking/details/20260207-deep-performance-audit-details.md (Lines 201-233)

### [ ] Phase 4: FocusModeComponent 懒加载（P1-2）

- [ ] Task 4.1: 将 FocusModeComponent 和 SpotlightTriggerComponent 改为 `@defer` 懒加载
  - Details: .copilot-tracking/details/20260207-deep-performance-audit-details.md (Lines 238-284)

- [ ] Task 4.2: 验证大门（Gate）功能正常工作
  - Details: .copilot-tracking/details/20260207-deep-performance-audit-details.md (Lines 286-303)

### [ ] Phase 5: 同步服务优化（P1-3, P1-4）

- [ ] Task 5.1: 将 LOCAL_AUTOSAVE_INTERVAL 从 1000ms 改为 3000ms 并使用 debounce
  - Details: .copilot-tracking/details/20260207-deep-performance-audit-details.md (Lines 308-353)

- [ ] Task 5.2: 消除 PersistSchedulerService 的双重 IndexedDB 写入
  - Details: .copilot-tracking/details/20260207-deep-performance-audit-details.md (Lines 355-379)

- [ ] Task 5.3: SyncCoordinatorService 延迟初始化（认证完成后启动定时器）
  - Details: .copilot-tracking/details/20260207-deep-performance-audit-details.md (Lines 381-438)

### [ ] Phase 6: 构建配置优化（P1-5, P2-1, P2-3）

- [ ] Task 6.1: 收紧 Bundle Budget
  - Details: .copilot-tracking/details/20260207-deep-performance-audit-details.md (Lines 443-480)

- [ ] Task 6.2: 生产构建关闭 namedChunks
  - Details: .copilot-tracking/details/20260207-deep-performance-audit-details.md (Lines 482-500)

- [ ] Task 6.3: 将构建依赖移到 devDependencies
  - Details: .copilot-tracking/details/20260207-deep-performance-audit-details.md (Lines 502-537)

### [ ] Phase 7: 验证与回归测试

- [ ] Task 7.1: 执行 Bundle 分析，验证 main.js br < 100KB
  - Details: .copilot-tracking/details/20260207-deep-performance-audit-details.md (Lines 542-562)

- [ ] Task 7.2: 运行 E2E 测试，确保无功能回归
  - Details: .copilot-tracking/details/20260207-deep-performance-audit-details.md (Lines 564-582)

- [ ] Task 7.3: Lighthouse 审计，验证 LCP < 2.5s
  - Details: .copilot-tracking/details/20260207-deep-performance-audit-details.md (Lines 584-608)

## Dependencies

- Angular CLI (`ng build --configuration production`)
- esbuild（Angular 默认构建器，用于 bundle 分析）
- Vitest（单元测试）
- Playwright（E2E 测试）
- Lighthouse / `npx lighthouse`（性能审计）
- GoJS 3.1.x（确认 tree-shaking 兼容性）

## Success Criteria

- main.js brotli 压缩后 < 100KB（当前 ~170KB）
- 首屏不加载 GoJS 相关 chunk（Network tab 验证）
- 页面不再卡死：LCP < 2.5s，INP < 200ms
- Service Worker 行为一致：保留 SW 缓存能力，无注册/注销矛盾
- IndexedDB 写入频率从 2次/秒降至 ~0.3次/秒（3s debounce）
- Bundle budget error 阈值 ≤ 1.2MB（从 2.5MB 降低）
- E2E 测试全部通过
- 无功能回归（Flow 视图、专注模式、同步功能正常）
