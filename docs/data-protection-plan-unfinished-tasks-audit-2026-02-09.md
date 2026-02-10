# data-protection-plan 未完成任务全量审查（2026-02-09）

## 1. 审查范围与方法

- 审查对象：`docs/data-protection-plan.md`（4274 行）。
- 审查口径：
  - `明确未完成`：文档内仍出现 `❌/⚠️/待实现/需补充/部分覆盖` 且无后续“已完成”覆盖证据。
  - `可继续优化`：当前为“设计决策/可接受风险”，若继续推进可进一步降低风险。
  - `文档未同步`：同一文档内前后状态冲突（前文未完成，后文已完成）。

## 2. 总结结论

- 结论 1：核心 P0/P1/P2/P3 功能在文档后半段（`v5.13`~`v5.16`）已多次标注为“完成/验证”。
- 结论 2：当前真正的“待继续完成”集中在：
  - 可选增强（附件导出/导入能力、覆盖率补齐）；
  - 风险治理收敛（Guest 过期提醒、少数活跃风险）；
  - 文档状态同步（版本、指标、附录待修复清单明显过期）。
- 结论 3：你这份策划案的最大问题已从“功能未做”变成“文档多版本叠加导致真相不一致”。

## 3. A 类：真实待完成任务（工程项）

| ID | 未完成任务 | 证据 | 若继续完成的利 | 若继续完成的弊 |
|---|---|---|---|---|
| A1 | 软删除 TTL 强制执行（30 天后自动清理 + 关联检查） | `docs/data-protection-plan.md:921`, `docs/data-protection-plan.md:931` | 控制表膨胀、降低历史脏数据负担、提升长期查询性能 | 需谨慎定义“误清理”边界，运维复杂度上升 |
| A2 | L 章节“客户端不传 `updated_at`”适配 | `docs/data-protection-plan.md:31`, `docs/data-protection-plan.md:4188` | 与“服务端时间权威”完全一致，减少策略歧义 | 改动同步链路核心字段，回归成本高 |
| A3 | P0 集成测试补齐（当前标记部分覆盖） | `docs/data-protection-plan.md:3292` | 关键防线回归更可靠，降低线上回归概率 | 测试编排成本高，CI 时长增加 |
| A4 | P1 集成测试补齐（当前标记部分覆盖） | `docs/data-protection-plan.md:3312` | 导入/导出/恢复链路可信度提升 | 涉及文件 IO 和大数据样本，构造成本高 |
| A5 | P2 集成测试补齐（当前标记部分覆盖） | `docs/data-protection-plan.md:3334` | 备份恢复链路可验证性提升，RTO/RPO 更可证 | 需要稳定测试环境与模拟故障场景 |
| A6 | 附件导出（流式 ZIP） | `docs/data-protection-plan.md:3301` | 导出能力完整，灾备可用性提升 | 大文件/内存/并发复杂度明显增加 |
| A7 | 大文件下载进度 UI | `docs/data-protection-plan.md:3302` | 用户感知更好，降低“卡死误判” | 前端状态机复杂，边缘态较多 |
| A8 | 附件导入（分批） | `docs/data-protection-plan.md:3304` | 导入恢复完整闭环（含附件） | 上传重试、配额、失败补偿复杂 |
| A9 | 导出校验和（SHA-256）强化验真 | `docs/data-protection-plan.md:3305` | 导出文件可验真，降低损坏/篡改风险 | 计算耗时增加，超大项目影响导出耗时 |
| A10 | Guest 数据过期提醒增强 | `docs/data-protection-plan.md:3399`, `docs/data-protection-plan.md:2754` | 降低 Guest 数据“到期后主观丢失”投诉 | 提醒过频会打扰用户，需节流策略 |

## 4. B 类：可继续推进的风险优化项（当前为“可接受/设计决策”）

| ID | 风险优化项 | 证据 | 若继续完成的利 | 若继续完成的弊 |
|---|---|---|---|---|
| B1 | TabSync 从“仅警告”升级到“可阻止并发编辑” | `docs/data-protection-plan.md:26` | 降低并发覆盖概率 | 可能影响流畅性与用户自由度 |
| B2 | 迁移快照从单一备份升级为双备份一致策略 | `docs/data-protection-plan.md:29` | 迁移失败恢复成功率更高 | 存储与清理逻辑更复杂 |
| B3 | batch_upsert 与附件策略进一步统一（或明确定义边界） | `docs/data-protection-plan.md:35` | 开发者心智统一、文档更一致 | 可能破坏现有“附件独立 RPC 原子性”优势 |
| B4 | 字段锁“永久不同步”风险治理（自动解锁/告警） | `docs/data-protection-plan.md:3412` | 降低长期隐性不同步 | 误解锁可能引入覆盖风险 |
| B5 | replyKeepBoth 副本增长治理（上限/归档） | `docs/data-protection-plan.md:3413` | 控制存储增长，避免脏副本积累 | 需要定义副本合并策略，规则复杂 |
| B6 | 连接批量删除 AND 误删风险治理（精确匹配强约束） | `docs/data-protection-plan.md:3414` | 降低误删事故概率 | 对历史调用方兼容性有影响 |
| B7 | C 层误判为主备份的 UI 防呆强化 | `docs/data-protection-plan.md:3393` | 用户备份心智更准确 | 需要额外 UX 文案与引导成本 |
| B8 | 备份多区域/容灾策略（对象存储故障兜底） | `docs/data-protection-plan.md:3385` | 提升极端灾难韧性 | 成本和运维复杂度上升 |

## 5. C 类：文档本身待完成任务（强烈建议优先）

> 这类不是“代码未做”，而是“策划案真相不一致”，会直接影响后续决策质量。

| ID | 文档待完成任务 | 证据 | 若继续完成的利 | 若继续完成的弊 |
|---|---|---|---|---|
| C1 | 更新文档头部版本/状态（当前仍写 5.5、18%） | `docs/data-protection-plan.md:3`, `docs/data-protection-plan.md:5`, `docs/data-protection-plan.md:4274` | 一眼可读真实状态，避免误判“仍在早期阶段” | 需要通读全篇做一次统一改版 |
| C2 | 修正 C 层状态冲突（前文❌，后文✅） | `docs/data-protection-plan.md:64`, `docs/data-protection-plan.md:2059`, `docs/data-protection-plan.md:4245` | 消除执行优先级误导 | 需重构“状态总览”表 |
| C3 | 修正“当前最大风险”段落（仍是 v5.0 风险） | `docs/data-protection-plan.md:143`, `docs/data-protection-plan.md:147`, `docs/data-protection-plan.md:4271` | 让风险面板与真实实现一致 | 需重写该章节与优先级原则 |
| C4 | 修正成功指标（仍显示 0%/∞/未实现） | `docs/data-protection-plan.md:3435`, `docs/data-protection-plan.md:3438`, `docs/data-protection-plan.md:3443` | KPI 可作为真实管理基线 | 需要补齐最新观测口径与数据来源 |
| C5 | 清理附录 A 的“待修复/待创建”历史残留 | `docs/data-protection-plan.md:3472`, `docs/data-protection-plan.md:3496` | 避免团队重复做已完成工作 | 需逐项核对并迁移到“历史记录” |
| C6 | 清理附录 E 死代码描述（已在后续版本称修复） | `docs/data-protection-plan.md:3609`, `docs/data-protection-plan.md:4237` | 降低文档噪音，保持可信 | 需要补充“已迁移到何处”说明 |
| C7 | 修正 4.8/4.9 标题“需明确/需补充”与正文冲突 | `docs/data-protection-plan.md:2708`, `docs/data-protection-plan.md:2754` | 章节语义一致，读者不混乱 | 需要统一“决策已定 vs 功能未做”边界 |
| C8 | 对“可选增强”设置统一标签（未做/已做/放弃） | `docs/data-protection-plan.md:3301`, `docs/data-protection-plan.md:3308`, `docs/data-protection-plan.md:4274` | 避免同一任务多处冲突 | 需要全篇状态治理与标签规范 |

## 6. 建议执行顺序（从性价比看）

1. 先做 C 类文档同步（C1-C8），把“真实状态面板”校正。
2. 再做 A3-A5（集成测试补齐），建立回归护栏。
3. 再做 A1/A10（TTL 与 Guest 提醒），压长期风险。
4. 最后评估 A6-A9（附件导出导入增强）与 B 类风险优化，按业务价值分期。

## 7. 一句话结论

这份策划案的“未完成任务”并不主要是核心能力缺失，而是“可选增强 + 测试闭环 + 文档状态不一致”；若继续完成，收益最大的第一步是先完成文档治理，再补齐集成测试。

## 8. 核实后落实结果（2026-02-09）

> 依据代码库二次核实并已完成一轮落地优化（同日执行）。

### 8.1 已核实为“历史已修复”的项（非当前未完成）

- U7/U8：登出流程已调用 `onUserLogout()`，且 `clearAllLocalData()` 已清理 `sessionStorage`（`src/app/core/services/app-auth-coordinator.service.ts`, `src/services/user-session.service.ts`）。
- U9/U10：Flow 视图 `saveToCloud()` 已接入真实同步逻辑，Toolbar `isUploading` 已在 `finally` 与超时保护中复位（`src/app/features/flow/components/flow-view.component.ts`, `src/app/features/flow/components/flow-toolbar.component.ts`）。
- U12/U13：关键 Feature Flag 安全校验与首次离线加载通知已实现（`src/config/feature-flags.config.ts`, `src/app/shared/components/offline-banner.component.ts`）。

### 8.2 本次已新增落地优化

- A10（Guest 过期提醒增强）已实现：
  - 到期前 7 天提示；
  - 24 小时提醒节流；
  - 清理 Guest 数据时同步移除提醒节流键。
  - 代码位置：`src/services/migration.service.ts`
- A1（软删除 TTL）补齐运维接线脚本：
  - 新增 `pg_cron` 幂等配置脚本，调度 `cleanup_old_deleted_tasks()` / `cleanup_old_deleted_connections()` / `cleanup_old_logs()`。
  - 脚本位置：`scripts/cleanup-cron-setup.sql`
- A2（时间戳策略一致性）完成一项关键收口：
  - `pushProject` 不再上行 `updated_at`，改由服务端 `DEFAULT NOW() + trigger` 统一生成。
  - 代码位置：`src/app/core/services/simple-sync.service.ts`

### 8.3 回归测试结果

- `src/services/migration.service.spec.ts`：新增 Guest 到期提醒相关测试并通过（16 tests）。
- `src/app/core/services/simple-sync.service.spec.ts`：新增“`pushProject` 不上传客户端 `updated_at`”测试并通过（含现有用例总计 78 tests，64 skipped）。

### 8.4 本轮追加落地（第二轮）

- A6/A7/A8（附件导出导入闭环）已完成关键工程落地：
  - 设置页新增“附件备份（ZIP）”导出/导入入口与实时进度文案；
  - `AttachmentImportService` 补齐进度计数字段（completed/failed/skipped）；
  - ZIP 导入支持按 `projectId` 或 `taskId -> projectId` 自动分组后分批导入。
  - 代码位置：`src/app/shared/modals/settings-modal.component.ts`、`src/services/attachment-import.service.ts`
- P0 清理链路加固：
  - `AppAuthCoordinatorService.signOut()` 改为逐服务独立 `try/catch`，避免单个 `onUserLogout` 异常阻断后续清理；
  - `UserSessionService.clearAllLocalData()` 改为标准 `localStorage.length/key(i)` 枚举，修复偏好键残留风险。
  - 代码位置：`src/app/core/services/app-auth-coordinator.service.ts`、`src/services/user-session.service.ts`
- 一次性 SQL 脚本完善：
  - `init-supabase.sql` 升级为 3.7.0，明确自动 pg_cron 配置语义并清理过期说明；
  - `cleanup-cron-setup.sql` 升级为 1.1.0，改为 `DO $$` 原子校验 + 幂等重建 + 明确异常信息。
- 新增测试与回归：
  - `src/app/core/services/app-auth-coordinator.service.spec.ts`（真实 signOut 清理链路测试）
  - `src/services/user-session.service.spec.ts`（sessionStorage + 偏好键清理测试）
  - `src/services/attachment-roundtrip.integration.spec.ts`（附件 ZIP 导出→解析→导入闭环）
  - 回归命令：`npm run test:run -- ...`（9 文件通过，134 passed，64 skipped）
