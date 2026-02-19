# DDE 线上全链路瓶颈全量调查报告

- 调查日期：2026-02-18
- 目标站点：`https://dde-eight.vercel.app/#/projects/a112a0fd-99a3-4002-b077-c74ff5a3a82e/text`
- 账号：`1@qq.com / 1`
- 范围：全链路（登录、项目加载、Text/Flow、Focus/BlackBox、轻度写入压测）
- 基线对比：`docs/deep-performance-audit-2026-02-14.md`、`docs/deep-performance-audit-2026-02-07.md`

---

## 1. 执行摘要

本次按计划完成了环境修复、18 轮自动化采样与证据归并。总体通过率 `55.6%`（10/18），核心结论如下：

1. `weak-network-startup` 出现高频抖动失败（3/5），失败指标一致为 `dataRequests=0`。
2. `resume-budget` 出现间歇失败（2/5），失败指标一致为 `resume.interaction_ready_ms=0`。
3. 轻写压测链路未能有效执行：`task-crud` 与 `sync-flow-lite` 均在前置交互阶段超时，无法进入写入与同步验证。
4. 与 2026-02-14 相比，`weak-network-budget` 成功样本中未复现 `RPC400`、`black_box_entries` 重复拉取、预加载大 chunk 问题。

---

## 2. 执行与产物

### 2.1 环境预处理（已执行）

- 已执行并成功：
  - 暂时禁用 `yarn.list`，修复 `playwright install-deps` 的 apt 签名阻断
  - 安装 Chromium 运行依赖与浏览器
  - 恢复 `yarn.list`
- 预检通过：
  - `npx playwright --version` => `1.58.0`
  - `npx playwright test e2e/perf/weak-network-startup.spec.ts --list` 正常列出用例

### 2.2 产物路径

- 原始日志：`tmp/perf-audit/2026-02-18`
- 批次状态：`tmp/perf-audit/2026-02-18/run-status.tsv`
- 报告：`docs/deep-performance-audit-2026-02-18.md`

---

## 3. 结果总览

| 套件 | 运行数 | 通过 | 失败 | 通过率 |
|---|---:|---:|---:|---:|
| weak-network-startup | 5 | 2 | 3 | 40% |
| weak-network-budget | 5 | 4 | 1 | 80% |
| resume-budget | 5 | 3 | 2 | 60% |
| auth-flow | 1 | 1 | 0 | 100% |
| task-crud | 1 | 0 | 1 | 0% |
| sync-flow-lite | 1 | 0 | 1 | 0% |

总计：`18` 轮，`10` 通过，`8` 失败（`55.6%`）。

---

## 4. 指标摘要（成功样本）

`weak-network-budget` 成功样本（4 轮）日志指标：

- 日志来源：`tmp/perf-audit/2026-02-18/weak-budget-1.log:8`、`tmp/perf-audit/2026-02-18/weak-budget-2.log:8`、`tmp/perf-audit/2026-02-18/weak-budget-3.log:8`、`tmp/perf-audit/2026-02-18/weak-budget-4.log:8`

| 指标 | 平均 | 最小 | 最大 |
|---|---:|---:|---:|
| LCP | 505ms | 448ms | 596ms |
| FCP | 505ms | 448ms | 596ms |
| Long Task 总时长 | 81.8ms | 52ms | 129ms |
| DataFetch | 3.25 | 3 | 4 |
| BlackBox 拉取次数 | 1.00 | 1 | 1 |
| RPC400 次数 | 0.00 | 0 | 0 |
| Large Chunk 预拉取 | 0.00 | 0 | 0 |
| ModulePreload 数 | 0.00 | 0 | 0 |

---

## 5. 关键瓶颈与归因（P0/P1/P2）

## P0-1 认证态弱网启动门禁存在高频抖动（dataRequests=0）

- 现象：`weak-network-startup` 5 轮中 3 轮失败。
- 证据：
  - `tmp/perf-audit/2026-02-18/weak-startup-1.log:13`
  - `tmp/perf-audit/2026-02-18/weak-startup-3.log:13`
  - `tmp/perf-audit/2026-02-18/weak-startup-5.log:13`
  - 失败信息一致：`认证态首阶段数据请求必须大于 0，当前=0`
- 指标数值：`dataRequests=0`（失败轮次）
- 代码定位：
  - 断言位置：`e2e/perf/weak-network-startup.spec.ts:65` 到 `e2e/perf/weak-network-startup.spec.ts:68`
  - 采样窗口：`e2e/perf/weak-network-startup.spec.ts:42` 到 `e2e/perf/weak-network-startup.spec.ts:47`
- 根因判断：门禁把 `dataRequests > 0` 设为硬约束，但采样发生在二次导航窗口（登录完成后再次跳转目标项目），与 Offline-first/缓存命中场景冲突，导致“无网络请求也算失败”的误报型抖动。
- 改造方案：
  - 将断言从“必须 >0”调整为“允许 0，但 0 时记录 cold/warm 状态并单独告警”。
  - 或者扩大采样窗口：把 `ensurePerfAuthenticated` 阶段的响应也纳入同一计数。
- 风险：放宽下限可能降低对真实“请求完全丢失”问题的敏感性。
- 回滚点：恢复 `toBeGreaterThan(0)` 原断言逻辑。
- 验收阈值：连续 10 轮运行，`weak-network-startup` 不因 `dataRequests=0` 触发失败；若 `dataRequests=0` 出现，需伴随 warm-path 标记并统计比例。

## P0-2 恢复预算门禁间歇失败（interaction_ready_ms=0）

- 现象：`resume-budget` 5 轮中 2 轮失败。
- 证据：
  - `tmp/perf-audit/2026-02-18/resume-1.log:13`
  - `tmp/perf-audit/2026-02-18/resume-5.log:13`
  - 失败信息一致：`resume.interaction_ready_ms 必须大于 0`
- 指标数值：`interaction_ready_ms=0`
- 代码定位：
  - 失败断言：`e2e/perf/resume-budget.spec.ts:113` 到 `e2e/perf/resume-budget.spec.ts:116`
  - 指标生成：`src/services/app-lifecycle-orchestrator.service.ts:362` 到 `src/services/app-lifecycle-orchestrator.service.ts:375`
- 根因判断：`interactionReadyMs` 用 `Date.now()` 毫秒差值计算，快速路径可能落在同一毫秒内，合法结果就是 `0`，与测试“必须 >0”的断言冲突。
- 改造方案：
  - 优先改指标采样：使用 `performance.now()`（高精度）
  - 同步调整门禁断言：从 `>0` 改为 `>=0`，并使用上限约束作为主门禁。
- 风险：改断言后会放过一部分“空转恢复”异常，需要结合事件计数和 ticket 去重约束。
- 回滚点：恢复当前 `Date.now()` 计算与 `>0` 断言。
- 验收阈值：连续 10 轮 `resume-budget` 稳定通过，且 `heavyRecordCount<=1`、`heavyTicketCount<=1` 仍成立。

## P0-3 轻写压测链路前置阻塞，导致写入/同步瓶颈无法验证

- 现象：
  - `task-crud` 3/3 用例在 30s 超时。
  - `sync-flow-lite` 2/2 用例在 30s 超时。
- 证据：
  - `tmp/perf-audit/2026-02-18/task-crud.log:23`（`Test timeout of 30000ms exceeded`）
  - `tmp/perf-audit/2026-02-18/task-crud.log:27`（等待 `[data-testid="add-task-btn"]`）
  - `tmp/perf-audit/2026-02-18/sync-flow-lite.log:53`（`dynamic-modal-container` 拦截点击）
  - `test-results/critical-paths-sync-flow-关键路径-3-拖拽-同步-离线修改应在重连后同步-chromium/error-context.md:1`（页面处于“请先登录 + 登录弹窗”状态）
- 指标数值：写入相关用例统一卡在 `30,000ms` 超时。
- 代码定位：
  - 强制登录路由：`src/app.routes.ts:106` 到 `src/app.routes.ts:108`
  - 与现状不匹配的测试前置：`e2e/critical-paths/task-crud.spec.ts:11` 到 `e2e/critical-paths/task-crud.spec.ts:24`
  - 重复点击登录且未处理“已弹窗”状态：`e2e/critical-paths/sync-flow.spec.ts:115` 到 `e2e/critical-paths/sync-flow.spec.ts:120`
- 根因判断：业务进入“强制登录模式”后，部分旧测试仍按未登录可操作路径执行，导致关键按钮不可达或被模态层拦截。
- 改造方案：
  - 为 `task-crud`/`sync-flow` 统一接入 `ensureLoginModalVisible + submit` 登录 helper。
  - 在点击 `login-btn` 前先判断弹窗可见性，避免 overlay intercept。
  - 对写入压测用例增加“认证前置步骤成功”断言，否则快速失败并标注前置问题。
- 风险：改造测试前置后，测试时长略增；若登录态不稳定会放大失败暴露。
- 回滚点：恢复原始测试流程（不建议）。
- 验收阈值：`task-crud` 与 `sync-flow-lite` 至少连续 5 轮可稳定进入写入动作（达到 `add-task-btn` 点击成功）。

## P1-1 认证链路存在轻度抖动（弱网预算第 5 轮）

- 现象：`weak-network-budget` 第 5 轮失败，登录弹窗未关闭。
- 证据：`tmp/perf-audit/2026-02-18/weak-budget-5.log:15` 到 `tmp/perf-audit/2026-02-18/weak-budget-5.log:23`
- 指标数值：登录阶段 `not.toBeVisible(login-modal)` 在 15s 超时。
- 代码定位：`e2e/perf/authenticated-perf.setup.ts:60`
- 建议：认证 helper 增加重试与错误文案采集，作为门禁前置健康检查。

## P1-2 计划产物 `test-results/perf/current-metrics.json` 未生成

- 现象：门禁用例运行后未发现 `test-results/perf/current-metrics.json`。
- 证据：执行 `find . -path '*current-metrics.json'` 返回空。
- 影响：与历史基线的自动指标归并缺失，后续比对依赖日志解析。
- 代码定位：`e2e/perf/perf-metrics.ts:4` 到 `e2e/perf/perf-metrics.ts:31`
- 建议：在 CI/本地运行后增加产物存在性断言，失败即中断流水线。

## P2-1 观测治理建议

- 建议统一追加：
  - `warm/cold` 样本标签
  - `login helper` 成功率
  - `resume metrics` 0ms 频率
- 目标：将当前“测试前置问题”和“真实性能退化”拆分为独立告警通道。

---

## 6. 与历史基线对比（2026-02-14 / 2026-02-07）

| 项目 | 2026-02-14 结论 | 2026-02-18 结果 | 状态 |
|---|---|---|---|
| `black_box_entries` 重复拉取 | 曾观测到 2 次 | 成功样本均为 1 次 | 已改善 |
| `rpc/get_full_project_data` 400 | 曾观测到 Access Denied | 成功样本均为 0 次 | 已改善 |
| pre-flow 大 chunk 提前下载 | 曾是高优问题 | 成功样本 `LargeChunks=0` | 已改善 |
| 弱网 LCP 退化（26s 级） | 曾显著超标 | 本次成功样本 448~596ms | 明显改善（但需继续做 cold-path 校验） |
| 页面卡死（2026-02-07） | 曾出现全局卡死 | 本次未复现 | 暂未复现 |
| 写入链路可测性 | 历史报告未突出 | 本次写入套件全部前置阻塞 | 新增风险 |

说明：本次“弱网预算成功样本”表现优于 2026-02-14，但存在样本抖动与写入套件前置阻塞，当前结论应视为“读路径稳定性提升、写路径覆盖不足”。

---

## 7. 清理与残留校验

- 结论：本次轻写压测未形成有效写入，残留测试数据计为 `0`。
- 依据：
  - `task-crud` 全部在 `add-task-btn` 点击前超时（未进入创建动作）
  - `sync-flow-lite` 也在前置交互阶段超时（未进入写入动作）
- 风险提示：若后续修复前置后重新执行，需重新做一次残留校验。

---

## 8. 后续实施顺序（建议）

1. 先修测试前置（认证 helper 统一化），恢复写路径可测性。
2. 修 `startup` 与 `resume` 两个门禁中的 0 值误判问题。
3. 补 `current-metrics.json` 产物校验，建立可回归的自动指标归档。
4. 修复后重跑同一批次（18 轮）并对比 `run-status.tsv` 与指标分布。

---

## 9. 修复后复测（2026-02-18）

### 9.1 修复落地清单

1. 统一认证前置与登录重试。
   - 新增：`e2e/shared/auth-helpers.ts`
   - 改造：`e2e/perf/authenticated-perf.setup.ts`、`e2e/critical-paths/helpers.ts`
2. `weak-network-startup` / `weak-network-budget` 改为分层门禁。
   - 改造：`e2e/perf/weak-network-startup.spec.ts`、`e2e/weak-network-budget.spec.ts`
   - 规则：`cold-path` 保持 `totalDataRequests > 0`；`warm-path` 允许 `0` 但记录 `warm_zero_fetch_flag`。
3. `resume.interaction_ready_ms` 抖动修复。
   - 改造：`src/services/app-lifecycle-orchestrator.service.ts`（优先 `performance.now()`）
   - 门禁：`e2e/perf/resume-budget.spec.ts` 从 `>0` 改为“数值有效 + 上限 + 结构性事件约束”。
4. 写路径可测性修复。
   - 改造：`e2e/critical-paths/task-crud.spec.ts`、`e2e/critical-paths/sync-flow.spec.ts`、`e2e/critical-paths/auth-flow.spec.ts`
   - 规则：操作前统一 `ensureEditorReady`，失败快速报错。
5. 指标与无回归守卫一致性修复。
   - 改造：`e2e/perf/perf-metrics.ts`、`scripts/perf-no-regression-guard.cjs`
6. 夜间/手动批量回归机制落地。
   - 新增：`scripts/run-perf-audit-batch.cjs`、`.github/workflows/perf-nightly-audit.yml`
   - 脚本：`package.json` 新增 `perf:audit:batch`。

### 9.2 本地复测（结构验证）

已完成：

1. Playwright 用例解析校验（`--list`）通过：
   - `e2e/perf/weak-network-startup.spec.ts`
   - `e2e/weak-network-budget.spec.ts`
   - `e2e/perf/resume-budget.spec.ts`
   - `e2e/critical-paths/auth-flow.spec.ts`
   - `e2e/critical-paths/task-crud.spec.ts`
   - `e2e/critical-paths/sync-flow.spec.ts`
2. 单测通过：
   - `npx vitest run src/services/app-lifecycle-orchestrator.service.spec.ts`
   - 结果：`12 passed / 0 failed`。

未完成（受环境凭据限制）：

1. 认证态弱网与云同步链路的真实执行复测（需 `E2E_PERF_*` / `TEST_USER_*`）。
2. 18 轮批次阈值判定的实跑结果归档。

### 9.3 复测执行指令与验收阈值

执行命令：

```bash
node scripts/run-perf-audit-batch.cjs --date=2026-02-18 --rounds=5 --strict-thresholds=1
```

产物：

1. `tmp/perf-audit/2026-02-18/run-status.tsv`
2. `test-results/perf/2026-02-18/run-status.tsv`
3. `test-results/perf/2026-02-18/summary.txt`

阈值：

1. warm-path zero-fetch 占比 `<= 40%`
2. 登录前置成功率 `>= 95%`
3. `resume.interaction_ready_ms=0` 频率 `<= 20%`

### 9.4 回滚点（按提交独立）

1. 认证前置问题回滚：`e2e/shared/auth-helpers.ts` 与 `e2e/critical-paths/helpers.ts`
2. 分层门禁回滚：`e2e/perf/weak-network-startup.spec.ts` 与 `e2e/weak-network-budget.spec.ts`
3. 恢复计时口径回滚：`src/services/app-lifecycle-orchestrator.service.ts`
4. 批量回归机制回滚：`scripts/run-perf-audit-batch.cjs` 与 `.github/workflows/perf-nightly-audit.yml`

附：值班执行手册 `docs/perf-gate-runbook.md`。
