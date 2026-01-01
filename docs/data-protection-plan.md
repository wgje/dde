# NanoFlow 数据保护方案 E++ 实施计划

> **版本**: 5.4.0  
> **日期**: 2026-01-01  
> **状态**: 部分实施（熔断层 3/11 项，整体约 18%，存在 Critical 级安全漏洞）  
> **上次审查**: 2026-01-01  
> **审查状态**: 🟢 七次深度审查后修订（修正 3 个误报问题，新增 5 个 Critical、7 个 High 级问题，调整工时）

---

## 🚨 重要警告：代码实现验证

> **本策划案部分描述与实际代码不一致，实施前必须验证以下关键代码位置：**

| 问题 | 策划案描述 | 实际代码状态 | 验证位置 |
|------|-----------|-------------|----------|
| **登出清理** | 要求清理 IndexedDB/localStorage | `AuthService.signOut()` 仅清理信号状态 | `src/services/auth.service.ts#L385-L406` |
| **clearLocalData 不完整** | 要求清理 8 个 localStorage 键 | 仅清理信号和 retryQueue 内存 | `src/services/user-session.service.ts#L150-L155` |
| **clearOfflineCache 不完整** | 要求清理 localStorage | 仅清理内存中的 retryQueue | `src/app/core/services/simple-sync.service.ts#L2655-L2659` |
| **sessionExpired 检查** | 要求入口阻止同步 | `pushTask`/`pushProject` 无任何检查 | `src/app/core/services/simple-sync.service.ts` |
| **附件 RPC 权限** | 要求项目归属校验 | 函数内无 `auth.uid()` 校验 | `scripts/attachment-rpc.sql` |
| **路由离开保护** | 定义了 CanDeactivate Guard | 项目中完全不存在 | 需新建 `src/services/guards/` |
| **TabSyncService 并发保护** | 多标签页编辑保护 | 仅通知警告，无实际保护 | `src/services/tab-sync.service.ts` |
| **beforeunload 处理器冲突** | 统一处理器 | 存在两个独立监听器 | `app.component.ts` + `persistence-failure-handler.service.ts` |
| **EscapePod 已存在** | D 层手动导出 ❌ | 脏数据逃生舱已实现（非完整导出） | `src/services/persistence-failure-handler.service.ts#L47-L60` |
| **迁移快照未实现** | K 章节定义 sessionStorage + localStorage 双备份 | `migration.service.ts` 仅使用 `nanoflow.guest-data`，无快照逻辑 | `src/services/migration.service.ts` |
| **Safari 处理未实现** | M 章节定义 `handleSafariBrowser()` | 代码库中无任何 Safari 特殊处理实现 | 需新建 `src/services/safari-handler.service.ts` |
| **L 章节时间策略** | 推送时不传 `updated_at` | 代码仍发送 `task.updatedAt \|\| nowISO()` | `src/app/core/services/simple-sync.service.ts#L654` |
| **🆕 离线缓存键不一致** | 统一使用 `nanoflow.offline-cache-v2` | 存在两个不同的键定义 | `sync.config.ts#L155` vs `simple-sync.service.ts#L2663` |
| **🆕 RetryQueue sessionExpired** | 重试前检查会话状态 | 重试逻辑无 sessionExpired 检查 | `src/app/core/services/simple-sync.service.ts#L1714` |
| **🆕 附件 RPC SQL 表结构** | 通过 tasks.project_id 关联 | 需验证 tasks 表是否有 project_id 列 | `scripts/attachment-rpc.sql` |
| **🆕 batch_upsert_tasks 缺少 attachments** | 包含所有字段 | 未处理 attachments 字段 | `docs/data-protection-plan.md#H.2` |
| **🆕 RetryQueue 优先级排序已实现** | 标记为未实现 | **✅ 已在 #L1652-1658 实现排序** | `src/app/core/services/simple-sync.service.ts#L1652` |
| **🆕 Tombstone DELETE 策略不存在** | 标记需移除 DELETE 策略 | **✅ init-database.sql 无 DELETE 策略** | `scripts/init-database.sql#L224-235` |
| **🆕 clearLocalData 无 localStorage 清理** | 要求清理 8 个键 | **❌ 仅清理内存状态，无 localStorage.removeItem** | `src/services/user-session.service.ts#L150-155` |
| **🆕 onAuthStateChange 未监听** | JWT 刷新失败需监听 | **❌ 代码中无 onAuthStateChange 订阅** | `src/services/auth.service.ts` |
| **🆕 pagehide/visibilitychange 未实现** | Safari 兼容 | **❌ 代码中无任何监听器** | `src/app.component.ts` |
| **🆕 Realtime 重连状态未追踪** | 定义 previousRealtimeStatus | **❌ subscribe 回调未保存状态** | `src/app/core/services/simple-sync.service.ts#L2102` |

---

## 实现状态总览

| 层级 | 功能模块 | 状态 | 说明 |
|------|----------|------|------|
| **熔断层** | Tombstone 防复活 | ✅ 已实现 | 数据库触发器阻止已删除任务复活 |
| **熔断层** | 网络层 Circuit Breaker | ✅ 已实现 | 连续失败自动熔断 |
| **熔断层** | 空数据拒写 | ❌ 未实现 | **P0 关键缺失** |
| **熔断层** | 任务数骤降检测 | ❌ 未实现 | **P0 关键缺失** |
| **熔断层** | 服务端批量删除防护 | ❌ 未实现 | **P0 关键缺失** |
| **熔断层** | 服务端字段校验触发器 | ❌ 未实现 | **P0 关键缺失** |
| **熔断层** | Connection Tombstone | ❌ 未实现 | **P0 关键缺失** |
| **熔断层** | 乐观锁/版本强制 | ⚠️ 部分实现 | 仅警告不拒绝 |
| **熔断层** | 会话过期数据保护 | ❌ 未实现 | **P0 紧急：pushTask 入口无检查** |
| **熔断层** | 会话过期入口检查 | ❌ 未实现 | **P0 紧急：代码中完全不存在** |
| **D 层** | 手动导出 | ❌ 未实现 | 逃生舱不可用 |
| **D 层** | 手动导入 | ❌ 未实现 | 逃生舱不可用 |
| **E 层** | 服务端全量备份 | ❌ 未实现 | 主保险不存在 |
| **E 层** | 服务端增量备份 | ❌ 未实现 | 主保险不存在 |
| **E 层** | 恢复服务 | ❌ 未实现 | 主保险不存在 |
| **C 层** | 坚果云备份 | ❌ 未实现 | 可选增强 |
| **辅助** | beforeunload 数据保存 | ✅ 已实现 | 页面关闭前刷新队列 |
| **辅助** | RetryQueue 持久化 | ✅ 已实现 | 离线变更不丢失 |
| **辅助** | 字段级锁 | ✅ 已实现 | 防止远程更新覆盖正在编辑的字段 |
| **辅助** | LWW 冲突解决 | ✅ 已实现 | 支持 local/remote/merge 策略 |
| **辅助** | 多标签页同步 | ⚠️ 部分实现 | 仅通知不阻止并发 |
| **辅助** | 存储配额保护 | ⚠️ 部分实现 | 仅 RetryQueue 有保护，主数据无 |
| **辅助** | 乐观更新统一回滚 | ⚠️ 部分实现 | 未在所有写入操作中统一使用 |
| **辅助** | RLS 权限拒绝数据保全 | ❌ 未实现 | 被拒数据直接丢弃 |
| **辅助** | IndexedDB 损坏恢复 | ❌ 未实现 | 无检测和恢复机制 |
| **辅助** | 时钟偏移校验 | ❌ 未实现 | LWW 依赖客户端时钟 |
| **辅助** | 附件 URL 自动刷新 | ✅ 已实现 | `AttachmentService` 定时刷新即将过期 URL |
| **辅助** | IndexedDB 恢复时过滤已删除 | ✅ 已实现 | `StorePersistenceService.loadProject()` 过滤 deletedAt |
| **辅助** | 数据迁移安全 | ❌ 未实现 | **P0.5 紧急：无快照+无确认+无回滚** |
| **辅助** | 路由离开保护 | ❌ 未实现 | CanDeactivate Guard 完全不存在 |
| **安全** | SECURITY DEFINER 权限校验 | ❌ 未实现 | **🔴 Critical：附件 RPC 可越权操作** |
| **安全** | Tombstone DELETE 策略 | ✅ 无漏洞 | **v5.4 修正：init-database.sql 中无 DELETE 策略，无需修复** |
| **安全** | 登出时数据清理 | ❌ 未实现 | **🔴 Critical：本地数据未清理，多用户泄露** |
| **安全** | 多用户数据隔离 | ❌ 未实现 | **🔴 Critical：离线缓存键不区分用户** |
| **安全** | 批量操作事务保护 | ❌ 未实现 | **🔴 Critical：部分失败无回滚** |
| **安全** | 附件并发写入保护 | ❌ 未实现 | **🔴 Critical：竞态条件导致附件丢失** |
| **安全** | IndexedDB 写入校验 | ❌ 未实现 | **🔴 Critical：写入后无完整性验证** |
| **安全** | Merge 策略远程保护 | ⚠️ 存在漏洞 | **🔴 Critical：可能丢失远程更新** |
| **安全** | 迁移原子性 | ❌ 未实现 | **🔴 Critical：部分失败后清除本地数据** |
| **安全** | 附件病毒扫描 | ❌ 未实现 | **🔴 Critical：无恶意文件检测** |
| **安全** | 文件类型验证 | ⚠️ 不完整 | **High：MIME 类型可伪造** |
| **安全** | 附件-任务删除联动 | ❌ 未实现 | **High：孤儿文件累积** |
| **安全** | project_members RLS | ⚠️ 被覆盖 | **High：协作功能失效** |
| **安全** | cleanup_logs RLS | ⚠️ 过度宽松 | **Medium：任意用户可读写日志** |
| **安全** | 批量操作速率限制 | ❌ 未实现 | **Medium：DoS 风险** |
| **安全** | is_task_tombstoned 权限校验 | ❌ 未实现 | **🔴 Critical：信息泄露风险** |
| **安全** | 附件数量服务端限制 | ❌ 未实现 | **High：可绕过客户端限制** |
| **辅助** | Safari/iOS pagehide 事件 | ❌ 未实现 | **🔴 Critical：Safari 不触发 beforeunload** |
| **辅助** | visibilitychange 保存 | ❌ 未实现 | **High：后台标签页数据丢失** |
| **辅助** | 统一 beforeunload 处理器 | ⚠️ 分散 | **High：两个处理器执行顺序不可控** |
| **辅助** | pushProject sessionExpired 检查 | ❌ 未实现 | **🔴 Critical：与 pushTask 同样问题** |
| **辅助** | 撤销历史持久化 | ❌ 未实现 | **High：页面刷新丢失撤销历史** |
| **辅助** | 用户偏好键隔离 | ❌ 未实现 | **High：多用户偏好混淆** |
| **辅助** | loadProject schema 验证 | ❌ 未实现 | **High：损坏缓存导致运行时异常** |
| **辅助** | mergeConnections 唯一键修正 | ⚠️ 存在漏洞 | **High：使用 source→target 而非 id** |
| **辅助** | JWT 后台刷新监听 | ❌ 未实现 | **High：刷新失败无感知** |
| **辅助** | Realtime 重连增量同步 | ❌ 未实现 | **High：重连时可能丢失变更事件** |
| **辅助** | 乐观快照配置一致性 | ⚠️ 不一致 | **Medium：代码 5 分钟 vs 策划案 30 分钟** |
| **🆕 安全** | 离线缓存键版本一致性 | ❗ 存在冲突 | **🔴 Critical：两个不同的缓存键定义** |
| **🆕 安全** | RetryQueue sessionExpired 检查 | ❌ 未实现 | **🔴 Critical：重试时无会话状态检查** |
| **🆕 安全** | RetryQueue 优先级排序 | ✅ 已实现 | **v5.4 修正：代码 #L1652-1658 已按 project→task→connection 排序** |
| **🆕 安全** | batch_upsert_tasks attachments | ❌ 未实现 | **High：批量导入时附件丢失** |
| **🆕 辅助** | 迁移快照 sessionStorage 限制 | ❌ 未处理 | **High：大项目可能超过 5MB 限制** |
| **🆕 辅助** | is_task_tombstoned NULL 信息泄露 | ⚠️ 设计缺陷 | **High：返回 NULL 仍泄露任务存在性** |
| **🆕 设计** | 熔断分级阈值不合理 | ⚠️ 设计缺陷 | **Medium：小项目过敏感，大项目过宽松** |
| **🆕 设计** | 病毒扫描 TOCTOU 窗口 | ❌ 未定义 | **High：未明确扫描时机** |

---

## 一、方案定位

### 核心理念

**"稳健、费用少、高选择性"**

- **稳健**：不依赖用户记得备份，不依赖电脑是否开机
- **费用少**：对象存储 + 定时任务，避免持续运行的高成本系统
- **高选择性**：用户只需看到"可回滚到某天某时"，无需理解备份策略

### 关键洞察

> 现在方案里"缺的不是备份"，而是 **版本化 + 防覆盖机制**

很多团队栽在这里：备份做了，但没有"可证明健康"的历史版本链，一旦空数据写入，同步把"坏状态"也备份了，等于一起完蛋。

### 🚨 当前最大风险

**熔断层未完整实现**：客户端空数据拒写、任务数骤降检测、服务端批量删除防护均未落地。即使完成 E 层备份，"坏数据也会被备份"。

**🔴 Critical 级安全漏洞（v5.0 审计发现）**：

| # | 漏洞 | 影响 | 紧急程度 |
|---|------|------|----------|
| 1 | **sessionExpired 入口检查完全缺失** | 会话过期后数据进入 RetryQueue 永远无法同步 | Week 1 Day 1 |
| 2 | **SECURITY DEFINER 函数无权限校验** | 攻击者可操作任意用户附件 | Week 1 Day 1 |
| 3 | **Tombstone DELETE 策略破坏防复活** | 可先删 tombstone 再复活已删除任务 | Week 1 Day 1 |
| 4 | **🆕 Safari/iOS 不触发 beforeunload** | Safari 关闭页面时数据丢失 | Week 1 Day 1 |
| 5 | **🆕 is_task_tombstoned 无权限校验** | 任意用户可探测他人 tombstone（信息泄露） | Week 1 Day 1 |
| 6 | **🆕 pushProject 缺少 sessionExpired 检查** | 项目级同步同样在会话过期后静默失败 | Week 1 Day 1 |
| 7 | **缺少 Connection Tombstone 表** | 离线客户端可复活已删除连接 | Week 1 |
| 8 | **批量操作无事务保护** | 部分失败导致数据不一致 | Week 1 |
| 9 | **附件读-改-写竞态条件** | 多设备同时操作附件丢失 | Week 1 |
| 10 | **IndexedDB 写入无完整性校验** | 崩溃导致部分数据静默丢失 | Week 2 |
| 11 | **Merge 策略可能丢失远程更新** | tombstone 查询失败时覆盖远程删除 | Week 2 |
| 12 | **迁移无原子性保证** | 部分失败后仍清除本地数据 | Week 2 |
| 13 | **无病毒扫描** | 可上传恶意 SVG/PDF/Office 文件 | Week 3 |
| 14 | **登出时本地数据未清理** | 多用户共享设备数据泄露 | Week 1 |
| 15 | **离线缓存键不区分用户** | 新用户加载前用户数据 | Week 1 |
| 16 | **🆕 离线缓存键版本不一致** | 数据写入一个键、从另一个键读取，静默数据丢失 | Week 1 Day 1 |
| 17 | **🆕 RetryQueue 无 sessionExpired 检查** | 会话过期后重试队列无限重试失败 | Week 1 Day 1 |
| 18 | **🆕 RetryQueue 无优先级排序** | 连接先于任务推送导致外键违规 | Week 1 |
| 19 | **🆕 is_task_tombstoned NULL 信息泄露** | 返回 NULL vs false 可区分任务存在性 | Week 1 |

**优先级原则**：
1. **Week 1 Day 1**：修复 #1~#6（阻止越权访问、数据复活、Safari 兼容性）
2. **Week 1**：修复 #7、#8、#9、#14、#15（数据一致性和隔离）
3. **Week 2**：修复 #10、#11、#12（数据完整性）
4. **Week 3**：修复 #13（安全加固）

---

## 二、架构设计

### 整体架构图

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           第一层：实时同步                               │
│                                                                         │
│   📱 手机 PWA  ←────────→  ☁️ Supabase  ←────────→  💻 电脑 PWA         │
│        ↓                       ↑↓                        ↓              │
│   IndexedDB               PostgreSQL                IndexedDB           │
│                                │                                        │
│                         ┌──────┴──────┐                                 │
│                         │   熔断层    │ ← 贯穿所有写入操作               │
│                         └──────┬──────┘                                 │
└────────────────────────────────┼────────────────────────────────────────┘
                                 │
         ┌───────────────────────┼───────────────────────┐
         ▼                       ▼                       ▼
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│  第二层(主保险)  │    │  第二层(逃生舱)  │    │  第三层(可选)   │
│     【E 层】     │    │     【D 层】     │    │     【C 层】    │
│                 │    │                 │    │                 │
│ 服务端版本化备份 │    │  手动导出/导入   │    │  桌面坚果云备份  │
│                 │    │                 │    │                 │
│ • 每日全量快照  │    │ • 全平台可用    │    │ • Chrome/Edge   │
│ • 15分钟增量    │    │ • 一键导出JSON  │    │ • 自动写入本地  │
│ • 健康校验      │    │ • 一键恢复      │    │ • 坚果云同步    │
│ • 版本保留策略  │    │ • 最后防线      │    │ • 心理安全感    │
└─────────────────┘    └─────────────────┘    └─────────────────┘
         │                       │                       │
         ▼                       ▼                       ▼
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│  R2/B2/S3 存储  │    │   用户本地文件   │    │   坚果云文件夹   │
│  (版本化保留)   │    │                 │    │                 │
└─────────────────┘    └─────────────────┘    └─────────────────┘
```

### 各层定位

| 层级 | 名称 | 定位 | 可靠性 | 依赖 |
|------|------|------|--------|------|
| **E 层** | 服务端备份 | 主保险，真正抗灾 | ⭐⭐⭐⭐⭐ | Supabase + 对象存储 |
| **D 层** | 手动导出 | 全平台逃生舱 | ⭐⭐⭐⭐ | 用户主动操作 |
| **C 层** | 坚果云备份 | 桌面增强层，锦上添花 | ⭐⭐⭐ | Chrome/Edge + 电脑在线 |
| **熔断层** | 防覆盖机制 | 贯穿所有写入 | - | 客户端 + 服务端双保险 |

---

## 三、优先级规划

### P0：熔断机制（强约束）⚠️ 关键未实现

**目标**：将"Bug 空覆盖"从高危降到可控，**修复 Critical 级安全漏洞**

**工时**：70-95 小时（v5.3.0 修订版，原估算 65-85h 未含六次审查新增工作量）

**建议时间范围**：Week 1-7（原 Week 1-6）

**v5.3.0 新增工作量（六次审查后）**：
- 🆕 离线缓存键版本统一：1h
- 🆕 RetryQueue sessionExpired 检查：2h
- 🆕 RetryQueue 优先级排序：3-4h
- 🆕 is_task_tombstoned NULL 修复：0.5h
- 🆕 batch_upsert_tasks attachments 字段：0.5h
- 🆕 迁移快照 sessionStorage 降级：1h
- 🆕 熔断分级阈值优化：1h
- 🆕 病毒扫描时机定义：1h
- 新增工时小计：10-12h

**v5.2.1 新增工作量**：
- H.1 Realtime 重连处理：2-3h
- H.2 批量操作 RPC + 权限校验：3-4h
- H.3 Guest 迁移冲突检测：4-6h  
- H.4 附件清理触发器 + 表定义：2-3h
- M Safari 特殊处理：2-3h
- 新增工时小计：13-19h

**工时调整原因（v5.1 二次审查后）**：
- 需新增 `CircuitBreakerService` 核心服务 + 完整单元测试（6-8h）
- 需编写完整的单元测试（覆盖 ≥ 80%）
- 需集成 Sentry 告警
- 需清理现有死代码
- Connection Tombstone 需与 2900+ 行 `simple-sync.service.ts` 集成（5-6h）
- 服务端 RPC 需要集成测试（+3h）
- **🔴 新增**：SECURITY DEFINER 函数权限校验修复（3-4h）
- **🔴 新增**：`is_task_tombstoned` 权限校验（0.5h）
- **🔴 新增**：Tombstone DELETE 策略移除（0.5h）
- **🔴 新增**：多用户数据隔离修复（4-5h）
- **🔴 新增**：登出时数据清理（2-3h）
- **🔴 新增**：批量操作事务保护（4-6h）
- **🔴 新增**：附件并发写入改用原子操作（2-3h）
- **🆕 v5.1**：Safari/iOS pagehide 事件兼容性（1h）
- **🆕 v5.1**：visibilitychange 后台保存（0.5h）
- **🆕 v5.1**：统一 beforeunload 处理器（2h）
- **🆕 v5.1**：pushProject sessionExpired 检查（0.5h）
- **🆕 v5.1**：附件数量服务端限制（0.5h）
- **🆕 v5.1**：用户偏好键隔离（1h）

**当前实现状态**：
- ✅ Tombstone 防复活触发器（`prevent_tombstoned_task_writes`）
- ✅ 网络层 Circuit Breaker（连续失败熔断）
- ✅ **客户端 IndexedDB 恢复时过滤已删除任务**（`StorePersistenceService.loadProject()` 中 `filter(t => !t.deletedAt)`）
- ❌ 客户端空数据拒写
- ❌ 客户端任务数骤降检测
- ❌ 服务端批量删除防护 RPC（非 RLS，RLS 无法限制删除数量）
- ❌ 服务端字段校验触发器
- ❌ Connection Tombstone 表（连接防复活）
- ❌ **会话过期入口检查**（🚨 紧急：`pushTask`/`pushProject` 中无任何 `sessionExpired` 检查）
- ❌ 会话过期数据保护逻辑
- ⚠️ 乐观锁（仅警告不拒绝）
- ❌ **🔴 SECURITY DEFINER 函数权限校验**（可越权操作任意用户附件）
- ❌ **🔴 is_task_tombstoned 权限校验**（可探测他人 tombstone，信息泄露）
- ⚠️ **🔴 Tombstone DELETE 策略存在漏洞**（允许删除 tombstone 破坏防复活）
- ❌ **🔴 登出时本地数据清理**（多用户共享设备数据泄露）
- ❌ **🔴 多用户离线缓存隔离**（缓存键不区分用户）
- ❌ **🔴 批量操作事务保护**（部分失败无回滚）
- ❌ **🔴 附件并发写入保护**（竞态条件导致附件丢失）
- ❌ **🆕 Safari/iOS pagehide 事件**（Safari 关闭页面不触发 beforeunload）
- ❌ **🆕 visibilitychange 保存**（后台标签页数据丢失）
- ⚠️ **🆕 beforeunload 处理器分散**（两个处理器执行顺序不可控）
- ❌ **🆕 用户偏好存储键隔离**（多用户偏好混淆）

> 🚨 **v5.0 审计发现（Critical #2）**：`append_task_attachment` / `remove_task_attachment` 使用 `SECURITY DEFINER` 绕过 RLS，但**内部没有验证调用者是否有权操作该任务**。攻击者可传入任意 `task_id` 操作其他用户的附件。

> 🚨 **v5.1 审查发现（Critical #5）**：`is_task_tombstoned` 同样使用 `SECURITY DEFINER` 但无权限校验，任意认证用户可探测其他用户项目中是否存在特定 `task_id` 的 tombstone（信息泄露）。

> 🚨 **v5.0 审计发现（Critical #3）**：`20251212_security_hardening.sql` 中的 tombstones DELETE 策略允许 owner 删除 tombstone 记录。**攻击者可先删除 tombstone，再 upsert 复活已删除任务**，完全破坏防复活机制。

> 🚨 **v5.1 审查发现（Critical #4）**：Safari（尤其是 iOS）在关闭标签页或导航离开时**可能不触发 `beforeunload` 事件**，必须添加 `pagehide` 和 `visibilitychange` 事件监听作为 fallback。

> 🚨 **v5.0 审计发现（Critical #11、#12）**：`user-session.service.ts` 的 `signOut` 方法仅清理信号，**未清理 IndexedDB 和 localStorage**。离线缓存键 `nanoflow.offline-cache` 是全局的，不区分用户。另一用户在同一浏览器可看到前用户数据。

> 🔴 **v5.2 代码验证（Critical）**：经代码审查确认，`auth.service.ts#L385-L406` 的 `signOut()` 方法**确实没有调用任何存储清理函数**。`userSession.clearLocalData()` 虽在 `app.component.ts#L915` 被调用，但 `clearLocalData()` 内部清理不完整。

**需清理的完整存储键清单**（必须全部处理）：

| 存储类型 | 键名 | 说明 |
|----------|------|------|
| localStorage | `nanoflow.offline-cache-v2` | 离线项目缓存 |
| localStorage | `nanoflow.retry-queue` | 待同步队列 |
| localStorage | `nanoflow.local-tombstones` | 本地 tombstone 缓存 |
| localStorage | `nanoflow.auth-cache` | 认证缓存 |
| localStorage | `nanoflow.escape-pod` | 紧急逃生数据 |
| localStorage | `nanoflow.preference.*` | 用户偏好（需改为 `nanoflow.preference.{userId}.*`） |
| localStorage | `nanoflow.safari-warning-time` | Safari 警告显示时间（🔴 v5.2.2 新增） |
| localStorage | `nanoflow.guest-data` | 访客数据缓存（迁移用） |
| IndexedDB | `nanoflow-db` | 主数据库（需清理或按用户分库） |
| IndexedDB | `nanoflow-queue-backup` | 操作队列备份（🔴 v5.2.2 新增） |
| sessionStorage | `nanoflow.migration-snapshot` | 迁移快照（会话自动清理） |
| sessionStorage | `nanoflow.fatal-error` | 致命错误信息（会话自动清理） |

> 🚨 **v5.0 审计发现（Critical #5）**：`task-repository.service.ts` 批量保存使用分批 upsert，中间批次失败时**已成功的批次无法回滚**，导致父任务成功但子任务失败，破坏树结构完整性。

> 🚨 **v5.0 审计发现（Critical #6）**：`attachment.service.ts` 使用 read-modify-write 模式添加附件，存在 TOCTOU 竞态条件。多设备同时添加附件时，**一方的附件会被覆盖丢失**。

> 🚨 **v5.1 审查发现（High）**：`app.component.ts` 和 `persistence-failure-handler.service.ts` 各自注册了 `beforeunload` 监听器，**执行顺序不可控，可能冲突**。应统一为单一处理器。

> 🚨 **审查发现（紧急）**：`sessionExpired` 信号存在于 `simple-sync.service.ts`，但 **代码中无任何逻辑在 `sessionExpired=true` 时阻止同步**。会话过期后继续推送会导致 401 错误，数据进入 RetryQueue 但永远无法成功同步，用户无感知。

> 🚨 **审查发现**：代码中存在死代码 `SYNC_CONFIG.CIRCUIT_BREAKER_*`（值=5），与生效的 `CIRCUIT_BREAKER_CONFIG.FAILURE_THRESHOLD`（值=3）重复且不一致，需在实现时清理。

> ✅ **已实现保护**：`StorePersistenceService.loadProject()` 在从 IndexedDB 恢复数据时会过滤 `deletedAt` 非空的任务，与服务端 Tombstone 形成双重保护。

#### 3.0 Week 1 Day 1 紧急修复（🔴 Critical）

以下问题必须在 **Week 1 Day 1** 修复，否则系统存在严重安全漏洞：

```sql
-- ✅ 修复 #3: Tombstone DELETE 策略 - v5.4 验证：无需修复
-- 位置：scripts/init-database.sql#L224-235
-- v5.4 代码验证确认：init-database.sql 中只有 SELECT 和 INSERT 策略
-- task_tombstones_select_owner 和 task_tombstones_insert_owner
-- 不存在 DELETE 策略，无需修复
-- 此任务标记为已完成，节省 0.5h 工时
```

```sql
-- 修复 #2: SECURITY DEFINER 函数添加权限校验（3-4h）
-- 位置：scripts/attachment-rpc.sql 修改
CREATE OR REPLACE FUNCTION append_task_attachment(p_task_id UUID, p_attachment JSONB)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public' AS $$
BEGIN
  -- 🔴 必须添加：权限校验
  IF NOT EXISTS (
    SELECT 1 FROM tasks t
    JOIN projects p ON t.project_id = p.id
    WHERE t.id = p_task_id
      AND (p.owner_id = auth.uid() 
           OR EXISTS (SELECT 1 FROM project_members pm 
                      WHERE pm.project_id = p.id AND pm.user_id = auth.uid()))
  ) THEN
    RAISE EXCEPTION 'Not authorized to modify task %', p_task_id;
  END IF;
  -- ... 原有逻辑
END; $$;

-- 🆕 修复 #5 (v5.1): is_task_tombstoned 函数添加权限校验（0.5h）
-- 位置：scripts/attachment-rpc.sql 或单独迁移文件
CREATE OR REPLACE FUNCTION is_task_tombstoned(p_task_id UUID)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public' AS $$
BEGIN
  -- 🔴 v5.3 修正：返回 false 而非 NULL，与不存在的任务行为一致
  -- 避免通过 NULL vs false 区分任务存在性（信息泄露）
  IF NOT EXISTS (
    SELECT 1 FROM tasks t
    JOIN projects p ON t.project_id = p.id
    WHERE t.id = p_task_id
      AND (p.owner_id = auth.uid() 
           OR EXISTS (SELECT 1 FROM project_members pm 
                      WHERE pm.project_id = p.id AND pm.user_id = auth.uid()))
  ) THEN
    -- 🔴 v5.3 修正：无权访问时返回 false（与任务不存在行为一致）
    RETURN false;
  END IF;
  -- ... 原有逻辑
END; $$;
```

```typescript
// 🆕 修复 #16 (v5.3): 离线缓存键版本统一（1h）
// 位置：src/app/core/services/simple-sync.service.ts
// 🔴 当前问题：存在两个不同的缓存键定义
// - sync.config.ts#L155: OFFLINE_CACHE_KEY = 'nanoflow.offline-cache-v2'
// - simple-sync.service.ts#L2663: this.OFFLINE_CACHE_KEY = 'nanoflow.offline-cache'
// 数据可能写入一个键，从另一个键读取，导致静默数据丢失

// ✅ 解决方案：统一使用 SYNC_CONFIG.OFFLINE_CACHE_KEY
// 删除 simple-sync.service.ts 中的硬编码常量，改用配置导入
import { SYNC_CONFIG } from '@config/sync.config';

// 删除：private readonly OFFLINE_CACHE_KEY = 'nanoflow.offline-cache';
// 改为：使用 SYNC_CONFIG.OFFLINE_CACHE_KEY
```

```typescript
// 🆕 修复 #17 (v5.3): RetryQueue sessionExpired 检查（2h）
// 位置：src/app/core/services/simple-sync.service.ts#L1700-1730
// 🔴 当前问题：processRetryQueue 调用 pushTask/pushProject 时
//    虽然 pushTask 会检查 sessionExpired，但任务会进入死循环重试

// ✅ 解决方案：在 processRetryQueue 入口处统一检查
async processRetryQueue(): Promise<void> {
  // 🔴 必须添加：会话过期检查
  if (this.syncState().sessionExpired) {
    this.logger.info('会话已过期，暂停重试队列处理');
    return; // 不处理队列，等待重新登录
  }
  
  // ... 原有逻辑
}
```

```typescript
// 🆕 修复 #18 (v5.3): RetryQueue 优先级排序
// ✅ v5.4 验证：此功能已在 simple-sync.service.ts#L1652-1658 实现
// 无需额外开发工时

/**
 * RetryQueue 优先级排序 - 已实现的代码
 * 位置：src/app/core/services/simple-sync.service.ts#L1652-1658
 */
const sortedItems = itemsToProcess.sort((a, b) => {
  const order = { project: 0, task: 1, connection: 2 };
  return order[a.type] - order[b.type];
});
// ✅ 已按 project → task → connection 顺序处理，外键约束安全
```

```typescript
// 修复 #1 & #6: sessionExpired 入口检查（2h）
// 位置：src/app/core/services/simple-sync.service.ts
// 🆕 v5.1: pushProject 同样需要添加检查

async pushTask(task: Task, projectId: string): Promise<boolean> {
  // 🔴 必须添加：会话过期检查
  if (this.syncState().sessionExpired) {
    this.logger.warn('会话已过期，同步被阻止', { taskId: task.id });
    this.toast.warning('登录已过期', '请重新登录以继续同步数据');
    return false; // 不加入 RetryQueue
  }
  // ... 原有逻辑
}

async pushProject(project: Project): Promise<boolean> {
  // 🔴 v5.1 新增：pushProject 同样需要会话过期检查
  if (this.syncState().sessionExpired) {
    this.logger.warn('会话已过期，项目同步被阻止', { projectId: project.id });
    this.toast.warning('登录已过期', '请重新登录以继续同步数据');
    return false;
  }
  // ... 原有逻辑
}
```

```typescript
// 🆕 修复 #4 (v5.1): Safari/iOS pagehide 事件兼容性（1h）
// 位置：src/app.component.ts
// Safari/iOS 在关闭标签页时可能不触发 beforeunload，必须添加 pagehide

// 🔴 当前问题：代码中存在两个独立的 beforeunload 监听器
// 1. app.component.ts#L395-L408 - 主要处理器
// 2. persistence-failure-handler.service.ts#L278-L300 - 故障处理器
// 这两个处理器都调用保存逻辑，但执行顺序不可控，可能导致重复执行或冲突

// ✅ 解决方案：合并为统一的 BeforeUnloadManager 服务
// 位置：src/services/before-unload-manager.service.ts

@Injectable({ providedIn: 'root' })
export class BeforeUnloadManagerService {
  private readonly syncCoordinator = inject(SyncCoordinatorService);
  private readonly undoService = inject(UndoService);
  private readonly simpleSync = inject(SimpleSyncService);
  private readonly persistenceHandler = inject(PersistenceFailureHandlerService);
  
  private handler: ((e: BeforeUnloadEvent) => void) | null = null;
  
  /**
   * 初始化统一的页面卸载处理器
   * 注意：此方法应只在 AppComponent 中调用一次
   */
  initialize(): void {
    if (typeof window === 'undefined' || this.handler) return;
    
    const saveHandler = (event?: BeforeUnloadEvent | PageTransitionEvent): void => {
      // 统一保存逻辑（确保顺序）
      // 1. 先刷新同步协调器
      this.syncCoordinator.flushPendingPersist();
      // 2. 刷新撤销服务
      this.undoService.flushPendingAction();
      // 3. 刷新重试队列
      this.simpleSync.flushRetryQueueSync();
      // 4. 处理持久化失败场景
      this.persistenceHandler.flushEmergencyData();
      
      // 检查是否有待同步数据
      if (event instanceof BeforeUnloadEvent) {
        const hasPendingData = this.simpleSync.state().pendingCount > 0;
        if (hasPendingData) {
          event.preventDefault();
          event.returnValue = '有未同步的数据，确定要离开吗？';
        }
      }
    };
    
    // 🔴 多事件覆盖，确保跨浏览器兼容
    window.addEventListener('beforeunload', saveHandler);
    window.addEventListener('pagehide', saveHandler, { capture: true }); // Safari/iOS
    
    // 🔴 visibilitychange 用于后台保存
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        saveHandler();
      }
    });
    
    this.handler = saveHandler;
  }
  
  destroy(): void {
    if (this.handler) {
      window.removeEventListener('beforeunload', this.handler);
      window.removeEventListener('pagehide', this.handler);
      this.handler = null;
    }
  }
}
```

#### 3.0.1 Week 1 安全修复（🔴 Critical）

```typescript
// 修复 #11 & #12: 登出清理 + 多用户隔离（4-5h）
// 位置：src/services/user-session.service.ts
// 🔴 v5.4 验证：当前 clearLocalData() 仅清理内存，不清理 localStorage/IndexedDB
// 必须实现完整的存储清理

async signOut(): Promise<void> {
  // 🔴 必须添加：清理本地数据
  await this.clearAllLocalData();
  // ... 原有代码
}

/**
 * 完整的本地数据清理（v5.4 补充实现代码）
 * 🔴 当前代码问题：user-session.service.ts#L150-155 只清理内存信号
 */
private async clearAllLocalData(): Promise<void> {
  const userId = this.currentUser()?.id;
  
  // 1. 清理 IndexedDB（主数据库）
  await this.clearIndexedDB('nanoflow-db');
  await this.clearIndexedDB('nanoflow-queue-backup');
  
  // 2. 清理所有 localStorage 键（完整清单 v5.4）
  const keysToRemove = [
    'nanoflow.offline-cache-v2',      // 离线项目缓存
    'nanoflow.offline-cache',          // 旧版缓存键（兼容）
    'nanoflow.retry-queue',            // 待同步队列
    'nanoflow.local-tombstones',       // 本地 tombstone 缓存
    'nanoflow.auth-cache',             // 认证缓存
    'nanoflow.escape-pod',             // 紧急逃生数据
    'nanoflow.safari-warning-time',    // Safari 警告显示时间
    'nanoflow.guest-data',             // 访客数据缓存
  ];
  
  keysToRemove.forEach(key => localStorage.removeItem(key));
  
  // 3. 清理用户偏好键（带 userId 前缀的）
  if (userId) {
    const prefixToRemove = `nanoflow.preference.${userId}`;
    Object.keys(localStorage)
      .filter(key => key.startsWith(prefixToRemove))
      .forEach(key => localStorage.removeItem(key));
  }
  
  // 4. 清理内存状态（原有逻辑）
  this.projectState.clearData();
  this.uiState.clearAllState();
  this.undoService.clearHistory();
  this.syncCoordinator.clearOfflineCache();
}

private async clearIndexedDB(dbName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(dbName);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => {
      // 数据库被其他连接占用，记录日志但继续
      this.logger.warn(`IndexedDB ${dbName} 删除被阻塞，可能存在未关闭的连接`);
      resolve();
    };
  });
}

// 缓存键改为用户级别
private getOfflineCacheKey(userId: string): string {
  return `nanoflow.offline-cache.${userId}`;
}
```

```typescript
// 🆕 修复 #19 (v5.4): onAuthStateChange 监听（1h）
// 位置：src/services/auth.service.ts
// 🔴 当前问题：代码中无 onAuthStateChange 订阅
// JWT 刷新失败时用户无感知，请求继续发送导致 401 错误

/**
 * 初始化认证状态监听
 * 位置：src/services/auth.service.ts 构造函数或 init 方法
 */
private initAuthStateListener(): void {
  this.supabase.client().auth.onAuthStateChange((event, session) => {
    switch (event) {
      case 'SIGNED_OUT':
        // 用户登出，清理本地数据
        this.handleSignOut();
        break;
      case 'TOKEN_REFRESHED':
        // Token 刷新成功，更新会话
        this.updateSession(session);
        break;
      case 'USER_UPDATED':
        // 用户信息更新
        this.updateUserProfile(session?.user);
        break;
    }
    
    // 🔴 关键：检测 Token 刷新失败
    // 如果 event 为 'SIGNED_OUT' 且非用户主动登出，可能是 Token 过期
    if (event === 'SIGNED_OUT' && !this.isManualSignOut) {
      this.handleSessionExpired();
    }
  });
}

private handleSessionExpired(): void {
  // 1. 设置 sessionExpired 信号
  this.simpleSync.setSessionExpired(true);
  
  // 2. 停止所有同步操作
  this.syncCoordinator.pauseSync();
  
  // 3. 显示重新登录提示
  this.toast.warning('登录已过期', '请重新登录以继续同步数据', {
    duration: 0, // 持续显示
    action: {
      label: '重新登录',
      callback: () => this.showLoginModal(),
    },
  });
}
```

```typescript
// 修复 #6: 附件并发写入改用原子操作（2-3h）
// 位置：src/services/attachment.service.ts
// 改用 Postgres jsonb 原子操作，避免 read-modify-write

// 旧代码（有竞态条件）：
// const newAttachments = [...currentAttachments, attachment];
// await client.from('tasks').update({ attachments: newAttachments });

// 新代码（原子操作）：
await this.supabase.client().rpc('append_task_attachment', {
  p_task_id: taskId,
  p_attachment: attachment
});
```

#### 3.1 客户端熔断规则（❌ 待实现）

```typescript
/**
 * 熔断配置常量
 * 位置：src/config/circuit-breaker.config.ts
 * 
 * 【审查修订】增加分级设计，避免"全有或全无"
 */
export const CLIENT_CIRCUIT_BREAKER_CONFIG = {
  // 规则 1: 空数据拒写
  REJECT_EMPTY_DATA: true,
  
  // 规则 2: 任务数骤降阈值
  // 【审查修订】增加分级阈值，使用绝对值+相对值结合
  TASK_COUNT_DROP_CONFIG: {
    // L1 警告：下降 20-50%
    L1_WARNING_THRESHOLD: 0.2,
    // L2 软熔断：下降 50-80%
    L2_SOFT_BLOCK_THRESHOLD: 0.5,
    // L3 硬熔断：下降 >80% 或归零
    L3_HARD_BLOCK_THRESHOLD: 0.8,
    // 绝对值阈值：小项目使用绝对值而非比例
    // 下降超过 20 个任务 → 至少触发 L1
    ABSOLUTE_DROP_THRESHOLD: 20,
    // 最小任务数（低于此数量时使用绝对值）
    MIN_TASK_COUNT_FOR_RATIO: 10,
  },
  
  // 规则 3: 最小任务数保护（防止全部删除）
  // 如果项目原有 > 10 个任务，不允许一次性删到 0
  MIN_TASK_COUNT_PROTECTION: true,
  MIN_TASK_COUNT_THRESHOLD: 10,
  
  // 规则 4: 必要字段列表
  REQUIRED_TASK_FIELDS: ['id', 'title', 'updatedAt'],
  REQUIRED_PROJECT_FIELDS: ['id', 'name'],
  
  // 规则 5: Schema 结构校验
  VALIDATE_SCHEMA: true,
  
  // 规则 6: 熔断分级行为
  CIRCUIT_LEVELS: {
    L1: 'log_and_sentry',      // 记录日志 + Sentry 警告
    L2: 'block_and_toast',     // 阻止同步 + Toast 提示
    L3: 'block_and_export',    // 阻止 + 强制导出提示
  },
} as const;

/**
 * 熔断校验接口
 * 【审查修订】增加 level 字段
 */
interface CircuitBreakerValidation {
  passed: boolean;
  violations: CircuitBreakerViolation[];
  level: 'L0' | 'L1' | 'L2' | 'L3'; // L0 = 正常，无违规
  severity: 'low' | 'medium' | 'high' | 'critical';
  shouldBlock: boolean;
  suggestedAction: 'none' | 'log' | 'toast' | 'export-prompt';
}

interface CircuitBreakerViolation {
  rule: string;
  message: string;
  details: Record<string, unknown>;
}
```

**实现位置与集成点**：

```typescript
// 【审查新增】0. pushTask/pushProject 入口 - 会话过期检查
async pushTask(task: Task, projectId: string): Promise<boolean> {
  // 🚨 【紧急修复】会话过期检查 - 当前代码中完全不存在！
  if (this.syncState().sessionExpired) {
    this.logger.warn('会话已过期，同步被阻止', { taskId: task.id });
    // 不加入 RetryQueue（会话过期后重试无意义），提示用户重新登录
    this.toast.warning('登录已过期', '请重新登录以继续同步数据');
    return false;
  }
  // ... 原有逻辑
}

// 1. SimpleSyncService.saveProjectToCloud() - 上传前校验
async saveProjectToCloud(project: Project): Promise<Result<void, OperationError>> {
  // 【新增】熔断校验
  const validation = this.circuitBreaker.validateBeforeSync(project, this.lastKnownTaskCount);
  if (!validation.passed && validation.shouldBlock) {
    this.logger.error('熔断: 同步被阻止', validation.violations);
    Sentry.captureMessage('CircuitBreaker: Sync blocked', { extra: validation });
    return failure(ErrorCodes.CIRCUIT_BREAKER, '检测到异常数据变更，同步已阻止');
  }
  // ... 原有逻辑
}

// 2. ChangeTrackerService.validateChanges() - 增强现有方法
// 当前已实现引用完整性校验，需新增：
// - 空数据检测
// - 任务数骤降检测
// - 必填字段校验

// 3. TaskOperationService - 写入前校验
// 每次批量操作前检查是否触发熔断规则
```

**Sentry 告警集成**：

```typescript
// 熔断触发时发送告警
if (validation.severity === 'critical') {
  Sentry.captureMessage('CircuitBreaker: Critical violation detected', {
    level: 'error',
    tags: { 
      operation: 'sync',
      projectId: project.id,
      rule: validation.violations[0]?.rule 
    },
    extra: {
      violations: validation.violations,
      taskCountBefore: this.lastKnownTaskCount,
      taskCountAfter: project.tasks.length
    }
  });
}
```

#### 3.2 服务端熔断规则（❌ 待实现）

**迁移文件**：`supabase/migrations/YYYYMMDD_circuit_breaker_rules.sql`

```sql
-- ============================================
-- 熔断机制：服务端防护规则
-- ============================================

-- 规则 1: 防止批量删除（通过 RPC 函数限制）
-- 注意：RLS 无法直接限制删除数量，需通过 RPC 包装
CREATE OR REPLACE FUNCTION public.safe_delete_tasks(
  p_task_ids uuid[],
  p_project_id uuid
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  task_count integer;
  total_tasks integer;
  delete_ratio float;
BEGIN
  -- 获取待删除数量
  task_count := array_length(p_task_ids, 1);
  IF task_count IS NULL THEN
    RETURN 0;
  END IF;
  
  -- 获取项目总任务数
  SELECT COUNT(*) INTO total_tasks
  FROM public.tasks
  WHERE project_id = p_project_id AND deleted_at IS NULL;
  
  -- 计算删除比例
  delete_ratio := task_count::float / GREATEST(total_tasks, 1);
  
  -- 规则：单次删除不能超过 50%，且不能超过 50 条
  IF delete_ratio > 0.5 OR task_count > 50 THEN
    RAISE EXCEPTION 'Bulk delete blocked: attempting to delete % tasks (%.1f%% of total)', 
      task_count, delete_ratio * 100;
  END IF;
  
  -- 规则：如果总任务数 > 10，不允许删到 0
  IF total_tasks > 10 AND task_count >= total_tasks THEN
    RAISE EXCEPTION 'Cannot delete all tasks from a project with more than 10 tasks';
  END IF;
  
  -- 执行软删除
  UPDATE public.tasks
  SET deleted_at = NOW(), updated_at = NOW()
  WHERE id = ANY(p_task_ids)
    AND project_id = p_project_id
    AND EXISTS (
      SELECT 1 FROM public.projects p
      WHERE p.id = p_project_id AND p.owner_id = auth.uid()
    );
  
  GET DIAGNOSTICS task_count = ROW_COUNT;
  RETURN task_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.safe_delete_tasks(uuid[], uuid) TO authenticated;

-- 规则 2: 触发器校验 - 拒绝无效数据
CREATE OR REPLACE FUNCTION public.validate_task_data()
RETURNS TRIGGER AS $$
BEGIN
  -- 拒绝将 title 和 content 同时置空
  IF (NEW.title IS NULL OR NEW.title = '') AND (NEW.content IS NULL OR NEW.content = '') THEN
    -- 例外：软删除的任务允许
    IF NEW.deleted_at IS NOT NULL THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Task must have either title or content';
  END IF;
  
  -- 拒绝无效的 stage 值（如果有定义范围）
  -- IF NEW.stage IS NOT NULL AND NEW.stage < 0 THEN
  --   RAISE EXCEPTION 'Invalid stage value: %', NEW.stage;
  -- END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_validate_task_data ON public.tasks;
CREATE TRIGGER trg_validate_task_data
BEFORE INSERT OR UPDATE ON public.tasks
FOR EACH ROW
EXECUTE FUNCTION public.validate_task_data();

-- 规则 3: 记录危险操作到审计日志
CREATE TABLE IF NOT EXISTS public.circuit_breaker_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id),
  operation text NOT NULL,
  blocked boolean NOT NULL DEFAULT false,
  reason text,
  details jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.circuit_breaker_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_read_own_logs" ON public.circuit_breaker_logs
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());
```

#### 3.3 软删除机制（✅ 已实现，需强化 TTL）

```typescript
// 现有实现已支持软删除 (deletedAt 字段)
// 已实现：
// ✅ tasks 表 deleted_at 字段
// ✅ task_tombstones 表防止复活
// ✅ 同步时排除 deletedAt 非空的记录
// ✅ 回收站 UI (trash-modal.component.ts)

// 待实现 - TTL 强制执行：
// ❌ 定时清理超过 30 天的软删除记录
// ❌ 清理前检查是否有关联数据

// 建议实现方式：Edge Function 定时任务
// supabase/functions/cleanup-soft-deleted/index.ts
const SOFT_DELETE_RETENTION_DAYS = 30;

async function cleanupSoftDeleted() {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - SOFT_DELETE_RETENTION_DAYS);
  
  // 只有超过 30 天的软删除记录才会被永久删除
  // 永久删除时同时写入 tombstone
  const { data, error } = await supabase.rpc('purge_expired_soft_deleted', {
    p_cutoff_date: cutoffDate.toISOString()
  });
}
```

#### 3.4 乐观锁机制（⚠️ 部分实现，需强化）

```typescript
/**
 * 乐观锁接口定义
 * 当前状态：数据库有 version 字段，但仅警告不拒绝
 */
interface OptimisticLock {
  clientSeq: number;      // 客户端序列号（本次会话内递增）
  serverRev: number;      // 服务端版本号（数据库 version 字段）
  baseRev: number;        // 基于哪个版本修改
}

/**
 * 待实现：版本冲突检测策略
 */
export const OPTIMISTIC_LOCK_CONFIG = {
  // 是否启用严格模式（拒绝版本回退）
  STRICT_MODE: false, // 当前 false，待稳定后切换为 true
  
  // 版本冲突处理策略
  CONFLICT_STRATEGY: 'warn_and_lww' as const, // 'reject' | 'warn_and_lww' | 'silent_lww'
  
  // 是否记录版本冲突到日志
  LOG_CONFLICTS: true,
} as const;

// 服务端触发器需修改：
// 当前：RAISE WARNING 'Version regression detected...'
// 目标：STRICT_MODE=true 时 RAISE EXCEPTION
```

**数据库迁移（强化版本控制）**：

```sql
-- 修改现有的版本检查函数
CREATE OR REPLACE FUNCTION public.check_version_increment()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.version IS NOT NULL AND NEW.version IS NOT NULL THEN
    IF NEW.version < OLD.version THEN
      -- 记录版本回退事件
      INSERT INTO public.circuit_breaker_logs (user_id, operation, blocked, reason, details)
      VALUES (
        auth.uid(),
        'version_regression',
        false, -- 当前不阻止，仅记录
        'Version regression detected',
        jsonb_build_object(
          'table', TG_TABLE_NAME,
          'record_id', NEW.id,
          'old_version', OLD.version,
          'new_version', NEW.version
        )
      );
      
      -- TODO: 稳定后启用严格模式
      -- RAISE EXCEPTION 'Version regression not allowed: % -> %', OLD.version, NEW.version;
      
      -- 当前：警告但允许
      RAISE WARNING 'Version regression detected: % -> %, allowing update but logging', 
        OLD.version, NEW.version;
    END IF;
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
```

#### 3.5 多标签页并发保护（⚠️ 部分实现，需强化）

**当前状态**：
- ✅ `TabSyncService` 使用 BroadcastChannel 通知其他标签页
- ✅ 项目打开时广播通知
- ❌ 不阻止并发编辑同一任务
- ❌ 无并发编辑冲突提示

**待实现**：

```typescript
/**
 * 多标签页并发保护策略
 * 位置：src/services/tab-sync.service.ts
 */
export const TAB_CONCURRENCY_CONFIG = {
  // 是否启用并发编辑检测
  DETECT_CONCURRENT_EDIT: true,
  
  // 同一任务在多标签页编辑时的处理策略
  CONCURRENT_EDIT_STRATEGY: 'warn' as const, // 'block' | 'warn' | 'silent'
  
  // 编辑锁超时时间（毫秒）
  EDIT_LOCK_TIMEOUT: 30000,
} as const;

interface TabEditLock {
  taskId: string;
  tabId: string;
  field: string;
  lockedAt: number;
  expiresAt: number;
}

// 增强 TabSyncService
class TabSyncService {
  // 新增：广播编辑锁
  broadcastEditLock(lock: TabEditLock): void;
  
  // 新增：检查是否有其他标签页正在编辑
  isBeingEditedByOtherTab(taskId: string, field: string): boolean;
  
  // 新增：编辑冲突回调
  onConcurrentEditDetected: EventEmitter<ConcurrentEditEvent>;
}
```

#### 3.6 离线数据完整性（❌ 待实现）

**问题**：离线期间 IndexedDB 数据可能损坏，联网时可能产生大量冲突。

```typescript
/**
 * 离线数据完整性校验配置
 */
export const OFFLINE_INTEGRITY_CONFIG = {
  // 定期校验间隔（毫秒）- 每 5 分钟
  CHECK_INTERVAL: 5 * 60 * 1000,
  
  // 校验内容
  CHECKS: {
    // 任务引用完整性（parentId 指向存在的任务）
    TASK_REFERENCES: true,
    // 连接引用完整性（source/target 指向存在的任务）
    CONNECTION_REFERENCES: true,
    // 数据结构校验（必填字段存在）
    SCHEMA_VALIDATION: true,
    // 循环引用检测
    CIRCULAR_REFERENCE: true,
  },
  
  // 校验失败时的行为
  ON_FAILURE: 'log_and_repair' as const, // 'log_only' | 'log_and_repair' | 'block_sync'
} as const;

/**
 * 离线数据校验服务
 * 位置：src/services/offline-integrity.service.ts
 */
interface OfflineIntegrityService {
  // 执行完整性校验
  validateLocalData(): Promise<IntegrityReport>;
  
  // 尝试自动修复
  repairLocalData(report: IntegrityReport): Promise<RepairResult>;
  
  // 生成数据摘要（用于联网时快速比对）
  generateChecksum(): Promise<string>;
}

interface IntegrityReport {
  valid: boolean;
  projectCount: number;
  taskCount: number;
  connectionCount: number;
  issues: IntegrityIssue[];
  checksum: string;
  timestamp: string;
}
```

#### 3.7 会话过期保护（❌ 待实现）

**问题**：用户离线期间 JWT 过期，重连时同步失败可能导致数据丢失。

**当前状态**：
- ✅ `sessionExpired` 信号已存在（simple-sync.service.ts）
- ✅ `autoRefreshToken` 已启用（supabase-client.service.ts）
- ❌ 会话过期时未保护本地未同步数据
- ❌ 无同步入口检查 `sessionExpired` 状态

> 🚨 **审查发现**：`sessionExpired` 信号仅是字段，代码中**无任何逻辑在 `sessionExpired=true` 时暂停同步或保护数据**。

**必须实现**：

```typescript
// 在 pushTask/pushProject 入口处添加检查
async pushTask(task: Task, projectId: string): Promise<Result<void, Error>> {
  // 【必须添加】会话过期检查
  if (this.syncState().sessionExpired) {
    this.logger.warn('会话已过期，同步被阻止');
    return failure(ErrorCodes.SESSION_EXPIRED, '会话已过期，请重新登录');
  }
  // ... 原有逻辑
}
```

```typescript
/**
 * 会话过期保护配置
 * 位置：src/config/auth.config.ts
 */
export const SESSION_PROTECTION_CONFIG = {
  // 会话过期前主动保存本地数据
  SAVE_BEFORE_EXPIRY: true,
  
  // 检测到 sessionExpired 时的处理策略
  ON_SESSION_EXPIRED: 'preserve-local' as const, // 'preserve-local' | 'prompt-reauth' | 'force-logout'
  
  // 保留本地未同步变更直到重新认证
  PRESERVE_PENDING_CHANGES: true,
  
  // 过期提前警告时间（毫秒）- JWT 过期前 5 分钟
  EXPIRY_WARNING_BEFORE: 5 * 60 * 1000,
  
  // 最大离线保留时间（毫秒）- 超过后强制清理
  MAX_OFFLINE_RETENTION: 30 * 24 * 60 * 60 * 1000, // 30 天
} as const;

/**
 * 会话过期处理流程
 */
interface SessionExpiryHandler {
  // 检测到会话过期
  onSessionExpired(): void {
    // 1. 暂停所有同步操作
    this.syncCoordinator.pause();
    
    // 2. 保存当前状态到 IndexedDB
    await this.persistence.saveEmergencySnapshot();
    
    // 3. 显示重新登录提示（不强制登出）
    this.modal.open(SessionExpiredModal, {
      message: '登录已过期，请重新登录以继续同步',
      preserveData: true,
      actions: [
        { label: '重新登录', action: 'reauth' },
        { label: '导出数据', action: 'export' }, // 提供逃生通道
      ]
    });
    
    // 4. 不清除本地数据，等待重新认证
  }
  
  // 重新认证成功后
  onReauthSuccess(): void {
    // 恢复同步，合并本地变更
    this.syncCoordinator.resume();
  }
}
```

#### 3.8 存储配额保护（❌ 待实现）

**问题**：IndexedDB 配额耗尽时新数据无法写入，可能导致数据丢失。

**当前状态**：
- ✅ RetryQueue 已有 `QuotaExceededError` 处理（simple-sync.service.ts#L1532）
- ❌ 主数据存储无配额保护
- ❌ 无配额预警机制

```typescript
/**
 * 存储配额保护配置
 * 位置：src/config/storage.config.ts
 */
export const STORAGE_QUOTA_CONFIG = {
  // 配额预警阈值（使用率）
  WARNING_THRESHOLD: 0.8, // 80%
  
  // 危险阈值（使用率）
  CRITICAL_THRESHOLD: 0.95, // 95%
  
  // 检查间隔（毫秒）
  CHECK_INTERVAL: 5 * 60 * 1000, // 5 分钟
  
  // 配额不足时的处理策略
  ON_QUOTA_LOW: 'warn-and-cleanup' as const, // 'warn-only' | 'warn-and-cleanup' | 'block-writes'
  
  // 自动清理优先级（从高到低）
  CLEANUP_PRIORITY: [
    'expired-tombstones',      // 1. 过期的 tombstone 记录
    'synced-retry-queue',      // 2. 已同步的重试队列项
    'old-undo-history',        // 3. 旧的撤销历史
    'cached-attachments',      // 4. 已同步的附件缓存
  ],
} as const;

/**
 * 存储配额监控服务
 */
interface StorageQuotaService {
  // 获取当前存储使用情况
  async getQuotaStatus(): Promise<QuotaStatus> {
    if (!navigator.storage?.estimate) {
      return { supported: false };
    }
    const { usage, quota } = await navigator.storage.estimate();
    return {
      supported: true,
      usage: usage ?? 0,
      quota: quota ?? 0,
      usageRatio: (usage ?? 0) / (quota ?? 1),
    };
  }
  
  // 配额不足时的紧急处理
  async handleQuotaExceeded(): Promise<void> {
    // 1. 触发紧急导出提示
    this.toast.error('存储空间不足', '请立即导出数据以防丢失', {
      action: { label: '导出', callback: () => this.exportService.exportAll() }
    });
    
    // 2. 尝试自动清理
    await this.performEmergencyCleanup();
    
    // 3. 上报 Sentry
    Sentry.captureMessage('Storage quota exceeded', { level: 'error' });
  }
}
```

#### 3.9 乐观更新回滚强化（⚠️ 部分实现）

**问题**：乐观更新失败时需要正确回滚状态，避免用户看到虚假的「已保存」状态。

**当前状态**：
- ✅ `OptimisticStateService.rollbackSnapshot()` 已实现
- ⚠️ 仅在部分场景使用
- ❌ 离线期间的乐观更新缺乏统一回滚机制

```typescript
/**
 * 乐观更新回滚策略
 * 位置：src/services/optimistic-state.service.ts
 */
export const OPTIMISTIC_ROLLBACK_CONFIG = {
  // 是否启用自动回滚
  AUTO_ROLLBACK_ON_ERROR: true,
  
  // 回滚前保留快照的最大数量
  MAX_SNAPSHOTS: 50,
  
  // 快照过期时间（毫秒）
  SNAPSHOT_TTL: 30 * 60 * 1000, // 30 分钟
  
  // 回滚失败时的降级策略
  ON_ROLLBACK_FAILURE: 'reload-from-server' as const,
} as const;

/**
 * 统一的乐观更新执行器
 */
async function executeOptimisticOperation<T>(
  operation: () => Promise<T>,
  options: {
    snapshotId: string;
    rollbackOnError: boolean;
    notifyUser: boolean;
  }
): Promise<Result<T, Error>> {
  const snapshot = this.createSnapshot(options.snapshotId);
  
  try {
    const result = await operation();
    // 成功：清理快照
    this.clearSnapshot(options.snapshotId);
    return success(result);
  } catch (error) {
    // 失败：执行回滚
    if (options.rollbackOnError) {
      const rollbackResult = this.rollbackSnapshot(options.snapshotId);
      if (!rollbackResult.ok) {
        // 回滚也失败：降级处理
        await this.reloadFromServer();
      }
    }
    
    if (options.notifyUser) {
      this.toast.error('操作失败', '已恢复到之前的状态', {
        action: { label: '撤销', callback: () => this.undoService.undo() }
      });
    }
    
    return failure(error);
  }
}
```

---

### P1：手动导出/导入（D 层 - 逃生舱）❌ 未实现

**目标**：提供全平台可用的数据逃生能力

**工时**：16-24 小时（原估算 6-10h 严重低估）

**工时调整原因**：
- 附件处理复杂（嵌入 vs 引用策略）
- 大文件下载需要进度条 UI
- 需处理 Signed URL 30 天过期问题
- 需编写完整的单元测试

**当前状态**：
- ❌ ExportService 不存在
- ❌ ImportService 不存在
- ❌ Settings Modal 无导出/导入入口
- ❌ 导出提醒机制不存在

#### 4.1 导出功能

```typescript
/**
 * 导出服务
 * 位置：src/services/export.service.ts
 */
@Injectable({ providedIn: 'root' })
export class ExportService {
  private readonly projectState = inject(ProjectStateService);
  private readonly logger = inject(LoggerService).category('Export');
  
  /**
   * 导出当前项目
   */
  async exportCurrentProject(): Promise<ExportResult> {
    const project = this.projectState.currentProject();
    if (!project) {
      return { success: false, error: 'No project selected' };
    }
    return this.exportProjects([project]);
  }
  
  /**
   * 导出所有项目
   */
  async exportAllProjects(): Promise<ExportResult> {
    const projects = this.projectState.projects();
    return this.exportProjects(projects);
  }
  
  /**
   * 导出指定项目
   */
  private async exportProjects(projects: Project[]): Promise<ExportResult> {
    const exportData: ExportData = {
      metadata: {
        exportedAt: new Date().toISOString(),
        version: '2.0',
        appVersion: environment.version,
        projectCount: projects.length,
        taskCount: projects.reduce((sum, p) => sum + (p.tasks?.length ?? 0), 0),
        checksum: '', // 后面计算
      },
      projects: projects.map(p => this.sanitizeProject(p)),
    };
    
    // 计算校验和
    exportData.metadata.checksum = await this.calculateChecksum(exportData);
    
    // 生成文件
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { 
      type: 'application/json' 
    });
    
    return { 
      success: true, 
      blob,
      filename: `nanoflow-backup-${this.formatDate()}.json`,
      metadata: exportData.metadata
    };
  }
  
  /**
   * 触发下载
   */
  downloadExport(result: ExportResult): void {
    if (!result.success || !result.blob) return;
    
    const url = URL.createObjectURL(result.blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = result.filename ?? 'nanoflow-backup.json';
    a.click();
    URL.revokeObjectURL(url);
    
    // 记录导出时间
    this.preferenceService.setLastExportAt(new Date().toISOString());
  }
  
  /**
   * 清理敏感数据
   */
  private sanitizeProject(project: Project): Project {
    // 移除用户 ID 等敏感信息（可选）
    return {
      ...project,
      // ownerId: undefined, // 如需匿名化
    };
  }
}

interface ExportData {
  metadata: ExportMetadata;
  projects: Project[];
}

interface ExportMetadata {
  exportedAt: string;
  version: string;
  appVersion: string;
  projectCount: number;
  taskCount: number;
  checksum: string;
}

interface ExportResult {
  success: boolean;
  error?: string;
  blob?: Blob;
  filename?: string;
  metadata?: ExportMetadata;
}
```

**UI 位置**：设置页面 → 数据管理 → 导出数据

#### 4.2 导入/恢复功能

```typescript
/**
 * 导入服务
 * 位置：src/services/import.service.ts
 */
@Injectable({ providedIn: 'root' })
export class ImportService {
  /**
   * 从文件导入
   */
  async importFromFile(file: File): Promise<ImportResult> {
    try {
      const text = await file.text();
      const data = JSON.parse(text) as ExportData;
      
      // 1. 版本兼容性检查
      const versionCheck = this.checkVersion(data.metadata.version);
      if (!versionCheck.compatible) {
        return { success: false, error: versionCheck.error };
      }
      
      // 2. 校验和验证
      const checksumValid = await this.verifyChecksum(data);
      if (!checksumValid) {
        return { 
          success: false, 
          error: '数据校验失败，文件可能已损坏',
          requiresConfirmation: true,
          confirmMessage: '校验和不匹配，是否仍要继续导入？'
        };
      }
      
      // 3. 数据结构校验
      const validation = this.validateImportData(data);
      if (!validation.valid) {
        return { success: false, error: validation.errors.join('; ') };
      }
      
      return {
        success: true,
        data,
        preview: {
          projectCount: data.projects.length,
          taskCount: data.metadata.taskCount,
          exportedAt: data.metadata.exportedAt,
        }
      };
    } catch (e) {
      return { success: false, error: `解析失败: ${(e as Error).message}` };
    }
  }
  
  /**
   * 执行导入
   */
  async executeImport(
    data: ExportData, 
    options: ImportOptions
  ): Promise<ImportExecutionResult> {
    const results: ImportProjectResult[] = [];
    
    for (const project of data.projects) {
      const result = await this.importProject(project, options);
      results.push(result);
    }
    
    return {
      success: results.every(r => r.success),
      imported: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length,
      details: results,
    };
  }
  
  /**
   * 导入单个项目
   */
  private async importProject(
    project: Project, 
    options: ImportOptions
  ): Promise<ImportProjectResult> {
    const existingProject = this.projectState.getProjectById(project.id);
    
    if (existingProject) {
      switch (options.conflictStrategy) {
        case 'skip':
          return { success: true, skipped: true, projectId: project.id };
        case 'overwrite':
          // 覆盖前创建快照
          if (options.createSnapshotBeforeOverwrite) {
            await this.createLocalSnapshot(existingProject);
          }
          break;
        case 'rename':
          project = { ...project, id: crypto.randomUUID(), name: `${project.name} (导入)` };
          break;
      }
    }
    
    // 执行导入
    try {
      await this.projectState.upsertProject(project);
      return { success: true, projectId: project.id };
    } catch (e) {
      return { success: false, projectId: project.id, error: (e as Error).message };
    }
  }
}

interface ImportOptions {
  mode: 'merge' | 'replace';
  conflictStrategy: 'skip' | 'overwrite' | 'rename';
  createSnapshotBeforeOverwrite: boolean;
}

interface ImportResult {
  success: boolean;
  error?: string;
  data?: ExportData;
  preview?: ImportPreview;
  requiresConfirmation?: boolean;
  confirmMessage?: string;
}
```

**UI 位置**：设置页面 → 数据管理 → 恢复数据

#### 4.3 定期提醒

```typescript
/**
 * 导出提醒配置
 * 位置：src/config/backup.config.ts
 */
export const EXPORT_REMINDER_CONFIG = {
  // 提醒间隔（毫秒）- 7 天
  INTERVAL: 7 * 24 * 60 * 60 * 1000,
  
  // 是否默认启用
  DEFAULT_ENABLED: true,
  
  // 提醒方式
  NOTIFICATION_TYPE: 'toast' as const, // 'toast' | 'modal' | 'banner'
  
  // 提醒消息
  MESSAGE: '已超过 7 天未导出数据，建议立即备份',
} as const;

// PreferenceService 扩展
interface UserPreferences {
  lastExportAt?: string;
  exportReminderEnabled: boolean;
  exportReminderInterval?: number; // 自定义间隔
}

// AppComponent 中检查
private checkExportReminder(): void {
  if (!this.preferenceService.exportReminderEnabled()) return;
  
  const lastExport = this.preferenceService.lastExportAt();
  const interval = EXPORT_REMINDER_CONFIG.INTERVAL;
  
  if (!lastExport || Date.now() - new Date(lastExport).getTime() > interval) {
    this.toast.info('数据备份提醒', EXPORT_REMINDER_CONFIG.MESSAGE, {
      action: { label: '立即导出', callback: () => this.openExportModal() }
    });
  }
}
```

#### 4.4 Settings Modal 集成

```typescript
// 需要在 settings-modal.component.ts 中添加数据管理区块
// UI 设计：
// ┌─────────────────────────────────────────┐
// │  数据管理                               │
// ├─────────────────────────────────────────┤
// │  [📤 导出数据]  导出所有项目到 JSON 文件  │
// │  [📥 导入数据]  从备份文件恢复           │
// │                                         │
// │  上次导出：2026-01-01 10:30             │
// │  ☑️ 启用定期备份提醒（每 7 天）          │
// └─────────────────────────────────────────┘
```

---

### P2：服务端版本化备份（E 层 - 主保险）❌ 未实现

**目标**：实现分钟级 RPO 的自动化灾难恢复

**工时**：40-60 小时（原估算 20-30h 严重低估）

**工时调整原因**：
- Edge Function 开发复杂度高于预期
- 备份加密实现需额外工时
- 恢复 UI 需要设计和实现
- 需要完整的告警通道集成
- 需处理恢复操作原子性问题

**当前状态**：
- ❌ 备份 Edge Functions 不存在（仅有 cleanup-attachments）
- ❌ 对象存储未配置
- ❌ 恢复服务不存在
- ❌ 备份健康校验不存在
- ❌ 恢复 UI 不存在

**依赖关系**：E 层必须在 P0 熔断机制完成后实施，否则"坏数据也会被备份"。

#### 5.1 备份策略

```
┌─────────────────────────────────────────────────────────────┐
│                      备份时间线                              │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  00:00          06:00          12:00          18:00   24:00 │
│    │              │              │              │       │   │
│    ▼              ▼              ▼              ▼       ▼   │
│  [全量]                                              [全量] │
│    │                                                   │    │
│    ├──[增量]──[增量]──[增量]──[增量]──[增量]──...──[增量]──┤ │
│       15min    15min    15min    15min    15min           │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

| 类型 | 频率 | 内容 | 保留策略 |
|------|------|------|----------|
| **全量快照** | 每日 00:00 | 所有用户全部数据 | 保留 30 天 |
| **增量备份** | 每 15 分钟 | updated_at > 上次备份时间的记录 | 保留 7 天 |
| **事件日志** | 实时 | 关键操作日志 | 保留 90 天 |

#### 5.2 Edge Function 实现

```typescript
// supabase/functions/backup-scheduler/index.ts

import { createClient } from '@supabase/supabase-js';

interface BackupJob {
  type: 'full' | 'incremental';
  userId?: string;  // null = 全用户
  since?: string;   // 增量起始时间
}

Deno.serve(async (req) => {
  const job: BackupJob = await req.json();
  
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );
  
  // 1. 导出数据
  const data = await exportData(supabase, job);
  
  // 2. 健康校验
  const validation = validateBackup(data);
  if (!validation.ok) {
    await alertAdmin('Backup validation failed', validation.errors);
    return new Response(JSON.stringify({ error: 'Validation failed' }), { status: 400 });
  }
  
  // 3. 压缩
  const compressed = await compress(data);
  
  // 4. 上传到对象存储
  const path = generateBackupPath(job);
  await uploadToStorage(compressed, path);
  
  // 5. 加密（可选但推荐）
  const encrypted = BACKUP_ENCRYPTION_CONFIG.ENABLED 
    ? await encrypt(compressed, Deno.env.get('BACKUP_ENCRYPTION_KEY')!)
    : compressed;
  
  // 6. 上传到对象存储
  const path = generateBackupPath(job);
  await uploadToStorage(encrypted, path);
  
  // 7. 记录备份元数据
  await recordBackupMeta(supabase, {
    path,
    type: job.type,
    size: encrypted.size,
    recordCount: data.totalRecords,
    checksum: await hash(encrypted, 'SHA-256'), // 明确使用 SHA-256
    encrypted: BACKUP_ENCRYPTION_CONFIG.ENABLED,
    createdAt: new Date().toISOString()
  });
  
  return new Response(JSON.stringify({ success: true, path }));
});
```

#### 5.3 备份加密与完整性

```typescript
/**
 * 备份加密配置
 * 位置：supabase/functions/backup-scheduler/encryption.ts
 */
export const BACKUP_ENCRYPTION_CONFIG = {
  // 是否启用加密（推荐生产环境启用）
  ENABLED: true,
  
  // 加密算法
  ALGORITHM: 'AES-256-GCM' as const,
  
  // 密钥来源（环境变量）
  KEY_ENV_VAR: 'BACKUP_ENCRYPTION_KEY',
  
  // 密钥轮换策略
  KEY_ROTATION_DAYS: 90, // 每 90 天轮换
} as const;

/**
 * 完整性校验算法
 */
export const BACKUP_INTEGRITY_CONFIG = {
  // 校验算法（明确指定）
  CHECKSUM_ALGORITHM: 'SHA-256' as const,
  
  // 校验时机
  VERIFY_ON_UPLOAD: true,   // 上传后立即校验
  VERIFY_ON_RESTORE: true,  // 恢复前校验
  
  // 校验失败处理
  ON_CHECKSUM_MISMATCH: 'abort-and-alert' as const,
} as const;
```

#### 5.4 备份健康校验

```typescript
/**
 * 备份健康校验
 * 位置：supabase/functions/backup-scheduler/validation.ts
 */
interface BackupValidation {
  // 基础校验
  isJsonValid: boolean;
  
  // 完整性校验
  hasRequiredTables: boolean;  // projects, tasks, connections
  
  // 合理性校验
  projectCount: number;
  taskCount: number;
  taskCountInRange: boolean;  // 与上次备份对比，变化不超过阈值
  
  // 一致性校验
  orphanedTasks: number;      // 没有项目的任务数
  brokenConnections: number;  // 断开的连接数
  
  // 最终结论
  ok: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * 健康校验配置
 * 【审查修订】使用绝对值+相对值结合，避免小项目/大项目阈值不合理
 */
export const BACKUP_VALIDATION_CONFIG = {
  // 任务数变化阈值 - 【审查修订】分级告警
  TASK_COUNT_CHANGE: {
    // 相对值阈值（超过则告警）
    WARNING_RATIO: 0.1,  // 10% → 警告
    BLOCK_RATIO: 0.3,    // 30% → 阻止备份
    // 绝对值阈值（小项目使用）
    // 变化超过 20 个任务 → 至少触发警告
    ABSOLUTE_THRESHOLD: 20,
    // 小项目判定（低于此数量时使用绝对值）
    MIN_TASK_COUNT_FOR_RATIO: 50,
  },
  
  // 是否允许空备份
  ALLOW_EMPTY_BACKUP: false,
  
  // 最小项目数（低于则告警）
  MIN_PROJECT_COUNT: 1,
  
  // 孤儿任务阈值（超过则告警）
  MAX_ORPHANED_TASKS: 10,
  
  // 断开连接阈值
  MAX_BROKEN_CONNECTIONS: 20,
} as const;

/**
 * 执行备份健康校验
 */
async function validateBackup(
  currentData: BackupData,
  previousMeta: BackupMeta | null
): Promise<BackupValidation> {
  const errors: string[] = [];
  const warnings: string[] = [];
  
  // 1. JSON 有效性
  const isJsonValid = isValidJson(currentData);
  if (!isJsonValid) {
    errors.push('备份数据 JSON 格式无效');
  }
  
  // 2. 必需表检查
  const hasRequiredTables = 
    Array.isArray(currentData.projects) &&
    Array.isArray(currentData.tasks) &&
    Array.isArray(currentData.connections);
  if (!hasRequiredTables) {
    errors.push('缺少必需的数据表');
  }
  
  // 3. 任务数变化检查
  const taskCount = currentData.tasks?.length ?? 0;
  const previousTaskCount = previousMeta?.taskCount ?? 0;
  let taskCountInRange = true;
  
  if (previousTaskCount > 0) {
    const changeRatio = Math.abs(taskCount - previousTaskCount) / previousTaskCount;
    if (changeRatio > BACKUP_VALIDATION_CONFIG.TASK_COUNT_CHANGE_THRESHOLD) {
      warnings.push(
        `任务数变化异常: ${previousTaskCount} → ${taskCount} (${(changeRatio * 100).toFixed(1)}%)`
      );
      taskCountInRange = false;
    }
  }
  
  // 4. 空备份检查
  if (!BACKUP_VALIDATION_CONFIG.ALLOW_EMPTY_BACKUP && taskCount === 0) {
    errors.push('备份数据为空');
  }
  
  // 5. 孤儿任务检测
  const projectIds = new Set(currentData.projects?.map(p => p.id) ?? []);
  const orphanedTasks = currentData.tasks?.filter(t => !projectIds.has(t.projectId)) ?? [];
  if (orphanedTasks.length > BACKUP_VALIDATION_CONFIG.MAX_ORPHANED_TASKS) {
    warnings.push(`发现 ${orphanedTasks.length} 个孤儿任务`);
  }
  
  // 6. 断开连接检测
  const taskIds = new Set(currentData.tasks?.map(t => t.id) ?? []);
  const brokenConnections = currentData.connections?.filter(
    c => !taskIds.has(c.source) || !taskIds.has(c.target)
  ) ?? [];
  if (brokenConnections.length > BACKUP_VALIDATION_CONFIG.MAX_BROKEN_CONNECTIONS) {
    warnings.push(`发现 ${brokenConnections.length} 个断开的连接`);
  }
  
  return {
    isJsonValid,
    hasRequiredTables,
    projectCount: currentData.projects?.length ?? 0,
    taskCount,
    taskCountInRange,
    orphanedTasks: orphanedTasks.length,
    brokenConnections: brokenConnections.length,
    ok: errors.length === 0,
    errors,
    warnings,
  };
}
```

#### 5.4 版本保留策略

```typescript
// 保留策略配置
const RETENTION_POLICY = {
  // 最近 24 小时：保留所有增量（每 15 分钟一个）
  last24Hours: { type: 'all', maxAge: 24 * 60 * 60 * 1000 },
  
  // 最近 7 天：每天保留 4 个点（00:00, 06:00, 12:00, 18:00）
  last7Days: { type: 'sampled', interval: 6 * 60 * 60 * 1000, maxAge: 7 * 24 * 60 * 60 * 1000 },
  
  // 最近 30 天：每天保留 1 个点（全量快照）
  last30Days: { type: 'daily', maxAge: 30 * 24 * 60 * 60 * 1000 },
  
  // 更久：每周保留 1 个点
  older: { type: 'weekly', maxAge: 90 * 24 * 60 * 60 * 1000 }
};
```

#### 5.5 恢复入口

```typescript
interface RecoveryService {
  // 列出可用的恢复点
  listRecoveryPoints(userId: string): Promise<RecoveryPoint[]>;
  
  // 预览恢复内容（不实际恢复）
  previewRecovery(pointId: string): Promise<RecoveryPreview>;
  
  // 执行恢复
  executeRecovery(pointId: string, options: RecoveryOptions): Promise<RecoveryResult>;
}

interface RecoveryPoint {
  id: string;
  type: 'full' | 'incremental';
  timestamp: string;
  projectCount: number;
  taskCount: number;
  size: number;
}

interface RecoveryOptions {
  // 恢复模式
  mode: 'replace' | 'merge';
  
  // 恢复范围
  scope: 'all' | 'project';
  projectId?: string;
  
  // 是否创建恢复前快照
  createSnapshot: boolean;
}

/**
 * 恢复操作原子性保证
 * 
 * 问题：恢复过程中断（网络错误、浏览器崩溃）可能导致数据不完整
 * 
 * 解决方案：两阶段恢复
 */
interface AtomicRecoveryService {
  async executeRecovery(point: RecoveryPoint, options: RecoveryOptions): Promise<RecoveryResult> {
    // 阶段 1：准备（可中断）
    const prepareResult = await this.prepare(point, options);
    if (!prepareResult.ok) {
      return { success: false, error: prepareResult.error };
    }
    
    // 阶段 2：提交（尽可能原子）
    try {
      // 2.1 创建恢复前快照（必须成功）
      if (options.createSnapshot) {
        const snapshotId = await this.createPreRecoverySnapshot();
        if (!snapshotId) {
          return { success: false, error: '无法创建恢复前快照' };
        }
      }
      
      // 2.2 执行恢复（使用事务）
      await this.supabase.rpc('execute_recovery', {
        backup_path: point.path,
        mode: options.mode,
        scope: options.scope,
        project_id: options.projectId,
      });
      
      // 2.3 清理临时数据
      await this.cleanup(prepareResult.tempFiles);
      
      return { success: true, recoveredAt: new Date().toISOString() };
    } catch (error) {
      // 恢复失败：回滚到快照
      if (options.createSnapshot) {
        await this.rollbackToSnapshot();
      }
      return { success: false, error: error.message, rolledBack: true };
    }
  }
}
```

**UI 位置**：设置页面 → 数据管理 → 历史版本 → 选择时间点 → 预览 → 恢复

---

### P3：桌面坚果云备份（C 层 - 可选增强）❌ 未实现

**目标**：为桌面用户提供本地可见的额外备份

**工时**：8-16 小时

**当前状态**：
- ❌ LocalBackupService 不存在
- ❌ File System Access API 集成不存在
- ❌ Settings Modal 无相关入口

**依赖关系**：
- E 层必须先实现（C 层是增强层，不是替代）
- 若 E 层未实现，C 层**不应作为唯一备份**

#### 6.1 定位说明

> C 层是"第三层"，**不是主依赖**。它的价值是：
> - 让用户手里真的有一份离线可见的副本（心理安全感强）
> - 在极端情况下（Supabase 完全不可用）提供额外恢复途径

⚠️ **重要**：C 层依赖电脑在线 + 特定浏览器，不能作为主要备份策略。

#### 6.2 功能限制

| 限制项 | 说明 | 影响 |
|--------|------|------|
| 仅桌面端 | 手机不支持 File System Access API | 移动用户无法使用 |
| 仅 Chromium | Firefox/Safari 不支持 | 部分用户无法使用 |
| 需授权 | 浏览器重启后需要重新授权 | 用户体验受影响 |
| 依赖电脑在线 | 电脑关机时无备份 | 非 24x7 保护 |
| 依赖坚果云客户端 | 需要用户自行安装配置 | 额外配置成本 |

#### 6.3 实现要点

```typescript
/**
 * 本地备份服务
 * 位置：src/services/local-backup.service.ts
 */
@Injectable({ providedIn: 'root' })
export class LocalBackupService {
  private readonly uiState = inject(UiStateService);
  private readonly exportService = inject(ExportService);
  private readonly logger = inject(LoggerService).category('LocalBackup');
  
  // 目录句柄（持久化授权）
  private directoryHandle: FileSystemDirectoryHandle | null = null;
  
  /**
   * 浏览器兼容性检查
   */
  get isSupported(): boolean {
    return 'showDirectoryPicker' in window && !this.uiState.isMobile();
  }
  
  /**
   * 功能启用条件
   */
  get canEnable(): CanEnableResult {
    if (!this.isSupported) {
      return { canEnable: false, reason: '当前浏览器不支持 File System Access API' };
    }
    if (this.uiState.isMobile()) {
      return { canEnable: false, reason: '移动设备不支持本地备份' };
    }
    // 注意：即使 E 层未实现，也允许启用 C 层，但会显示警告
    return { canEnable: true };
  }
  
  /**
   * 请求目录授权
   */
  async requestDirectoryAccess(): Promise<boolean> {
    try {
      this.directoryHandle = await window.showDirectoryPicker({
        mode: 'readwrite',
        startIn: 'documents',
      });
      
      // 持久化授权（如果浏览器支持）
      if ('permissions' in navigator) {
        await this.persistPermission();
      }
      
      return true;
    } catch (e) {
      if ((e as Error).name === 'AbortError') {
        // 用户取消
        return false;
      }
      this.logger.error('目录授权失败', e);
      return false;
    }
  }
  
  /**
   * 执行本地备份
   */
  async performBackup(): Promise<BackupResult> {
    if (!this.directoryHandle) {
      return { success: false, error: '未授权目录访问' };
    }
    
    // 检查授权是否仍有效
    const permission = await this.directoryHandle.queryPermission({ mode: 'readwrite' });
    if (permission !== 'granted') {
      return { success: false, error: '目录访问权限已过期，请重新授权' };
    }
    
    // 导出数据
    const exportResult = await this.exportService.exportAllProjects();
    if (!exportResult.success || !exportResult.blob) {
      return { success: false, error: exportResult.error };
    }
    
    // 写入文件
    const filename = `nanoflow-backup-${this.formatTimestamp()}.json`;
    try {
      const fileHandle = await this.directoryHandle.getFileHandle(filename, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(exportResult.blob);
      await writable.close();
      
      this.logger.info('本地备份完成', { filename });
      return { success: true, filename };
    } catch (e) {
      this.logger.error('写入文件失败', e);
      return { success: false, error: (e as Error).message };
    }
  }
  
  /**
   * 自动备份（定时触发）
   */
  setupAutoBackup(intervalMs: number = 30 * 60 * 1000): void {
    setInterval(() => {
      if (this.directoryHandle) {
        this.performBackup().catch(e => this.logger.error('自动备份失败', e));
      }
    }, intervalMs);
  }
}
```

#### 6.4 与其他层的关系

```
┌─────────────────────────────────────────────────────────────┐
│                     故障恢复优先级                          │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  1. E 层可用 → 从服务端恢复（推荐）                          │
│       ↓ 失败                                                │
│  2. C 层可用 → 从坚果云本地文件恢复                          │
│       ↓ 失败                                                │
│  3. D 层可用 → 从用户手动导出文件恢复                        │
│       ↓ 失败                                                │
│  4. 无可用备份 → 数据丢失                                   │
│                                                             │
└─────────────────────────────────────────────────────────────┘

注意：如果 E 层未实现，C 层和 D 层是仅有的保护，应强烈提醒用户
```

#### 6.5 坚果云集成说明

```markdown
## 用户配置指南（需在帮助文档中提供）

1. 安装坚果云桌面客户端
2. 在 NanoFlow 设置中启用"本地备份"
3. 选择坚果云同步文件夹下的一个子目录
4. NanoFlow 会自动将备份写入该目录
5. 坚果云会自动同步到云端

**注意事项**：
- 浏览器重启后可能需要重新授权目录访问
- 确保坚果云客户端保持运行
- 定期检查坚果云同步状态
```

---

## 四、遗漏场景补充

### 4.1 附件数据保护

**当前状态**：
- ✅ 附件软删除机制已实现（`cleanup-attachments` Edge Function）
- ✅ **运行时 Signed URL 自动刷新已实现**（`AttachmentService.checkAndRefreshExpiredUrls()`）
- ❌ 附件未包含在 D 层导出中
- ❌ 附件未包含在 E 层备份中

**风险**：用户导出/恢复数据后，附件丢失。

**解决方案**：

```typescript
/**
 * 附件备份策略
 */
export const ATTACHMENT_BACKUP_CONFIG = {
  // D 层：导出时包含附件
  INCLUDE_IN_EXPORT: {
    // 嵌入方式（适用于小附件）
    EMBED_SMALL_FILES: true,
    EMBED_SIZE_LIMIT: 1 * 1024 * 1024, // 1MB
    
    // 引用方式（适用于大附件）
    INCLUDE_REFERENCES: true, // 仅包含 URL，不嵌入内容
  },
  
  // E 层：备份时包含附件
  INCLUDE_IN_BACKUP: true,
  
  // 附件存储位置备份
  BACKUP_STORAGE_BUCKET: true,
  
  // Signed URL 过期处理（当前配置：30天过期）
  SIGNED_URL_HANDLING: {
    // 导出时：下载文件内容而非保存 URL
    DOWNLOAD_BEFORE_EXPORT: true,
    
    // 导入时：重新获取 Signed URL
    REFRESH_URLS_ON_IMPORT: true,
    
    // URL 过期检测阈值（天）
    URL_EXPIRY_WARNING_DAYS: 7,
  },
} as const;

// 导出数据结构扩展
interface ExportData {
  metadata: ExportMetadata;
  projects: Project[];
  attachments?: AttachmentExport[]; // 新增
}

interface AttachmentExport {
  id: string;
  taskId: string;
  projectId: string;
  name: string;
  type: string;
  size: number;
  // 小文件嵌入 base64，大文件仅保留引用
  data?: string; // base64
  url?: string;  // 外部引用（注意：Signed URL 30天后过期）
  storagePath?: string; // 存储路径（用于重新获取 URL）
}

/**
 * 附件导出策略说明
 * 
 * 问题：Supabase Storage 的 Signed URL 有 30 天有效期（ATTACHMENT_CONFIG.SIGNED_URL_EXPIRY）
 * 
 * 解决方案：
 * 1. D 层导出：小于 1MB 的文件直接嵌入 base64，大于 1MB 的下载后嵌入
 * 2. E 层备份：直接备份 Storage bucket，不依赖 Signed URL
 * 3. 导入时：根据 storagePath 重新获取 Signed URL
 * 
 * 🚨 审查补充 - 需额外考虑的问题：
 * 1. 导出文件过大：嵌入所有附件可能导致 JSON 超过 500MB
 *    解决方案：采用 ZIP 打包 + 流式写入，而非单一 JSON 文件
 * 2. 附件去重：同一附件被多个任务引用时应只导出一份
 *    解决方案：使用 attachmentId 作为唯一标识，projects 中只保留引用
 * 3. 导入时配额：导入大量附件可能超出 Storage 配额
 *    解决方案：导入前检查配额，分批上传，支持跳过附件
 */

// 优化的导出数据结构
interface ExportDataV2 {
  metadata: ExportMetadata;
  projects: Project[];
  // 附件清单（不包含内容，避免 JSON 过大）
  attachmentManifest: AttachmentManifest[];
  preferences?: UserPreferences;
}

interface AttachmentManifest {
  id: string;
  taskIds: string[]; // 支持一对多引用
  name: string;
  type: string;
  size: number;
  checksum: string; // 用于去重和完整性校验
  // 打包文件中的相对路径（如 "attachments/abc-123.pdf"）
  bundlePath?: string;
}

// 导出时生成 ZIP 包而非单一 JSON
interface ExportBundle {
  manifest: ExportDataV2;      // manifest.json
  attachments: Map<string, Blob>; // attachments/*.pdf 等
}
```

### 4.2 用户偏好保护

**当前状态**：
- ✅ `user_preferences` 表存在
- ❌ 偏好设置未包含在导出/备份中

**解决方案**：

```typescript
interface ExportData {
  metadata: ExportMetadata;
  projects: Project[];
  attachments?: AttachmentExport[];
  preferences?: UserPreferences; // 新增
}
```

### 4.3 连接（Connection）数据保护

**当前状态**：
- ✅ 软删除已实现（`deleted_at` 字段）
- ⚠️ 连接随任务删除时的级联处理已实现
- ❌ 连接的 tombstone 机制未实现

**风险**：已删除的连接可能被旧客户端复活。

**解决方案**：

```sql
-- 添加连接 tombstone 表（参考 task_tombstones）
CREATE TABLE IF NOT EXISTS public.connection_tombstones (
  connection_id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  deleted_at timestamptz NOT NULL DEFAULT now(),
  deleted_by uuid NULL
);

-- 🔴 v5.2 补充：RLS 策略（必须添加，否则无法访问）
ALTER TABLE public.connection_tombstones ENABLE ROW LEVEL SECURITY;

-- 用户只能读写自己项目的 tombstone
CREATE POLICY "connection_tombstones_read" ON public.connection_tombstones
  FOR SELECT TO authenticated
  USING (
    project_id IN (
      SELECT id FROM public.projects WHERE owner_id = auth.uid()
      UNION
      SELECT project_id FROM public.project_members WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "connection_tombstones_insert" ON public.connection_tombstones
  FOR INSERT TO authenticated
  WITH CHECK (
    project_id IN (
      SELECT id FROM public.projects WHERE owner_id = auth.uid()
      UNION
      SELECT project_id FROM public.project_members WHERE user_id = auth.uid()
    )
  );

-- 🔴 注意：不允许删除 tombstone（与 task_tombstones 一致）
-- 这是防复活机制的关键，tombstone 应该是不可逆的

-- 防复活触发器
CREATE OR REPLACE FUNCTION public.prevent_tombstoned_connection_writes()
RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.connection_tombstones ct
    WHERE ct.connection_id = NEW.id
  ) THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_prevent_connection_resurrection ON public.connections;
CREATE TRIGGER trg_prevent_connection_resurrection
  BEFORE INSERT OR UPDATE ON public.connections
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_tombstoned_connection_writes();
```

### 4.4 项目元数据保护

**当前状态**：
- ✅ 项目 `updated_at` 触发器已实现
- ❌ 项目级 tombstone 未实现
- ❌ 项目删除时的级联清理不完整

**解决方案**：

```sql
-- 项目删除时确保级联处理
CREATE OR REPLACE FUNCTION public.safe_delete_project(p_project_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- 1. 记录所有任务到 tombstone
  INSERT INTO public.task_tombstones (task_id, project_id, deleted_at, deleted_by)
  SELECT id, project_id, NOW(), auth.uid()
  FROM public.tasks
  WHERE project_id = p_project_id
  ON CONFLICT (task_id) DO NOTHING;
  
  -- 2. 删除任务
  DELETE FROM public.tasks WHERE project_id = p_project_id;
  
  -- 3. 删除连接
  DELETE FROM public.connections WHERE project_id = p_project_id;
  
  -- 4. 删除项目
  DELETE FROM public.projects WHERE id = p_project_id AND owner_id = auth.uid();
  
  RETURN FOUND;
END;
$$;
```

### 4.5 PWA 缓存一致性

**当前状态**：
- ✅ Service Worker 已配置（ngsw-config.json）
- ⚠️ 缓存失效策略未优化
- ❌ 离线期间的缓存数据校验不存在

**风险**：Service Worker 缓存过期数据，导致数据不一致。

**解决方案**：

```typescript
/**
 * PWA 缓存配置建议
 */
export const PWA_CACHE_CONFIG = {
  // 数据请求策略
  DATA_STRATEGY: 'network-first', // 优先网络，失败用缓存
  
  // 缓存有效期
  DATA_CACHE_TTL: 5 * 60 * 1000, // 5 分钟
  
  // 版本检查
  CHECK_VERSION_ON_ACTIVATE: true,
  
  // 缓存清理
  CLEANUP_ON_VERSION_CHANGE: true,
} as const;
```

### 4.6 RLS 权限拒绝处理（❌ 待实现）

**场景**：用户离线编辑 → 管理员撤销权限 → 重连时同步被 401/403 拒绝

**当前状态**：
- ✅ 401/403 被识别为不可重试错误（supabase-error.ts#L108）
- ❌ 被拒数据直接丢弃，未提供用户复制机会
- ❌ 无权限变更检测机制

**风险**：用户离线期间编辑的数据在重连时被静默丢弃。

> 🚨 **审查补充**：方案建议将被拒数据存入 localStorage，但未考虑：
> 1. localStorage 配额有限（5-10MB）
> 2. 被拒数据可能超过配额
> 
> **修正策略**：改为直接触发文件下载，不存本地

```typescript
/**
 * 权限拒绝处理配置
 * 位置：src/config/sync.config.ts
 */
export const PERMISSION_DENIED_CONFIG = {
  // 权限拒绝时的数据处理策略
  // 🚨 修正：从 'isolate-and-notify' 改为 'download-and-discard'
  ON_PERMISSION_DENIED: 'download-and-discard' as const, // 'discard' | 'download-and-discard' | 'isolate-and-notify'
  
  // 隔离存储 key（仅当策略为 isolate-and-notify 时使用）
  REJECTED_DATA_STORAGE_KEY: 'nanoflow.rejected-data',
  
  // 隔离数据保留时间（毫秒）
  REJECTED_DATA_RETENTION: 7 * 24 * 60 * 60 * 1000, // 7 天
  
  // 最大可隔离数据大小（字节）- 超过则强制下载
  MAX_ISOLATE_SIZE: 1 * 1024 * 1024, // 1MB
} as const;

/**
 * 权限拒绝处理服务
 * 位置：src/services/permission-denied-handler.service.ts
 */
interface PermissionDeniedHandler {
  /**
   * 处理同步时的权限拒绝错误
   */
  async handlePermissionDenied(
    error: SupabaseError,
    rejectedData: Task[] | Connection[]
  ): Promise<void> {
    // 1. 将被拒数据隔离到单独存储
    const isolatedData = {
      rejectedAt: new Date().toISOString(),
      reason: error.message,
      data: rejectedData,
    };
    await this.storage.set(PERMISSION_DENIED_CONFIG.REJECTED_DATA_STORAGE_KEY, isolatedData);
    
    // 2. 从主存储中移除（避免重复同步失败）
    // 注意：不是删除，是隔离
    
    // 3. 通知用户
    this.modal.open(PermissionDeniedModal, {
      title: '数据同步被拒绝',
      message: '您没有权限保存这些更改，可能是因为权限被撤销',
      actions: [
        { 
          label: '复制到剪贴板', 
          action: async () => {
            await navigator.clipboard.writeText(JSON.stringify(rejectedData, null, 2));
            this.toast.success('已复制到剪贴板');
          }
        },
        { 
          label: '导出为文件', 
          action: () => this.exportService.exportData(rejectedData, 'rejected-data.json')
        },
        { label: '放弃数据', action: () => this.discardRejectedData() },
      ]
    });
    
    // 4. 上报 Sentry
    Sentry.captureMessage('Permission denied during sync', {
      level: 'warning',
      tags: { errorCode: error.code },
      extra: { dataCount: rejectedData.length }
    });
  }
}
```

### 4.7 多设备冲突处理（⚠️ 部分覆盖）

**场景**：同一用户在手机和电脑上同时编辑同一任务

**当前状态**：
- ✅ LWW 策略可解决冲突
- ⚠️ 可能导致一方编辑被覆盖
- ❌ 无跨设备编辑检测

**说明**：与多标签页不同，多设备场景无法使用 BroadcastChannel 通信。

```typescript
/**
 * 多设备冲突处理策略
 * 
 * 设计决策：
 * 1. 接受 LWW 作为默认策略（简单可靠）
 * 2. 通过 Realtime 订阅检测远程变更
 * 3. 当检测到冲突时提示用户（而非静默覆盖）
 */
export const MULTI_DEVICE_CONFLICT_CONFIG = {
  // 是否启用远程变更检测
  DETECT_REMOTE_CHANGES: true,
  
  // 检测到远程变更时的处理
  ON_REMOTE_CHANGE_DETECTED: 'notify-and-merge' as const, // 'silent-lww' | 'notify-and-merge' | 'prompt-choice'
  
  // 编辑窗口期（毫秒）- 在此时间内的并发编辑视为冲突
  CONFLICT_WINDOW: 5000, // 5 秒
  
  // 冲突通知消息
  CONFLICT_MESSAGE: '其他设备刚刚也修改了此任务，已自动合并',
  
  // 🚨 Realtime 不可用时的降级策略
  // 注意：项目默认关闭 Realtime（SYNC_CONFIG.USE_REALTIME = false）以节省流量
  FALLBACK_ON_REALTIME_UNAVAILABLE: 'polling-enhanced' as const, // 'polling-enhanced' | 'no-detection' | 'warn-user'
  
  // 增强轮询配置（当 Realtime 不可用时）
  ENHANCED_POLLING: {
    // 缩短拉取间隔
    INTERVAL: 10 * 1000, // 10 秒（正常为 30 秒）
    // 启用 updated_at 变化检测
    DETECT_UPDATED_AT_CHANGE: true,
    // 变化检测窗口
    CHANGE_DETECTION_WINDOW: 5000, // 5 秒内的变化视为潜在冲突
  },
} as const;

/**
 * Realtime 降级说明
 * 
 * 当 SYNC_CONFIG.USE_REALTIME = false（默认）时：
 * 1. 无法实时检测远程变更
 * 2. 依赖增强轮询检测冲突
 * 3. 冲突检测有 10 秒延迟窗口
 * 
 * 建议：
 * - 对于高频协作场景，考虑启用 Realtime
 * - 对于单用户多设备场景，增强轮询足够
 */

/**
 * 冲突检测逻辑（在 Realtime 订阅回调中）
 */
function handleRealtimeUpdate(payload: RealtimePayload): void {
  const { eventType, new: newRecord, old: oldRecord } = payload;
  
  // 检查是否是自己的变更（通过 client_id 或 updated_by 字段）
  if (newRecord.updated_by === this.currentClientId) {
    return; // 忽略自己的变更
  }
  
  // 检查本地是否有未同步的对同一记录的编辑
  const localPending = this.retryQueue.find(item => item.id === newRecord.id);
  if (localPending) {
    // 检测到冲突
    this.handleConflict(localPending, newRecord);
  }
}

/**
 * 增强轮询冲突检测（Realtime 不可用时的替代方案）
 */
function checkForRemoteChanges(pulledTasks: Task[]): void {
  const now = Date.now();
  
  for (const task of pulledTasks) {
    const localTask = this.taskStore.getTask(task.id);
    if (!localTask) continue;
    
    // 检查是否有近期的远程变更
    const remoteUpdatedAt = new Date(task.updatedAt).getTime();
    const localUpdatedAt = new Date(localTask.updatedAt).getTime();
    
    if (remoteUpdatedAt > localUpdatedAt) {
      const timeDiff = now - remoteUpdatedAt;
      if (timeDiff < MULTI_DEVICE_CONFLICT_CONFIG.ENHANCED_POLLING.CHANGE_DETECTION_WINDOW) {
        // 近期有远程变更，检查本地是否也有未同步的编辑
        const localPending = this.retryQueue.find(item => item.id === task.id);
        if (localPending) {
          this.handleConflict(localPending, task);
        }
      }
    }
  }
}
```

### 4.8 Undo 历史保护（⚠️ 需明确策略）

**问题**：撤销历史是否需要持久化或包含在备份中？

**当前状态**：
- ✅ `UndoService` 已实现，支持 Ctrl+Z/Y
- ✅ 撤销历史存储在内存中
- ❌ 页面刷新后撤销历史丢失
- ❌ 导出/备份不包含撤销历史

**设计决策**：

```typescript
/**
 * Undo 历史保护策略
 * 
 * 决策：撤销历史 **不纳入** 导出/备份范围
 * 
 * 理由：
 * 1. 撤销历史是临时操作记录，非核心数据
 * 2. 持久化撤销历史会显著增加存储占用
 * 3. 跨设备/跨会话的撤销行为难以定义
 * 4. 用户期望：刷新页面后撤销历史清空是合理的
 * 
 * 例外情况：
 * - 会话内持久化：页面刷新不丢失（可选功能）
 * - 使用 sessionStorage 而非 localStorage
 */
export const UNDO_PERSISTENCE_CONFIG = {
  // 是否在会话内持久化撤销历史
  PERSIST_IN_SESSION: false, // 默认不启用
  
  // 如果启用，使用 sessionStorage
  STORAGE_TYPE: 'session' as const, // 'session' | 'local' | 'none'
  
  // 最大历史记录数
  MAX_HISTORY_SIZE: 100,
  
  // 是否在导出中包含
  INCLUDE_IN_EXPORT: false, // 明确：不包含
  
  // 是否在 E 层备份中包含
  INCLUDE_IN_BACKUP: false, // 明确：不包含
} as const;
```

### 4.9 Guest 用户数据保护（⚠️ 需补充）

**问题**：未登录的 Guest 用户数据如何保护？

**当前状态**：
- ✅ Guest 数据存储在 localStorage（migration.service.ts）
- ✅ Guest 数据有 30 天过期时间（`GUEST_DATA_EXPIRY_DAYS = 30`）
- ❌ Guest 无法使用云端备份
- ❌ Guest 数据导出提醒不明确

```typescript
/**
 * Guest 用户数据保护策略
 * 
 * 注意：EXPIRY_DAYS 必须与 migration.service.ts 中的 GUEST_DATA_EXPIRY_DAYS 保持一致
 */
export const GUEST_DATA_PROTECTION_CONFIG = {
  // Guest 数据过期天数（与 migration.service.ts 一致）
  EXPIRY_DAYS: 30,
  
  // 过期前警告天数
  WARNING_BEFORE_EXPIRY_DAYS: 7,
  
  // 是否启用 D 层导出（Guest 可用）
  ENABLE_EXPORT: true,
  
  // 是否在首页显示登录提醒
  SHOW_LOGIN_REMINDER: true,
  
  // 提醒消息
  LOGIN_REMINDER_MESSAGE: '当前为访客模式，数据仅保存在本地。登录后可启用云端同步和自动备份。',
  
  // 数据即将过期时的处理
  ON_EXPIRY_WARNING: [
    'show-toast',           // 显示 Toast 提醒
    'prompt-export',        // 提示导出
    'prompt-login',         // 提示登录
  ],
} as const;
```

### 4.10 IndexedDB 损坏恢复（❌ 待实现）

**问题**：浏览器更新/崩溃可能导致 IndexedDB 损坏。

**当前状态**：
- ❌ 无 IndexedDB 损坏检测
- ❌ 无自动恢复机制

> 🚨 **审查补充**：方案原有检测方法过于简单，遗漏以下场景：
> - **数据静默损坏**：IndexedDB 可成功打开，但数据已损坏（如 JSON 解析失败）
> - **跨版本升级问题**：IndexedDB 版本号增量导致数据迁移失败
> - **Safari 特殊行为**：Safari 的 IndexedDB 有 7 天未访问自动清理策略

**解决方案**：

```typescript
/**
 * IndexedDB 损坏检测配置
 * 位置：src/services/storage-adapter.service.ts
 * 【审查修订】增加静默损坏检测和 Safari 特殊处理
 */
export const INDEXEDDB_HEALTH_CONFIG = {
  // 初始化时检测数据库健康
  CHECK_ON_INIT: true,
  
  // 损坏检测方法 - 【审查修订】增加更多检测类型
  DETECT_METHODS: [
    'open-error',         // 无法打开数据库
    'version-error',      // 版本错误
    'transaction-abort',  // 事务中断
    'quota-error',        // 配额错误
    'json-parse-error',   // 【新增】数据 JSON 解析失败
    'schema-mismatch',    // 【新增】数据结构不匹配
    'checksum-mismatch',  // 【新增】校验和不匹配
  ],
  
  // 【新增】启动时数据完整性校验
  STARTUP_INTEGRITY_CHECK: {
    ENABLED: true,
    // 校验方式：抽样校验前 N 条记录
    SAMPLE_SIZE: 10,
    // 校验内容
    CHECK_JSON_PARSE: true,
    CHECK_REQUIRED_FIELDS: true,
    CHECK_CHECKSUM: false, // 可选，性能开销较大
  },
  
  // 【新增】Safari 特殊处理
  SAFARI_HANDLING: {
    // 检测是否为 Safari
    DETECT_SAFARI: true,
    // Safari 7 天未访问自动清理警告
    WARN_INACTIVITY_DAYS: 5,
    // 提醒用户定期访问
    SHOW_SAFARI_WARNING: true,
    WARNING_MESSAGE: '您正在使用 Safari 浏览器，超过 7 天未访问可能导致本地数据被清理，建议定期导出备份。',
  },
  
  // 损坏时的恢复策略
  ON_CORRUPTION: 'prompt-recovery' as const, // 'auto-cloud' | 'prompt-recovery' | 'notify-only'
} as const;

/**
 * 数据库健康检查
 * 【审查修订】增加数据内容校验
 */
async function checkDatabaseHealth(): Promise<HealthCheckResult> {
  try {
    const db = await openDatabase();
    const testTx = db.transaction(['projects'], 'readonly');
    await testTx.objectStore('projects').count();
    return { healthy: true };
  } catch (e) {
    const error = e as DOMException;
    return {
      healthy: false,
      errorType: error.name,
      canRecover: error.name !== 'SecurityError',
      suggestedAction: 'cloud-recovery',
    };
  }
}
```

### 4.11 时钟偏移问题（❌ 待实现）

**问题**：用户手动调整系统时钟可能导致 `updatedAt` 比较失效。

**当前状态**：
- ❌ LWW 完全依赖客户端时钟
- ❌ 无服务端时间校验

**风险**：时钟回拨会导致新数据被旧数据覆盖。

**解决方案**：

```sql
-- 服务端强制使用服务端时间
CREATE OR REPLACE FUNCTION public.force_server_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  -- 强制使用服务端时间，忽略客户端传入的 updated_at
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 注意：此触发器会与客户端 LWW 策略冲突
-- 需要调整客户端逻辑：先推送变更，再拉取服务端时间
```

**客户端适配**：

```typescript
/**
 * 时钟校正配置
 */
export const CLOCK_SYNC_CONFIG = {
  // 是否启用服务端时间校正
  USE_SERVER_TIME: true,
  
  // 时钟偏移警告阈值（毫秒）
  CLOCK_DRIFT_WARNING_THRESHOLD: 60 * 1000, // 1 分钟
  
  // 时钟偏移错误阈值（毫秒）
  CLOCK_DRIFT_ERROR_THRESHOLD: 5 * 60 * 1000, // 5 分钟
  
  // 检测到严重时钟偏移时的处理
  ON_SEVERE_DRIFT: 'warn-and-sync' as const,
} as const;
```

### 4.12 跨设备 UUID 冲突（理论风险）

**问题**：两台设备离线创建任务时，极小概率发生 UUID 冲突。

**风险等级**：极低（UUID v4 冲突概率约 10^-37）

**当前状态**：
- ✅ 使用 `crypto.randomUUID()` 生成
- ❌ 无冲突检测和处理

**建议策略**：

```typescript
/**
 * UUID 冲突处理（作为防御性编程）
 */
export const UUID_CONFLICT_CONFIG = {
  // 是否启用冲突检测
  DETECT_CONFLICTS: true,
  
  // 冲突处理策略
  ON_CONFLICT: 'regenerate-and-retry' as const,
  
  // 最大重试次数
  MAX_RETRIES: 3,
} as const;

// 在 upsert 时检测主键冲突
async function safeUpsert(task: Task): Promise<Result<void, Error>> {
  try {
    await this.supabase.from('tasks').upsert(task);
    return success();
  } catch (e) {
    if (isPrimaryKeyConflict(e) && this.isNewTask(task)) {
      // 极小概率：UUID 冲突，重新生成 ID
      const newTask = { ...task, id: crypto.randomUUID() };
      return this.safeUpsert(newTask);
    }
    return failure(e);
  }
}
```

### 4.13 数据迁移安全（❌ 待实现）

**问题**：Guest 用户登录后的数据迁移过程可能导致数据丢失。

**当前状态**：
- ✅ `MigrationService` 已实现基础迁移功能
- ❌ 迁移前无本地快照保护
- ❌ `discard-local` 策略无二次确认
- ❌ 迁移失败时本地数据可能已被清理

**风险场景**：

| 场景 | 当前行为 | 风险 |
|------|----------|------|
| 迁移过程中网络中断 | 部分数据上传 | 数据不一致 |
| 误选 `discard-local` 策略 | 本地数据直接丢弃 | 无法撤销 |
| 本地与远程存在同 ID 项目 | `merge` 可能覆盖 | 静默数据丢失 |
| 迁移失败后重试 | 本地数据可能已清理 | 无数据可迁移 |

**解决方案**：

```typescript
/**
 * 数据迁移安全配置
 * 位置：src/config/migration.config.ts
 */
export const MIGRATION_SAFETY_CONFIG = {
  // 迁移前强制创建本地快照
  CREATE_SNAPSHOT_BEFORE_MIGRATION: true,
  
  // 禁止一键丢弃，需二次确认
  REQUIRE_CONFIRMATION_FOR_DISCARD: true,
  DISCARD_CONFIRMATION_MESSAGE: '确定要放弃所有本地数据吗？此操作不可撤销。',
  
  // 迁移失败时保留本地数据
  PRESERVE_LOCAL_ON_FAILURE: true,
  
  // 快照保留时间（毫秒）
  SNAPSHOT_RETENTION: 7 * 24 * 60 * 60 * 1000, // 7 天
  
  // 迁移超时时间（毫秒）
  MIGRATION_TIMEOUT: 60 * 1000, // 1 分钟
  
  // 批量上传配置（避免大量数据一次性上传失败）
  BATCH_SIZE: 50,
  BATCH_DELAY: 500, // 毫秒
} as const;

/**
 * 安全迁移流程
 */
interface SafeMigrationService {
  async executeMigration(strategy: MigrationStrategy): Promise<MigrationResult> {
    // 1. 创建本地快照（必须成功）
    const snapshotId = await this.createLocalSnapshot();
    if (!snapshotId) {
      return { success: false, error: '无法创建本地快照' };
    }
    
    // 2. 对于 discard-local 策略，要求二次确认
    if (strategy === 'discard-local') {
      const confirmed = await this.confirmDiscard();
      if (!confirmed) {
        return { success: false, error: '用户取消' };
      }
    }
    
    // 3. 执行迁移（带超时和重试）
    try {
      const result = await this.performMigration(strategy);
      
      if (result.success) {
        // 成功：清理快照（可选保留一段时间）
        this.scheduleSnapshotCleanup(snapshotId);
      }
      
      return result;
    } catch (error) {
      // 4. 失败：保留本地数据，提示用户
      this.toast.error('迁移失败', '本地数据已保留，可稍后重试');
      Sentry.captureException(error, { tags: { operation: 'migration' } });
      
      return { 
        success: false, 
        error: error.message,
        snapshotId, // 返回快照 ID 以便恢复
      };
    }
  }
}
```

### 4.14 路由离开保护（❌ 待实现）

**问题**：切换项目或导航离开编辑页面时，可能丢失未保存的变更。

**当前状态**：
- ✅ `beforeunload` 保护已实现（关闭页面时）
- ❌ 应用内路由切换无保护
- ❌ 切换项目时未检查未保存变更

**风险场景**：

| 场景 | 当前行为 | 风险 |
|------|----------|------|
| 编辑任务后立即切换项目 | 静默切换 | 编辑丢失（如果未完成同步） |
| 点击浏览器后退按钮 | 直接导航 | 编辑丢失 |
| 在编辑中刷新页面 | `beforeunload` 提示 | ✅ 已保护 |

**解决方案**：

```typescript
/**
 * 路由离开保护配置
 * 位置：src/config/ui.config.ts
 */
export const ROUTE_LEAVE_PROTECTION_CONFIG = {
  // 是否启用未保存变更检查
  CHECK_UNSAVED_CHANGES: true,
  
  // 离开前提示
  PROMPT_BEFORE_LEAVE: true,
  PROMPT_MESSAGE: '有未保存的更改，确定要离开吗？',
  
  // 是否在离开前自动保存
  AUTO_SAVE_BEFORE_LEAVE: false, // 设为 true 可改善体验
  
  // 自动保存超时（毫秒）
  AUTO_SAVE_TIMEOUT: 3000,
  
  // 需要保护的路由
  PROTECTED_ROUTES: [
    '/project/:id',
    '/project/:id/flow',
    '/project/:id/text',
  ],
} as const;

/**
 * 路由守卫实现
 * 位置：src/services/guards/unsaved-changes.guard.ts
 */
@Injectable({ providedIn: 'root' })
export class UnsavedChangesGuard implements CanDeactivate<unknown> {
  private readonly syncService = inject(SimpleSyncService);
  private readonly modal = inject(ModalService);
  
  async canDeactivate(
    component: unknown,
    currentRoute: ActivatedRouteSnapshot,
    currentState: RouterStateSnapshot,
    nextState: RouterStateSnapshot
  ): Promise<boolean> {
    // 检查是否有未同步的变更
    const hasPendingChanges = this.syncService.hasPendingChanges();
    
    if (!hasPendingChanges) {
      return true;
    }
    
    if (ROUTE_LEAVE_PROTECTION_CONFIG.AUTO_SAVE_BEFORE_LEAVE) {
      // 尝试自动保存
      try {
        await this.syncService.flushPendingChanges();
        return true;
      } catch {
        // 自动保存失败，提示用户
      }
    }
    
    // 显示确认对话框
    const confirmed = await this.modal.confirm({
      title: '未保存的更改',
      message: ROUTE_LEAVE_PROTECTION_CONFIG.PROMPT_MESSAGE,
      confirmText: '离开',
      cancelText: '留在此页',
      danger: true,
    });
    
    return confirmed;
  }
}

/**
 * 项目切换保护
 * 在 ProjectShellComponent 中实现
 */
async switchProject(newProjectId: string): Promise<void> {
  // 检查当前项目是否有未保存变更
  if (this.syncService.hasPendingChanges()) {
    const action = await this.modal.choice({
      title: '未保存的更改',
      message: '当前项目有未同步的更改',
      choices: [
        { label: '保存并切换', value: 'save' },
        { label: '放弃并切换', value: 'discard' },
        { label: '取消', value: 'cancel' },
      ],
    });
    
    switch (action) {
      case 'save':
        await this.syncService.flushPendingChanges();
        break;
      case 'discard':
        this.syncService.discardPendingChanges();
        break;
      case 'cancel':
        return; // 不切换
    }
  }
  
  // 执行项目切换
  this.projectState.setActiveProject(newProjectId);
}
```

---

## 五、费用估算

### 对象存储费用（以 Cloudflare R2 为例）

| 项目 | 数量 | 单价 | 月费用 |
|------|------|------|--------|
| 存储 | 10 GB | $0.015/GB | $0.15 |
| Class A 操作（写入） | 100K | $4.50/百万 | $0.45 |
| Class B 操作（读取） | 50K | $0.36/百万 | $0.02 |
| **合计** | | | **~$0.62/月** |

> 注：以 1000 用户，平均每用户 10MB 数据，每日全量+96次增量为估算基础

### Supabase Edge Functions 费用

| 项目 | 数量 | 单价 | 月费用 |
|------|------|------|--------|
| 函数调用 | 3000/天 | 免费额度 200万/月 | $0 |
| 执行时间 | 平均 500ms | 免费额度 500K GB-seconds | $0 |
| **合计** | | | **$0** |

### 总费用

| 方案 | 月费用 | 说明 |
|------|--------|------|
| **当前（纯 Supabase）** | $0 | 无额外费用 |
| **E++ 方案** | ~$1-5 | 主要是对象存储 |
| **企业版（多区域）** | ~$10-20 | 跨区域冗余 |

---

## 六、实施时间表（修订版 v5.4）

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                   实施时间线（修订版 v5.4 - 七次深度审查后调整）                 │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│  Week 1-7           Week 8-9           Week 10-13         Week 14               │
│    │                  │                  │                  │                   │
│    ▼                  ▼                  ▼                  ▼                   │
│  ┌────────┐        ┌────────┐        ┌────────┐        ┌────────┐              │
│  │  P0    │        │  P1    │        │  P2    │        │  P3    │              │
│  │熔断+安全│  ──→   │ 导出   │  ──→   │ E层   │  ──→   │ C层   │              │
│  │ 修复   │        │ 导入   │        │ 备份   │        │ 可选   │              │
│  └────────┘        └────────┘        └────────┘        └────────┘              │
│  65-85h             22-30h            45-65h            8-16h                  │
│  (v5.4节省5h)                                                                   │
│                                                                                 │
│  🔴 Week 1 Day 1:   里程碑:            里程碑:            里程碑:                │
│  - sessionExpired   逃生舱就绪         主保险就绪         完整方案               │
│  - SECURITY DEFINER 附件ZIP打包        密钥管理           本地可见备份            │
│  - ✅ Tombstone安全  大文件流式下载     分批恢复                                  │
│  - 🆕 pagehide 兼容  路由离开保护       恢复原子性                                 │
│  - 🆕 is_tombstoned                                                             │
│  - 🆕 缓存键统一                                                                │
│  - 🆕 RetryQueue 安全                                                           │
│                                                                                 │
│  🔴 Week 1:                                                                     │
│  - 多用户数据隔离                                                                │
│  - 登出清理                                                                     │
│  - 附件原子操作                                                                 │
│  - Connection墓碑                                                               │
│  - 🆕 统一 beforeunload                                                         │
│  - 🆕 用户偏好隔离                                                               │
│  - ✅ RetryQueue排序已完成                                                       │
│                                                                                 │
│  ⚠️ 重要：P0 必须完成后才能开始 P2（否则坏数据也会被备份）                        │
│  🔴 紧急：Week 1 Day 1 必须修复 7 个 Critical 级安全漏洞（v5.4 移除 1 个误报）    │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### 详细任务拆分（修订版 v5.4 - 七次深度审查后调整）

#### Week 1-7: P0 熔断机制 + 安全修复（关键优先）- 65-85h

> 🔴 **v5.0 审计新增**：Week 1 Day 1 必须修复 3 个 Critical 级安全漏洞。Week 1 必须完成多用户隔离等 6 个 Critical 问题。
> 🔴 **v5.3 审计新增**：Week 1 Day 1 新增 2 个 Critical 级问题（离线缓存键、RetryQueue sessionExpired）。
> ✅ **v5.4 修正**：移除 2 个误报任务（Tombstone DELETE 策略不存在，RetryQueue 优先级排序已实现），工时从 70-95h 调整为 65-85h。

| 任务 | 工时 | 产出 | 状态 | 测试要求 | 优先级 |
|------|------|------|------|----------|--------|
| **✅ Tombstone DELETE 策略** | - | **无需修复：init-database.sql 中无 DELETE 策略** | ✅ | - | **v5.4 修正** |
| **🔴 SECURITY DEFINER 权限校验** | 3-4h | 附件 RPC 添加权限校验 | ❌ | SQL 测试 | **Week 1 Day 1** |
| **🔴 is_task_tombstoned 权限校验** | 0.5h | 添加项目归属校验，返回 false 而非 NULL | ❌ | SQL 测试 | **Week 1 Day 1** |
| **🔴 会话过期入口检查** | 2h | `pushTask/pushProject` 入口添加检查 | ❌ | ≥80% 覆盖 | **Week 1 Day 1** |
| **🆕 Safari/iOS pagehide 兼容** | 1h | 添加 pagehide + visibilitychange 监听 | ❌ | 手动验证 | **Week 1 Day 1** |
| **🆕🔴 离线缓存键版本统一** | 1h | 统一使用 SYNC_CONFIG.OFFLINE_CACHE_KEY | ❌ | ≥90% 覆盖 | **Week 1 Day 1** |
| **🆕🔴 RetryQueue sessionExpired 检查** | 2h | processRetryQueue 入口添加检查 | ❌ | ≥80% 覆盖 | **Week 1 Day 1** |
| **🔴 多用户数据隔离** | 4-5h | 缓存键用户级别 + 用户切换清理 | ❌ | ≥80% 覆盖 | **Week 1** |
| **🔴 登出时数据清理** | 2-3h | signOut 清理 IndexedDB/localStorage | ❌ | ≥80% 覆盖 | **Week 1** |
| **🔴 附件并发写入保护** | 2-3h | 改用 Postgres jsonb 原子操作 | ❌ | ≥80% 覆盖 | **Week 1** |
| **🔴 批量操作事务保护** | 4-6h | 分批 upsert 回滚机制 | ❌ | ≥80% 覆盖 | **Week 1** |
| **✅ RetryQueue 优先级排序** | - | **已实现：L1652-1658 按 project→task→connection 排序** | ✅ | 已通过 | **v5.4 修正** |
| **🆕 统一 beforeunload 处理器** | 2h | 合并两个监听器，避免冲突 | ❌ | 手动验证 | **Week 1** |
| **🆕 用户偏好键隔离** | 1h | 添加 userId 前缀 | ❌ | ≥80% 覆盖 | **Week 1** |
| **🆕 附件数量服务端限制** | 0.5h | RPC 添加 MAX_ATTACHMENTS 检查 | ❌ | SQL 测试 | **Week 1** |
| 清理死代码 | 1h | 删除 `SYNC_CONFIG.CIRCUIT_BREAKER_*` | ❌ | - | Week 2 |
| **🆕 loadProject schema 验证** | 1h | Zod schema 验证恢复的数据 | ❌ | ≥80% 覆盖 | Week 2 |
| **🆕 mergeConnections 唯一键修正** | 0.5h | 使用 id 而非 source→target | ❌ | ≥80% 覆盖 | Week 2 |
| **🆕 乐观快照配置统一** | 1h | 对齐 TTL 和 MAX_SNAPSHOTS | ❌ | - | Week 2 |
| **🆕 迁移快照 sessionStorage 降级** | 1h | 超过 5MB 时降级到文件下载 | ❌ | ≥80% 覆盖 | Week 2 |
| 新建 CircuitBreakerService | 6-8h | 核心服务框架 + 单元测试 | ❌ | ≥80% 覆盖 | Week 2-3 |
| 空数据拒写校验 | 2h | `validateBeforeSync()` | ❌ | ≥90% 覆盖 | Week 3 |
| **🆕 任务数骤降检测（优化）** | 3h | L1/L2/L3 分级 + 动态阈值算法 | ❌ | ≥90% 覆盖 | Week 3 |
| 必填字段校验 | 1h | Schema 校验函数 | ❌ | ≥80% 覆盖 | Week 3 |
| 服务端批量删除防护 | 3h | `safe_delete_tasks()` RPC + 集成测试 | ❌ | SQL 测试 | Week 3 |
| 服务端字段校验触发器 | 2h | `validate_task_data()` 触发器 | ❌ | SQL 测试 | Week 3 |
| **🚨 Connection Tombstone 表** | 5-6h | 迁移文件 + 触发器 + SimpleSyncService 集成 | ❌ | SQL 测试 | Week 4 |
| 熔断日志表 | 1h | `circuit_breaker_logs` 表 | ❌ | - | Week 4 |
| **🚨 迁移安全快照机制** | 3-4h | 迁移前创建快照 + discard 二次确认 | ❌ | ≥80% 覆盖 | Week 4 |
| 乐观锁强化 | 2h | 版本拒绝（非仅警告） | ⚠️ | ≥80% 覆盖 | Week 4 |
| **🆕 batch_upsert_tasks attachments** | 0.5h | 补全 attachments 字段 | ❌ | SQL 测试 | Week 4 |
| 多标签页并发检测 | 2h | `TabSyncService` 增强 | ⚠️ | ≥80% 覆盖 | Week 5 |
| 离线数据校验（增强） | 3h | `OfflineIntegrityService` + 静默损坏检测 | ❌ | ≥80% 覆盖 | Week 5 |
| Sentry 告警集成 | 2h | 熔断事件上报 + 告警规则 | ❌ | 手动验证 | Week 5 |
| **🆕 病毒扫描时机定义** | 1h | 定义扫描策略（上传时/异步/下载时） | ❌ | 文档 | Week 5 |
| 集成测试 | 4h | 端到端测试 | ❌ | - | Week 5-6 |

#### Week 8-9: P1 手动导出/导入 - 22-30h

> 🚨 **审查修订**：附件导出工时从 5-6h 增加到 8-10h，新增流式处理和内存限制处理。P1 总工时从 20-28h 增加到 22-30h。

| 任务 | 工时 | 产出 | 状态 | 测试要求 | 备注 |
|------|------|------|------|----------|------|
| ExportService 核心 | 4h | 基础导出功能 | ❌ | ≥80% 覆盖 | |
| **附件导出（流式 ZIP）** | 8-10h | ZIP 打包 + 流式下载 + 去重 + 内存限制 | ❌ | ≥80% 覆盖 | **审查修订** |
| 大文件下载进度 | 2h | 进度条 UI | ❌ | 手动验证 | |
| ImportService 核心 | 3h | 基础导入功能 | ❌ | ≥80% 覆盖 | |
| 附件导入（分批） | 3h | 重新上传附件 + 配额检查 + 分批上传 | ❌ | ≥80% 覆盖 | **审查修订** |
| 导出校验和 | 1h | SHA-256 校验 | ❌ | ≥90% 覆盖 | |
| 导入校验 | 2h | 版本兼容 + 结构校验 | ❌ | ≥90% 覆盖 | |
| Settings Modal 集成 | 2h | 数据管理 UI | ❌ | 手动验证 | |
| 导出提醒机制 | 1h | 定期提醒 | ❌ | ≥80% 覆盖 | |
| **路由离开保护** | 3h | CanDeactivate Guard + 项目切换检查 | ❌ | ≥80% 覆盖 | **审查新增** |
| **🆕 撤销历史截断提示** | 1h | 栈截断时用户通知 | ❌ | ≥80% 覆盖 | **v5.1 新增** |
| **🆕 JWT 刷新失败监听** | 1h | onAuthStateChange 订阅 | ❌ | ≥80% 覆盖 | **v5.1 新增** |
| 集成测试 | 3h | 端到端测试 | ❌ | - | |

#### Week 10-13: P2 服务端备份 - 45-65h

> 🚨 **审查修订**：新增密钥管理、分批恢复、恢复超时处理。

| 任务 | 工时 | 产出 | 状态 | 测试要求 | 备注 |
|------|------|------|------|----------|------|
| 对象存储配置 | 2h | R2/B2 bucket | ❌ | 手动验证 | |
| 全量备份 Edge Function | 8h | `backup-full` | ❌ | ≥80% 覆盖 | |
| 增量备份 Edge Function | 6h | `backup-incremental` | ❌ | ≥80% 覆盖 | |
| 备份加密实现 | 4h | AES-256-GCM | ❌ | ≥90% 覆盖 | |
| **密钥生命周期管理** | 3h | 密钥存储 + 轮换 + 多版本解密 | ❌ | 手动验证 | **审查新增** |
| 健康校验逻辑（增强） | 5h | `validateBackup()` + 绝对值+相对值结合 | ❌ | ≥90% 覆盖 | **审查修订** |
| 版本保留清理 | 3h | 过期备份清理 | ❌ | ≥80% 覆盖 | |
| 定时任务配置 | 2h | Supabase Cron | ❌ | 手动验证 | |
| 告警通道集成 | 3h | Slack/Email 告警 | ❌ | 手动验证 | |
| RecoveryService（分批） | 8h | 恢复服务 + 分批恢复 + 断点续传 | ❌ | ≥80% 覆盖 | **审查修订** |
| 恢复 UI | 6h | 历史版本列表 + 预览 | ❌ | 手动验证 | |
| 附件备份 | 4h | Storage bucket 备份 | ❌ | ≥80% 覆盖 | |
| **🆕 Realtime 重连增量同步** | 2h | 重连后触发增量拉取 | ❌ | ≥80% 覆盖 | **v5.1 新增** |
| 集成测试 | 6h | 端到端测试 | ❌ | - | |

#### Week 12: P3 桌面坚果云备份 - 8-16h

（保持原有规划）

---

## 七、风险评估（修订版 v5.3）

| 风险 | 概率 | 影响 | 当前状态 | 缓解措施 |
|------|------|------|----------|----------|
| **🆕🔴 离线缓存键版本不一致** | 高 | 严重 | ⚠️ **Critical** | **Week 1 Day 1 统一缓存键** |
| **🆕🔴 RetryQueue 无 sessionExpired 检查** | 高 | 严重 | ⚠️ **Critical** | **Week 1 Day 1 添加入口检查** |
| **🆕🔴 RetryQueue 无优先级排序** | 中 | 严重 | ⚠️ **Critical** | **Week 1 按类型排序** |
| **🚨 sessionExpired 入口检查缺失** | 高 | 严重 | ⚠️ **紧急** | **Week 1 Day 1 修复** |
| **🆕 Safari/iOS 不触发 beforeunload** | 高 | 严重 | ⚠️ **紧急** | **Week 1 Day 1 添加 pagehide** |
| **🆕 is_task_tombstoned 信息泄露** | 中 | 中 | ⚠️ **紧急** | **Week 1 Day 1 返回 false 而非 NULL** |
| **🔴 SECURITY DEFINER 越权访问** | 高 | 严重 | ⚠️ **Critical** | **Week 1 Day 1 修复** |
| **🔴 Tombstone DELETE 策略漏洞** | 中 | 严重 | ⚠️ **Critical** | **Week 1 Day 1 移除策略** |
| **🔴 多用户数据泄露（登出未清理）** | 高 | 严重 | ⚠️ **Critical** | **Week 1 修复** |
| **🔴 多用户数据混淆（缓存键全局）** | 高 | 严重 | ⚠️ **Critical** | **Week 1 修复** |
| **🔴 批量操作无事务（部分失败无回滚）** | 中 | 高 | ⚠️ **Critical** | **Week 1 修复** |
| **🔴 附件并发竞态条件** | 中 | 高 | ⚠️ **Critical** | **Week 1 改用原子操作** |
| **🔴 IndexedDB 写入无校验** | 低 | 高 | ⚠️ **Critical** | **Week 2 实现** |
| **🔴 Merge 策略丢失远程更新** | 中 | 高 | ⚠️ **Critical** | **Week 2 修复** |
| **🔴 迁移无原子性（失败后清除本地）** | 中 | 严重 | ⚠️ **Critical** | **Week 2 实现快照** |
| **🔴 无附件病毒扫描** | 中 | 高 | ⚠️ **Critical** | **Week 3 集成扫描** |
| **🆕🔴 pushProject sessionExpired 检查缺失** | 高 | 严重 | ⚠️ **紧急** | **Week 1 Day 1 与 pushTask 统一** |
| **🚨 Connection Tombstone 缺失** | 中 | 高 | ⚠️ 活跃风险 | **Week 4 实现** |
| **🚨 迁移过程无原子性保证** | 中 | 高 | ⚠️ 活跃风险 | **Week 4 实现快照机制** |
| **🆕⚠️ 两个 beforeunload 监听器冲突** | 中 | 中 | ⚠️ **High** | **Week 1 统一处理器** |
| **🆕⚠️ 用户偏好键无 userId 前缀** | 中 | 中 | ⚠️ **High** | **Week 1 添加前缀** |
| **🆕⚠️ 撤销历史页面刷新丢失** | 中 | 中 | ⚠️ **High** | **P1 持久化或截断提示** |
| **🆕⚠️ mergeConnections 唯一键错误** | 低 | 中 | ⚠️ **High** | **Week 2 使用 id** |
| **🆕⚠️ 乐观快照配置不一致** | 低 | 低 | ⚠️ **Medium** | **Week 2 对齐代码与策划** |
| **🆕⚠️ loadProject 无 schema 验证** | 低 | 中 | ⚠️ **High** | **Week 2 Zod 验证** |
| **🆕⚠️ JWT 刷新失败无监听** | 中 | 中 | ⚠️ **High** | **P1 onAuthStateChange** |
| **🆕⚠️ Realtime 重连无增量同步** | 中 | 中 | ⚠️ **High** | **P2 重连后拉取** |
| **🆕⚠️ batch_upsert_tasks 缺少 attachments** | 中 | 高 | ⚠️ **High** | **Week 4 补全字段** |
| **🆕⚠️ 迁移快照 sessionStorage 限制** | 中 | 中 | ⚠️ **High** | **Week 2 降级策略** |
| **🆕⚠️ 熔断分级阈值不合理** | 中 | 中 | ⚠️ **Medium** | **Week 3 动态阈值** |
| **🆕⚠️ 病毒扫描 TOCTOU 窗口** | 低 | 高 | ⚠️ **High** | **Week 5 定义扫描时机** |
| **熔断规则未实现导致空数据覆盖** | 高 | 严重 | ⚠️ 活跃风险 | **P0 优先实施** |
| **数据熔断层实际为 0%（非 30%）** | 高 | 严重 | ⚠️ 活跃风险 | 重新评估进度，按实际状态规划 |
| **E 层未实现导致无法灾难恢复** | 高 | 严重 | ⚠️ 活跃风险 | 完成 P0 后立即实施 P2 |
| **D 层未实现导致用户无法自救** | 高 | 高 | ⚠️ 活跃风险 | P1 优先于 P2 |
| 熔断规则过严，误拦正常操作 | 中 | 中 | - | 分级设计 + 管理员覆盖开关 |
| **附件导出内存溢出** | 中 | 高 | - | 流式 ZIP + 分批处理 |
| **恢复操作超时** | 中 | 高 | - | 分批恢复 + 断点续传 |
| **密钥轮换后旧备份无法解密** | 低 | 严重 | - | 多密钥版本管理 |
| 对象存储服务商故障 | 低 | 高 | - | 使用多区域配置 |
| Edge Function 超时 | 中 | 低 | - | 分片处理大数据 |
| 恢复操作覆盖用户新数据 | 中 | 高 | - | 恢复前自动创建快照 |
| 用户不理解多层备份 | 高 | 低 | - | 简化 UI，隐藏复杂性 |
| 多标签页并发编辑冲突 | 中 | 中 | ⚠️ 部分实现 | 增强 TabSyncService |
| 离线期间数据损坏 | 低 | 高 | ⚠️ 无保护 | 实现离线完整性校验 |
| **数据静默损坏（JSON 解析失败）** | 低 | 高 | ⚠️ 无保护 | 启动时校验和比对 |
| **Safari 7 天自动清理** | 低 | 高 | ⚠️ 无保护 | 检测 Safari + 提醒用户 |
| 附件与项目数据不同步 | 中 | 中 | ⚠️ 无保护 | 附件纳入备份范围 |
| C 层被误认为主备份 | 中 | 高 | - | UI 明确标注依赖关系 |
| **RLS 权限撤销导致数据丢失** | 中 | 严重 | ⚠️ 活跃风险 | 实现权限拒绝数据保全（4.6 节） |
| **会话过期导致未同步数据丢失** | 中 | 高 | ⚠️ 无保护 | 实现会话过期保护（3.7 节） |
| **IndexedDB 配额溢出** | 低 | 高 | ⚠️ 部分处理 | 实现存储配额保护（3.8 节） |
| **Signed URL 过期导致附件丢失** | 中 | 中 | ✅ 运行时刷新已实现 | 导出时下载文件内容（4.1 节） |
| **多设备并发编辑冲突** | 中 | 中 | ⚠️ 仅 LWW | 增强冲突检测 + Realtime 降级（4.7 节） |
| **Guest 数据过期丢失** | 中 | 中 | ⚠️ 提醒不足 | 增强过期提醒（4.9 节） |
| **IndexedDB 损坏无法恢复** | 低 | 高 | ⚠️ 无保护 | 实现损坏检测和恢复（4.10 节） |
| **时钟偏移导致 LWW 失效** | 低 | 中 | ⚠️ 无保护 | 服务端强制时间戳（4.11 节） |
| **配置死代码残留** | 低 | 低 | ⚠️ 存在 | 清理 `SYNC_CONFIG.CIRCUIT_BREAKER_*` |
| **乐观更新回滚不统一** | 中 | 中 | ⚠️ 部分实现 | 创建统一的回滚 wrapper |
| **E 层备份无告警通道** | 中 | 高 | - | 实施时定义 Slack/Email 告警 |
| **附件导出文件过大** | 中 | 中 | - | 采用 ZIP 打包 + 流式下载 |
| **迁移过程数据丢失** | 中 | 高 | ⚠️ 活跃风险 | 迁移前创建快照 + 二次确认（4.13 节） |
| **路由切换丢失未保存数据** | 中 | 中 | ⚠️ 无保护 | 实现路由离开保护（4.14 节） |
| **Realtime 不可用时无冲突检测** | 中 | 中 | ⚠️ 无降级 | 增强轮询作为降级方案（4.7 节） |
| **project_members RLS 被覆盖** | 中 | 高 | ⚠️ **High** | 恢复协作功能的 RLS 策略 |
| **cleanup_logs RLS 过度宽松** | 低 | 中 | ⚠️ **Medium** | 仅允许 service_role 访问 |
| **批量操作无速率限制（DoS）** | 低 | 中 | ⚠️ **Medium** | purge_tasks_v2 添加限制 |
| **字段锁可能导致永久不同步** | 中 | 中 | ⚠️ **High** | 字段锁添加超时机制 |
| **replyKeepBoth 副本无限增长** | 低 | 中 | ⚠️ **High** | 副本数量上限检测 |
| **连接批量删除 AND 条件误删** | 中 | 高 | ⚠️ **High** | 改用精确匹配删除 |
| **任务创建无输入校验** | 中 | 中 | ⚠️ **High** | 添加标题/内容校验 |
| **重试队列无优先级** | 中 | 中 | ⚠️ **High** | 关键操作优先级更高 |
| **Token 刷新失败无降级** | 中 | 中 | ⚠️ **Medium** | 监听 onAuthStateChange |
| **附件删除与任务不联动** | 中 | 中 | ⚠️ **High** | 任务删除时标记附件 |

### 风险等级说明

- **🔴 Critical**：安全漏洞，必须立即修复
- **⚠️ 活跃风险**：当前存在且无缓解措施，需立即处理
- **⚠️ High**：高优先级功能缺陷
- **⚠️ Medium**：中优先级问题
- **高概率/高影响**：需优先处理
- **中/低**：可在高优先级任务完成后处理

---

## 八、成功指标（修订版 v5.3）

| 指标 | 目标 | 当前状态 | 测量方式 |
|------|------|----------|----------|
| **Critical 漏洞数** | 0 | **19**（v5.3 审计发现，+4） | 代码审查 |
| **High 漏洞数** | 0 | **14**（v5.3 审计发现，+6） | 代码审查 |
| **熔断实现率** | 100% | ~18%（网络层 only） | 代码审查 |
| **数据熔断实现率** | 100% | 0%（未实现） | 代码审查 |
| **空数据拦截率** | 100% | 0%（未实现） | 熔断日志统计 |
| **RPO（恢复点目标）** | ≤ 15 分钟 | ∞（无备份） | 增量备份间隔 |
| **RTO（恢复时间目标）** | ≤ 5 分钟 | ∞（无备份） | 从触发恢复到完成 |
| **备份成功率** | ≥ 99.9% | N/A | 监控告警 |
| **用户手动导出率** | ≥ 30% | 0%（未实现） | 埋点统计 |
| **导出提醒触达率** | ≥ 80% | N/A | 埋点统计 |
| **测试覆盖率** | ≥ 80% | N/A | Jest/Vitest 报告 |

### 阶段性目标

| 阶段 | 目标 | 验收标准 |
|------|------|----------|
| **Week 1 Day 1** | Critical 安全修复 | **8 个**紧急漏洞修复（含缓存键统一、RetryQueue 安全、Safari pagehide） |
| **Week 1** | 安全基线就绪 | **19 个** Critical 漏洞全部修复 |
| P0 完成 | 熔断保护就绪 | 空数据同步被 100% 拦截 |
| P1 完成 | 逃生舱可用 | 用户可手动导出/导入数据 |
| P2 完成 | 主保险就绪 | RPO ≤ 15 分钟，RTO ≤ 5 分钟 |
| P3 完成 | 完整方案 | 桌面用户可启用本地备份 |

---

## 九、附录

### A. 相关文件

**已实现**：
- `src/services/change-tracker.service.ts` - 变更追踪（含引用完整性校验，待增强熔断）
- `src/app/core/services/simple-sync.service.ts` - 同步服务（含网络层 Circuit Breaker）
- `src/services/tab-sync.service.ts` - 多标签页同步（仅通知，待增强并发保护）
- `src/services/conflict-resolution.service.ts` - 冲突解决（LWW 策略）
- `supabase/migrations/20251212_prevent_task_resurrection.sql` - Tombstone 防复活
- `supabase/functions/cleanup-attachments/` - 附件清理 Edge Function

**待修复（v5.1 审计发现的安全漏洞）**：
- `scripts/attachment-rpc.sql` - **🔴 SECURITY DEFINER 需添加权限校验**
- `supabase/migrations/20251212_security_hardening.sql` - **🔴 需移除 tombstone DELETE 策略**
- `src/services/user-session.service.ts` - **🔴 signOut 需清理本地数据**
- `src/services/task-repository.service.ts` - **🔴 批量操作需事务保护**
- `src/services/attachment.service.ts` - **🔴 需改用原子操作**
- `src/app/core/state/store-persistence.service.ts` - **🔴 写入后需完整性校验**
- `src/services/conflict-resolution.service.ts` - **🔴 merge 策略需保护远程更新**
- `src/services/migration.service.ts` - **🔴 需实现原子性迁移**
- `supabase/migrations/20251213_is_task_tombstoned.sql` - **🆕🔴 is_task_tombstoned 需返回 false 而非 NULL**
- `src/app/core/services/simple-sync.service.ts` - **🆕🔴 pushProject 需添加 sessionExpired 检查**
- `src/app/core/services/simple-sync.service.ts#L2663` - **🆕🔴 缓存键硬编码需改用 SYNC_CONFIG.OFFLINE_CACHE_KEY**
- `src/app/core/services/simple-sync.service.ts#L1714` - **🆕🔴 processRetryQueue 需添加 sessionExpired 前置检查**
- `src/app/core/services/simple-sync.service.ts#L1720` - **🆕🔴 RetryQueue 需按类型排序（task 优先于 connection）**
- `src/app.component.ts` - **🆕🔴 需添加 pagehide + visibilitychange 监听（Safari/iOS）**
- `src/app.component.ts` + `persistence-failure-handler.service.ts` - **🆕⚠️ 两个 beforeunload 监听器需统一**
- `src/services/undo.service.ts` - **🆕⚠️ 撤销历史需持久化或截断提示**
- `src/services/preference.service.ts` - **🆕⚠️ 存储键需添加 userId 前缀**
- `src/services/auth.service.ts` - **🆕⚠️ JWT 刷新失败需监听上报**
- `src/services/conflict-resolution.service.ts` - **🆕⚠️ mergeConnections 唯一键需修正为 id**
- `src/services/optimistic-state.service.ts` - **🆕⚠️ MAX_SNAPSHOTS/SNAPSHOT_TTL 需与策划对齐**
- `scripts/attachment-rpc.sql` - **🆕⚠️ batch_upsert_tasks 需补全 attachments 字段**
- `src/config/sync.config.ts#L155` - **🆕⚠️ OFFLINE_CACHE_KEY 值需与实际使用一致**

**待创建**：
- `src/config/circuit-breaker.config.ts` - 熔断配置常量（`CLIENT_CIRCUIT_BREAKER_CONFIG`）
- `src/config/storage.config.ts` - 存储配额配置常量
- `src/config/backup.config.ts` - 备份相关配置常量
- `src/services/circuit-breaker.service.ts` - 客户端熔断服务（核心）
- `src/services/circuit-breaker.service.spec.ts` - 熔断服务测试
- `src/services/export.service.ts` - 导出服务
- `src/services/export.service.spec.ts` - 导出服务测试
- `src/services/import.service.ts` - 导入服务
- `src/services/import.service.spec.ts` - 导入服务测试
- `src/services/local-backup.service.ts` - 本地备份服务
- `src/services/offline-integrity.service.ts` - 离线完整性校验
- `src/services/offline-integrity.service.spec.ts` - 离线完整性测试
- `src/services/permission-denied-handler.service.ts` - 权限拒绝处理服务
- `src/services/storage-quota.service.ts` - 存储配额监控服务
- `src/services/storage-quota.service.spec.ts` - 存储配额测试
- `supabase/migrations/YYYYMMDD_circuit_breaker_rules.sql` - 熔断规则迁移
- `supabase/migrations/YYYYMMDD_connection_tombstones.sql` - 连接 Tombstone 表
- `supabase/migrations/YYYYMMDD_validate_task_data.sql` - 任务数据校验触发器
- `supabase/functions/backup-full/` - 全量备份 Edge Function
- `supabase/functions/backup-incremental/` - 增量备份 Edge Function

**待清理**：
- `src/config/sync.config.ts` 中的 `CIRCUIT_BREAKER_THRESHOLD`、`CIRCUIT_BREAKER_TIMEOUT`、`CIRCUIT_BREAKER_HALF_OPEN_RETRIES`（死代码）

### B. 参考资料

- [Supabase Edge Functions 文档](https://supabase.com/docs/guides/functions)
- [Cloudflare R2 定价](https://developers.cloudflare.com/r2/pricing/)
- [File System Access API](https://developer.mozilla.org/en-US/docs/Web/API/File_System_Access_API)
- [Circuit Breaker Pattern](https://martinfowler.com/bliki/CircuitBreaker.html)

### C. 术语表

| 术语 | 解释 |
|------|------|
| **RPO** | Recovery Point Objective，可接受的数据丢失时间窗口 |
| **RTO** | Recovery Time Objective，从故障到恢复的目标时间 |
| **熔断** | Circuit Breaker，检测到异常时阻止操作继续执行 |
| **软删除** | 标记删除而非物理删除，保留恢复可能 |
| **Tombstone** | 软删除记录，用于同步删除状态，防止已删除数据复活 |
| **LWW** | Last-Write-Wins，最后写入优先的冲突解决策略 |
| **乐观锁** | 基于版本号的并发控制，写入时校验版本 |

### D. 配置常量汇总

> **🆕 v5.1 审查发现**：以下配置值在代码与策划中存在不一致，需统一：
> - `MAX_SNAPSHOTS`：代码中为 20，策划建议 50 → 建议统一为 20（节省内存）
> - `SNAPSHOT_TTL`：代码中为 5 分钟，策划建议 30 分钟 → 建议统一为 5 分钟（避免过期快照堆积）

```typescript
// 熔断配置
CLIENT_CIRCUIT_BREAKER_CONFIG.TASK_COUNT_DROP_THRESHOLD = 0.5; // 50%
CLIENT_CIRCUIT_BREAKER_CONFIG.MIN_TASK_COUNT_THRESHOLD = 10;

// 备份配置
BACKUP_VALIDATION_CONFIG.TASK_COUNT_CHANGE_THRESHOLD = 0.3; // 30%
BACKUP_ENCRYPTION_CONFIG.ALGORITHM = 'AES-256-GCM';
BACKUP_INTEGRITY_CONFIG.CHECKSUM_ALGORITHM = 'SHA-256';
RETENTION_POLICY.last24Hours = 'all';
RETENTION_POLICY.last7Days = 'sampled';
RETENTION_POLICY.last30Days = 'daily';

// 导出配置
EXPORT_REMINDER_CONFIG.INTERVAL = 7 * 24 * 60 * 60 * 1000; // 7 天
ATTACHMENT_BACKUP_CONFIG.SIGNED_URL_HANDLING.DOWNLOAD_BEFORE_EXPORT = true;

// 离线配置
OFFLINE_INTEGRITY_CONFIG.CHECK_INTERVAL = 5 * 60 * 1000; // 5 分钟

// 会话保护配置
SESSION_PROTECTION_CONFIG.ON_SESSION_EXPIRED = 'preserve-local';
SESSION_PROTECTION_CONFIG.EXPIRY_WARNING_BEFORE = 5 * 60 * 1000; // 5 分钟

// 存储配额配置
STORAGE_QUOTA_CONFIG.WARNING_THRESHOLD = 0.8; // 80%
STORAGE_QUOTA_CONFIG.CRITICAL_THRESHOLD = 0.95; // 95%

// 权限拒绝配置
PERMISSION_DENIED_CONFIG.ON_PERMISSION_DENIED = 'isolate-and-notify';
PERMISSION_DENIED_CONFIG.REJECTED_DATA_RETENTION = 7 * 24 * 60 * 60 * 1000; // 7 天

// 🆕 乐观更新配置（需与代码对齐）
OPTIMISTIC_STATE_CONFIG.MAX_SNAPSHOTS = 20;                    // 代码实际值
OPTIMISTIC_STATE_CONFIG.SNAPSHOT_TTL = 5 * 60 * 1000;          // 5 分钟（代码实际值）

// Guest 用户配置（与 migration.service.ts 保持一致）
GUEST_DATA_PROTECTION_CONFIG.EXPIRY_DAYS = 30;
GUEST_DATA_PROTECTION_CONFIG.WARNING_BEFORE_EXPIRY_DAYS = 7;

// 时钟同步配置
CLOCK_SYNC_CONFIG.USE_SERVER_TIME = true;
CLOCK_SYNC_CONFIG.CLOCK_DRIFT_WARNING_THRESHOLD = 60 * 1000; // 1 分钟

// IndexedDB 健康配置
INDEXEDDB_HEALTH_CONFIG.CHECK_ON_INIT = true;
INDEXEDDB_HEALTH_CONFIG.ON_CORRUPTION = 'prompt-recovery';

// 数据迁移安全配置（4.13 节）
MIGRATION_SAFETY_CONFIG.CREATE_SNAPSHOT_BEFORE_MIGRATION = true;
MIGRATION_SAFETY_CONFIG.REQUIRE_CONFIRMATION_FOR_DISCARD = true;
MIGRATION_SAFETY_CONFIG.PRESERVE_LOCAL_ON_FAILURE = true;

// 路由离开保护配置（4.14 节）
ROUTE_LEAVE_PROTECTION_CONFIG.CHECK_UNSAVED_CHANGES = true;
ROUTE_LEAVE_PROTECTION_CONFIG.PROMPT_BEFORE_LEAVE = true;
ROUTE_LEAVE_PROTECTION_CONFIG.AUTO_SAVE_BEFORE_LEAVE = false;

// Realtime 降级配置（4.7 节）
MULTI_DEVICE_CONFLICT_CONFIG.FALLBACK_ON_REALTIME_UNAVAILABLE = 'polling-enhanced';
MULTI_DEVICE_CONFLICT_CONFIG.ENHANCED_POLLING.INTERVAL = 10 * 1000; // 10 秒
```

### E. 待清理死代码

以下代码在实现 P0 时需要清理：

```typescript
// src/config/sync.config.ts - 需删除（与 CIRCUIT_BREAKER_CONFIG 重复）
SYNC_CONFIG.CIRCUIT_BREAKER_THRESHOLD = 5;      // ❌ 死代码
SYNC_CONFIG.CIRCUIT_BREAKER_TIMEOUT = 2 * 60 * 1000;  // ❌ 死代码
SYNC_CONFIG.CIRCUIT_BREAKER_HALF_OPEN_RETRIES = 3;    // ❌ 死代码

// 实际生效的配置（保留）
CIRCUIT_BREAKER_CONFIG.FAILURE_THRESHOLD = 3;   // ✅ 生效
CIRCUIT_BREAKER_CONFIG.RECOVERY_TIME = 30000;   // ✅ 生效
```

### F. 测试覆盖要求

| 服务 | 最低覆盖率 | 关键测试场景 |
|------|-----------|-------------|
| `CircuitBreakerService` | ≥80% | 空数据检测、L1/L2/L3 分级骤降检测、熔断触发/恢复 |
| `ExportService` | ≥80% | 正常导出、大文件流式处理、附件 ZIP 打包、校验和计算、内存限制 |
| `ImportService` | ≥80% | 版本兼容、冲突处理、数据校验、回滚、分批附件上传 |
| `OfflineIntegrityService` | ≥80% | 引用完整性、循环检测、自动修复、静默损坏检测 |
| `StorageQuotaService` | ≥80% | 配额检测、自动清理、紧急导出 |
| `SessionExpiryHandler` | ≥80% | 会话过期检测、入口检查阻止同步、数据隔离、重新认证 |
| `MigrationService` | ≥80% | 快照创建、迁移失败回滚、二次确认、原子性保证 |
| `UnsavedChangesGuard` | ≥80% | 路由离开检测、项目切换检测、自动保存、用户确认 |
| 服务端 RPC/触发器 | SQL 测试 | 批量删除防护、字段校验、task/connection tombstone 防复活 |

### G. E2E 测试场景

以下端到端测试场景必须在相应功能实现后添加：

| 场景 | 优先级 | 测试步骤 | 验收标准 |
|------|--------|----------|----------|
| **� 多用户切换数据隔离** | P0 | 1. 用户A登录创建数据<br>2. 登出<br>3. 用户B登录<br>4. 验证看不到用户A数据 | 用户数据完全隔离 |
| **🔴 附件越权访问阻止** | P0 | 1. 用户A创建任务+附件<br>2. 用户B尝试操作附件<br>3. 验证被拒绝 | 操作被拒绝，返回权限错误 |
| **🔴 Tombstone 不可删除** | P0 | 1. 删除任务<br>2. 尝试删除 tombstone 记录<br>3. 验证被拒绝 | DELETE 操作被阻止 |
| **🚨 会话过期同步阻止** | P0 | 1. 登录<br>2. 编辑任务<br>3. 模拟 JWT 过期<br>4. 尝试同步<br>5. 验证同步被阻止 | 同步被阻止，提示重新登录，数据保留 |
| **🚨 批量操作部分失败回滚** | P0 | 1. 准备批量任务<br>2. 模拟中间批次失败<br>3. 验证全部回滚 | 数据一致，无部分写入 |
| **🚨 附件并发添加** | P0 | 1. 两设备同时添加附件<br>2. 验证两个附件都存在 | 无附件丢失 |
| **离线编辑→联网同步** | P0 | 1. 断网<br>2. 编辑任务<br>3. 联网<br>4. 验证数据 | 数据完整同步，无丢失 |
| **多标签页并发编辑** | P0 | 1. 两个标签页打开同一任务<br>2. 同时编辑<br>3. 验证冲突处理 | 提示冲突，LWW 正确应用 |
| **熔断触发（L3 硬熔断）** | P0 | 1. 模拟空数据覆盖<br>2. 验证熔断触发<br>3. 验证数据未丢失 | 同步被阻止，Sentry 告警，强制导出提示 |
| **Guest 数据迁移** | P1 | 1. Guest 创建项目/任务<br>2. 登录<br>3. 选择迁移策略<br>4. 验证迁移结果 | 数据完整迁移，无丢失 |
| **迁移失败回滚** | P1 | 1. Guest 创建数据<br>2. 登录<br>3. 模拟网络错误<br>4. 验证本地数据保留 | 本地数据未丢失，快照可恢复 |
| **迁移 discard 二次确认** | P1 | 1. Guest 创建数据<br>2. 登录<br>3. 选择放弃本地<br>4. 验证确认对话框 | 显示二次确认，用户可取消 |
| **路由切换保护** | P1 | 1. 编辑任务（不等待同步）<br>2. 切换项目<br>3. 验证提示出现 | 显示确认对话框，可选保存/放弃/取消 |
| **导出/导入完整流程** | P1 | 1. 创建项目/任务/附件<br>2. 导出<br>3. 清空数据<br>4. 导入<br>5. 验证数据 | 数据完整恢复 |
| **大文件附件导出（流式）** | P2 | 1. 创建 >100MB 附件<br>2. 导出<br>3. 验证内存不溢出<br>4. 验证 ZIP 生成 | 内存使用稳定，ZIP 包正确生成 |
| **Connection Tombstone 防复活** | P0 | 1. 删除连接<br>2. 清理 purge<br>3. 旧客户端尝试 upsert<br>4. 验证被拒绝 | 连接不复活 |
| **Safari 7 天警告** | P2 | 1. Safari 浏览器打开<br>2. 验证警告显示 | 显示 Safari 特殊警告 |
| **1000+ 任务性能** | P2 | 1. 创建 1000 任务<br>2. 导出<br>3. 测量时间 | 导出 <30 秒，内存稳定 |
| **IndexedDB 写入完整性** | P1 | 1. 保存大量任务<br>2. 模拟崩溃<br>3. 重启验证数据 | 数据完整或可检测到不完整 |
| **🆕🔴 Safari/iOS 页面关闭保护** | P0 | 1. Safari 浏览器编辑任务<br>2. 直接关闭标签页<br>3. 重新打开验证数据 | 数据保存成功，无丢失 |
| **🆕🔴 is_task_tombstoned 权限校验** | P0 | 1. 用户A删除任务<br>2. 用户B调用 is_task_tombstoned<br>3. 验证返回 null/拒绝 | 非所有者无法获取删除状态信息 |
| **🆕⚠️ 撤销历史页面刷新** | P1 | 1. 创建多个任务<br>2. 撤销操作<br>3. 刷新页面<br>4. 验证撤销历史截断提示 | 用户收到历史丢失提示，可选持久化 |
| **🆕⚠️ 用户偏好隔离** | P1 | 1. 用户A设置偏好<br>2. 登出<br>3. 用户B登录<br>4. 验证偏好独立 | 不同用户偏好完全隔离 |
| **🆕⚠️ Realtime 重连增量同步** | P2 | 1. 设备A在线编辑<br>2. 设备B断网后重连<br>3. 验证增量拉取触发 | 重连后自动拉取期间变更，无数据遗漏 |
| **🆕⚠️ JWT 刷新失败处理** | P2 | 1. 登录<br>2. 模拟后台 JWT 刷新失败<br>3. 验证告警上报 + 用户通知 | Sentry 收到告警，用户收到重新登录提示 |
| **🆕🔴 离线缓存键一致性** | P0 | 1. 断网离线编辑<br>2. 联网同步<br>3. 验证缓存读写使用相同键 | 缓存正确写入和读取，无数据丢失 |
| **🆕🔴 RetryQueue 会话过期检查** | P0 | 1. 离线编辑任务入队<br>2. 模拟会话过期<br>3. 联网触发重试<br>4. 验证不无限重试 | 检测 403/401 后停止重试，提示重新登录 |
| **🆕🔴 RetryQueue 顺序保护** | P0 | 1. 离线创建任务<br>2. 离线创建该任务的连接<br>3. 联网同步<br>4. 验证无 FK 错误 | 任务先于连接同步，无外键违规 |
| **🆕⚠️ 迁移快照大数据降级** | P1 | 1. 创建超过 5MB 的项目数据<br>2. 触发迁移<br>3. 验证快照降级策略 | 自动降级到 IndexedDB 备份，提示用户 |

### H. 未覆盖的重大风险（v5.2 补充）

> 以下风险在 v5.1 及之前版本中未被完整覆盖，需在实施时特别关注。

#### H.1 Realtime 断连期间的变更丢失

**场景**：
```
用户 A 在 Realtime 断开期间删除任务 
  → Realtime 重连 
  → 用户 B 的修改通过 Realtime 到达 
  → 用户 A 重连后的增量拉取基于旧的 last_sync_time
```

**风险**：断连期间的远程变更可能被遗漏。

**解决方案**：

```typescript
/**
 * Realtime 重连处理
 * 位置：src/app/core/services/simple-sync.service.ts
 * 
 * 🔴 v5.2 修正：Supabase Realtime 没有 'system' 事件类型
 *    正确方式是监听 subscribe 回调的 status 参数变化
 */
private previousRealtimeStatus: string = 'CLOSED';

private subscribeToProjectRealtime(projectId: string, userId: string): void {
  // ... 现有订阅代码 ...
  
  this.realtimeChannel = client
    .channel(channelName)
    .on('postgres_changes', { ... }, (payload) => { ... })
    .subscribe((status: string) => {
      this.logger.info('Realtime 订阅状态', { status, previousStatus: this.previousRealtimeStatus });
      
      // 🔴 关键：检测从非 SUBSCRIBED 变为 SUBSCRIBED（即重连成功）
      if (status === 'SUBSCRIBED' && this.previousRealtimeStatus !== 'SUBSCRIBED') {
        this.logger.info('Realtime 重连成功，触发增量同步');
        
        // 重连时强制拉取断连期间的变更
        const lastSyncTime = this.lastSyncTimeByProject.get(this.currentProjectId);
        if (lastSyncTime && this.currentProjectId) {
          this.pullIncrementalChanges(this.currentProjectId, lastSyncTime)
            .catch(e => this.logger.error('重连后增量同步失败', e));
        }
      }
      
      this.previousRealtimeStatus = status;
    });
}
```

#### H.2 批量操作的"全有或全无"语义

**问题**：批量操作的边界定义不清晰。

**决策**：

| 边界 | 定义 | 处理策略 |
|------|------|----------|
| 批量阈值 | ≥20 个任务视为批量 | 使用服务端 RPC 包装事务 |
| 分批大小 | 每批 20 个任务 | 客户端分批，服务端事务 |
| 回滚范围 | 整个批量操作 | 任一批次失败，全部回滚 |

**实现方案**：

```sql
-- 使用服务端 RPC 保证原子性
-- 🔴 v5.2 修正：添加 auth.uid() 权限校验，防止越权操作
CREATE OR REPLACE FUNCTION public.batch_upsert_tasks(
  p_tasks jsonb[],
  p_project_id uuid
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_count integer := 0;
  v_task jsonb;
  v_user_id uuid;
BEGIN
  -- 🔴 权限校验：获取当前用户 ID
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized: not authenticated';
  END IF;
  
  -- 🔴 权限校验：验证用户是项目所有者
  IF NOT EXISTS (
    SELECT 1 FROM public.projects 
    WHERE id = p_project_id AND owner_id = v_user_id
  ) THEN
    RAISE EXCEPTION 'Unauthorized: not project owner (project_id: %, user_id: %)', p_project_id, v_user_id;
  END IF;
  
  -- 事务内执行，任何失败自动回滚
  FOREACH v_task IN ARRAY p_tasks
  LOOP
    -- 🔴 v5.2.2 修正：补全所有必要字段
    INSERT INTO public.tasks (
      id, project_id, title, content, stage, parent_id, 
      "order", rank, status, x, y, short_id, deleted_at, owner_id
    )
    VALUES (
      (v_task->>'id')::uuid,
      p_project_id,
      v_task->>'title',
      v_task->>'content',
      (v_task->>'stage')::integer,
      (v_task->>'parentId')::uuid,
      COALESCE((v_task->>'order')::integer, 0),
      COALESCE((v_task->>'rank')::integer, 10000),
      COALESCE(v_task->>'status', 'active'),
      COALESCE((v_task->>'x')::integer, 0),
      COALESCE((v_task->>'y')::integer, 0),
      v_task->>'shortId',
      (v_task->>'deletedAt')::timestamptz,
      v_user_id  -- 🔴 设置 owner_id
    )
    ON CONFLICT (id) DO UPDATE SET
      title = EXCLUDED.title,
      content = EXCLUDED.content,
      stage = EXCLUDED.stage,
      parent_id = EXCLUDED.parent_id,
      "order" = EXCLUDED."order",
      rank = EXCLUDED.rank,
      status = EXCLUDED.status,
      x = EXCLUDED.x,
      y = EXCLUDED.y,
      short_id = EXCLUDED.short_id,
      deleted_at = EXCLUDED.deleted_at,
      updated_at = NOW()
    WHERE public.tasks.owner_id = v_user_id;  -- 🔴 只能更新自己的任务
    
    v_count := v_count + 1;
  END LOOP;
  
  RETURN v_count;
EXCEPTION WHEN OTHERS THEN
  -- 任何错误导致整个事务回滚
  RAISE;
END;
$$;
```

#### H.3 Guest 用户登录时的边界场景

**未定义场景**：

| 场景 | 当前处理 | 建议处理 |
|------|----------|----------|
| Guest 项目 ID 与云端重复 | 未处理 | 重新生成 UUID 后迁移 |
| Guest 任务 ID 在云端是 tombstone | 未处理 | 检测后重新生成 ID |
| 迁移中断后重试 | 本地数据可能已清理 | 迁移前创建 sessionStorage 快照 |

**解决方案**：

```typescript
/**
 * Guest 数据迁移安全检查
 * 位置：src/services/migration.service.ts
 */
async migrateGuestData(strategy: MigrationStrategy): Promise<MigrationResult> {
  const guestData = this.getGuestData();
  if (!guestData) return { success: true, migrated: 0 };
  
  // 🔴 v5.2 新增：ID 冲突检测
  const { conflictingProjects, tombstonedTasks } = await this.detectConflicts(guestData);
  
  if (conflictingProjects.length > 0) {
    // 重新生成冲突项目的 ID
    for (const project of conflictingProjects) {
      const oldId = project.id;
      project.id = crypto.randomUUID();
      // 更新所有引用
      for (const task of project.tasks) {
        task.projectId = project.id;
      }
      this.logger.info('项目 ID 冲突，已重新生成', { oldId, newId: project.id });
    }
  }
  
  if (tombstonedTasks.length > 0) {
    // 移除已被 tombstone 的任务（这些任务在云端已删除）
    for (const project of guestData.projects) {
      project.tasks = project.tasks.filter(t => !tombstonedTasks.includes(t.id));
    }
    this.logger.warn('移除与云端 tombstone 冲突的任务', { count: tombstonedTasks.length });
  }
  
  // 继续迁移...
}
```

#### H.4 附件生命周期管理

**当前问题**：附件与任务的删除未联动，可能产生孤儿文件。

**完整生命周期定义**：

```
任务创建 → 添加附件 → 任务软删除 → 任务硬删除（30天后）→ 附件清理
    ↓           ↓            ↓              ↓               ↓
  无附件    Storage 上传   附件保留     附件标记删除    Storage 删除
```

**实现方案**：

```typescript
/**
 * 附件生命周期配置
 * 位置：src/config/attachment.config.ts
 */
export const ATTACHMENT_LIFECYCLE_CONFIG = {
  // 任务软删除时的附件处理
  ON_TASK_SOFT_DELETE: 'preserve', // 'preserve' | 'soft-delete'
  
  // 任务硬删除时的附件处理
  ON_TASK_HARD_DELETE: 'mark-for-cleanup', // 'immediate-delete' | 'mark-for-cleanup'
  
  // 孤儿附件清理间隔（毫秒）
  ORPHAN_CLEANUP_INTERVAL: 24 * 60 * 60 * 1000, // 每天
  
  // 孤儿附件保留时间（毫秒）- 被标记删除后保留多久
  ORPHAN_RETENTION: 7 * 24 * 60 * 60 * 1000, // 7 天
} as const;
```

```sql
-- 🔴 v5.2 修正：先定义 attachment_cleanup_queue 表
CREATE TABLE IF NOT EXISTS public.attachment_cleanup_queue (
  task_id uuid PRIMARY KEY,
  attachments jsonb,
  marked_at timestamptz NOT NULL DEFAULT NOW(),
  processed_at timestamptz,  -- 清理完成时间
  error_message text         -- 清理失败原因
);

COMMENT ON TABLE public.attachment_cleanup_queue IS '附件清理队列，由 cleanup-attachments Edge Function 定期处理';

-- RLS 策略：只有服务端可操作
ALTER TABLE public.attachment_cleanup_queue ENABLE ROW LEVEL SECURITY;

-- 不允许客户端直接访问
CREATE POLICY "No client access" ON public.attachment_cleanup_queue
  FOR ALL USING (false);

-- 索引：用于定期清理任务
CREATE INDEX IF NOT EXISTS idx_cleanup_queue_marked_at 
  ON public.attachment_cleanup_queue (marked_at) 
  WHERE processed_at IS NULL;

-- 附件-任务级联处理触发器
CREATE OR REPLACE FUNCTION public.handle_task_delete_attachments()
RETURNS trigger AS $$
BEGIN
  -- 任务硬删除时，标记附件为待清理
  IF TG_OP = 'DELETE' AND OLD.attachments IS NOT NULL AND jsonb_array_length(OLD.attachments) > 0 THEN
    -- 记录到清理队列（由 cleanup-attachments Edge Function 处理）
    INSERT INTO public.attachment_cleanup_queue (task_id, attachments, marked_at)
    VALUES (OLD.id, OLD.attachments, NOW())
    ON CONFLICT (task_id) DO UPDATE SET
      attachments = EXCLUDED.attachments,
      marked_at = NOW(),
      processed_at = NULL;  -- 重置处理状态
  END IF;
  
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_handle_task_delete_attachments ON public.tasks;
CREATE TRIGGER trg_handle_task_delete_attachments
  BEFORE DELETE ON public.tasks
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_task_delete_attachments();
```

### I. 回滚计划（v5.2 新增）

> 每个 P0/P1 功能上线后，如果出现严重问题，需要能够快速回滚。

#### I.1 回滚策略

| 功能 | 回滚方式 | 回滚时间 | 回滚影响 |
|------|----------|----------|----------|
| 客户端熔断规则 | 功能开关关闭 | <1 分钟 | 熔断保护失效，依赖服务端防护 |
| 服务端批量删除防护 | RPC 函数版本回退 | <5 分钟 | 批量删除不受限制 |
| Connection Tombstone | 删除触发器 | <5 分钟 | 连接可能被复活 |
| 登出数据清理 | 代码回退 | 需重新部署 | 多用户数据可能泄露 |
| E 层备份 | 停止定时任务 | <1 分钟 | 备份停止，不影响现有备份 |
| Safari 特殊处理 | 功能开关关闭 | <1 分钟 | Safari 用户恢复正常同步频率 |
| 迁移快照机制 | 功能开关关闭 | <1 分钟 | 迁移失败后无法从快照恢复 |

#### I.1.1 🔴 客户端代码回滚流程（v5.2 补充）

> 对于需要"代码回退 + 重新部署"的功能，需要明确回滚流程：

**回滚步骤**：

1. **服务端**：切换到回滚分支 / 恢复旧版本 Tag
2. **部署**：Vercel 自动构建（~2 分钟）
3. **PWA 缓存处理**：
   - Service Worker 会在下次访问时检测更新
   - 用户需刷新页面或等待后台更新
4. **紧急强制刷新**（如需）：
   ```typescript
   // 在 main.ts 添加版本检查
   const FORCE_REFRESH_VERSION = 'v5.2.1-hotfix';
   const cachedVersion = localStorage.getItem('nanoflow.app-version');
   if (cachedVersion !== FORCE_REFRESH_VERSION) {
     // 清除 SW 缓存并强制刷新
     if ('serviceWorker' in navigator) {
       const registrations = await navigator.serviceWorker.getRegistrations();
       for (const reg of registrations) {
         await reg.unregister();
       }
     }
     localStorage.setItem('nanoflow.app-version', FORCE_REFRESH_VERSION);
     location.reload();
   }
   ```

**正在使用的用户处理**：
- 用户本地数据保留在 IndexedDB，不受影响
- 只影响新上线的功能逻辑
- 如有数据格式变更，需在回滚版本中添加兼容层

#### I.2 功能开关配置

> 🔴 v5.2 补充：明确配置文件位置和动态更新机制

**配置文件位置**：`src/config/feature-flags.config.ts`（需新建）

**动态更新机制**：
- **当前版本**：静态配置，需重新部署
- **未来考虑**：可通过 Supabase Edge Config 实现运行时动态开关

**与环境变量的关系**：
- `FEATURE_FLAGS` 用于功能开关（开/关）
- `environment.ts` 用于环境配置（开发/生产）
- 不混用，职责分离

```typescript
/**
 * 功能开关配置
 * 位置：src/config/feature-flags.config.ts
 * 
 * 使用方式：
 * import { FEATURE_FLAGS } from '@config/feature-flags.config';
 * if (FEATURE_FLAGS.CIRCUIT_BREAKER_ENABLED) { ... }
 */
export const FEATURE_FLAGS = {
  // 熔断层
  CIRCUIT_BREAKER_ENABLED: true,
  CIRCUIT_BREAKER_L3_ENABLED: true, // 可单独关闭硬熔断
  
  // 安全功能
  SESSION_EXPIRED_CHECK_ENABLED: true,
  LOGOUT_CLEANUP_ENABLED: true,
  
  // 备份功能
  AUTO_BACKUP_ENABLED: true,
  
  // Safari 兼容性
  PAGEHIDE_HANDLER_ENABLED: true,
} as const;
```

#### I.3 数据库迁移回滚脚本

```sql
-- 回滚 Connection Tombstone（如需）
-- 文件：supabase/migrations/YYYYMMDD_rollback_connection_tombstone.sql

DROP TRIGGER IF EXISTS trg_prevent_connection_resurrection ON public.connections;
DROP FUNCTION IF EXISTS public.prevent_tombstoned_connection_writes();
DROP TABLE IF EXISTS public.connection_tombstones;
```

### J. 监控告警规范（v5.2 新增）

#### J.1 告警级别定义

| 级别 | 响应时间 | 通知渠道 | 示例 |
|------|----------|----------|------|
| **P0** | 立即 | Slack + 短信 + 电话 | 数据丢失、安全漏洞被利用 |
| **P1** | 15 分钟 | Slack + 短信 | 备份失败、熔断频繁触发 |
| **P2** | 1 小时 | Slack | 配额告警、性能下降 |
| **P3** | 24 小时 | 邮件 | 统计异常、使用量变化 |

#### J.2 关键指标监控

| 指标 | 阈值 | 告警级别 | 检查间隔 |
|------|------|----------|----------|
| 熔断触发次数 | >10/小时 | P1 | 5 分钟 |
| 备份失败率 | >5% | P1 | 每次备份后 |
| 401/403 错误率 | >1% | P2 | 5 分钟 |
| IndexedDB 写入失败 | >0 | P2 | 实时 |
| Storage 配额使用率 | >80% | P2 | 1 小时 |
| 同步队列积压 | >100 项 | P2 | 5 分钟 |
| **🔴 IndexedDB 配额使用率** | >70% | P2 | 1 小时 |
| **🔴 IndexedDB 读取延迟** | >500ms | P3 | 5 分钟 |
| **🔴 IndexedDB 事务失败** | >0 | P2 | 实时 |
| **🔴 本地缓存命中率** | <80% | P3 | 1 小时 |

#### J.3 Sentry 告警配置

```typescript
/**
 * Sentry 告警规则配置
 */
const SENTRY_ALERT_RULES = {
  // 熔断触发告警
  circuitBreakerTriggered: {
    name: 'Circuit Breaker Triggered',
    conditions: {
      event_frequency: { count: 10, interval: '1h' },
      event_type: 'CircuitBreaker:*',
    },
    actions: ['slack-critical', 'email-oncall'],
  },
  
  // 安全漏洞利用尝试
  securityViolation: {
    name: 'Security Violation Detected',
    conditions: {
      event_type: 'SecurityViolation:*',
    },
    actions: ['slack-security', 'pagerduty'],
  },
  
  // 备份失败
  backupFailed: {
    name: 'Backup Failed',
    conditions: {
      event_type: 'Backup:Failed',
    },
    actions: ['slack-ops', 'email-oncall'],
  },
};
```

### K. 迁移快照存储策略（v5.2 补充）

> 针对 4.13 节数据迁移安全中"快照存储位置未定义"的问题。

**决策**：使用 `sessionStorage` 作为主存储，`localStorage` 作为备份。

**理由**：
1. `sessionStorage` 随标签页关闭自动清理，不会累积
2. 迁移操作通常在单次会话内完成
3. 如果用户中途关闭页面，下次打开可从 `localStorage` 备份恢复

**🔴 v5.2 补充：双存储触发时机**：

| 时机 | sessionStorage | localStorage | 说明 |
|------|----------------|--------------|------|
| 迁移开始 | ✅ 写入 | ✅ 写入 | 同时写入两个存储 |
| 迁移成功 | ✅ 清除 | ✅ 清除 | 同时清除两个存储 |
| 迁移失败 | 保留 | 保留 | 用于重试 |
| 页面关闭 | 自动清除 | 保留 24h | 下次打开可恢复 |
| 应用启动 | 检查 localStorage | 检查过期 | 发现未完成迁移则提示恢复 |

```typescript
/**
 * 迁移快照存储配置
 * 位置：src/services/migration.service.ts
 */
const MIGRATION_SNAPSHOT_CONFIG = {
  // 主存储（会话级别）
  PRIMARY_STORAGE: 'sessionStorage',
  PRIMARY_KEY: 'nanoflow.migration-snapshot',
  
  // 备份存储（持久化）
  BACKUP_STORAGE: 'localStorage',
  BACKUP_KEY: 'nanoflow.migration-snapshot-backup',
  
  // 备份保留时间（毫秒）
  BACKUP_RETENTION: 24 * 60 * 60 * 1000, // 24 小时
  
  // 最大快照大小（字节）- 超过则只备份元数据
  MAX_SNAPSHOT_SIZE: 5 * 1024 * 1024, // 5MB
};
```

### L. 时钟偏移问题最终决策（v5.2 补充）

> 针对 4.11 节时钟偏移问题中"未给出最终决策"的问题。

**最终决策**：**服务端时间作为权威来源**

**实现策略**：

> 🔴 **v5.2.2 代码验证说明**：当前 `simple-sync.service.ts#L658` 实际代码仍发送 `updated_at: task.updatedAt || nowISO()`。服务端触发器会覆盖此值，因此最终效果仍是服务端时间作为权威。但如需完全遵循"不传 updated_at"策略，需修改客户端代码。

```typescript
/**
 * 时钟同步策略
 */
// 1. 客户端仅用于乐观 UI 显示
// 2. 【当前实现】客户端发送 updated_at，但服务端触发器强制覆盖为 NOW()
// 3. 【目标实现】推送到服务端时，不传 updated_at（由服务端生成）
// 4. 拉取时使用服务端返回的 updated_at
// 5. LWW 比较基于服务端时间戳

// 服务端触发器确保时间戳正确（已存在于 init-database.sql）
CREATE OR REPLACE FUNCTION public.force_server_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := NOW();  -- 强制使用服务端时间，覆盖客户端传入值
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
```

**客户端适配（待实现）**：

```typescript
// 🔴 当前代码（simple-sync.service.ts#L658）：
// updated_at: task.updatedAt || nowISO()  // 仍发送客户端时间

// ✅ 目标代码：推送时移除客户端时间戳
async pushTask(task: Task, projectId: string): Promise<boolean> {
  const { updatedAt, ...taskWithoutTimestamp } = task;
  // 服务端触发器会自动设置 updated_at
  await this.supabase.from('tasks').upsert(taskWithoutTimestamp);
}
```

**🔴 v5.2 补充：与 LWW 策略的一致性说明**：

> 策划案 3.2 节 LWW 策略中的 `mergeTask` 代码使用了客户端 `updatedAt` 比较，这与本章节"服务端时间作为权威"看似矛盾，实际上是两个不同阶段的处理：

| 阶段 | 时间戳来源 | 说明 |
|------|-----------|------|
| **推送** | 不传 `updated_at` | 服务端触发器生成权威时间戳 |
| **拉取** | 使用服务端返回的 `updated_at` | 覆盖本地时间戳 |
| **本地 LWW** | 使用已拉取的服务端时间戳 | 本地比较时，双方时间戳都来自服务端 |
| **冲突解决** | 基于服务端时间戳 | 无客户端时钟偏移问题 |

**实现要点**：
1. `pullIncrementalChanges` 返回的数据中 `updated_at` 是服务端时间
2. 本地存储的 `task.updatedAt` 在拉取后被服务端时间覆盖
3. 下次 `mergeTask` 比较时，两边的 `updatedAt` 都是服务端生成的，无偏移问题
4. 唯一需要确保的是：本地未同步的修改不能覆盖已同步的数据（由 `localPendingIds` 检查保护）

### M. Safari 7天自动清理应对策略（v5.2 补充）

> 针对 4.10 节中 "Safari 只做警告不做保护" 的问题。

**决策**：Safari 用户自动启用更频繁的云端同步

```typescript
/**
 * Safari 特殊处理配置
 * 位置：src/config/browser.config.ts
 */
export const SAFARI_HANDLING_CONFIG = {
  // 检测是否为 Safari
  DETECT_SAFARI: true,
  
  // Safari 用户同步策略调整
  SAFARI_SYNC_STRATEGY: {
    // 缩短同步间隔（10 分钟 → 5 分钟）
    REDUCED_SYNC_INTERVAL: 5 * 60 * 1000,
    
    // 每次打开应用强制同步
    FORCE_SYNC_ON_OPEN: true,
    
    // 强制启用 E 层备份提醒
    FORCE_BACKUP_REMINDER: true,
  },
  
  // 警告消息
  WARNING_MESSAGE: '您正在使用 Safari 浏览器，超过 7 天未访问可能导致本地数据被清理，建议定期导出备份。',
  
  // 显示警告的最小间隔（毫秒）
  WARNING_INTERVAL: 3 * 24 * 60 * 60 * 1000, // 3 天
} as const;

/**
 * Safari 检测和处理逻辑
 * 
 * 🔴 v5.2 修正：原正则 /^((?!chrome|android).)*safari/i 会错误匹配 Chrome on iOS
 *    使用更可靠的检测方式
 */
function isSafariBrowser(): boolean {
  const ua = navigator.userAgent.toLowerCase();
  // Safari 但不是 Chrome/Chromium/Android 浏览器
  return ua.includes('safari') && 
         !ua.includes('chrome') && 
         !ua.includes('chromium') && 
         !ua.includes('android');
}

function handleSafariBrowser(): void {
  if (!isSafariBrowser()) return;
  
  // 1. 调整同步策略
  SYNC_CONFIG.POLLING_INTERVAL = SAFARI_HANDLING_CONFIG.SAFARI_SYNC_STRATEGY.REDUCED_SYNC_INTERVAL;
  
  // 2. 强制同步
  if (SAFARI_HANDLING_CONFIG.SAFARI_SYNC_STRATEGY.FORCE_SYNC_ON_OPEN) {
    this.syncCoordinator.forceSync();
  }
  
  // 3. 检查警告间隔
  const lastWarning = localStorage.getItem('nanoflow.safari-warning-time');
  const now = Date.now();
  
  if (!lastWarning || now - parseInt(lastWarning) > SAFARI_HANDLING_CONFIG.WARNING_INTERVAL) {
    this.toast.warning('Safari 浏览器提醒', SAFARI_HANDLING_CONFIG.WARNING_MESSAGE, {
      duration: 10000,
      action: { 
        label: '立即导出', 
        callback: () => this.exportService.exportCurrentProject() 
      }
    });
    localStorage.setItem('nanoflow.safari-warning-time', now.toString());
  }
}
```

---

## 十、变更记录

| 版本 | 日期 | 变更内容 |
|------|------|----------|
| 1.0 | 2026-01-01 | 初稿完成 |
| 2.0 | 2026-01-01 | 深度审查后修订：<br>- 添加实现状态追踪<br>- 补充多标签页并发保护<br>- 补充离线数据完整性校验<br>- 补充附件/连接/偏好设置保护<br>- 强化熔断机制详细设计<br>- 修订工时估算<br>- 更新风险评估 |
| 2.1 | 2026-01-01 | 二次审查后补充：<br>- 新增 3.7 会话过期保护<br>- 新增 3.8 存储配额保护<br>- 新增 3.9 乐观更新回滚强化<br>- 新增 4.6 RLS 权限拒绝处理<br>- 新增 4.7 多设备冲突处理<br>- 新增 4.8 Undo 历史保护策略<br>- 新增 4.9 Guest 用户数据保护<br>- 补充 5.3 备份加密与完整性配置<br>- 补充附件 Signed URL 过期处理<br>- 补充恢复操作原子性保证<br>- 更新风险评估表（+6 项）<br>- 更新配置常量汇总 |
| 3.0 | 2026-01-01 | 代码审查后完善：<br>- 修正熔断层实现率从 30% 到 20%（数据熔断为 0%）<br>- 更新工时估算（P0: 24-32h, P1: 16-24h, P2: 40-60h）<br>- 新增 Connection Tombstone 到 P0<br>- 新增会话过期入口检查到 P0<br>- 新增 4.10 IndexedDB 损坏恢复<br>- 新增 4.11 时钟偏移问题<br>- 新增 4.12 UUID 冲突处理<br>- 新增死代码清理清单<br>- 新增测试覆盖要求<br>- 更新风险评估表（+7 项）<br>- 更新实施时间表为 10 周 |
| 3.1 | 2026-01-01 | 第二轮代码审查后完善：<br>- 修正 Guest 过期天数（7→30，与 migration.service.ts 一致）<br>- 更新状态表（新增附件 URL 刷新、IndexedDB 过滤、迁移安全、路由保护）<br>- 补充 3.1 节 IndexedDB 客户端过滤已实现说明<br>- 补充 4.7 节 Realtime 降级策略（增强轮询）<br>- 新增 4.13 节数据迁移安全<br>- 新增 4.14 节路由离开保护<br>- 调整 P0 Connection Tombstone 工时（2h→3-4h）<br>- 调整 P1 附件导出工时（3h→5-6h）<br>- 更新风险评估表（+3 项）<br>- 新增附录 G E2E 测试场景 |
| 4.0 | 2026-01-01 | 深度审查后完善（v4）：<br>- P0 工时调整：24-32h → 35-45h（Week 1-3 → Week 1-4）<br>- 紧急项识别：`sessionExpired` 入口检查完全缺失<br>- 熔断分级设计：L1/L2/L3 分级<br>- 任务数骤降阈值改为绝对值+相对值结合<br>- P1 工时调整：16-24h → 20-28h<br>- P2 工时调整：40-60h → 45-65h<br>- 总实施周期：10 周 → 11 周 |
| 5.0 | 2026-01-01 | **🔴 深度代码审计后完善（v5）**：<br>- 🔴 **发现 12 个 Critical 级安全漏洞**<br>- 🔴 **P0 工时调整**：35-45h → 45-60h（Week 1-4 → Week 1-5）<br>- 🔴 **Week 1 Day 1 紧急修复**：<br>  · SECURITY DEFINER 权限校验（附件 RPC 可越权）<br>  · Tombstone DELETE 策略移除（破坏防复活）<br>  · sessionExpired 入口检查<br>- 🔴 **Week 1 安全修复**：<br>  · 多用户数据隔离（缓存键用户级别）<br>  · 登出时数据清理（IndexedDB + localStorage）<br>  · 附件并发保护（改用原子操作）<br>  · 批量操作事务保护（部分失败回滚）<br>- 🔴 **Week 2 数据完整性**：<br>  · IndexedDB 写入完整性校验<br>  · Merge 策略远程保护<br>  · 迁移原子性保证<br>- 🔴 **Week 3 安全加固**：<br>  · 附件病毒扫描集成<br>- **新增 16 个 High 级问题到风险表**<br>- **新增 8 个待修复安全文件到附录 A**<br>- **新增 7 个 E2E 安全测试场景**<br>- **成功指标新增 Critical 漏洞数**<br>- **阶段性目标新增 Week 1 Day 1 和 Week 1**<br>- 总实施周期：11 周 → 12 周 |
| **5.1** | **2026-01-01** | **🔴 二次深度代码审计后完善（v5.1）**：<br>- 🔴 **发现 15 个 Critical 级（+3）、8 个 High 级安全漏洞**<br>- 🔴 **P0 工时调整**：45-60h → 50-68h<br>- 🔴 **P1 工时调整**：20-28h → 22-30h<br>- 🔴 **Week 1 Day 1 紧急修复新增**：<br>  · Safari/iOS pagehide 兼容（beforeunload 不触发）<br>  · is_task_tombstoned 权限校验（SECURITY DEFINER 信息泄露）<br>  · pushProject sessionExpired 检查<br>- ⚠️ **Week 1 新增**：<br>  · 统一 beforeunload 处理器（两个监听器冲突）<br>  · 用户偏好键隔离（storage key 添加 userId 前缀）<br>  · 附件数量服务端限制（RPC 添加 MAX_ATTACHMENTS 检查）<br>- ⚠️ **Week 2 新增**：<br>  · loadProject schema 验证<br>  · mergeConnections 唯一键修正（id 而非 source→target）<br>  · 乐观快照配置统一（TTL 和 MAX_SNAPSHOTS）<br>- ⚠️ **P1 新增**：<br>  · 撤销历史截断提示<br>  · JWT 刷新失败监听<br>- ⚠️ **P2 新增**：<br>  · Realtime 重连增量同步<br>- **新增 9 个待修复文件到附录 A**<br>- **新增 3 个 E2E 测试场景（Safari/Undo/Realtime）**<br>- **成功指标新增 High 漏洞数**<br>- **阶段性目标 Week 1 Day 1 更新为 6 项** |
| **5.2** | **2026-01-01** | **🔵 三次深度代码审计后完善（v5.2）**：<br>- 🔵 **添加代码验证警告表**（文档顶部，扩展至 9 项）<br>- 🔵 **新增完整 Storage Key 清理清单**：<br>  · IndexedDB: `nanoflow-db`<br>  · localStorage: `nanoflow.*` 系列 8 个键<br>- 🔵 **新增 H 章节：未覆盖重大风险**：<br>  · H.1 Realtime 断连期间变更丢失处理（🔴 修正为正确的 Supabase API）<br>  · H.2 批量操作"全有或全无"语义定义（🔴 添加 auth.uid() 权限校验）<br>  · H.3 Guest 用户登录边界场景处理<br>  · H.4 附件生命周期管理（🔴 添加 cleanup_queue 表定义和 RLS）<br>- 🔵 **新增 I 章节：回滚计划**：<br>  · 功能开关配置（🔴 明确位置和动态更新机制）<br>  · 🔴 客户端代码回滚流程（PWA 缓存处理）<br>  · 数据库迁移回滚脚本<br>- 🔵 **新增 J 章节：监控告警规范**：<br>  · P0-P3 告警级别定义<br>  · 关键指标监控阈值（🔴 新增 4 项 IndexedDB 相关指标）<br>  · Sentry 告警规则配置<br>- 🔵 **新增 K 章节：迁移快照存储策略**<br>  · 决策：sessionStorage + localStorage 双备份<br>  · 🔴 补充双存储触发时机表<br>- 🔵 **新增 L 章节：时钟偏移最终决策**<br>  · 决策：服务端时间作为权威来源<br>- 🔵 **新增 M 章节：Safari 7天自动清理应对策略**<br>  · Safari 用户自动启用更频繁云端同步<br>  · 🔴 修正 Safari 检测正则表达式<br>- 🔵 **补充 Connection Tombstone RLS 策略**<br>- 🔵 **统一 BeforeUnloadManagerService 设计**<br>- 🔵 **新增 3 个 E2E 测试场景**（偏好隔离/Realtime重连/JWT刷新）<br>- 🔴 **v5.2 修正**：修复 4 个 Critical 级问题（API 错误、权限缺失、表定义缺失） |
| **5.3** | **2026-01-01** | **🔴 六次深度代码审计后完善（v5.3）**：<br>- 🔴 **发现 19 个 Critical 级（+4）、14 个 High 级（+6）安全漏洞**<br>- 🔴 **P0 工时调整**：65-85h → 70-95h（Week 1-6 → Week 1-7）<br>- 🔴 **Week 1 Day 1 紧急修复新增**：<br>  · 离线缓存键版本统一（`sync.config.ts#L155` vs `simple-sync.service.ts#L2663` 不一致）<br>  · RetryQueue sessionExpired 入口检查（无限重试 403 错误）<br>  · RetryQueue 优先级排序（FK 违规风险）<br>- ⚠️ **Week 1 新增**：<br>  · is_task_tombstoned 返回 false 而非 NULL（信息泄露修复）<br>- ⚠️ **Week 4 新增**：<br>  · batch_upsert_tasks 补全 attachments 字段<br>- ⚠️ **Week 2 新增**：<br>  · 迁移快照 sessionStorage 5MB 限制降级策略<br>- ⚠️ **Week 3 新增**：<br>  · 熔断分级阈值动态调整<br>- ⚠️ **Week 5 新增**：<br>  · 附件病毒扫描 TOCTOU 窗口处理<br>- **风险评估表更新至 v5.3**：新增 12 项风险<br>- **成功指标更新**：Critical 15→19, High 8→14<br>- **阶段性目标 Week 1 Day 1 更新为 8 项**<br>- **新增 RETRY_QUEUE_PRIORITY 常量定义**<br>- **新增 3 个修复代码块到 Week 1 Day 1 详细任务** |
| **5.4** | **2026-01-01** | **✅ 七次深度代码审计后修正（v5.4）**：<br>- ✅ **修正 3 个误报问题**：<br>  · **RetryQueue 优先级排序已实现**（L1652-1658 按 project→task→connection 排序）<br>  · **Tombstone DELETE 策略不存在**（init-database.sql 中无 DELETE 策略）<br>  · **移除无效任务，工时节省 3.5-4.5h**<br>- 🔴 **P0 工时调整**：70-95h → 65-85h<br>- 🔴 **新增 5 个 Critical 级纠正项到代码验证警告表**<br>- ⚠️ **新增 7 个 High 级问题到代码验证警告表**：<br>  · clearLocalData 无 localStorage 清理（仅内存）<br>  · onAuthStateChange 未监听（JWT 刷新失败）<br>  · pagehide/visibilitychange 未实现（Safari 兼容）<br>  · Realtime 重连状态未追踪<br>- **更新实现状态总览表**：<br>  · RetryQueue 优先级排序：❌ → ✅ 已实现<br>  · Tombstone DELETE 策略：⚠️ 存在漏洞 → ✅ 无漏洞<br>- **熔断层实现率更新**：2/11 → 3/11（约 18%） |

---

## 十一、审批记录

| 日期 | 审批人 | 状态 | 备注 |
|------|--------|------|------|
| 2026-01-01 | - | 草案 | 初稿完成 |
| 2026-01-01 | - | 修订 | 深度审查后完善 |
| 2026-01-01 | - | v3 修订 | 代码审查后完善 |
| 2026-01-01 | - | v3.1 待批准 | 第二轮审查后完善 |
| 2026-01-01 | - | v4.0 审查通过 | 深度审查后完善，标记紧急项，调整工时 |
| 2026-01-01 | - | v5.0 紧急修订 | 深度代码审计发现 12 个 Critical 级安全漏洞，需立即修复 |
| 2026-01-01 | - | **🔴 v5.1 紧急修订** | **二次深度代码审计发现 15 个 Critical 级（+3）、8 个 High 级安全漏洞** |
| 2026-01-01 | - | **🔵 v5.2 修订** | **三次深度审查后完善：添加代码验证警告、未覆盖风险(H-M章节)、回滚计划、监控告警规范** |
| 2026-01-01 | - | **🟢 v5.2.1 修订** | **根据四次审查修复 4 个 Critical、6 个 High 级问题** |
| 2026-01-01 | - | **🟢 v5.2.2 修订** | **根据五次审查修复**：<br>- 🔴 **C1**：L 章节时间策略添加代码验证说明（当前代码仍发送 updated_at）<br>- 🔴 **C2**：代码验证表添加迁移快照/Safari处理/L章节未实现条目<br>- ⚠️ **H1**：batch_upsert_tasks 补全 order/rank/x/y/status/short_id/deleted_at 字段<br>- ⚠️ **H5**：Storage Key 清理清单添加 safari-warning-time/guest-data/queue-backup<br>- ⚠️ **M2**：I.1 回滚表添加 Safari 特殊处理和迁移快照机制 |
| 2026-01-01 | - | **🔴 v5.3 紧急修订** | **六次深度代码审计发现 19 个 Critical 级（+4）、14 个 High 级（+6）安全漏洞**：<br>- 离线缓存键版本不一致（sync.config vs simple-sync）<br>- RetryQueue 无 sessionExpired 检查<br>- RetryQueue 无优先级排序<br>- is_task_tombstoned NULL 信息泄露 |
| 2026-01-01 | - | **✅ v5.4 修正版** | **七次深度代码审计修正 3 个误报问题**：<br>- ✅ RetryQueue 优先级排序已实现（L1652-1658）<br>- ✅ Tombstone DELETE 策略不存在（无需修复）<br>- 🔴 P0 工时节省 3.5-4.5h（65-85h）<br>- 新增 7 个代码验证警告项 |
