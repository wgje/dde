# Perf Gate Runbook（2026-02-18）

## 1. 目标与范围

本 runbook 用于性能门禁值班与回归，覆盖：

1. 弱网启动门禁（startup / budget）
2. 恢复门禁（resume）
3. 写路径可测性（task-crud / sync-flow-lite）
4. 无回归守卫（baseline 对比）

门禁策略遵循“低体验影响”：

1. `cold-path` 保持硬约束
2. `warm-path` 允许 `zero-fetch`，但必须打标并统计
3. `resume.interaction_ready_ms` 不再要求 `>0`，改为“数值有效 + 上限 + 结构性约束”

## 2. 分层执行

### 2.1 PR 轻量门禁

目标：快速发现明显回归，不阻塞开发效率。

```bash
npm run perf:guard
```

补充（按需）：

```bash
npx playwright test e2e/perf/weak-network-startup.spec.ts --list
npx playwright test e2e/weak-network-budget.spec.ts --list
npx playwright test e2e/perf/resume-budget.spec.ts --list
```

### 2.2 夜间/手动批量回归（18 轮矩阵）

目标：收集趋势并执行阈值判定。

```bash
node scripts/run-perf-audit-batch.cjs --date=YYYY-MM-DD --rounds=5 --strict-thresholds=1
```

说明：`--rounds=5` 时总执行轮次为 `18`（`5 + 5 + 5 + 1 + 1 + 1`）。

## 3. 环境变量

认证态弱网 / no-regression / nightly audit 必需：

1. `E2E_PERF_EMAIL`
2. `E2E_PERF_PASSWORD`

可选：

1. `E2E_PERF_PROJECT_ID`（固定项目）
2. `TEST_USER_EMAIL` / `TEST_USER_PASSWORD`（critical-path 云同步用例）
3. `PERF_BUDGET_TEST=1`（启用弱网预算用例）

说明：

1. PR / push 的 `perf-and-resume-gates` 在缺少 `E2E_PERF_EMAIL` 或 `E2E_PERF_PASSWORD` 时，会保留 `npm run perf:guard`、恢复核心测试等无凭据门禁。
2. 认证态弱网 E2E、`current-metrics.json` 上传、以及 `no-regression-guard` 会在缺少凭据时自动跳过，并在 Step Summary 中给出原因。
3. 一旦凭据存在并进入认证态 perf E2E，`current-metrics.json` 仍属于硬性产物；成功执行后缺失该文件应直接判定 workflow 失败，而不是静默跳过。

## 4. 产物与判定

批量脚本产物：

1. `tmp/perf-audit/<date>/run-status.tsv`
2. `test-results/perf/<date>/run-status.tsv`
3. `test-results/perf/<date>/summary.txt`

关键阈值（`strict-thresholds=1`）：

1. warm-path zero-fetch 占比 `<= 40%`
2. 登录前置成功率 `>= 95%`
3. `resume.interaction_ready_ms=0` 频率 `<= 20%`

失败判定：

1. 任一子套件退出码非 0
2. 任一阈值超限

## 5. 常见故障排查

1. 登录弹窗未关闭/被遮罩拦截  
   先检查日志中的 `login=0` 与 modal 错误；优先验证 `e2e/shared/auth-helpers.ts` 的重试与弹窗可见性逻辑。
2. `warm-path totalDataRequests=0`  
   属于告警样本，关注占比，不应直接判定失败（`cold-path` 仍必须 `>0`）。
3. `resume.interaction_ready_ms=0` 偶发  
   先看 `resume.interaction_zero_flag` 频率，再看 `heavyRecordCount/heavyTicketCount` 是否超限。
4. `current-metrics.json` 缺失  
   先确认当前 workflow 是否因为缺少 `E2E_PERF_EMAIL` / `E2E_PERF_PASSWORD` 而主动跳过认证态 perf 链路；若未跳过，再检查用例入口是否调用 `initPerfMetrics()`，以及进程是否在极早阶段中断。

## 6. 回滚策略

1. 认证前置异常：回滚 `e2e/shared/auth-helpers.ts` 与 `e2e/critical-paths/helpers.ts`
2. 分层门禁误判：回滚 `e2e/perf/weak-network-startup.spec.ts` 与 `e2e/weak-network-budget.spec.ts`
3. 恢复计时口径争议：回滚 `src/services/app-lifecycle-orchestrator.service.ts`
4. 夜间任务成本过高：临时禁用 `.github/workflows/perf-nightly-audit.yml`

## 7. 值班清单

1. 先看 `summary.txt` 的三项阈值是否超限
2. 再看 `run-status.tsv` 定位失败套件与轮次
3. 最后按日志 marker 回放：
   - `[weak-startup]`
   - `[weak-budget]`
   - `[resume-budget]`
