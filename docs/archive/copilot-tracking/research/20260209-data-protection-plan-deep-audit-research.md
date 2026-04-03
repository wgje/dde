<!-- markdownlint-disable-file -->

# Task Research Notes: NanoFlow 数据保护方案 E++ 深度审计

> 研究日期: 2026-02-09
> 审查对象: `docs/data-protection-plan.md` (v5.5.0, 4275 行)
> 方法: 全量代码验证、逐项交叉验证、利弊分析

---

## Research Executed

### File Analysis

- `docs/data-protection-plan.md` — 完整通读 4275 行策划案
- `src/services/` — 90+ 服务文件验证存在性与核心实现
- `scripts/init-supabase.sql` — 验证数据库函数/触发器/表/RLS
- `supabase/functions/` — 验证 Edge Functions 存在性
- `e2e/data-protection.spec.ts` — 验证 E2E 测试覆盖
- `.copilot-tracking/research/20260209-data-loss-ui-truthfulness-research.md` — 交叉引用最新审计

### Code Search Results

- 核心服务全部验证存在:
  - `CircuitBreakerService` → `src/services/circuit-breaker.service.ts:133`
  - `ExportService` → `src/services/export.service.ts:213`
  - `ImportService` → `src/services/import.service.ts:172`
  - `RecoveryService` → `src/services/recovery.service.ts:107`
  - `LocalBackupService` → `src/services/local-backup.service.ts:53`
  - `StorageQuotaService` → `src/services/storage-quota.service.ts:65`
  - `IndexedDBHealthService` → `src/services/indexeddb-health.service.ts:73`
  - `ClockSyncService` → `src/services/clock-sync.service.ts:84`
  - `OfflineIntegrityService` → `src/services/offline-integrity.service.ts:112`
  - `PermissionDeniedHandlerService` → `src/services/permission-denied-handler.service.ts:46`
  - `VirusScanService` → `src/services/virus-scan.service.ts:77`
  - `FileTypeValidatorService` → `src/services/file-type-validator.service.ts:269`
  - `AttachmentExportService` → `src/services/attachment-export.service.ts` (有 spec 文件)
  - `AttachmentImportService` → `src/services/attachment-import.service.ts`
- 数据库函数/触发器验证（`init-supabase.sql`）:
  - `safe_delete_tasks` → L1580 ✅
  - `validate_task_data` → L2117 ✅
  - `circuit_breaker_logs` → L2159 ✅
  - `connection_tombstones` → L463-600 ✅
  - `prevent_tombstoned_connection_writes` → L527 ✅
- Edge Functions 验证存在:
  - `backup-full/`, `backup-incremental/`, `backup-cleanup/`, `backup-alert/`, `backup-attachments/`, `backup-restore/`, `cleanup-attachments/`, `virus-scan/` → 全部存在
- Cron 配置: `scripts/backup-cron-setup.sql` — pg_cron 配置存在但需手动启用

---

## Key Discoveries

## 一、未完成项目清单（经代码验证）

### 1.1 真正未完成的功能项

| 编号 | 功能项 | 策划案位置 | 当前状态 | 严重程度 |
|------|--------|-----------|---------|---------|
| **U1** | 软删除 TTL 自动清理 | §3.3 | ❌ 完全未实现：无 `cleanup-soft-deleted` Edge Function，无 `purge_expired_soft_deleted` RPC | LOW |
| **U2** | 附件导出流式 ZIP 打包 | §P1 任务表 | ⚠️ `AttachmentExportService` 已实现基础版(有 spec)，但策划案标注为"可选增强" | LOW |
| **U3** | 导出校验和（SHA-256） | §P1 任务表 | ⚠️ `ExportService` 已有 `calculateChecksum` 和 `ImportService` 有 `verifyChecksum`，但策划案标注为 ⚠️ | DONE(实际) |
| **U4** | 大文件下载进度条 | §P1 任务表 | ⚠️ 标注为"可选增强"，未实现 | LOW |
| **U5** | 导出提醒机制 | §P1 任务表 | ✅ 已实现 `needsExportReminder` signal + `app.component.ts:449` effect + Settings Modal 开关 | DONE |
| **U6** | E2E 集成测试覆盖不足 | §附录 G | ⚠️ `data-protection.spec.ts` 存在(18 test cases)但策划案定义了 30+ 场景，覆盖率约 50% | MEDIUM |
| **U7** | `onUserLogout()` 未调用 | 最新审计发现 | ❌ 三个服务的 `onUserLogout()` 从未在登出流程中被调用（跨用户数据泄露） | **HIGH** |
| **U8** | `sessionStorage` 登出后未清理 | 最新审计发现 | ❌ `undo.service.ts` 撤销历史残留 | **HIGH** |
| **U9** | `saveToCloud()` 按钮占位 | 最新审计发现 | ❌ flow-view 的"保存到云端"按钮仅 toast 提示"功能开发中" | MEDIUM |
| **U10** | `isUploading` 永久卡死 | 最新审计发现 | ❌ `setUploadComplete()` 全代码库无调用 | MEDIUM |
| **U11** | Guest 数据过期提醒不足 | §4.9 | ⚠️ 策划案 STATUS 标注为 ⚠️，代码仅有基础 30 天过期，无提前 7 天预警 | LOW |
| **U12** | Feature Flags 安全性校验 | 最新审计发现 | ❌ 关键保护性 flag 可被禁用且无 warning 日志 | LOW |
| **U13** | 首次离线加载无通知 | 最新审计发现 | ❌ `offline-banner` 仅监听状态变化，不检测初始状态 | LOW |

### 1.2 策划案标记"已完成"但实际有残留问题的项

| 编号 | 功能项 | 策划案声明 | 实际代码验证 | 差距 |
|------|--------|-----------|-------------|------|
| **R1** | 登出清理 | ✅ `clearAllLocalData()` | `clearAllLocalData()` 存在且清理 localStorage + IndexedDB，**但不调用** `onUserLogout()` | sessionStorage + 乐观快照未清理 |
| **R2** | 成功指标 | 声明 100% 达成 | 成功指标表中的目标（如 Critical=0, RPO≤15min）为**策划阶段目标**，非代码验证结果 | 成功指标数值未实际测量 |
| **R3** | 备份加密 | ✅ AES-256-GCM | Edge Function 代码存在，但密钥管理（轮换、多版本解密）**未验证** | 需运维环节确认 |

---

## 二、未完成原因深度分析

### U1: 软删除 TTL 自动清理 — 为何未完成
- **原因**: 属于运维层面任务，非客户端功能。`purge-deleted-tasks.sql` 脚本存在但需配合 pg_cron 手动启用，且 Supabase Free Plan 可能不支持 pg_cron
- **依赖**: pg_cron 扩展 + DBA 操作
- **风险评估**: 低。软删除记录仅占存储空间，不影响功能正确性。30 天内用户可从回收站恢复

### U6: E2E 测试覆盖不足 — 为何未完成
- **原因**: 策划案定义了 30+ E2E 场景，但实际测试环境搭建困难（需模拟 Supabase、JWT 过期、多设备等复杂场景）
- **现有覆盖**: 18 个测试用例覆盖核心路径（数据隔离、离线同步、熔断、导出导入、tombstone、配额、页面保护）
- **缺失场景**: 会话过期同步阻止、附件越权、批量失败回滚、Realtime 重连、JWT 刷新失败等

### U7/U8: onUserLogout 和 sessionStorage 清理 — 为何未完成
- **原因**: `clearAllLocalData()` 在 v5.5 实现时聚焦 localStorage + IndexedDB 两大存储，**遗漏了**内存级服务状态清理和 sessionStorage。策划案中"登出清理"的验证范围限于 localStorage 键和 IndexedDB
- **根本原因**: 策划案 §3.0.1 定义的清理清单未包含 sessionStorage 和服务内存状态

### U9/U10: saveToCloud 和 isUploading — 为何未完成
- **原因**: 这两项属于 flow-view 组件的 UI 层问题，不在数据保护策划案的覆盖范围内。策划案聚焦同步层/备份层/安全层，未涉及 UI 交互占位
- **发现来源**: 2026-02-09 最新 UI 真逻辑一致性审计

---

## 三、完成每个未完成项的利弊分析

### U1: 软删除 TTL 自动清理

| | 完成 | 不完成 |
|---|---|---|
| **利** | 自动释放数据库空间；符合 GDPR 数据保留最佳实践；减少扫描范围提升查询性能 | 无额外开发工时；回收站记录永久可恢复（用户友好） |
| **弊** | 需 pg_cron 或额外调度（Supabase Free tier 限制）；硬删除后不可恢复（风险点）；需集成测试验证级联（连接、附件、tombstone） | 存储缓慢增长（长期可能成为问题）；30 天后的 soft-deleted 数据仍被 IndexedDB 同步 |
| **建议** | 中期实施。短期可通过手动 SQL 脚本清理（`scripts/purge-deleted-tasks.sql` 已存在） | |
| **工时** | 4-6h（RPC 函数 + Edge Function/Cron + 集成测试） | |

### U6: E2E 测试补全（策划案 30+ 场景 vs 现有 18 场景）

| | 完成 | 不完成 |
|---|---|---|
| **利** | 关键安全场景自动化验证；每次部署前回归保障；覆盖多设备/JWT/Realtime 等难以手动测试的场景 | 节省 20-30h 开发工时；避免 Playwright CI 环境复杂度 |
| **弊** | 需搭建 Supabase mock/本地 Supabase 容器；CI 运行时间增长；维护成本（Supabase API 变更时需同步更新） | 无法自动化验证安全场景；回归依赖手动测试 |
| **建议** | 分批实施。优先补充 HIGH 优先级场景（会话过期阻止、附件越权、批量回滚）。低优先级场景（Realtime 重连、JWT 刷新）可后续加入 | |
| **工时** | 15-25h（约 12 个新场景，每个 1.5-2h） | |

### U7: onUserLogout() 未调用 — 跨用户数据泄露

| | 完成 | 不完成 |
|---|---|---|
| **利** | 修复跨用户数据泄露安全漏洞；乐观快照/撤销历史/附件缓存正确清理 | 无 |
| **弊** | 工时极低（0.5-1h） | **HIGH 安全风险**: 用户 B 可看到用户 A 的撤销历史和快照 |
| **建议** | **立即实施**。在 `AppAuthCoordinatorService.signOut()` 中添加对 `optimisticState.onUserLogout()`、`undo.onUserLogout()`、`attachment.onUserLogout()` 的调用 | |
| **工时** | 0.5-1h | |

### U8: sessionStorage 登出后未清理

| | 完成 | 不完成 |
|---|---|---|
| **利** | 撤销历史不泄露给下一个登入用户；sessionStorage 干净 | 无 |
| **弊** | 工时极低（0.5h） | 安全风险同 U7 |
| **建议** | **与 U7 一并实施**。在 `clearAllLocalData()` 末尾加 `sessionStorage.clear()` 兜底 | |
| **工时** | 0.5h（含在 U7 中） | |

### U9: saveToCloud() 占位按钮

| | 完成 | 不完成 |
|---|---|---|
| **利** | 消除用户困惑（点击无效但无明确错误）；完成流程图视图云端保存功能 | 不增加代码复杂度 |
| **弊** | 需定义"保存到云端"的准确语义（vs 自动同步）；实现可能与现有同步机制重复 | 用户可能多次点击后以为保存成功（实际未保存）|
| **建议** | **短期**: 移除按钮 或 改为明确的文案"数据自动保存中"。**长期**: 如需手动触发模式，需设计交互 | |
| **工时** | 移除按钮 0.5h / 实现功能 6-8h | |

### U10: isUploading 永久卡死

| | 完成 | 不完成 |
|---|---|---|
| **利** | 按钮状态正确反映上传进度；用户可重复触发 | 无 |
| **弊** | 工时极低 | 按钮点击一次后永久 disabled |
| **建议** | **立即修复**。在异步操作完成/失败的 callback 中调用 `setUploadComplete()` | |
| **工时** | 0.5h | |

### U11: Guest 数据过期提醒不足

| | 完成 | 不完成 |
|---|---|---|
| **利** | Guest 用户在数据过期前收到警告；减少"我的数据怎么没了"投诉 | 节省 1-2h 开发 |
| **弊** | 实现简单（定时检查 + toast） | Guest 数据 30 天后静默消失（目前仅有基础 30 天逻辑） |
| **建议** | 低优先级实施。Guest 模式用户量少，且登录提醒已有 | |
| **工时** | 1-2h | |

### U12: Feature Flags 安全性校验

| | 完成 | 不完成 |
|---|---|---|
| **利** | 防止误关闭关键保护（tombstone、同步持久性）；开发环境调试时有明确日志 | 节省 1h |
| **弊** | 工时低 | 开发者可能误禁关键保护，且无任何警告 |
| **建议** | 低优先级。在 `feature-flags.config.ts` 中为关键 flag 添加 `console.warn` | |
| **工时** | 1h | |

### U13: 首次离线加载无通知

| | 完成 | 不完成 |
|---|---|---|
| **利** | 用户首次离线启动 PWA 时知道自己处于离线状态 | 节省 0.5h |
| **弊** | 改动极小 | 离线首次加载时无提示（可能以为数据丢失） |
| **建议** | 低优先级。在 `offline-banner.component.ts` 的 `ngOnInit` 中添加初始状态检测 | |
| **工时** | 0.5h | |

---

## 四、策划案整体评估

### 4.1 策划案质量

| 维度 | 评分 | 说明 |
|------|------|------|
| **完整性** | ⭐⭐⭐⭐⭐ (5/5) | 覆盖了数据保护的全部关键层面：熔断、备份、导出、安全 |
| **代码一致性** | ⭐⭐⭐⭐ (4/5) | 95% 的"已实现"声明经代码验证确认。5% 有残留问题（U7/U8） |
| **版本追踪** | ⭐⭐⭐⭐⭐ (5/5) | 16 个版本详细变更记录，从 v1.0 到 v5.16，审计发现逐版修复 |
| **风险覆盖** | ⭐⭐⭐⭐ (4/5) | 40+ 风险项识别全面，但遗漏 UI 层问题（U9/U10）和清理遗漏（U7/U8） |
| **工时准确性** | ⭐⭐⭐⭐ (4/5) | 总工时预估 140-196h，实际通过 16 个版本迭代逐步完成，总体合理 |
| **架构设计** | ⭐⭐⭐⭐⭐ (5/5) | E/D/C 三层架构 + 熔断层设计合理，分级防护、费用可控 |

### 4.2 策划案核心成就

| 层级 | 目标 | 实现率 | 验证方式 |
|------|------|--------|---------|
| **P0 熔断层** | 11 项核心防护 | **100%** | 代码 + SQL 文件验证 |
| **P1 导出/导入 (D 层)** | 导出+导入+校验+提醒 | **95%** | 附件 ZIP 为"可选增强" |
| **P2 服务端备份 (E 层)** | 5 个 Edge Function + 恢复 | **100%** | 文件存在性验证 |
| **P3 坚果云备份 (C 层)** | LocalBackupService | **100%** | 代码验证 |
| **安全漏洞修复** | 19 Critical + 14 High | **95%** | U7/U8 为新发现残留 |

### 4.3 真实完成度总结

```
策划案声称完成度: 100%
代码验证完成度:   ~95%

未完成分类:
├── 安全残留 (HIGH):  2 项 — U7 onUserLogout, U8 sessionStorage
├── UI 占位 (MEDIUM): 2 项 — U9 saveToCloud, U10 isUploading  
├── 测试覆盖 (MEDIUM): 1 项 — U6 E2E 50% 覆盖
├── 运维任务 (LOW):   1 项 — U1 软删除 TTL
├── 可选增强 (LOW):   3 项 — U4 进度条, U11 Guest提醒, U12 Flag校验
└── 低优先级 (LOW):   1 项 — U13 首次离线通知
```

---

## Recommended Approach

### 立即修复（0 成本，高收益）
1. **U7+U8**: 修复 `onUserLogout()` 调用 + `sessionStorage.clear()` — **1h**
2. **U10**: 修复 `isUploading` 卡死 — **0.5h**

### 短期修复（低成本，中收益）
3. **U9**: 移除或修正 `saveToCloud` 占位按钮 — **0.5h**
4. **U13**: 首次离线检测 — **0.5h**
5. **U12**: Feature Flags 安全 warning — **1h**

### 中期改进（中等成本，高收益）
6. **U6**: 补充 12 个 HIGH 优先级 E2E 场景 — **15-25h**
7. **U1**: 实施软删除 TTL 清理 — **4-6h**

### 可选增强（可无限延后）
8. **U4**: 大文件下载进度条
9. **U11**: Guest 数据过期预警

---

## Implementation Guidance

- **Objectives**: 将策划案实际完成度从 95% 推至 99%+
- **Key Tasks**:
  1. U7+U8 在 `AppAuthCoordinatorService.signOut()` 中添加 3 个 `onUserLogout()` 调用 + `sessionStorage.clear()`
  2. U10 在 `saveToCloud()` 的 promise 链中调用 `setUploadComplete()`
  3. U6 优先编写会话过期同步阻止、附件越权、批量回滚 E2E
- **Dependencies**: U7/U8 无外部依赖；U6 需 Playwright 测试环境
- **Success Criteria**: U7/U8 修复后单元测试通过 + 登出后 sessionStorage 为空

---

## Execution Update（2026-02-09 同日落实）

### 已二次核实并确认为“已完成”的历史项

- U7/U8：已在登出链路落地（`AppAuthCoordinatorService.signOut` + `UserSessionService.clearAllLocalData`）。
- U9/U10：Flow 端 `saveToCloud` 与 `isUploading` 复位逻辑已具备。
- U12/U13：Feature Flags 安全告警与首次离线提示已具备。

### 本次新增实现

- **U1 / A1 TTL 调度接线**：
  - 新增 `scripts/cleanup-cron-setup.sql`，将已存在清理函数接入 `pg_cron`（幂等可重跑）。
- **U11 / A10 Guest 到期提醒增强**：
  - 到期前 7 天触发提醒；
  - 24 小时提醒节流；
  - 清理 Guest 数据时同步清除提醒键。
  - 代码：`src/services/migration.service.ts`
- **A2（部分）时间戳策略一致化**：
  - `pushProject` 不再上传客户端 `updated_at`，统一交给服务端触发器与默认值。
  - 代码：`src/app/core/services/simple-sync.service.ts`

### 测试验证

- `src/services/migration.service.spec.ts`：新增 Guest 到期提醒测试并通过。
- `src/app/core/services/simple-sync.service.spec.ts`：新增“`pushProject` 不上传 `updated_at`”测试并通过。
