# 性能瓶颈修复 — 变更记录

> 日期：2026-02-14
> 关联计划：`plans/20260214-perf-bottleneck-remediation-plan.instructions.md`
> 关联研究：`research/20260214-perf-bottleneck-remediation-research.md`
> 关联详情：`details/20260214-perf-bottleneck-remediation-details.md`

---

## Added

| 文件 | 摘要 |
|------|------|
| `e2e/weak-network-budget.spec.ts` | 新增弱网性能预算 E2E 测试，使用 Playwright CDP 模拟 Slow 3G + 4x CPU 限制，检查 LCP < 6s、Long Task < 3s、fetch ≤ 15、blackbox pulls ≤ 1、RPC 400 = 0。需 `PERF_BUDGET_TEST=1` 环境变量启用 |

## Modified

| 文件 | 摘要 |
|------|------|
| `src/config/sync.config.ts` | 在 `SYNC_CONFIG` 中新增 `BLACKBOX_PULL_FRESHNESS_WINDOW: 30_000`（30 秒新鲜度窗口），用于抑制重复拉取 |
| `src/services/black-box-sync.service.ts` | 注入 `SentryLazyLoaderService`；`pullChanges()` 增加 freshness window 检查，30 秒内重复请求自动跳过（force 参数可绕过）；跳过时记录 Sentry breadcrumb |
| `src/app/features/focus/focus-mode.component.ts` | `initializeAndCheckGate()` 改为 local-first：先 `loadFromLocal()` + 立即 `checkGateOnStartup()`，再异步 `pullChanges()` 完成后二次检查 |
| `src/app/core/services/sync/project-data.service.ts` | `loadFullProjectOptimized()` 增加 Access Denied (P0001) 错误检测，权限不足时返回 `null` 而非回退到全量加载；记录 Sentry breadcrumb |
| `src/services/user-session.service.ts` | `startBackgroundSync()` 策略 2：当 `loadSingleProjectFromCloud()` 返回 `null` 时，清理 `activeProjectId` 为 `null`，避免无权项目持续重试 |
| `src/app.component.ts` | 新增 `coreDataLoaded` computed signal，组合 `isCheckingSession`、`currentUserId`、`isAuthLoading` 三个条件 |
| `src/app.component.html` | FocusMode `@defer` 条件从 `(on idle)` 改为 `(when coreDataLoaded())`，确保核心数据就绪后才加载 |
| `index.html` | 移除 subset-118 和 subset-117 的 `<link rel="prefetch">`（仅保留 subset-119 preload）；字体 CSS 加载延迟到 `window.load` + `requestIdleCallback`（timeout 3s） |

## Removed

无文件删除。

## 偏差记录

| 偏差 | 原因 | 影响 |
|------|------|------|
| Phase 3 (Flow @defer intent trigger) 跳过实施 | 上一次会话已完全实现 `shouldLoadFlowNow()` + `activateFlowIntent()` + `FLOW_INTENT_LAZYLOAD_V1` feature flag | 无影响，仅验证确认已存在 |
| `pullChanges()` freshness window 插入位置调整 | 方法已在先前会话中加入 `PullChangesOptions` 参数和 `BLACKBOX_PULL_COOLDOWN_V1` 检查，需在已有逻辑之后插入 | 无负面影响，逻辑顺序正确 |

## 验证结果

| 验证项 | 结果 |
|--------|------|
| `black-box-sync.service.spec.ts` | 3/3 通过 |
| `project-data.service.spec.ts` | 1/1 通过 |
| `user-session.service.spec.ts` | 12/13 通过（1 个预存失败，与本次无关） |
| 全量 `npm run test:run` | 7 个文件失败（均为预存问题，原始代码 15 个文件失败） |
| `npm run lint` | 15 个预存 warning，本次修改文件无新增 |

## 风险与回滚

- **风险**：`coreDataLoaded` computed 条件过于严格可能导致 FocusMode 延迟加载。回滚点：将 `@defer (when coreDataLoaded())` 改回 `@defer (on idle)`。
- **风险**：Access Denied 返回 `null` 后清理 `activeProjectId` 可能影响刚被撤销权限的共享项目场景。回滚点：移除 `user-session.service.ts` 中的 `else` 分支。
- **回滚策略**：所有改动均为独立可回滚单元，可按 Phase 粒度逐一 revert。
