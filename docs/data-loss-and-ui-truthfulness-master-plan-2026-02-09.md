# NanoFlow 数据丢失与 UI 真逻辑一致性治理策划案

> 版本: v1.0  
> 日期: 2026-02-09  
> 适用范围: `NanoFlow` Web（含线上站点 `https://dde-eight.vercel.app/#/projects`）  
> 审核目标: 深度排查数据丢失风险、确认“UI 是否只是摆件”并给出可执行治理方案

---

## 1. 背景与目标

本策划案基于本轮代码审计 + 线上实测形成，目标是：

1. 明确当前真实风险点（按严重度排序）。
2. 将风险转化为可落地的任务清单（含改造步骤、验收标准、测试覆盖）。
3. 在不破坏 Offline-first 体验前提下，提升“可恢复性、可观测性、可解释性”。

---

## 2. 本轮结论摘要（可作为立项依据）

### 2.1 已确认高优先问题

1. `保存到云端` 为占位逻辑，不执行真实云保存。  
关键位置:
- `src/app/features/flow/components/flow-view.component.ts:422`
- `src/app/features/flow/components/flow-view.component.html:116`
- `src/app/features/flow/components/flow-view.component.html:329`

2. `保存到云端` 点击后 UI 进入 `上传中...`，但缺少有效复位路径。  
关键位置:
- `src/app/features/flow/components/flow-toolbar.component.ts:335`
- `src/app/features/flow/components/flow-toolbar.component.ts:341`

3. 队列在存储压力/上限场景存在“新操作拒绝入队”或“仅内存兜底”窗口，极端情况下存在刷新/崩溃后丢失风险。  
关键位置:
- `src/services/action-queue.service.ts:155`
- `src/services/action-queue.service.ts:231`
- `src/services/action-queue-storage.service.ts:432`
- `src/app/core/services/sync/retry-queue.service.ts:238`
- `src/app/core/services/sync/retry-queue.service.ts:984`

### 2.2 已验证有效的保护机制

1. `content` 字段防丢失已在同步字段与转换层多重保护。  
关键位置:
- `src/config/sync.config.ts:145`
- `src/app/core/services/sync/project-data.service.ts:445`
- `src/services/delta-sync-coordinator.service.ts:131`

2. 远程变更合并具备字段锁与 LWW 保护。  
关键位置:
- `src/services/remote-change-handler.service.ts:523`

3. 线上实测（2026-02-09）验证通过:  
- 创建任务 -> 编辑 -> 刷新持久化  
- 离线编辑 -> 恢复网络 -> 刷新持久化

---

## 3. 总体治理策略

分 4 个工作流并行推进：

1. **WF-A: UI 真逻辑一致性治理（消除摆件）**
2. **WF-B: 同步队列耐久性加固（降低极端丢失窗口）**
3. **WF-C: 离线状态可见性与用户心智对齐**
4. **WF-D: 回归测试与上线守护（防回归）**

---

## 4. 任务清单（全面版）

## 4.1 WF-A: UI 真逻辑一致性治理

### A1. 替换 `saveToCloud` 占位逻辑为真实流程

- 现状:
  - `flow-view.saveToCloud()` 仅 toast。
- 目标:
  - 实际执行一次“云端保存/同步确认”流程（可用现有同步能力封装）。
- 任务项:
  1. 在 `flow-view` 中实现真实 `saveToCloud` orchestration。
  2. 失败时提供明确错误类型提示（网络、认证、配额、服务端）。
  3. 成功时返回可追踪结果（timestamp / revision / pendingCount）。
- 验收:
  - 点击后网络层存在真实请求。
  - 成功后显示“已保存到云端”，失败显示错误原因。

### A2. 修复工具栏 `上传中` 卡死状态

- 现状:
  - `onSaveToCloud()` 将 `isUploading=true`，但复位路径不完整。
- 任务项:
  1. 将 `saveToCloud` 事件改为 `Promise<Result>` 或 success/error 事件回传。
  2. `finally` 分支统一调用 `setUploadComplete()`。
  3. 增加超时保护，避免异常分支漏复位。
- 验收:
  - 成功/失败/超时三种路径都能自动退出 `上传中...`。

### A3. 建立“摆件扫描”机制

- 任务项:
  1. 扫描含 `TODO` 且绑定 click/output 的可视按钮。
  2. 在 CI 报告中输出“占位交互清单”。
  3. 对用户可见入口设置 `feature flag + disabled reason`，防止误导。
- 验收:
  - 关键入口不再出现“可点击但无业务动作”。

---

## 4.2 WF-B: 同步队列耐久性加固

### B1. 为 ActionQueue 增加持久化失败的强保障策略

- 现状:
  - `queueFrozen` 时内存兜底可接收，但刷新/崩溃风险上升。
- 任务项:
  1. 增加“冻结期间定时重试落盘 + 指数退避”。
  2. 增加“导出待同步操作 JSON”入口（逃生备份）。
  3. 将 `storage_failure` 状态可视化到 `sync-status`。
- 验收:
  - 配额不足场景下，用户可一键导出待同步数据。
  - 存储恢复后自动回写并解冻。

### B2. 为 RetryQueue 增加“绝对上限触发前预警 + 降载动作”

- 任务项:
  1. 在接近绝对上限前提前提示（例如 70/85/95% 分层）。
  2. 将高频冗余更新合并策略前置（减少无效排队）。
  3. 对“拒绝入队”事件进行结构化日志与埋点聚合。
- 验收:
  - 压测下拒绝入队次数明显下降。
  - 关键业务操作不被低优先级噪声挤压。

### B3. 离线快照存储升级评估（localStorage -> IDB）

- 现状:
  - `ProjectDataService` 离线快照仍是 localStorage。
- 任务项:
  1. 设计离线快照主存储迁移到 IndexedDB（保留 localStorage 兜底）。
  2. 迁移过程做版本与校验和保护。
  3. 大项目场景基准对比（容量、耗时、失败率）。
- 验收:
  - 大体量数据快照稳定性提升。

---

## 4.3 WF-C: 离线状态可见性与用户心智对齐

### C1. 统一离线提示语义（组件名 vs 实际行为）

- 现状:
  - `offline-banner` 实际只做 toast，无 banner。
- 任务项:
  1. 明确命名（保留现实现名或恢复真实横幅二选一）。
  2. 若保持 toast-only，则在 UI 中增加 persistent 状态点（例如 SyncStatus 红点 + 文案）。
  3. 更新 E2E 断言，避免“以为有 banner”误测。
- 验收:
  - 用户能持续感知“当前在线/离线/队列冻结”。

### C2. 增加“数据安全状态面板”

- 展示内容:
  - 本地待同步数量
  - 最近成功云同步时间
  - 存储压力状态
  - 是否存在未持久化内存操作
- 验收:
  - 用户可主动判断“现在刷新是否安全”。

---

## 4.4 WF-D: 测试与上线守护

### D1. 增加针对本次风险的自动化用例

- 单测:
  1. `saveToCloud` 成功/失败/超时复位测试。
  2. `queueFrozen` + 刷新前告警测试。
  3. `retryQueue` 软上限/绝对上限行为测试。
- E2E:
  1. 点击“保存到云端”应触发真实请求（非仅 toast）。
  2. 离线编辑恢复后数据一致性。
  3. 存储配额模拟下逃生导出可用。

### D2. 发布门禁

- 合入要求:
  - 关键测试全部通过。
  - 关键按钮无占位逻辑。
  - 无新增“拒绝入队”高频告警。

---

## 5. 验收标准（Definition of Done）

以下全部满足才算本期完成：

1. `保存到云端` 不再是 TODO/占位，且全路径复位 UI 状态。
2. 队列压力下可解释、可恢复、可导出，不出现“静默丢操作”。
3. 用户可见层能明确知道在线/离线/同步安全性。
4. 新增自动化测试覆盖本次发现风险，CI 稳定通过。

---

## 6. 里程碑建议（两周版）

### M1（D1-D3）: 快速止血

1. A1+A2 完成（真实保存 + 上传状态复位）
2. C1 完成（离线状态可见性统一）
3. 补最小回归测试

### M2（D4-D8）: 耐久加固

1. B1+B2 完成（队列冻结/上限治理）
2. D1 扩展测试矩阵

### M3（D9-D14）: 收敛与发布

1. B3 评估结论与落地方案
2. D2 门禁接入
3. 发布观察与回滚预案演练

---

## 7. 风险清单与应对

1. 风险: 增强持久化会引入性能开销  
应对: 分层写入 + 批量/防抖 + 指标监控

2. 风险: 真实云保存引发接口节流或并发冲突  
应对: 请求幂等键 + 节流 + 明确错误分级

3. 风险: 迁移离线快照触发老数据兼容问题  
应对: 双写灰度 + 版本迁移脚本 + 回退开关

---

## 8. 本次线上审计证据归档

- 审计报告: `/tmp/dde-live-audit/report.json`
- 截图证据: `/tmp/dde-live-audit/final-state.png`

建议将以上证据复制归档到仓库内 `docs/audit-evidence/`（按日期分目录），便于后续回归对比。

---

## 9. 附录：优先级任务总表（便于直接建 Issue）

1. `P1` 实装 `saveToCloud` 真实业务链路（替换 TODO）
2. `P1` 修复 flow-toolbar 上传中状态复位
3. `P1` ActionQueue 冻结期的落盘恢复与逃生导出
4. `P1` RetryQueue 上限前预警与降载
5. `P2` 离线状态可见性统一（toast-only 与命名/测试对齐）
6. `P2` 离线快照 IDB 主存储迁移评估
7. `P2` “摆件交互”扫描与 CI 报告机制
8. `P2` 新增 E2E/单测覆盖本轮风险路径

