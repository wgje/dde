# NanoFlow 数据保护策划案全量深度报告（独立版）

> 报告日期：2026-02-09  
> 报告对象：`docs/data-protection-plan.md`  
> 关联文档：`docs/data-protection-plan-unfinished-tasks-audit-2026-02-09.md`  
> 审查目标：在单一文档中给出“真实未完成事项 + 继续完成利弊 + 可执行落地路径”

---

## 0. 报告摘要（先看结论）

本次深度审查结论非常明确：

1. **核心能力并非主要短板**。策划案后半段（`v5.13~v5.16`）已经多次声明并验证 P0/P1/P2/P3 核心能力完成。  
2. **当前最大问题是“文档真相不一致”**。同一份文档中存在大量“前文未完成、后文已完成”的冲突表述。  
3. **真实待推进任务集中在三类**：
   - 工程增强（附件导入导出闭环、软删除 TTL、时间戳策略一致性）；
   - 测试补齐（P0/P1/P2 集成测试仍标注部分覆盖）；
   - 文档治理（版本、状态、指标、附录清单的全量同步）。
4. **若继续推进，收益最大优先级不是先写新功能，而是先修正文档基线**，否则执行会持续跑偏。

---

## 1. 审查范围与方法

### 1.1 审查范围

- 主文档：`docs/data-protection-plan.md`（4274 行）
- 已生成中间审查文档：`docs/data-protection-plan-unfinished-tasks-audit-2026-02-09.md`
- 代码抽样核验文件：
  - `src/services/export.service.ts`
  - `src/services/import.service.ts`
  - `src/app.component.ts`
  - `src/config/`
  - `e2e/*.spec.ts`

### 1.2 审查方法

- 文档全量关键词扫描：`❌ / ⚠️ / 待实现 / 需补充 / 部分覆盖 / 可选增强 / 设计决策`。
- 章节级冲突比对：前文“未实现”与后文“已完成”交叉核验。
- 代码抽样验证：对最关键争议点做存在性与行为级别核验。
- 结果分级：
  - `A类` 真实待完成工程项
  - `B类` 可继续优化项（设计决策/可接受风险）
  - `C类` 文档治理项（状态同步）

---

## 2. 关键事实证据（原文冲突与现状）

### 2.1 头部状态与后文状态冲突

- 头部仍写：版本 5.5.0、整体约 18%、存在 Critical 漏洞。  
  证据：`docs/data-protection-plan.md:3` `docs/data-protection-plan.md:5`
- 但后文写到 `v5.13/v5.14/v5.15/v5.16`，并声明大量完成项与全量验证。  
  证据：`docs/data-protection-plan.md:4243` `docs/data-protection-plan.md:4244` `docs/data-protection-plan.md:4245` `docs/data-protection-plan.md:4274`

### 2.2 C 层状态冲突

- 状态总览中写 C 层“❌ 未实现”。  
  证据：`docs/data-protection-plan.md:64`
- P3 章节与变更记录中写 C 层“✅ 已实现（v5.15）”。  
  证据：`docs/data-protection-plan.md:2059` `docs/data-protection-plan.md:4245`

### 2.3 “当前最大风险”段落过期

- 文档仍将 v5.0/v5.3 阶段漏洞列为“当前最大风险”。  
  证据：`docs/data-protection-plan.md:143` `docs/data-protection-plan.md:147`
- 但后文审计显示大量项已修复。  
  证据：`docs/data-protection-plan.md:4243`

### 2.4 成功指标明显过期

- 成功指标表仍显示 Critical=19、熔断实现率 18%、RPO/RTO 为 ∞、用户导出率 0%。  
  证据：`docs/data-protection-plan.md:3435` `docs/data-protection-plan.md:3438` `docs/data-protection-plan.md:3443`
- 与后文“核心实现率 100%”叙述冲突。  
  证据：`docs/data-protection-plan.md:4244`

### 2.5 附录 A/E 大量历史“待修复/待创建/待清理”未同步

- 附录 A 仍列出大量“待修复”项，但同文后段显示已完成。  
  证据：`docs/data-protection-plan.md:3472`
- 附录 A 仍列“待创建”服务/函数，实仓库已存在绝大多数。  
  证据：`docs/data-protection-plan.md:3496`
- 附录 E 仍列死代码待清理，但后文已标注完成。  
  证据：`docs/data-protection-plan.md:3609` `docs/data-protection-plan.md:4237`

---

## 3. 代码抽样核验（防止纯文档误判）

### 3.1 导出功能核验

- 已实现导出校验和（SHA-256 + fallback hash）。  
  证据：`src/services/export.service.ts:331` `src/services/export.service.ts:333` `src/services/export.service.ts:581`
- 已包含附件元数据，但不是附件二进制导出；URL 可能过期。  
  证据：`src/services/export.service.ts:535` `src/services/export.service.ts:544`

### 3.2 导入功能核验

- 导入附件目前仅保留元数据，`url` 置空，需重新上传链路。  
  证据：`src/services/import.service.ts:612` `src/services/import.service.ts:619`

### 3.3 导出提醒核验

- 导出提醒信号已在 App 级 effect 接线。  
  证据：`src/services/export.service.ts:232` `src/app.component.ts:447` `src/app.component.ts:449`

### 3.4 配置/服务存在性核验（针对“待创建”）

- 实际已存在：
  - `src/services/circuit-breaker.service.ts`
  - `src/services/export.service.ts`
  - `src/services/import.service.ts`
  - `src/services/local-backup.service.ts`
  - `src/services/offline-integrity.service.ts`
  - `src/services/permission-denied-handler.service.ts`
  - `src/services/storage-quota.service.ts`
  - `supabase/functions/backup-full`
  - `supabase/functions/backup-incremental`
  - `src/services/recovery.service.ts`
  - `src/services/indexeddb-health.service.ts`
  - `src/config/feature-flags.config.ts`
- 仍不存在（按附录命名）：
  - `src/config/circuit-breaker.config.ts`
  - `src/config/storage.config.ts`
  - `src/config/backup.config.ts`
- 结论：附录“待创建”多数已过期，少数命名已被现有配置体系替代。

### 3.5 E2E 覆盖抽样

- E2E 文件存在且覆盖离线、导出导入、同步完整性等路径。  
  证据：`e2e/critical-paths.spec.ts` `e2e/sync-integrity.spec.ts` `e2e/data-protection.spec.ts`
- 但策划案仍标“部分覆盖”，应以实际测试矩阵重新对齐。

---

## 4. 未完成任务全量清单（最详细）

## 4.1 A 类：真实待完成工程项（建议优先处理）

| ID | 任务 | 当前状态 | 证据 | 依赖 | 预估工时 | 继续完成的利 | 继续完成的弊 | 建议优先级 |
|---|---|---|---|---|---|---|---|---|
| A1 | 软删除 TTL 强制执行（含关联检查） | 未完成 | `docs/data-protection-plan.md:931` | 清理 RPC + 定时任务 + 审计日志 | 4-8h | 控制软删除数据膨胀，降低历史脏数据成本 | 误清理风险，需严格回滚机制 | P1 |
| A2 | 推送不传 `updated_at`（L 章节目标态） | 未完成 | `docs/data-protection-plan.md:31` `docs/data-protection-plan.md:4188` | 同步链路回归测试 | 3-6h | 时间戳策略一致，减少歧义 | 核心同步链路改动，回归成本高 | P1 |
| A3 | P0 集成测试补齐 | 部分覆盖 | `docs/data-protection-plan.md:3292` | E2E 场景基线 | 6-12h | 防止安全与同步回归 | CI 时间增加 | P1 |
| A4 | P1 集成测试补齐 | 部分覆盖 | `docs/data-protection-plan.md:3312` | 导入导出/迁移场景脚手架 | 4-10h | 逃生舱链路更可信 | 场景构造复杂 | P2 |
| A5 | P2 集成测试补齐 | 部分覆盖 | `docs/data-protection-plan.md:3334` | 备份/恢复沙箱环境 | 8-16h | RTO/RPO 可验证 | 需要稳定 mock/staging | P2 |
| A6 | 附件导出（流式 ZIP + 大文件策略） | 未完成（可选增强） | `docs/data-protection-plan.md:3301` | Storage 下载管线、内存限流 | 10-20h | 备份恢复能力从“元数据”升级到“可离线恢复文件” | 实现复杂，失败补偿复杂 | P2 |
| A7 | 大文件下载进度（针对附件导出） | 未完成（可选增强） | `docs/data-protection-plan.md:3302` | A6 | 2-4h | 用户感知更可控 | UI 状态复杂化 | P3 |
| A8 | 附件导入（分批重传 + 配额治理） | 未完成（可选增强） | `docs/data-protection-plan.md:3304` `src/services/import.service.ts:619` | A6、上传重试策略 | 8-18h | 导入闭环完整 | 上传错误面与补偿复杂 | P2 |
| A9 | Guest 数据过期提醒增强 | 部分完成（提醒不足） | `docs/data-protection-plan.md:3399` | Toast 节流、首页提示策略 | 2-6h | 降低 Guest 到期数据争议 | 可能增加提示骚扰 | P2 |

### A 类统一验收标准

- A1：存在定时清理任务，且删除前后审计链可追溯；误删可恢复。  
- A2：客户端上行 payload 不含 `updated_at`，冲突/LWW 测试通过。  
- A3-A5：策划案中 P0/P1/P2 标注由“部分覆盖”改为“已覆盖”，并有用例清单链接。  
- A6-A8：导出文件可恢复附件原文件，不依赖过期 URL。  
- A9：Guest 过期前至少一次明确提示（可导出/可登录迁移）。

---

## 4.2 B 类：继续优化项（当前属于设计决策或可接受风险）

| ID | 优化项 | 当前状态 | 证据 | 继续完成的利 | 继续完成的弊 | 建议 |
|---|---|---|---|---|---|---|
| B1 | TabSync 从“仅警告”升级“可阻止并发编辑” | 设计决策保留警告 | `docs/data-protection-plan.md:26` | 减少并发覆盖 | 可能影响编辑自由度 | 先灰度到可选模式 |
| B2 | 迁移快照双备份一致化 | 当前单一备份可接受 | `docs/data-protection-plan.md:29` | 提升迁移失败恢复率 | 存储与清理复杂度上升 | 按大项目用户灰度 |
| B3 | 字段锁长期不同步治理 | 可接受风险 | `docs/data-protection-plan.md:3412` | 降低长期偏差 | 自动解锁可能误覆盖 | 先做超时告警 |
| B4 | replyKeepBoth 副本增长控制 | 可接受风险 | `docs/data-protection-plan.md:3413` | 控制存储增长 | 合并策略复杂 | 做副本上限 + 告警 |
| B5 | 连接批量删除误删防护 | 需监控 | `docs/data-protection-plan.md:3414` | 降低误删事故 | 老逻辑兼容改造成本 | 新接口强约束，旧接口逐步下线 |
| B6 | C 层“非主备份”认知强化 | 风险存在 | `docs/data-protection-plan.md:3393` | 用户心智更准确 | 需补 UI 文案与帮助文档 | 高优先 UX 文案修正 |
| B7 | 对象存储多区域容灾 | 可选 | `docs/data-protection-plan.md:3385` | 强化灾难韧性 | 成本上升 | 业务量上来后再做 |

---

## 4.3 C 类：文档治理待完成项（优先级应高于新增功能）

| ID | 文档任务 | 现状问题 | 证据 | 完成后的收益 | 不完成的后果 | 建议优先级 |
|---|---|---|---|---|---|---|
| C1 | 更新文档头部版本与状态 | 仍停留 v5.5、18% | `docs/data-protection-plan.md:3` `docs/data-protection-plan.md:5` | 管理层一眼看到真实进度 | 继续误判为“核心未做” | P0 |
| C2 | 统一 C 层状态 | 前文❌后文✅ | `docs/data-protection-plan.md:64` `docs/data-protection-plan.md:2059` | 资源配置不再冲突 | 继续拉偏优先级 | P0 |
| C3 | 重写“当前最大风险”章节 | 仍以旧漏洞为当前 | `docs/data-protection-plan.md:143` | 风险治理聚焦真实问题 | 团队持续围绕过时风险讨论 | P0 |
| C4 | 重写成功指标表 | KPI 严重过期 | `docs/data-protection-plan.md:3435` | 指标可用于周报/里程碑 | KPI 失真导致决策错误 | P0 |
| C5 | 清理附录 A “待修复/待创建” | 大量历史残留 | `docs/data-protection-plan.md:3472` `docs/data-protection-plan.md:3496` | 防止重复造轮子 | 团队重复劳动 | P0 |
| C6 | 清理附录 E 死代码项 | 与后文“已清理”冲突 | `docs/data-protection-plan.md:3609` `docs/data-protection-plan.md:4237` | 文档可信度恢复 | 持续制造噪音 | P1 |
| C7 | 修正 4.8/4.9 标题语义 | 标题“需明确/需补充”与正文决策矛盾 | `docs/data-protection-plan.md:2708` `docs/data-protection-plan.md:2754` | 阅读一致性提升 | 评审误解频发 | P1 |
| C8 | 给“可选增强”统一状态标签 | 多处状态冲突 | `docs/data-protection-plan.md:3301` `docs/data-protection-plan.md:4245` | 迭代边界清晰 | 需求范围持续漂移 | P1 |

---

## 5. 冲突矩阵（详细）

| 冲突编号 | 冲突描述 | 前文 | 后文 | 判定 |
|---|---|---|---|---|
| X1 | 文档总状态冲突 | “部分实施 18%” | “核心功能 100%” | 必须以最新审计版本为准，并更新头部 |
| X2 | C 层实现状态冲突 | “C 层未实现” | “P3 已实现” | 前文过期 |
| X3 | 风险基线冲突 | “当前最大风险为旧 Critical 清单” | “v5.13 已修复多数项” | 风险章节过期 |
| X4 | 成功指标冲突 | “RPO/RTO=∞、导出率0%” | 后文已实现备份/导出提醒 | 指标章节过期 |
| X5 | 附录待修复冲突 | 附录列大量待修复 | 变更记录写已修复 | 附录过期 |
| X6 | 导出校验和状态冲突 | 任务表标“可选增强” | 代码已计算 checksum | 需改为“已实现”或明确差异 |
| X7 | 导出提醒状态冲突 | 任务表标“可选增强” | App 已接线提醒 | 需改为“已实现” |
| X8 | Undo/Guest 章节语义冲突 | 标题“需明确/需补充” | 正文已有明确决策 | 标题需改写 |

---

## 6. 继续完成“利弊总览”（按类别）

### 6.1 继续做工程增强（A 类）

- 利：
  - 从“核心可用”提升到“灾备闭环完整”。
  - 把当前剩余风险从“用户感知问题”降到“可观测且可控问题”。
  - 为后续商业化/大客户审计准备更强证据链。
- 弊：
  - 对同步、导出、恢复链路改造成本高。
  - 集成测试与附件链路会显著增加维护成本。
  - 若文档先不治理，新增开发会被过期策划牵着走。

### 6.2 继续做风险优化（B 类）

- 利：
  - 进一步压缩极低概率高影响问题。
  - 降低长期技术债滚雪球。
- 弊：
  - 可能牺牲部分产品体验（如并发阻止策略）。
  - 需要更复杂策略与更多开关治理。

### 6.3 继续做文档治理（C 类）

- 利：
  - 立即提升执行效率和跨团队沟通质量。
  - 降低重复开发和误判优先级风险。
  - 成本最低、收益最快。
- 弊：
  - 短期不直接产出新功能。
  - 需要一次性全篇清洗，编辑工作量大。

---

## 7. 建议执行路线（带绝对日期）

> 当前日期为 **2026-02-09**，以下路线按自然周编排。

### 阶段 0（2026-02-10 至 2026-02-11）：文档基线修复

- 完成 C1-C8。
- 产出：
  - 单一真实状态页（总览、风险、指标、附录一致）。
  - “已完成/可选增强/待实施”三态标签规范。

### 阶段 1（2026-02-12 至 2026-02-16）：测试护栏补齐

- 完成 A3-A5。
- 产出：
  - P0/P1/P2 集成测试矩阵与通过证据。
  - 将“部分覆盖”替换为可量化覆盖率说明。

### 阶段 2（2026-02-17 至 2026-02-22）：高价值工程收口

- 完成 A1（TTL）、A9（Guest 提醒）、A2（时间戳策略一致化）。
- 产出：
  - 数据生命周期闭环。
  - 客户端/服务端时间戳策略单一真相。

### 阶段 3（2026-02-23 至 2026-03-06）：可选增强排期

- 评估并分期 A6-A8 与 B 类风险优化。
- 产出：
  - 附件导入导出路线图（若进入实施）。
  - 风险项灰度计划。

---

## 8. 决策建议（管理视角）

### 8.1 必做（本期）

- C 类全部（文档基线修复）。
- A3-A5（测试补齐）。
- A1 或 A9 至少完成一项（建议先 A9，投入更小、用户感知更直接）。

### 8.2 可延后（下期）

- A6-A8（附件导出导入闭环）。
- B7（多区域容灾）。

### 8.3 明确不做（除非策略变更）

- 将 C 层提升为主备份（与当前架构哲学冲突）。
- 在无灰度机制下直接启用“强阻止并发编辑”。

---

## 9. 本报告对应的“任务卡模板”（可直接建 Issue）

| 字段 | 模板建议 |
|---|---|
| 标题 | `[DataProtection][A1] 软删除 TTL 清理与关联安全检查` |
| 背景 | 引用本报告章节与证据行号 |
| 目标 | 明确“完成定义（DoD）” |
| 范围 | 列出涉及服务/配置/SQL/测试 |
| 风险 | 列出误删、回归、性能风险 |
| 验收 | 自动化测试 + 手工验收 + 监控指标 |
| 回滚 | 功能开关 / SQL 回滚脚本 / 数据恢复路径 |

---

## 10. 最终结论

`data-protection-plan.md` 当前的核心问题不是“系统没有实现”，而是“策划文档没有跟上实现状态”。

如果继续推进，最优策略是：

1. 先修文档基线；
2. 再补测试护栏；
3. 最后做附件链路等高复杂增强。

这条路径在投入、风险、收益三者之间最均衡。

---

## 11. 当日执行落地更新（2026-02-09）

### 11.1 代码核实结论修正

- 本报告 A 类之外的部分“未完成”条目，在代码中已确认完成：
  - 登出清理链路（`onUserLogout + sessionStorage`）；
  - Flow `saveToCloud` 实逻辑与上传状态复位；
  - Feature Flag 安全校验；
  - 首次离线加载提示。

### 11.2 已完成新增改进

- A1（TTL）运维接线补齐：
  - 新增 `scripts/cleanup-cron-setup.sql`，为软删除任务/连接及清理日志配置 `pg_cron` 定时任务（幂等可重跑）。
- Guest 过期提醒增强已落地：
  - 到期前 7 天提醒；
  - 24h 节流防骚扰；
  - 清理 Guest 数据时同步清理提醒节流键。
  - 文件：`src/services/migration.service.ts`
- 时间戳策略一致性收口（A2 局部）：
  - `pushProject` 已移除客户端 `updated_at` 上行，改由服务端统一生成。
  - 文件：`src/app/core/services/simple-sync.service.ts`

### 11.3 测试回归结果

- `npm run test:run:services -- src/services/migration.service.spec.ts src/app/core/services/simple-sync.service.spec.ts`
- 结果：2 个测试文件通过；新增提醒与时间戳策略测试通过。

### 11.4 第二轮落地补充（同日）

- 一次性 SQL 初始化完善：
  - `scripts/init-supabase.sql` 升级到 `3.7.0`，新增并固化“自动尝试配置 pg_cron 清理任务（幂等+容错）”语义；
  - `scripts/cleanup-cron-setup.sql` 升级到 `1.1.0`，采用原子 `DO $$` 流程（扩展可用性校验 + 函数存在性校验 + 幂等重建）。
- 附件导出导入闭环落地（A6/A7/A8）：
  - Settings Modal 新增“附件备份（ZIP）”导出/导入入口与进度反馈；
  - `AttachmentImportService` 进度状态补齐 completed/failed/skipped 计数；
  - 新增跨服务闭环测试：`attachment-roundtrip.integration.spec.ts`（导出 ZIP → 解析 → 导入挂载）。
- 安全清理链路进一步收敛（P0）：
  - `signOut()` 清理改为逐服务独立容错，避免单点异常阻断；
  - `clearAllLocalData()` 修复 `localStorage` 键枚举方式，避免偏好键残留。
- 回归结果（第二轮）：
  - `npm run test:run -- src/services/attachment-export.service.spec.ts src/services/attachment-import.service.spec.ts src/services/attachment-roundtrip.integration.spec.ts src/services/export.service.spec.ts src/services/import.service.spec.ts src/services/migration.service.spec.ts src/services/user-session.service.spec.ts src/app/core/services/simple-sync.service.spec.ts src/app/core/services/app-auth-coordinator.service.spec.ts`
  - 结果：9 文件通过，`134 passed / 64 skipped`。
