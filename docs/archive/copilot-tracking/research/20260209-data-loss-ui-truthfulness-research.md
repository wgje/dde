<!-- markdownlint-disable-file -->

# Task Research Notes: NanoFlow 数据丢失与 UI 真逻辑一致性治理策划案 — 全面审查

> 研究日期: 2026-02-09
> 审查对象: `docs/data-loss-and-ui-truthfulness-master-plan-2026-02-09.md`
> 方法: 以 `task-researcher.prompt.md` 为模板，对策划案中所有声明逐一代码验证

---

## Research Executed

### File Analysis

- `src/app/features/flow/components/flow-view.component.ts`
  - 验证 `saveToCloud()` 占位逻辑（行 422-425）
- `src/app/features/flow/components/flow-view.component.html`
  - 验证按钮绑定位置（行 116, 329）
- `src/app/features/flow/components/flow-toolbar.component.ts`
  - 验证 `isUploading` 卡死状态（行 280, 335-342）
- `src/services/action-queue.service.ts`
  - 验证队列冻结与软/硬上限（行 155, 231-254）
- `src/services/action-queue-storage.service.ts`
  - 验证存储压力处理与逃生模式（行 414-447, 531-550, 640-648）
- `src/app/core/services/sync/retry-queue.service.ts`
  - 验证绝对上限拒绝入队（行 238-243, 984-992）
- `src/config/sync.config.ts`
  - 验证 content 字段保护配置（行 131-145）
- `src/app/core/services/sync/project-data.service.ts`
  - 验证 rowToTask content 防护（行 445-463）
- `src/services/delta-sync-coordinator.service.ts`
  - 验证 Delta Sync content 保护（行 131-144）
- `src/services/remote-change-handler.service.ts`
  - 验证字段锁与 LWW 保护（行 523-549）
- `src/app/shared/components/offline-banner.component.ts`
  - 验证 toast-only 行为（行 19, 32-63）
- `src/app/shared/components/sync-status.component.ts`
  - 验证同步状态面板显示内容（行 43-100, 403-450）

### Code Search Results

- `saveToCloud` 全代码库搜索
  - flow-view.component.ts:422（TODO 占位）、flow-view.component.html:116/329（事件绑定）、flow-toolbar.component.ts:274/338（output 与 emit）
- `setUploadComplete` 全代码库搜索
  - flow-toolbar.component.ts:341（定义）— **全代码库未被调用**
- `queueFrozen` 搜索
  - action-queue-storage.service.ts:90（signal 定义）、action-queue.service.ts:155（入队时检测）
- `onUserLogout` 搜索
  - optimistic-state.service.ts:257、undo.service.ts:585、attachment.service.ts:158 — **定义但未在登出流程中调用**
- `DELTA_SYNC_ENABLED` 搜索
  - sync.config.ts — 值为 `false`（增量同步未启用）

### Project Conventions

- Standards referenced: `AGENTS.md`, `.github/instructions/general.instructions.md`
- Instructions followed: task-researcher.prompt.md 模板

---

## Key Discoveries

### 一、策划案声明验证总表

#### WF-A: UI 真逻辑一致性

| 编号 | 策划案声明 | 验证结果 | 证据位置 |
|------|-----------|---------|---------|
| A1 | `saveToCloud()` 是 TODO 占位，仅 toast | **✅ 确认** | `flow-view.component.ts:422-425` — `// TODO: 实现云端保存功能` + `this.toast.info('功能开发中', '云端保存功能即将推出')` |
| A1 | HTML 中有两处绑定触发 | **✅ 确认** | `flow-view.component.html:116`（mobile toolbar）、`:329`（desktop toolbar）均 `(saveToCloud)="saveToCloud()"` |
| A2 | `isUploading` 状态卡死、复位路径不完整 | **✅ 确认，且比策划案描述更严重** | `flow-toolbar.component.ts:337` 设 `true`，:341 定义 `setUploadComplete()` 但**全代码库无任何调用**。结果：点击一次后按钮**永久**卡在"上传中..." disabled 状态 |

**补充发现:** `setUploadComplete()` 不仅是"复位路径不完整"，而是**完全未接入**。策划案描述偏保守。

#### WF-B: 同步队列耐久性

| 编号 | 策划案声明 | 验证结果 | 证据位置 |
|------|-----------|---------|---------|
| B1 | ActionQueue `queueFrozen` 时内存兜底 | **✅ 确认** | `action-queue.service.ts:155-164` — 冻结时 warn 并继续内存接收。`action-queue-storage.service.ts:414-447` — localStorage QuotaExceeded 时冻结并尝试 IndexedDB 备份 |
| B1 | 刷新/崩溃后存在丢失风险 | **✅ 确认** | 冻结后数据仅在 `pendingActions` signal 中（内存），若 IndexedDB 备份也失败则进入 `triggerStorageFailureEscapeMode()`（:531-550），提示用户手动复制 |
| B2 | RetryQueue 绝对上限拒绝入队 | **✅ 确认** | `retry-queue.service.ts:238-243` — `absoluteLimit = maxQueueSize * 5`（localStorage=500, IndexedDB=5000），超限 `return false` |
| B2 | 存储大小超限保护 | **✅ 确认** | `retry-queue.service.ts:984-992` — JSON 序列化超 `RETRY_QUEUE_SIZE_LIMIT_BYTES`(1MB) 时拒绝覆盖存储 |
| B3 | ProjectDataService 离线快照用 localStorage | **✅ 确认** | `project-data.service.ts:368-406` — `localStorage.setItem/getItem(OFFLINE_CACHE_KEY)` |

**补充发现:**
- ActionQueue 已有 IndexedDB 备份机制（`backupQueueToIndexedDB`）和逃生回调（`onStorageFailure`），比策划案描述的更完善
- 但逃生模式仅提示用户"手动复制"，无自动导出 JSON 入口
- RetryQueue 已有 IndexedDB 主存储（`retry-queue.service.ts:5-12`），配额 1000 条，策划案中 max_retry_queue_size=100 是 localStorage 场景

#### 已验证有效的保护机制

| 编号 | 策划案声明 | 验证结果 | 证据位置 |
|------|-----------|---------|---------|
| 2.2.1 | content 字段多重保护 | **✅ 确认 — 7 层保护** | 见下方详细分析 |
| 2.2.2 | 远程变更字段锁与 LWW | **✅ 确认** | `remote-change-handler.service.ts:523-549` — 字段锁 + LWW 时间戳双重保护 |

**Content 字段 7 层保护栈 (全部验证通过):**

| 层级 | 保护机制 | 文件:行号 |
|------|---------|----------|
| 1 | 配置层：FIELD_SELECT_CONFIG 必须包含 content | `sync.config.ts:145` |
| 2 | 转换层：rowToTask 检测 content 缺失 + Sentry 告警 | `project-data.service.ts:445-463` |
| 3 | Delta 同步层：远程 content 为空时保留本地 | `delta-sync-coordinator.service.ts:131-144` |
| 4 | 远程变更层：字段操作锁保护 | `remote-change-handler.service.ts:523-529` |
| 5 | 远程变更层：LWW 时间戳保护（本地 >= 远程时保护全部关键字段） | `remote-change-handler.service.ts:531-549` |
| 6 | 冲突检测层：content 锁定 + 相似度检测 + 冲突副本 | `conflict-detection.service.ts:98-150` |
| 7 | 合并层：软删除处理 + 字段级冲突解决 | `conflict-resolution.service.ts:269-393` |

#### WF-C: 离线状态可见性

| 编号 | 策划案声明 | 验证结果 | 证据位置 |
|------|-----------|---------|---------|
| C1 | `offline-banner` 仅 toast，无 banner | **✅ 确认** | `offline-banner.component.ts:19` — template 为 `<!-- 无渲染内容 -->`，:32-63 仅调用 toast |
| C1 | 命名与实际行为不一致 | **✅ 确认** | 组件名 `offline-banner`，HTML 注释"离线状态横幅"，实际无任何可见 banner |

**补充发现:**
- sync-status.component.ts 已有**较完善的状态面板**，包含：在线/离线/同步中/队列冻结/失败项目/待同步数量
- 但仅在侧边栏内展示（需点击才能看到），**不是全局持久化状态指示器**
- sync-status 已监控 `queueFrozen` 状态并显示为红色（:423），策划案 C2 部分需求已部分实现

---

### 二、策划案未覆盖的新发现风险

以下为代码审查中发现的额外风险点，**不在原始策划案范围内**：

#### NEW-1: `onUserLogout()` 未被调用 — 跨用户数据泄露 [严重度: HIGH]

**问题:** 三个服务定义了 `onUserLogout()` 方法但**从未在登出流程中调用**：
- `optimistic-state.service.ts:257-259` — 清理乐观更新快照
- `undo.service.ts:585-603` — 清理撤销/重做栈 + sessionStorage
- `attachment.service.ts:158` — 清理附件 URL 缓存

**登出流程** (`app-auth-coordinator.service.ts:372-389`) 仅调用:
- `userSession.clearAllLocalData()`
- `auth.signOut()`

**风险:** 用户 A 登出 → 用户 B 登入 → 用户 B 可能访问到用户 A 的撤销历史和快照数据

#### NEW-2: sessionStorage 登出后未清理 [严重度: HIGH]

**问题:** `undo.service.ts` 将撤销历史持久化到 sessionStorage (key: `UNDO_CONFIG.PERSISTENCE.STORAGE_KEY`)。
`clearAllLocalData()` 不调用 `onUserLogout()`，因此 `clearPersistedData()` (行 757) 永远不执行。

**结果:** 撤销历史在登出后仍残留在 sessionStorage 中。

#### NEW-3: Session 过期时同步中断无数据刷盘保障 [严重度: MEDIUM]

**问题:** `batch-sync.service.ts:171-184` — Session 过期时同步直接中断返回 `{ success: false }`，
未确保 ActionQueue/RetryQueue 中的待同步操作已持久化到 IndexedDB。

**窗口:** Session 过期 → 用户重新登录 → 如果期间浏览器崩溃，队列中操作可能丢失。

#### NEW-4: 撤销 version-mismatch 过度拒绝 [严重度: MEDIUM]

**问题:** `undo.service.ts:326-345` — 当远程更新导致版本差距超过 `VERSION_TOLERANCE * 2` 时，
**完全拒绝撤销**，无用户感知（仅内部 return 'version-mismatch'）。

**结果:** 用户在离线编辑恢复后可能完全无法撤销，但不知道原因。

#### NEW-5: deletedAt vs Tombstone 双重删除机制不一致 [严重度: MEDIUM]

**问题:** 任务有两种删除机制:
1. 软删除: `task.deletedAt` 字段
2. 硬删除: 从云端移除 + tombstone 表

`store-persistence.service.ts:480-486` 加载时过滤 `deletedAt` 任务，
但离线删除后刷新可能导致删除操作丢失引用源。

#### NEW-6: beforeunload 回调非阻塞性 [严重度: MEDIUM]

**问题:** `before-unload-manager.service.ts:119-143` — `beforeunload` 事件仅能弹出确认对话框，
无法保证保存操作在用户确认离开后完成。现代浏览器不允许阻塞导航。

#### NEW-7: 首次离线加载无通知 [严重度: LOW]

**问题:** `offline-banner.component.ts:39` — 仅在状态**变化**时通知，
如果应用首次加载时即处于离线状态，用户不会收到任何提示。

#### NEW-8: Feature Flags 可禁用关键保护 [严重度: LOW]

**问题:** `feature-flags.config.ts:42-65` — 以下保护性 flag 如被禁用可导致数据丢失:
- `CONNECTION_TOMBSTONE_ENABLED` — 禁用后已删除连接可能复活
- `SYNC_DURABILITY_FIRST_ENABLED` — 禁用后队列可能丢弃项目
- `SYNC_STRICT_SUCCESS_ENABLED` — 禁用后部分同步可能被视为成功

无 flag 安全性校验或禁用时的日志警告。

---

### 三、策划案准确性评估

| 评价维度 | 评分 | 说明 |
|---------|------|------|
| 行号准确性 | ⭐⭐⭐⭐ (4/5) | 多数行号精确匹配，少数因代码变更有 ±5 行偏移 |
| 风险评估准确性 | ⭐⭐⭐⭐⭐ (5/5) | 所有已列出风险均经代码验证确认 |
| 风险描述保守度 | ⭐⭐⭐ (3/5) | A2（上传状态卡死）实际比描述更严重；B1 已有 IndexedDB 备份未被提及 |
| 保护机制描述 | ⭐⭐⭐⭐ (4/5) | content 保护实际有 7 层（策划案提及 3 层）；sync-status 已有部分 C2 功能 |
| 覆盖完整性 | ⭐⭐⭐ (3/5) | 遗漏了 8 个新发现风险（其中 2 个 HIGH 级别） |

---

## Recommended Approach

**策划案整体可行，建议以下调整：**

### 优先级提升

1. **新增 P0: 修复 `onUserLogout()` 调用缺失** — 跨用户数据泄露是安全问题，应在 M1 阶段完成
2. **A2 提升描述为"按钮永久卡死"** — `setUploadComplete()` 完全未接入，非"复位路径不完整"

### 优先级调整

3. **B1 调整范围** — ActionQueue 已有 IndexedDB 备份机制，重点应放在 "逃生导出 JSON 入口" 和 "冻结期定时重试" 上
4. **C2 缩减范围** — sync-status 已有待同步数量、失败数量、在线/离线/队列冻结状态，仅需补充"最近成功云同步时间"和"未持久化内存操作"

### 新增任务建议

5. **新增 P1 任务**: 修复 `onUserLogout()` 在 `AppAuthCoordinatorService.signOut()` 中的调用
6. **新增 P2 任务**: 修复 sessionStorage 撤销历史清理
7. **新增 P2 任务**: 首次离线加载通知（offline-banner 补充初始状态检测）
8. **新增 P3 任务**: Feature Flags 安全性校验机制

---

## Implementation Guidance

- **Objectives**: 确认策划案有效性、识别遗漏风险、提供修正建议
- **Key Tasks**:
  1. 将 NEW-1（onUserLogout）加入 M1 快速止血阶段
  2. 修正 A2 描述为"永久卡死"
  3. 更新 B1 范围，利用已有 IndexedDB 备份
  4. 缩减 C2 范围（已有部分实现）
- **Dependencies**: 无外部依赖，全部为内部代码修改
- **Success Criteria**: 所有 HIGH 级别风险有对应任务 + 测试覆盖
