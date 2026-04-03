<!-- markdownlint-disable-file -->

# Task Details: NanoFlow 数据丢失与 UI 真逻辑一致性治理

## Research Reference

- .copilot-tracking/research/20260209-data-loss-ui-truthfulness-research.md
- docs/data-loss-and-ui-truthfulness-master-plan-2026-02-09.md

## Phase 1: 快速止血 — UI 真逻辑 + 安全漏洞

### Task 1.1: 修复 `onUserLogout()` 调用缺失 [NEW-1, P0]

三个服务定义了 `onUserLogout()` 方法但从未在登出流程中调用，导致用户 A 登出后用户 B 可能访问到用户 A 的撤销历史和快照数据。

**实现方案:**

1. 在 `AppAuthCoordinatorService.signOut()` 方法中（`app-auth-coordinator.service.ts` 登出流程 :372-389），
   在 `userSession.clearAllLocalData()` 之前，依次调用：
   - `inject(OptimisticStateService).onUserLogout()` — 清理乐观更新快照
   - `inject(UndoService).onUserLogout()` — 清理撤销/重做栈 + sessionStorage
   - `inject(AttachmentService).onUserLogout()` — 清理附件 URL 缓存
2. 注意服务注入规则：直接注入具体子服务，禁止 `inject(StoreService)`

- **Files**:
  - `src/app/core/services/app-auth-coordinator.service.ts` — 在 signOut 中添加 onUserLogout 调用
- **Success**:
  - 登出后 optimistic-state、undo 栈、attachment 缓存全部清空
  - 新用户登入后无法访问前用户快照
- **Research References**:
  - Research (Lines 92-104) — NEW-1 发现详情
- **Dependencies**:
  - 无前置依赖

### Task 1.2: 修复 sessionStorage 撤销历史登出后残留 [NEW-2, P0]

`undo.service.ts` 将撤销历史持久化到 sessionStorage，`clearAllLocalData()` 不调用 `onUserLogout()`，
因此 `clearPersistedData()` (行 757) 永远不执行。

**实现方案:**

1. Task 1.1 已解决主要问题（调用 `onUserLogout()`）
2. 额外在 `UserSessionService.clearAllLocalData()` 中增加 `sessionStorage.clear()` 作为兜底
3. 验证 `onUserLogout()` 中 `clearPersistedData()` 确实清理了对应 key

- **Files**:
  - `src/services/user-session.service.ts` — clearAllLocalData 增加 sessionStorage.clear 兜底
  - `src/services/undo.service.ts` — 确认 clearPersistedData 清理逻辑
- **Success**:
  - 登出后 sessionStorage 中无 undo 相关 key
  - 手动检查 sessionStorage.length === 0（或仅剩非用户数据 key）
- **Research References**:
  - Research (Lines 106-112) — NEW-2 发现详情
- **Dependencies**:
  - Task 1.1 完成

### Task 1.3: 实装 `saveToCloud` 真实业务链路 [A1, P1]

`saveToCloud()` 当前仅 toast 提示"功能开发中"，需替换为真实同步流程。

**实现方案:**

1. 在 `flow-view.component.ts:422-425` 替换 TODO 占位：
   ```typescript
   async saveToCloud(): Promise<void> {
     // 1. 触发一次即时同步（复用现有 SimpleSyncService 能力）
     //    调用 SimpleSyncService.forceSyncNow() 或类似方法
     // 2. 等待同步结果 → 返回 Result<SyncResult, SyncError>
     // 3. 成功：toast.success('已保存到云端', `最后同步: ${timestamp}`)
     //    失败：toast.error('保存失败', errorMessage)
     //    超时：toast.warning('保存超时', '数据已缓存，将在连接恢复后自动同步')
   }
   ```
2. 利用现有 `SimpleSyncService` 的同步能力，不重复造轮子
3. 返回类型使用 `Result<T, E>` 模式（参考 `src/utils/result.ts`）
4. 增加超时保护（`TIMEOUT_CONFIG.STANDARD = 10000ms`）
5. 网络离线时直接提示"当前离线，数据已安全保存在本地"

**技术细节:**
- 注入 `SimpleSyncService`（或其子服务如 `BatchSyncService`）
- 调用同步方法并 await 结果
- 使用 `AbortController` + `setTimeout` 实现超时保护
- 错误分级：网络错误 → NOTIFY、认证错误 → RECOVERABLE、未知错误 → NOTIFY + Sentry

- **Files**:
  - `src/app/features/flow/components/flow-view.component.ts` — 替换 saveToCloud 占位逻辑
- **Success**:
  - 点击后存在真实网络请求（可在 DevTools Network 面板验证）
  - 成功后显示"已保存到云端"+ 时间戳
  - 失败后显示具体错误原因
  - 离线时显示"已安全保存在本地"
- **Research References**:
  - Research (Lines 53-58) — A1 验证结果
  - Master Plan (Section 4.1 A1) — 原始需求描述
- **Dependencies**:
  - SimpleSyncService 同步能力已可用

### Task 1.4: 修复 flow-toolbar `上传中` 永久卡死状态 [A2, P1]

`setUploadComplete()` 定义但**全代码库无任何调用**，导致按钮点击一次后永久卡在"上传中..."。

**实现方案:**

1. 重构事件通信模型：将 `saveToCloud` output 改为返回 `Promise<Result>` 或使用回调模式
2. 在 `flow-toolbar.component.ts` 中：
   ```typescript
   // 方案 A：父组件回调模式
   saveToCloudCallback = input<(() => Promise<Result<void, Error>>) | null>(null);
   
   async onSaveToCloud(): Promise<void> {
     const callback = this.saveToCloudCallback();
     if (!callback) return;
     this.isUploading.set(true);
     try {
       const result = await callback();
       if (result.ok) {
         // 成功处理
       } else {
         // 失败处理
       }
     } finally {
       this.setUploadComplete(); // 确保任何路径都复位
     }
   }
   ```
3. 方案 B（更简单）：在 flow-view 中 emit 后主动通知 toolbar 复位
4. 增加超时保护（30s），避免异常路径漏复位：
   ```typescript
   setTimeout(() => {
     if (this.isUploading()) {
       this.setUploadComplete();
       this.toast.warning('操作超时', '请稍后重试');
     }
   }, TIMEOUT_CONFIG.HEAVY);
   ```

- **Files**:
  - `src/app/features/flow/components/flow-toolbar.component.ts` — 修复 isUploading 复位逻辑
  - `src/app/features/flow/components/flow-view.component.ts` — 配合新通信模式
  - `src/app/features/flow/components/flow-view.component.html` — 更新绑定（如需要）
- **Success**:
  - 成功路径：按钮恢复可点击 + 成功提示
  - 失败路径：按钮恢复可点击 + 错误提示
  - 超时路径：30s 后自动复位 + 超时提示
  - 不存在按钮永久 disabled 的可能性
- **Research References**:
  - Research (Lines 59-63) — A2 验证结果 + 补充发现
- **Dependencies**:
  - Task 1.3 完成（saveToCloud 真实实现）

### Task 1.5: 统一离线提示语义 — offline-banner 行为治理 [C1, P1]

`offline-banner` 组件名与实际行为不一致：名为 banner 但仅做 toast，无可见 banner 元素。
且首次离线加载无通知（NEW-7）。

**实现方案:**

1. 方案选择：**保留 toast-only + 增加 persistent 状态指示器**
   - 理由：全局 banner 遮挡内容过于侵入，轻量持久化指示更符合 Offline-first 理念
2. 在 `offline-banner.component.ts` 中：
   - 修改 template 为一个小型持久化状态点（如右上角圆点/文字）
   - 离线时显示红色圆点 + "离线模式"
   - 在线时显示绿色圆点 + "已连接"（3 秒后淡出）
   - 队列冻结时显示橙色圆点 + "存储受限"
3. 修复 NEW-7：增加初始状态检测
   ```typescript
   ngOnInit() {
     // 首次加载时检测当前状态
     if (!navigator.onLine) {
       this.toast.info('当前处于离线模式', '数据将保存在本地，联网后自动同步');
     }
   }
   ```
4. 更新 E2E 断言，移除对不存在 banner 的误测

- **Files**:
  - `src/app/shared/components/offline-banner.component.ts` — 增加持久化状态指示器 + 首次离线检测
  - `src/styles.css` — 可能需要的全局样式（离线状态点定位）
- **Success**:
  - 离线时页面右上角（或合适位置）有持久化红色状态指示
  - 首次加载即离线时有 toast 通知
  - 组件行为与命名语义对齐
- **Research References**:
  - Research (Lines 76-83) — C1 验证结果
  - Research (Lines 138-141) — NEW-7 首次离线加载发现
- **Dependencies**:
  - 无前置依赖

## Phase 2: 耐久加固 — 同步队列韧性提升

### Task 2.1: ActionQueue 冻结期落盘恢复与逃生导出 [B1, P1]

ActionQueue 已有 IndexedDB 备份机制，但逃生模式仅提示用户"手动复制"，无自动导出入口。

**实现方案:**

1. **冻结期定时重试落盘**（新增）：
   ```typescript
   // 在 action-queue-storage.service.ts 中
   private startFrozenRetryTimer(): void {
     // 冻结后每 30s 重试一次 localStorage 写入
     // 成功则自动解冻，失败则指数退避（30s → 60s → 120s → max 5min）
     // 最多重试 10 次后停止，等待用户主动操作
   }
   ```
2. **逃生导出 JSON 入口**（新增）：
   ```typescript
   // 在 action-queue.service.ts 中
   exportPendingActionsAsJson(): string {
     const data = {
       exportedAt: new Date().toISOString(),
       pendingActions: this.pendingActions(),
       frozenState: this.queueFrozen(),
       metadata: { version: 1, source: 'action-queue-escape' }
     };
     return JSON.stringify(data, null, 2);
   }
   ```
3. **UI 导出入口**：在 sync-status 面板增加"导出待同步数据"按钮（仅冻结时显示）
4. **自动 Blob 下载**：点击后自动下载 `nanoflow-pending-sync-{timestamp}.json`
5. **storage_failure 状态可视化**：在 sync-status 面板显示"存储受限"警告

- **Files**:
  - `src/services/action-queue-storage.service.ts` — 加入冻结期定时重试逻辑
  - `src/services/action-queue.service.ts` — 加入 exportPendingActionsAsJson 方法
  - `src/app/shared/components/sync-status.component.ts` — 增加导出按钮与存储状态显示
  - `src/app/shared/components/sync-status.component.html` — 更新模板（如有单独模板）
- **Success**:
  - 冻结后 30s 开始自动重试落盘，存储恢复后自动解冻
  - 冻结期间 sync-status 面板显示"导出待同步数据"按钮
  - 点击后自动下载 JSON 文件（可用于手动恢复）
  - storage_failure 状态在 sync-status 面板有明确展示
- **Research References**:
  - Research (Lines 64-74) — B1 验证结果 + 补充发现（已有 IndexedDB 备份机制）
  - Master Plan (Section 4.2 B1) — 原始需求描述
- **Dependencies**:
  - Phase 1 完成

### Task 2.2: RetryQueue 上限前预警与降载 [B2, P1]

RetryQueue 绝对上限（localStorage=500, IndexedDB=5000）达到时直接 return false 拒绝入队。

**实现方案:**

1. **分层预警**（新增，在 `retry-queue.service.ts` 中）：
   ```typescript
   private checkQueueCapacity(): void {
     const usage = this.currentSize / this.absoluteLimit;
     if (usage >= 0.95) {
       this.toast.error('同步队列即将满载', '请尽快恢复网络连接');
       this.logger.error('RetryQueue at 95% capacity');
     } else if (usage >= 0.85) {
       this.toast.warning('同步队列接近上限', `已使用 ${Math.round(usage * 100)}%`);
     } else if (usage >= 0.70) {
       this.logger.warn(`RetryQueue at ${Math.round(usage * 100)}% capacity`);
     }
   }
   ```
2. **冗余更新合并**（优化入队逻辑）：
   - 同一任务的连续 update 操作合并为最后一次
   - 合并策略：相同 taskId + 相同操作类型 + 时间窗口内（5s）→ 合并
3. **拒绝入队事件埋点**（Sentry + 结构化日志）：
   ```typescript
   if (!enqueued) {
     this.logger.error('RetryQueue rejected operation', {
       queueSize: this.currentSize,
       absoluteLimit: this.absoluteLimit,
       operationType: action.type,
       taskId: action.taskId
     });
     this.sentryAlert.captureMessage('retry-queue-rejected', { level: 'error', extra: { ... } });
   }
   ```

- **Files**:
  - `src/app/core/services/sync/retry-queue.service.ts` — 分层预警 + 合并策略 + 埋点
  - `src/config/sync.config.ts` — 新增 RETRY_QUEUE_WARNING_THRESHOLDS 配置
- **Success**:
  - 70%/85%/95% 三级预警生效
  - 同一任务连续更新合并为一条（压测验证排队数量下降）
  - 拒绝入队事件有 Sentry 告警记录
- **Research References**:
  - Research (Lines 68-72) — B2 验证结果
  - Master Plan (Section 4.2 B2) — 原始需求描述
- **Dependencies**:
  - Phase 1 完成

### Task 2.3: 撤销 version-mismatch 用户感知 [NEW-4, P2]

版本差距过大时完全拒绝撤销，但无用户感知。

**实现方案:**

1. 在 `undo.service.ts:326-345` 中，当 `undo()` 返回 `'version-mismatch'` 时：
   ```typescript
   if (result === 'version-mismatch') {
     this.toast.warning(
       '无法撤销',
       '远端同步已更新数据，撤销历史已失效。请手动调整。'
     );
     // 清理已失效的撤销栈，避免重复提示
     this.clearInvalidEntries();
   }
   ```
2. 可选：在工具栏的撤销按钮上增加视觉反馈（如禁灰 + tooltip）

- **Files**:
  - `src/services/undo.service.ts` — 增加 version-mismatch 用户通知
- **Success**:
  - 撤销失败时用户收到明确 toast 提示
  - 无静默拒绝操作
- **Research References**:
  - Research (Lines 114-121) — NEW-4 发现详情
- **Dependencies**:
  - 无前置依赖

## Phase 3: 收敛与守护 — 可观测性 + 测试 + 门禁

### Task 3.1: 增加"数据安全状态面板"增强 [C2, P2]

sync-status 已有部分功能，仅需补充缺失项。

**实现方案:**

已有功能（sync-status.component.ts :43-450）：
- ✅ 在线/离线状态
- ✅ 同步中状态
- ✅ 队列冻结状态（红色展示）
- ✅ 失败项目数量
- ✅ 待同步数量

需要补充：
1. **最近成功云同步时间**：
   - 从 `SyncStateService` 获取 `lastSyncTime` signal
   - 显示格式：`最后同步: 2 分钟前` / `最后同步: 14:32:05`
2. **未持久化内存操作数量**：
   - 从 `ActionQueue` 获取冻结期间的内存操作数
   - 仅在 queueFrozen 时显示：`⚠️ ${count} 条操作仅在内存中`
3. **存储使用率**：
   - RetryQueue 使用百分比
   - 仅在 > 50% 时显示

- **Files**:
  - `src/app/shared/components/sync-status.component.ts` — 增加三项补充信息
- **Success**:
  - 面板显示最近成功同步时间
  - 冻结时显示内存中操作数量
  - 用户可主动判断"现在刷新是否安全"
- **Research References**:
  - Research (Lines 81-83) — sync-status 已有功能分析
  - Master Plan (Section 4.3 C2) — 原始需求
- **Dependencies**:
  - Task 2.1 完成（ActionQueue 导出能力）

### Task 3.2: 离线快照存储升级评估（localStorage → IDB）[B3, P2]

ProjectDataService 离线快照仍使用 localStorage，大项目可能超限。

**实现方案:**

1. **评估阶段**（不急于迁移）：
   - 统计当前离线快照平均大小（加入 logger）
   - 确认 localStorage 5MB 上限对大项目的影响
   - 测试 IndexedDB 写入大快照的耗时
2. **迁移设计**（如评估需要）：
   - 主存储切换到 IndexedDB（使用 idb-keyval）
   - localStorage 作为兜底（IDB 写入失败时回退）
   - 版本标记 + 校验和保护
   - 迁移脚本：读取 localStorage 旧快照 → 写入 IDB → 验证 → 清理旧数据
3. **双写灰度**：
   - Feature Flag `OFFLINE_SNAPSHOT_IDB_ENABLED` 控制
   - 灰度期间 localStorage + IDB 双写，读取 IDB 优先

- **Files**:
  - `src/app/core/services/sync/project-data.service.ts` — 迁移主存储逻辑
  - `src/config/feature-flags.config.ts` — 新增 OFFLINE_SNAPSHOT_IDB_ENABLED
- **Success**:
  - 评估报告输出（快照大小统计、IDB 耗时基准）
  - 如迁移：大项目快照稳定性提升，无 QuotaExceeded 错误
- **Research References**:
  - Research (Lines 73-74) — B3 验证结果
  - Master Plan (Section 4.2 B3) — 原始需求
- **Dependencies**:
  - Phase 2 完成

### Task 3.3: 首次离线加载通知 + Feature Flags 安全性校验 [NEW-7/NEW-8, P3]

**NEW-7 实现:**

在 `offline-banner.component.ts` 中（Task 1.5 已部分实现），确保首次加载时的离线检测：
- `ngOnInit` 或 `afterNextRender` 中检测 `navigator.onLine`
- 首次离线时发出通知

**NEW-8 实现:**

1. 在应用启动时（`app.component.ts` 或专门的初始化服务中）校验关键 Feature Flags：
   ```typescript
   private validateCriticalFlags(): void {
     const criticalFlags = [
       'CONNECTION_TOMBSTONE_ENABLED',
       'SYNC_DURABILITY_FIRST_ENABLED',
       'SYNC_STRICT_SUCCESS_ENABLED'
     ];
     for (const flag of criticalFlags) {
       if (!FEATURE_FLAGS[flag]) {
         this.logger.warn(`关键保护性 Flag 已禁用: ${flag}，数据安全可能受影响`);
         // 开发环境下 console.warn，生产环境 Sentry
       }
     }
   }
   ```

- **Files**:
  - `src/app/shared/components/offline-banner.component.ts` — 确认首次离线通知（承接 Task 1.5）
  - `src/config/feature-flags.config.ts` — 标注关键 flag + 添加校验函数
  - `src/app/app.component.ts` — 启动时调用 flag 校验
- **Success**:
  - 首次离线加载有明确通知
  - 关键保护性 Flag 被禁用时有日志警告 + Sentry 上报
- **Research References**:
  - Research (Lines 138-141) — NEW-7
  - Research (Lines 143-152) — NEW-8
- **Dependencies**:
  - Task 1.5 完成

### Task 3.4: 建立"摆件扫描"机制 [A3, P3]

扫描含 TODO 且绑定 click/output 的可视按钮，在 CI 中输出"占位交互清单"。

**实现方案:**

1. 创建脚本 `scripts/scan-placeholder-interactions.sh`：
   ```bash
   # 扫描 .html 中 (click)= 或 (output)= 绑定
   # 找到对应 .ts 中的方法实现
   # 检测方法体是否包含 TODO / 仅 toast / console.log
   # 输出"占位交互清单"
   ```
2. 在 CI pipeline 中增加该脚本执行步骤
3. 对用户可见入口设置 `feature flag + disabled reason`

- **Files**:
  - `scripts/scan-placeholder-interactions.sh` — 创建扫描脚本
  - CI 配置文件（如有）— 增加扫描步骤
- **Success**:
  - 脚本可检测出已知占位逻辑（saveToCloud 已修复则不再出现）
  - CI 报告中输出占位交互清单
  - 关键入口不再出现"可点击但无业务动作"
- **Research References**:
  - Master Plan (Section 4.1 A3) — 原始需求
- **Dependencies**:
  - Task 1.3 完成

### Task 3.5: 自动化测试覆盖与发布门禁 [D1+D2, P2]

覆盖本轮所有发现的风险路径。

**单元测试（Vitest）:**

1. **saveToCloud 测试** (`flow-view.component.spec.ts`)：
   - 成功路径：verify 网络请求 + toast.success
   - 失败路径：verify toast.error + 错误类型
   - 超时路径：verify 30s 后自动复位 + toast.warning
   - 离线路径：verify 不发请求 + toast.info

2. **isUploading 复位测试** (`flow-toolbar.component.spec.ts`)：
   - 成功后 isUploading === false
   - 失败后 isUploading === false
   - 超时后 isUploading === false

3. **onUserLogout 调用测试** (`app-auth-coordinator.service.spec.ts`)：
   - signOut 后 verify optimisticState.onUserLogout() called
   - signOut 后 verify undo.onUserLogout() called
   - signOut 后 verify attachment.onUserLogout() called

4. **queueFrozen 恢复测试** (`action-queue-storage.service.spec.ts`)：
   - 冻结后 30s 重试逻辑验证
   - 存储恢复后自动解冻验证
   - 导出 JSON 内容完整性验证

5. **RetryQueue 预警测试** (`retry-queue.service.spec.ts`)：
   - 70% → 仅日志
   - 85% → warning toast
   - 95% → error toast
   - 合并策略验证

6. **version-mismatch 通知测试** (`undo.service.spec.ts`)：
   - 撤销失败时 toast.warning 调用验证

**E2E 测试（Playwright）:**

7. **保存到云端 E2E** (`e2e/critical-paths.spec.ts` 扩展)：
   - 点击"保存到云端"应触发真实请求
   - 按钮状态正确复位

8. **离线编辑恢复**（`e2e/data-protection.spec.ts` 扩展）：
   - 离线编辑 → 恢复网络 → 数据一致性

9. **离线状态可见性** (`e2e/critical-paths.spec.ts` 扩展)：
   - 离线时状态指示器可见

**发布门禁:**

10. CI 配置中增加：
    - 上述测试全部通过
    - 占位扫描无新增项
    - 无新增"拒绝入队"高频告警

- **Files**:
  - `src/app/features/flow/components/flow-view.component.spec.ts` — saveToCloud 测试
  - `src/app/features/flow/components/flow-toolbar.component.spec.ts` — 复位测试
  - `src/app/core/services/app-auth-coordinator.service.spec.ts` — logout 测试
  - `src/services/action-queue-storage.service.spec.ts` — 冻结恢复测试
  - `src/app/core/services/sync/retry-queue.service.spec.ts` — 预警测试
  - `src/services/undo.service.spec.ts` — version-mismatch 测试
  - `e2e/critical-paths.spec.ts` — E2E 扩展
  - `e2e/data-protection.spec.ts` — E2E 扩展
- **Success**:
  - 所有新增单元测试通过 (`npm run test:run`)
  - E2E 测试通过 (`npm run test:e2e`)
  - CI 门禁配置生效
- **Research References**:
  - Master Plan (Section 4.4 D1+D2) — 原始需求
- **Dependencies**:
  - Phase 1 + Phase 2 完成

## Dependencies

- Angular 19.x Signals + 独立组件 + OnPush
- Supabase 客户端 SDK
- Vitest 4.0.x + Playwright 1.48+
- IndexedDB（idb-keyval）
- Result 模式（src/utils/result.ts）

## Success Criteria

- 所有 HIGH/P0 安全漏洞修复且有测试覆盖
- saveToCloud 真实业务链路可用
- 同步队列在极端压力下可观测、可恢复、可导出
- 用户可持续感知数据安全状态
- 自动化测试覆盖所有发现风险，CI 稳定通过
