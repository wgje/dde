<!-- markdownlint-disable-file -->

# Task Details: NanoFlow 代码库深度审查修复

## Research Reference

- .copilot-tracking/research/20260206-codebase-deep-review-research.md

## Phase 1: 低风险快赢 — 死代码清理与错误处理统一

### Task 1.1: 清理 task-operation.service.ts 中 8 处 @deprecated 标记及死代码

清理 `task-operation.service.ts` 中 6 处 `@deprecated` 方法（内部实现已迁移到 TaskTrashService）和 2 处 deprecated interface。

**具体位置**：
- Line 18: `@deprecated` interface `CreateTaskParams` → 使用 `TaskCreationService.CreateTaskParams`
- Line 30: `@deprecated` interface `MoveTaskParams` → 使用 `TaskMoveService.MoveTaskParams`
- Line 395: `@deprecated` method `moveToTrash()` → 已迁移到 TaskTrashService
- Line 411: `@deprecated` method `restoreFromTrash()` → 已迁移到 TaskTrashService
- Line 434: `@deprecated` method `emptyTrash()` → 已迁移到 TaskTrashService
- Line 442: `@deprecated` method `getTrashItems()` → 已迁移到 TaskTrashService
- Line 450: `@deprecated` method `permanentDelete()` → 已迁移到 TaskTrashService
- Line 458: `@deprecated` method `isInTrash()` → 已迁移到 TaskTrashService

**操作步骤**：
1. 使用 `npx knip` 或 `list_code_usages` 检查每个 deprecated 方法/interface 是否仍被外部引用
2. 无外部引用的直接删除
3. 仍有引用的：将调用方更新为使用新服务（TaskTrashService / TaskCreationService / TaskMoveService），然后删除
4. 删除对应的 deprecated interface 定义

- **Files**:
  - `src/services/task-operation.service.ts` - 删除 8 处 deprecated 代码
  - 调用方文件 - 更新引用到新服务
- **Success**:
  - `grep -c '@deprecated' src/services/task-operation.service.ts` 返回 0
  - 所有所有现有测试通过 `npm run test:run`
- **Research References**:
  - 研究报告 Lines 243-260 - @deprecated 详细位置列表
- **Dependencies**:
  - 无

### Task 1.2: 清理 task-operation-adapter.service.ts 中 8 处 @deprecated 代理方法

清理适配器中 8 处已有替代路径的 deprecated 代理方法。这些方法均为纯透传，无额外逻辑。

**具体位置**：
- Line 61: `@deprecated` property `get core()` → 调用方直接注入 TaskOperationService
- Line 141: `@deprecated` method `completeUnfinishedItem()` → 使用 `this.core.completeUnfinishedItem()`
- Line 155: `@deprecated` method `updateTaskPositionWithRankSync()` → 使用 `this.core.updateTaskPositionWithRankSync()`
- Line 285: `@deprecated` method `addTaskTag()` → 使用 `this.core.addTaskTag()`
- Line 292: `@deprecated` method `removeTaskTag()` → 使用 `this.core.removeTaskTag()`
- Line 1067: `@deprecated` method `addCrossTreeConnection()` → 使用 `connectionAdapter.addCrossTreeConnection()`
- Line 1074: `@deprecated` method `removeConnection()` → 使用 `connectionAdapter.removeConnection()`
- Line 1082: `@deprecated` method `relinkCrossTreeConnection()` → 使用 `connectionAdapter.relinkCrossTreeConnection()`
- Line 1095: `@deprecated` method `updateConnectionContent()` → 使用 `connectionAdapter.updateConnectionContent()`

**操作步骤**：
1. 使用 `list_code_usages` 检查每个 deprecated 方法的全部调用方
2. 将调用方从 `taskOpsAdapter.xxx()` 改为 `taskOpsAdapter.core.xxx()` 或直接注入目标服务
3. 删除 deprecated 代理方法
4. 此步骤同时减少文件行数（预计减少 ~80 行）

- **Files**:
  - `src/services/task-operation-adapter.service.ts` - 删除 8 处 deprecated 代理方法
  - 所有引用了这些方法的组件/服务文件 - 更新调用路径
- **Success**:
  - `grep -c '@deprecated' src/services/task-operation-adapter.service.ts` 返回 0
  - 文件行数减少约 80 行
  - 全部测试通过
- **Research References**:
  - 研究报告 Lines 243-260 - @deprecated 详细位置列表
- **Dependencies**:
  - Task 1.1 完成（避免同时修改 task-operation.service.ts 产生冲突）

### Task 1.3: 清理 sync-coordinator.service.ts、auth.guard.ts、flow-view-state.ts、supabase-types.ts 中 6 处 @deprecated

清理分散在 4 个文件中的剩余 @deprecated 标记。

**具体位置**：
- `src/services/sync-coordinator.service.ts:83` - `@deprecated` 属性，"使用 this.core 替代"
- `src/services/guards/auth.guard.ts:292` - `@deprecated` 旧 guard 函数，"已移除，请使用 requireAuthGuard"
- `src/services/guards/index.ts:4` - 注释说明 authGuard 已移除
- `src/models/flow-view-state.ts:148` - `@deprecated` 函数，"当前未被使用"
- `src/models/supabase-types.ts:99` - `@deprecated` v1 格式说明（仅注释，保留为文档）

**操作步骤**：
1. `sync-coordinator.service.ts`: 检查 `this.core` 的使用者，更新后删除 deprecated 属性
2. `auth.guard.ts`: 删除 deprecated 旧 guard 函数，确认 `requireAuthGuard` 已被路由使用
3. `flow-view-state.ts`: 删除未使用的 deprecated 函数
4. `supabase-types.ts`: 评估 — 此为自动生成文件的手动注释，可保留作为文档说明

- **Files**:
  - `src/services/sync-coordinator.service.ts` - 删除 deprecated 属性
  - `src/services/guards/auth.guard.ts` - 删除旧 guard
  - `src/services/guards/index.ts` - 清理导出
  - `src/models/flow-view-state.ts` - 删除未使用函数
- **Success**:
  - 除 supabase-types.ts 的文档注释外，`grep -rn '@deprecated' src` 返回 0
  - 路由仍正常工作
- **Research References**:
  - 研究报告 Lines 243-260
- **Dependencies**:
  - Task 1.1 和 1.2 完成

### Task 1.4: 修复 data-preloader.service.ts 中 3 处错误吞噬

`data-preloader.service.ts` 包含 3 处错误吞噬：2 处空 `.catch(function() {})` 和 1 处 `{ /* 忽略错误 */ }`。

**具体位置**：
- Line 130: `}).catch(function() {});` — 预加载 CSS 失败时静默吞噬
- Line 138: `}).catch(function() {});` — 预加载字体失败时静默吞噬
- 另有 `{ /* 忽略错误 */ }` 模式

**修复策略**：
- 预加载是非关键路径,失败不应阻塞用户。替换为 `logger.debug()` 记录失败而非完全静默
- 使用 `tryCatchAsync()` 包装,返回 Result 但仅记录日志

```typescript
// Before:
}).catch(function() {});

// After:
}).catch((error: unknown) => {
  this.logger.debug('预加载资源失败', { error });
});
```

- **Files**:
  - `src/services/data-preloader.service.ts` - 修复 3 处错误吞噬
- **Success**:
  - 无空 `.catch()` 或 `{ /* 忽略 */ }` 模式
  - 预加载失败时控制台有 debug 级别日志
- **Research References**:
  - 研究报告 Lines 166-179 - 错误吞噬违规列表
- **Dependencies**:
  - `src/services/logger.service.ts` 已可用

### Task 1.5: 修复 preference.service.ts、theme.service.ts、conflict-storage.service.ts 中 3 处 return null 吞噬

**具体位置**：
- `src/services/preference.service.ts` - 1 处 `catch { return null }`
- `src/services/theme.service.ts:173` - `catch { /* ignore */ }`（主题持久化读取）
- `src/services/theme.service.ts:246` - `catch (_error) { ... }`（主题应用）
- `src/services/conflict-storage.service.ts` - 1 处 `return null`

**修复策略**：

对于 `preference.service.ts` 和 `conflict-storage.service.ts`：
```typescript
// Before:
try {
  const data = await this.load();
  return data;
} catch {
  return null;
}

// After:
const result = await tryCatchAsync(() => this.load());
if (!result.ok) {
  this.logger.warn('加载偏好失败', { error: result.error });
  return null; // 降级为默认值是合理的，但需要记录
}
return result.value;
```

对于 `theme.service.ts`：
- Line 173: 主题读取失败应记录 warn 并使用默认主题
- Line 246: 主题应用失败应记录 error

- **Files**:
  - `src/services/preference.service.ts` - 添加日志记录
  - `src/services/theme.service.ts` - 2 处替换为 logger 记录
  - `src/services/conflict-storage.service.ts` - 添加日志记录
- **Success**:
  - 所有 catch 块包含有意义的日志记录
  - 功能行为不变（仍返回默认值）
- **Research References**:
  - 研究报告 Lines 166-179
- **Dependencies**:
  - LoggerService 已可用

### Task 1.6: 修复 export.service.ts、attachment.service.ts 中 4 处错误吞噬

**具体位置**：
- `src/services/export.service.ts` - 2 处 `// 忽略存储错误`
- `src/services/attachment.service.ts` - 2 处 `return null`

**修复策略**：

对于 `export.service.ts`：
```typescript
// Before:
try { ... } catch { /* 忽略存储错误 */ }

// After:
const result = await tryCatchAsync(() => ...);
if (!result.ok) {
  this.logger.warn('导出存储操作失败', { error: result.error });
}
```

对于 `attachment.service.ts`：
- 附件加载失败应返回 `Result<Attachment, AppError>` 而非裸 null
- 调用方需要处理 failure 分支

- **Files**:
  - `src/services/export.service.ts` - 替换 2 处错误吞噬
  - `src/services/attachment.service.ts` - 替换 2 处 return null
- **Success**:
  - 无 `// 忽略` 注释在 catch 块中
  - 附件加载失败有明确错误信息
- **Research References**:
  - 研究报告 Lines 166-179
- **Dependencies**:
  - `src/utils/result.ts` 中的 `tryCatchAsync` 已可用

### Task 1.7: 修复 migration/store-persistence/project-data/batch-sync/action-queue 中 6 处 return null 吞噬

**具体位置**：
- `src/services/migration.service.ts` - 2 处 `return null`
- `src/app/core/state/persistence/store-persistence.service.ts` (或 delta-sync 中) - 1 处 `return null`
- `src/app/core/services/sync/project-data.service.ts` - 1 处 `return null`
- `src/app/core/services/sync/batch-sync.service.ts` - 1 处 `return null`
- `src/services/action-queue.service.ts` - 1 处 `return null`

**修复策略**：
- 同步相关服务的错误吞噬影响数据完整性，必须替换为 Result 模式或至少 logger.error()
- migration.service.ts 的错误可能导致数据损坏，必须用 `failure()` 返回明确错误

```typescript
// migration.service.ts - Before:
try {
  await this.migrateV1ToV2();
} catch {
  return null;
}

// After:
const result = await tryCatchAsync(() => this.migrateV1ToV2());
if (!result.ok) {
  this.logger.error('数据迁移失败', { error: result.error });
  return failure(ErrorCodes.MIGRATION_FAILED, '数据迁移失败');
}
return success(result.value);
```

- **Files**:
  - `src/services/migration.service.ts` - 2 处替换
  - `src/app/core/state/persistence/store-persistence.service.ts` - 1 处替换
  - `src/app/core/services/sync/project-data.service.ts` - 1 处替换
  - `src/app/core/services/sync/batch-sync.service.ts` - 1 处替换
  - `src/services/action-queue.service.ts` - 1 处替换
- **Success**:
  - 所有同步/迁移路径无静默 null 返回
  - 错误有明确日志和 Result 包装
- **Research References**:
  - 研究报告 Lines 166-179
- **Dependencies**:
  - `src/utils/result.ts` 已可用

### Task 1.8: 修复 clock-sync/realtime-polling/user-preferences-sync 中 3 处错误吞噬

**具体位置**：
- `src/services/clock-sync.service.ts` - 1 处 `return null`（时钟同步请求失败）
- `src/app/core/services/sync/realtime-polling.service.ts:335` - `removeChannel().catch(() => {})`
- `src/app/core/services/sync/user-preferences-sync.service.ts:34` - `} catch {`

**修复策略**：
- `clock-sync.service.ts`: 时钟同步失败应记录 warn 并使用本地时间
- `realtime-polling.service.ts`: removeChannel 失败是预期场景（通道可能已移除），保留为日志记录
- `user-preferences-sync.service.ts`: 偏好同步失败应通知用户偏好可能未保存

```typescript
// realtime-polling.service.ts - Before:
client.removeChannel(this.realtimeChannel).catch(() => {});

// After:
client.removeChannel(this.realtimeChannel).catch((error: unknown) => {
  this.logger.debug('移除 Realtime 通道失败（可能已断开）', { error });
});
```

- **Files**:
  - `src/services/clock-sync.service.ts` - 添加 warn 日志
  - `src/app/core/services/sync/realtime-polling.service.ts` - 添加 debug 日志
  - `src/app/core/services/sync/user-preferences-sync.service.ts` - 添加 warn 日志
- **Success**:
  - 无空 catch 块
  - 同步失败有可追踪日志
- **Research References**:
  - 研究报告 Lines 166-179
- **Dependencies**:
  - LoggerService 已可用

### Task 1.9: 修复 flow-overview/flow-event/flow-touch 中 GoJS 相关错误吞噬

**具体位置**（flow-overview.service.ts 重灾区）：
- Line 660: `try { stopImmediatePropagation?.() } catch { /* ignore */ }`
- Line 661: `try { ev.stopPropagation() } catch { /* ignore */ }`
- Line 662: `try { preventDefault?.() } catch { /* ignore */ }`
- Line 675: `try { this.diagram.skipsUndoManager = true } catch { /* ignore */ }`
- Line 709: `try { this.diagram.skipsUndoManager = false } catch { /* ignore */ }`
- Line 739: 缩放操作 catch
- Line 761: `try { container.releasePointerCapture() } catch { /* ignore */ }`
- `flow-event.service.ts:587`: catch 块
- `flow-touch.service.ts:251`: `try { el.remove() } catch { /* ignore */ }`

**修复策略**：
- GoJS 事件处理中的防御性 try/catch 是**合理的**（浏览器兼容性、DOM 节点可能已移除）
- **不应替换为 Result 模式**，因为这些是 fire-and-forget 的防御性代码
- 将 `/* ignore */` 替换为 `logger.debug()` 以保留调试信息
- 对于 `releasePointerCapture` 和 DOM 操作，保持防御性模式但添加上下文日志

```typescript
// Before:
try { el.remove(); } catch { /* ignore */ }

// After:
try { el.remove(); } catch { /* GoJS DOM 清理：元素可能已被移除 */ }
```

- **Files**:
  - `src/app/features/flow/services/flow-overview.service.ts` - 7 处添加说明性注释或 debug 日志
  - `src/app/features/flow/services/flow-event.service.ts` - 1 处添加日志
  - `src/app/features/flow/services/flow-touch.service.ts` - 1 处添加说明性注释
- **Success**:
  - 所有 `/* ignore */` 替换为有意义的注释或 debug 日志
  - GoJS 功能不受影响
- **Research References**:
  - 研究报告 Lines 166-179
- **Dependencies**:
  - 无（GoJS 模块独立）

### Task 1.10: 修复 text-task-editor 和 sentry-alert 中 2 处错误吞噬

**具体位置**：
- `src/app/features/text/components/text-task-editor.component.ts:603` - catch 块
- `src/services/sentry-alert.service.ts:508` - catch 块

**修复策略**：
- `text-task-editor.component.ts`: 编辑器操作失败应 toast 通知用户
- `sentry-alert.service.ts`: Sentry 报告失败本身不应阻塞用户，但需要 console.error 作为最后手段

```typescript
// sentry-alert.service.ts - Sentry 自身报告失败是特殊情况
// 不能用 logger（logger 可能依赖 Sentry），使用 console.error 是合理的
try {
  Sentry.captureException(error);
} catch (sentryError) {
  console.error('Sentry 报告失败', sentryError);
}
```

- **Files**:
  - `src/app/features/text/components/text-task-editor.component.ts` - 添加 toast 通知
  - `src/services/sentry-alert.service.ts` - 确认是否已有 console.error，否则添加
- **Success**:
  - 编辑器失败有用户可见反馈
  - Sentry 失败有控制台日志
- **Research References**:
  - 研究报告 Lines 166-179
- **Dependencies**:
  - ToastService 已可用

## Phase 2: O(n) 线性搜索优化与构建配置修复

### Task 2.1: 替换 flow-view.component.ts 中线性搜索

**具体位置**：
`flow-view.component.ts` 中存在 `projectState.tasks().find(t => t.id === id)` 模式。

**替换策略**：
```typescript
// Before:
const task = this.projectState.tasks().find(t => t.id === taskId);

// After:
const task = this.taskStore.getTask(taskId);
```

**前提**：确认 `TaskStore` 已有 `getTask(id): Task | undefined` 方法（基于 `tasksMap` 的 O(1) 查找）。

**操作步骤**：
1. 搜索文件中所有 `.find(t => t.id` 或 `.find(task => task.id` 模式
2. 确认每处的数据源（是 `projectState.tasks()` 还是其他数组）
3. 对于来自 Store 的数据，替换为 `taskStore.getTask(id)`
4. 对于来自本地数组的（如函数参数），保留 .find() 但考虑是否可改用 Map

- **Files**:
  - `src/app/features/flow/components/flow-view.component.ts` - 替换线性搜索为 O(1)
- **Success**:
  - `grep -c '\.find.*\.id' src/app/features/flow/components/flow-view.component.ts` 显著减少
  - 流程图视图功能正常
- **Research References**:
  - 研究报告 Lines 201-211 - O(n) 线性搜索分析
- **Dependencies**:
  - `TaskStore.getTask(id)` 方法存在且功能正确

### Task 2.2: 替换 text-view.component.ts 中 8+ 处线性搜索

`text-view.component.ts` 是线性搜索最密集的文件，至少 8 处。

**操作步骤**：
1. 全文搜索 `.find(` 调用
2. 分类：任务查找、连接查找、项目查找
3. 批量替换：
   - 任务查找 → `taskStore.getTask(id)`
   - 连接查找 → `connectionStore.getConnection(id)`
4. 逐一替换并运行相关测试

- **Files**:
  - `src/app/features/text/components/text-view.component.ts` - 替换 8+ 处
- **Success**:
  - `.find()` 调用中无 ID 查找模式
  - 文本视图所有功能正常
- **Research References**:
  - 研究报告 Lines 201-211
- **Dependencies**:
  - Task 2.1 完成（建立替换模式）

### Task 2.3: 替换 task-operation.service.ts 中线性搜索

**具体模式**：
```typescript
// 常见于：
const task = project.tasks.find(t => t.id === taskId);
```

**注意**：`project.tasks` 是从 Store 构建的临时数组。应评估是否可以绕过 `project.tasks` 直接使用 Store 的 Map 查找。

**操作步骤**：
1. 检查 `project.tasks` 的来源 — 是否每次调用都从 Store 重建
2. 如果是，直接使用 `taskStore.getTask(taskId)` 替代
3. 如果 `project.tasks` 是计算属性或有过滤逻辑，需保留但预建 Map

- **Files**:
  - `src/services/task-operation.service.ts` - 替换线性搜索
- **Success**:
  - 任务操作的 ID 查找为 O(1)
- **Research References**:
  - 研究报告 Lines 201-211
- **Dependencies**:
  - TaskStore API 已验证

### Task 2.4: 替换 conflict-resolution.service.ts 中线性搜索

冲突解决服务在合并路径中多处使用线性搜索。

**操作步骤**：
1. 搜索所有 `.find()` 调用
2. 冲突解决时可能处理来自远程的任务列表（非 Store 数据），此时需要先建 Map 再查找
3. 对于远程数据批量处理，创建临时 `Map<string, Task>` 后使用 `.get(id)`

```typescript
// Before:
const remoteTask = remoteTasks.find(t => t.id === localTask.id);

// After:
const remoteTaskMap = new Map(remoteTasks.map(t => [t.id, t]));
const remoteTask = remoteTaskMap.get(localTask.id);
```

- **Files**:
  - `src/services/conflict-resolution.service.ts` - 替换线性搜索
- **Success**:
  - 冲突解决批量操作使用 Map 查找
  - 冲突解决功能正常
- **Research References**:
  - 研究报告 Lines 201-211
- **Dependencies**:
  - 无

### Task 2.5: 批量扫描并替换其余高频 .find(t => t.id) 路径

**操作步骤**：
1. 运行 `grep -rn '\.find.*\.id ===' src --include='*.ts' | grep -v '.spec.ts'` 获取完整列表
2. 按文件分组，优先处理高频文件
3. 逐文件替换，每个文件替换后运行测试
4. 记录无法替换的位置（如回调中无法访问 Store 的场景）

**预期影响的文件**：
- `src/services/task-move.service.ts`
- `src/services/task-attribute.service.ts`
- `src/services/task-connection.service.ts`
- `src/services/subtree-operations.service.ts`
- `src/services/undo.service.ts`
- `src/app/core/services/sync/task-sync-operations.service.ts`
- 其他散布文件

- **Files**:
  - 多个服务和组件文件 - 按需替换
- **Success**:
  - `grep -c '\.find.*\.id ===' src` 统计减少 80% 以上
  - 所有测试通过
- **Research References**:
  - 研究报告 Lines 201-211
- **Dependencies**:
  - Task 2.1-2.4 建立的模式

### Task 2.6: 移除 4 处 JSON.stringify 深比较

**具体位置**（需 grep 确认）：
- `src/services/task-operation-adapter.service.ts` 中变更检测路径
- 可能在 `change-tracker.service.ts` 中

**替换策略**：
```typescript
// Before:
if (JSON.stringify(oldTask) !== JSON.stringify(newTask)) { ... }

// After:
if (hasTaskChanged(oldTask, newTask)) { ... }

function hasTaskChanged(a: Task, b: Task): boolean {
  return a.title !== b.title
    || a.content !== b.content
    || a.stage !== b.stage
    || a.parentId !== b.parentId
    || a.order !== b.order
    || a.rank !== b.rank
    || a.status !== b.status
    || a.x !== b.x
    || a.y !== b.y;
}
```

- **Files**:
  - 包含 `JSON.stringify` 比较的文件 - 替换为字段级比较函数
  - `src/utils/` - 可选：创建通用 `hasChanged()` 工具函数
- **Success**:
  - `grep -c 'JSON.stringify' src` 中用于比较的数为 0
  - 变更检测功能正常
- **Research References**:
  - 研究报告 Lines 215-216
- **Dependencies**:
  - 无

### Task 2.7: 在 CI 构建中恢复 NG_BUILD_TYPE_CHECK=1

**当前状态**：
所有 4 个构建脚本（start, build, build:strict, build:dev）均设置 `NG_BUILD_TYPE_CHECK=0`。

**操作步骤**：
1. 先在本地尝试 `NG_BUILD_TYPE_CHECK=1` 构建，收集类型错误列表
2. 修复发现的类型错误（预期不多，因为 IDE 已有 strict mode）
3. 更新 `package.json` 中 `build:strict` 脚本为 `NG_BUILD_TYPE_CHECK=1`
4. 保留 `start` 和 `build:dev` 为 `NG_BUILD_TYPE_CHECK=0`（开发体验）
5. 评估 `NG_BUILD_MAX_WORKERS` 是否可以增加到 2（减少构建时间）

```json
// package.json - 仅修改 build:strict
"build:strict": "... NG_BUILD_TYPE_CHECK=1 ..."
```

**风险评估**：
- `NG_BUILD_TYPE_CHECK=0` 可能是因为某些类型错误当前无法修复
- 如果遇到重大类型错误阻塞，记录并创建单独的修复任务
- 不要为了通过构建而添加 `@ts-ignore`

- **Files**:
  - `package.json` - 修改 build:strict 脚本
  - 类型错误文件 - 修复发现的问题
- **Success**:
  - `npm run build:strict` 在 `NG_BUILD_TYPE_CHECK=1` 下通过
  - 无新增 `@ts-ignore` 或 `as any`
- **Research References**:
  - 研究报告 Lines 218-228 - 构建配置矛盾分析
- **Dependencies**:
  - Phase 1 完成（避免类型错误来自待删除的代码）

## Phase 3: 大文件拆分 — 核心组件与服务

### Task 3.1: 拆分 app.component.ts（1475 行）

**当前职责分析**（25 个 inject() 依赖）：
1. **模态框协调**（~300 行）：10+ 个模态框的打开/关闭/数据传递
2. **搜索管理**（~100 行）：searchResults, filteredProjects, 搜索方法
3. **认证协调**（~150 行）：authEmail, authPassword, authError, 登录/注册/重置
4. **项目管理**（~200 行）：项目 CRUD、切换、删除确认
5. **Service Worker 更新**（~80 行）：swUpdate 处理
6. **手势处理**（~50 行）：水平滑动视图切换
7. **初始化**（~100 行）：ngOnInit 中的会话检查、数据加载
8. **模板 getter**（~100 行）：暴露给 HTML 的 computed 属性

**拆分方案**：

| 新文件 | 职责 | 预计行数 |
|--------|------|----------|
| `src/app/core/services/app-modal-coordinator.service.ts` | 模态框开关、数据传递、懒加载协调 | ~250 |
| `src/app/core/services/app-auth-coordinator.service.ts` | 认证相关状态和方法（login/register/reset） | ~150 |
| `src/app/core/services/app-init.service.ts` | 应用初始化、会话检查、SW 更新 | ~120 |
| `src/app.component.ts` | 保留模板绑定、手势、项目管理 | ~500 |

**操作步骤**：
1. 创建 `app-modal-coordinator.service.ts`，提取所有模态框相关的 signal/computed/方法
2. 创建 `app-auth-coordinator.service.ts`，提取认证相关状态和方法
3. 创建 `app-init.service.ts`，提取 ngOnInit 中的初始化逻辑
4. `app.component.ts` 注入这三个服务，保留模板绑定和委托调用
5. 更新 `app.component.html` 中的绑定（如有必要）
6. 运行所有测试确认无回归

- **Files**:
  - `src/app/core/services/app-modal-coordinator.service.ts` - 新建
  - `src/app/core/services/app-auth-coordinator.service.ts` - 新建
  - `src/app/core/services/app-init.service.ts` - 新建
  - `src/app.component.ts` - 精简至 ~500 行
  - `src/app.component.html` - 可能需更新绑定
- **Success**:
  - `app.component.ts` ≤ 800 行（目标 ≤ 500 行）
  - 所有模态框功能正常
  - 认证流程正常
  - 应用初始化正常
- **Research References**:
  - 研究报告 Lines 46-57 - app.component.ts 根因分析
- **Dependencies**:
  - Phase 1 完成（@deprecated 代码已清理）

### Task 3.2: 拆分 task-operation-adapter.service.ts（1423 行）

**当前职责分析**：
1. 21 个纯代理方法（Phase 1 已删除 8 个 @deprecated 的，剩余 ~13 个）
2. 回调桥接（setCallbacks 链到 6 个子服务）
3. 记录与撤销协调（64 处 recordAndUpdate）
4. 连接操作代理

**拆分方案**：

| 新文件 | 职责 | 预计行数 |
|--------|------|----------|
| `src/services/task-callback-bridge.service.ts` | setCallbacks 链和 recordAndUpdate 回调 | ~200 |
| `src/services/task-operation-adapter.service.ts` | 精简后的适配器：核心 CRUD + 撤销 | ~600 |

**操作步骤**：
1. Phase 1 删除 deprecated 方法后评估剩余行数
2. 提取 setCallbacks 初始化和回调注册到 `task-callback-bridge.service.ts`
3. 评估剩余代理方法是否可直接让调用方注入目标服务
4. 保留核心 CRUD 适配和撤销协调在主文件中

- **Files**:
  - `src/services/task-callback-bridge.service.ts` - 新建
  - `src/services/task-operation-adapter.service.ts` - 精简
- **Success**:
  - 文件 ≤ 800 行
  - 回调注册逻辑隔离到专门服务
  - 所有任务操作正常
- **Research References**:
  - 研究报告 Lines 46-57, 83-107
- **Dependencies**:
  - Task 1.2 完成（deprecated 代理方法已清理）

### Task 3.3: 拆分 action-queue.service.ts（1376 行）

**当前职责分析**：
1. 操作队列 CRUD（~300 行）
2. IndexedDB 备份/恢复（~300 行）
3. 死信队列管理（~200 行）
4. 处理器注册和执行（~300 行）
5. 批量操作和去重（~200 行）

**拆分方案**：

| 新文件 | 职责 | 预计行数 |
|--------|------|----------|
| `src/services/action-queue-storage.service.ts` | IndexedDB 备份/恢复、死信队列 | ~350 |
| `src/services/action-queue-processor.service.ts` | 处理器注册和执行（可能已有 action-queue-processors.service.ts） | ~250 |
| `src/services/action-queue.service.ts` | 核心队列 CRUD + 批量去重 | ~500 |

**注意**：已有 `action-queue-processors.service.ts`，需评估其职责是否与上述拆分重叠。

- **Files**:
  - `src/services/action-queue-storage.service.ts` - 新建
  - `src/services/action-queue.service.ts` - 精简
- **Success**:
  - 文件 ≤ 800 行
  - 离线操作队列功能完整
- **Research References**:
  - 研究报告 Lines 46-57
- **Dependencies**:
  - Task 1.7 完成（action-queue 错误吞噬已修复）

### Task 3.4: 拆分 task-repository.service.ts（1198 行）

**拆分方案**：按操作类型分离 —— 读取 vs 写入 vs 批量操作。

| 新文件 | 职责 | 预计行数 |
|--------|------|----------|
| `src/services/task-repository-read.service.ts` | 查询、搜索、过滤 | ~300 |
| `src/services/task-repository-batch.service.ts` | 批量创建/更新/删除 | ~300 |
| `src/services/task-repository.service.ts` | 单条 CRUD + 协调 | ~500 |

- **Files**:
  - `src/services/task-repository-read.service.ts` - 新建
  - `src/services/task-repository-batch.service.ts` - 新建
  - `src/services/task-repository.service.ts` - 精简
- **Success**:
  - 文件 ≤ 800 行
  - 所有 Supabase 持久化操作正常
- **Research References**:
  - 研究报告 Lines 46-57
- **Dependencies**:
  - 无

### Task 3.5: 拆分 text-view.component.ts（1162 行）

**拆分方案**：提取阶段管理和任务操作逻辑到服务。

| 新文件 | 职责 | 预计行数 |
|--------|------|----------|
| `src/app/features/text/services/text-view-stage.service.ts` | 阶段列表管理、排序、过滤 | ~250 |
| `src/app/features/text/services/text-view-task-ops.service.ts` | 任务创建/编辑/删除的 UI 逻辑 | ~250 |
| `src/app/features/text/components/text-view.component.ts` | 组件模板绑定 + 生命周期 | ~600 |

- **Files**:
  - `src/app/features/text/services/text-view-stage.service.ts` - 新建
  - `src/app/features/text/services/text-view-task-ops.service.ts` - 新建
  - `src/app/features/text/components/text-view.component.ts` - 精简
- **Success**:
  - 文件 ≤ 800 行
  - 文本视图所有功能正常
- **Research References**:
  - 研究报告 Lines 46-57
- **Dependencies**:
  - Task 2.2 完成（线性搜索已优化）

### Task 3.6: 拆分 flow-task-detail.component.ts（1147 行）

**拆分方案**：提取附件管理和表单验证。

| 新文件 | 职责 | 预计行数 |
|--------|------|----------|
| `src/app/features/flow/services/flow-task-detail-attachment.service.ts` | 附件上传/删除/预览 | ~250 |
| `src/app/features/flow/services/flow-task-detail-form.service.ts` | 表单状态管理和验证 | ~200 |
| `src/app/features/flow/components/flow-task-detail.component.ts` | 组件绑定 | ~600 |

- **Files**:
  - `src/app/features/flow/services/flow-task-detail-attachment.service.ts` - 新建
  - `src/app/features/flow/services/flow-task-detail-form.service.ts` - 新建
  - `src/app/features/flow/components/flow-task-detail.component.ts` - 精简
- **Success**:
  - 文件 ≤ 800 行
  - 任务详情面板所有功能正常
- **Research References**:
  - 研究报告 Lines 46-57
- **Dependencies**:
  - 无

### Task 3.7: 拆分 GoJS 四大服务

4 个 GoJS 服务均超 1000 行：
- `flow-template.service.ts` (1169)
- `flow-link.service.ts` (1123)
- `flow-diagram.service.ts` (1098)
- `flow-view.component.ts` (1037)

**拆分方案**：

| 原文件 | 拆分方向 | 新文件 |
|--------|----------|--------|
| `flow-template.service.ts` | 节点模板 vs 链接模板 | `flow-node-template.service.ts` + `flow-link-template.service.ts` |
| `flow-link.service.ts` | 链接 CRUD vs 链接验证 | `flow-link-validation.service.ts` |
| `flow-diagram.service.ts` | 图表初始化 vs 数据同步 | `flow-diagram-data.service.ts` |
| `flow-view.component.ts` | 提取工具栏/面板逻辑到子组件 | 已有子组件，精简主组件 |

- **Files**:
  - `src/app/features/flow/services/flow-node-template.service.ts` - 新建
  - `src/app/features/flow/services/flow-link-template.service.ts` - 新建
  - `src/app/features/flow/services/flow-link-validation.service.ts` - 新建
  - `src/app/features/flow/services/flow-diagram-data.service.ts` - 新建
  - 原 4 个文件 - 精简
- **Success**:
  - 所有 GoJS 服务 ≤ 800 行
  - 流程图渲染、链接、模板功能正常
- **Research References**:
  - 研究报告 Lines 46-57
- **Dependencies**:
  - GoJS 模块相对独立，可并行拆分

### Task 3.8: 拆分同步层三大服务

- `conflict-resolution.service.ts` (1036)
- `simple-sync.service.ts` (1032)
- `migration.service.ts` (1018)

**拆分方案**：

| 原文件 | 拆分方向 | 新文件 |
|--------|----------|--------|
| `conflict-resolution.service.ts` | 冲突检测 vs 冲突合并 | `conflict-detection.service.ts` |
| `simple-sync.service.ts` | 已有 10 个子服务，评估是否可进一步委托 | 精简主协调器 |
| `migration.service.ts` | 按版本拆分迁移脚本 | `migration-v1-to-v2.service.ts` |

- **Files**:
  - `src/services/conflict-detection.service.ts` - 新建
  - `src/services/migration-v1-to-v2.service.ts` - 新建
  - 原文件 - 精简至 ≤ 800 行
- **Success**:
  - 文件 ≤ 800 行
  - 同步、冲突解决、迁移功能正常
- **Research References**:
  - 研究报告 Lines 46-57, 63-107
- **Dependencies**:
  - Task 1.7 完成（同步层错误吞噬已修复）

### Task 3.9: 拆分 9 个边界文件（800-902 行）

这 9 个文件轻微超标（仅超出 2%-13%），拆分优先级最低：

| 文件 | 行数 | 拆分策略 |
|------|------|----------|
| `dashboard-modal.component.ts` (902) | 提取统计计算逻辑 | `dashboard-stats.service.ts` |
| `change-tracker.service.ts` (899) | 提取 diff 计算 | `change-diff.service.ts` |
| `user-session.service.ts` (895) | 提取 token 管理 | `token-manager.service.ts` |
| `flow-overview.service.ts` (887) | 提取手势处理 | 已有 gesture 工具函数 |
| `task-sync-operations.service.ts` (872) | 提取批量操作 | 评估是否可委托给 batch-sync |
| `minimap-math.service.ts` (869) | 纯函数，提取为工具文件 | `src/utils/minimap-math.ts` |
| `undo.service.ts` (829) | 提取历史栈管理 | `undo-history.service.ts` |
| `text-view-drag-drop.service.ts` (829) | 精简：删除注释/空行 | 评估实际逻辑行数 |
| `attachment-export.service.ts` (818) | 提取文件格式处理 | 评估是否值得拆分 |

**操作策略**：部分文件可能通过删除冗余注释/空行降至 800 行以内，无需拆分。先评估每个文件的实际逻辑密度。

- **Files**:
  - 上述 9 个文件 - 评估后按需拆分或精简
- **Success**:
  - 所有文件 ≤ 800 行
- **Research References**:
  - 研究报告 Lines 46-57
- **Dependencies**:
  - Phase 1+2 完成（相关代码已优化）

## Phase 4: 测试覆盖率提升

### Task 4.1: 为 task-move.service.ts（734 行）补齐单元测试

**测试重点**：
- 跨阶段移动任务
- 同阶段重排序
- 跨父节点移动（子树操作）
- 边界条件：移动到空阶段、移动根节点、移动到自身子节点（循环检测）

**测试模式**：
```typescript
describe('TaskMoveService', () => {
  let service: TaskMoveService;
  let taskStore: TaskStore;
  // ... mock 依赖

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        TaskMoveService,
        // ... provide mock services
      ]
    });
    service = TestBed.inject(TaskMoveService);
  });

  describe('moveTask', () => {
    it('should move task to different stage', () => { ... });
    it('should reorder within same stage', () => { ... });
    it('should prevent circular parent reference', () => { ... });
    it('should update child tasks when parent moves', () => { ... });
  });
});
```

- **Files**:
  - `src/services/task-move.service.spec.ts` - 新建
- **Success**:
  - 测试覆盖核心移动场景
  - `npm run test:run -- --reporter=verbose task-move` 通过
- **Research References**:
  - 研究报告 Lines 132-160
- **Dependencies**:
  - 无

### Task 4.2: 为 task-creation.service.ts 和 subtree-operations.service.ts 补齐测试

**task-creation.service.ts（268 行）测试重点**：
- 创建根任务
- 创建子任务（指定 parentId）
- 创建时自动生成 UUID
- 创建时自动生成 shortId
- 创建时设置默认值

**subtree-operations.service.ts（430 行）测试重点**：
- 获取子树所有后代
- 深度限制（MAX_SUBTREE_DEPTH = 100）
- 子树移动
- 子树删除（级联）

- **Files**:
  - `src/services/task-creation.service.spec.ts` - 新建
  - `src/services/subtree-operations.service.spec.ts` - 新建
- **Success**:
  - 所有测试通过
  - 覆盖核心创建和子树操作场景
- **Research References**:
  - 研究报告 Lines 132-160
- **Dependencies**:
  - 无

### Task 4.3: 为 user-session.service.ts（895 行）补齐测试

**测试重点**：
- 会话初始化
- Token 刷新
- 会话过期处理
- 多标签页会话同步

- **Files**:
  - `src/services/user-session.service.spec.ts` - 新建
- **Success**:
  - 覆盖认证核心流程
  - mock Supabase Auth API
- **Research References**:
  - 研究报告 Lines 132-160
- **Dependencies**:
  - 无

### Task 4.4: 为 layout.service.ts 和 local-backup.service.ts 补齐测试

**layout.service.ts（784 行）测试重点**：
- 布局计算算法
- 响应式断点
- 视图切换

**local-backup.service.ts（742 行）测试重点**：
- 备份创建
- 备份恢复
- 备份清理（过期删除）
- IndexedDB 交互

- **Files**:
  - `src/services/layout.service.spec.ts` - 新建
  - `src/services/local-backup.service.spec.ts` - 新建
- **Success**:
  - 布局计算和备份流程有测试覆盖
- **Research References**:
  - 研究报告 Lines 132-160
- **Dependencies**:
  - 无

### Task 4.5: 为 migration.service.ts 和 attachment.service.ts 补齐测试

**migration.service.ts（1018 行）测试重点**：
- V1 到 V2 数据迁移
- 迁移前验证
- 迁移失败回滚
- 增量迁移

**attachment.service.ts（705 行）测试重点**：
- 附件上传（含类型验证）
- 附件删除（软删除）
- 签名 URL 生成和刷新
- 文件大小限制

- **Files**:
  - `src/services/migration.service.spec.ts` - 新建
  - `src/services/attachment.service.spec.ts` - 新建
- **Success**:
  - 迁移和附件核心路径有测试
- **Research References**:
  - 研究报告 Lines 132-160
- **Dependencies**:
  - Task 1.6, 1.7 完成（错误处理已统一）

### Task 4.6: 为 virus-scan.service.ts 和 clock-sync.service.ts 补齐测试

**virus-scan.service.ts（649 行）测试重点**：
- 扫描请求发送
- 扫描结果处理
- 超时处理
- 文件类型过滤

**clock-sync.service.ts（520 行）测试重点**：
- 时钟偏移计算
- 同步间隔管理
- 离线时钟处理

- **Files**:
  - `src/services/virus-scan.service.spec.ts` - 新建
  - `src/services/clock-sync.service.spec.ts` - 新建
- **Success**:
  - 安全和同步辅助服务有测试覆盖
- **Research References**:
  - 研究报告 Lines 132-160
- **Dependencies**:
  - Task 1.8 完成

### Task 4.7: 为 5 个中优先级服务补齐测试

为以下服务补齐测试：
- `logger.service.ts` (299 行) - 日志分级、分类、输出格式
- `preference.service.ts` (223 行) - 偏好读写、默认值
- `event-bus.service.ts` (213 行) - 事件发布/订阅、类型安全
- `connection-adapter.service.ts` (185 行) - 连接 CRUD 适配
- `supabase-client.service.ts` (182 行) - 客户端初始化、超时配置

- **Files**:
  - `src/services/logger.service.spec.ts` - 新建
  - `src/services/preference.service.spec.ts` - 新建
  - `src/services/event-bus.service.spec.ts` - 新建
  - `src/services/connection-adapter.service.spec.ts` - 新建
  - `src/services/supabase-client.service.spec.ts` - 新建
- **Success**:
  - 5 个服务均有测试
  - 服务测试覆盖率达到 70%+
- **Research References**:
  - 研究报告 Lines 132-160
- **Dependencies**:
  - Task 1.5 完成（preference/theme 错误处理已修复）

### Task 4.8: 消除测试中 116 处 as any 访问私有成员

**问题**：116 处 `(service as any).privateMethod` 导致测试与实现深度耦合。

**修复策略**：
1. 通过公共 API 间接测试私有逻辑
2. 将需要测试的私有方法提取为 `protected` 或独立工具函数
3. 使用 Vitest 的 spy 功能替代直接访问

```typescript
// Before:
(service as any).processQueue();

// After - 方案A：通过公共 API 触发
service.enqueue(action);
await service.flush();

// After - 方案B：提取为public/protected
service.processQueue(); // 改为 public
```

**操作步骤**：
1. `grep -rn 'as any' src --include='*.spec.ts'` 列出所有 116 处
2. 按文件分组，优先处理高频文件
3. 逐个评估是否可通过公共 API 测试
4. 无法通过公共 API 的，评估是否应提取为独立函数

- **Files**:
  - 所有 `.spec.ts` 文件 - 逐步替换
- **Success**:
  - `grep -c 'as any' src/**/*.spec.ts` ≤ 50
  - 所有测试通过
- **Research References**:
  - 研究报告 Lines 160-162
- **Dependencies**:
  - Phase 3 完成（文件拆分可能已暴露/提取了部分私有方法）

## Phase 5: 架构级优化 — 回调模式消除与安全修复

### Task 5.1: 消除 TaskOperationService 的 setCallbacks 回调模式

**当前回调链**：
```
TaskOperationAdapterService.constructor()
  → TaskOperationService.setCallbacks()
    → TaskTrashService.setCallbacks()
    → TaskCreationService.setCallbacks()
    → TaskMoveService.setCallbacks()
    → TaskAttributeService.setCallbacks()
    → TaskConnectionService.setCallbacks()
```

**问题**：子服务通过 setCallbacks 接收回调 → 所有跨服务调用都是间接的 → 调试困难、类型不安全。

**替换策略：直接 DI**

1. 分析回调内容 — 通常是 `recordAndUpdate()` 和 `getActiveProject()` 等共享方法
2. 将这些共享方法提取到 `ProjectStateService` 或已有的 Store 服务
3. 子服务直接注入 `ProjectStateService`，不再需要回调

```typescript
// Before (TaskCreationService):
private callbacks?: TaskCallbacks;
setCallbacks(cb: TaskCallbacks) { this.callbacks = cb; }
createTask() {
  this.callbacks?.recordAndUpdate(task);
}

// After (TaskCreationService):
private projectState = inject(ProjectStateService);
createTask() {
  this.projectState.recordAndUpdate(task);
}
```

**注意循环依赖**：回调模式的存在可能正是为了避免循环 DI。需要检查：
- `TaskOperationService` → `TaskCreationService` (has)
- `TaskCreationService` → `ProjectStateService` (will inject)
- `ProjectStateService` → `TaskOperationService` (check if exists - would cause circular)

如果存在循环依赖，使用 `forwardRef()` 或重构依赖图。

- **Files**:
  - `src/services/task-operation.service.ts` - 移除 setCallbacks
  - `src/services/task-creation.service.ts` - 直接注入 ProjectStateService
  - `src/services/task-move.service.ts` - 直接注入
  - `src/services/task-attribute.service.ts` - 直接注入
  - `src/services/task-connection.service.ts` - 直接注入
  - `src/services/task-trash.service.ts` - 直接注入
- **Success**:
  - 0 处 setCallbacks 在 task-operation 链中
  - 所有任务操作功能正常
  - 无循环依赖错误
- **Research References**:
  - 研究报告 Lines 83-107 - 回调模式分析
- **Dependencies**:
  - Phase 3 Task 3.2 完成（adapter 已拆分）
  - Phase 4 Task 4.1-4.2 完成（有测试覆盖保障）

### Task 5.2: 消除 SimpleSyncService 的 setCallbacks 回调模式

**当前回调链**：
```
SimpleSyncService.constructor()
  → BatchSyncService.setCallbacks()
  → TaskSyncOperationsService.setCallbacks()
  → ConnectionSyncOperationsService.setCallbacks()
```

**替换策略**：同 Task 5.1，将回调内容提取为可注入的服务方法。

**额外注意**：
- SimpleSyncService 有 17 个依赖，添加直接注入需检查是否会使构造函数更加臃肿
- 评估是否应通过 Signal 事件（而非回调或 DI）实现跨服务通信

- **Files**:
  - `src/app/core/services/simple-sync.service.ts` - 移除 setCallbacks
  - `src/app/core/services/sync/batch-sync.service.ts` - 直接注入
  - `src/app/core/services/sync/task-sync-operations.service.ts` - 直接注入
  - `src/app/core/services/sync/connection-sync-operations.service.ts` - 直接注入
- **Success**:
  - 0 处 setCallbacks 在同步链中
  - 同步功能正常
- **Research References**:
  - 研究报告 Lines 83-107
- **Dependencies**:
  - Task 5.1 完成（建立模式）

### Task 5.3: 修复 supabase-client.service.ts Navigator Lock 被禁用的安全隐患

**当前代码**（Line 77-81）：
```typescript
lock: async <T>(_name: string, _acquireTimeout: number, fn: () => Promise<T>): Promise<T> => {
    return await fn();
}
```

完全绕过了 Supabase Auth 的 Navigator Lock，多标签页 token 刷新会竞争。

**修复策略**：

方案 A — 恢复 Navigator Lock：
```typescript
lock: navigator.locks
  ? async <T>(name: string, acquireTimeout: number, fn: () => Promise<T>): Promise<T> => {
      return await navigator.locks.request(name, { mode: 'exclusive' }, fn);
    }
  : async <T>(_name: string, _acquireTimeout: number, fn: () => Promise<T>): Promise<T> => {
      return await fn(); // fallback for browsers without navigator.locks
    }
```

方案 B — 使用 BroadcastChannel 协调：
- 如果 Navigator Lock 导致死锁（这可能是当初禁用的原因），使用 BroadcastChannel 做软协调

**操作步骤**：
1. 查找 Git 历史中禁用 Lock 的 commit message，了解原因
2. 在支持 navigator.locks 的浏览器中启用，降级方案保留现有行为
3. 添加测试：多标签页 token 刷新不会冲突

- **Files**:
  - `src/services/supabase-client.service.ts` - 恢复 Navigator Lock
- **Success**:
  - Navigator Lock 在支持的浏览器中启用
  - 多标签页无 token 竞争
  - 不支持的浏览器优雅降级
- **Research References**:
  - 研究报告 Lines 230-241 - 安全隐患分析
- **Dependencies**:
  - 无

### Task 5.4: 优化 stores.ts 中 Map 克隆策略

**当前问题**：每次 signal 更新都 `new Map(map)` 完整克隆，批量操作 N 个任务 = 2N 次克隆。

**优化策略**：

方案 A — 批量更新 API：
```typescript
// 新增 bulkSetTasks() 方法
bulkSetTasks(tasks: Task[]): void {
  const map = new Map(this.tasksMap());
  const projMap = new Map(this.tasksByProject());
  for (const task of tasks) {
    map.set(task.id, task);
    // update project index
  }
  this.tasksMap.set(map);            // 只触发 1 次 signal
  this.tasksByProject.set(projMap);  // 只触发 1 次 signal
}
```

方案 B — update() 方法（Angular 19+）：
```typescript
this.tasksMap.update(map => {
  const newMap = new Map(map);
  newMap.set(task.id, task);
  return newMap;
});
```

**操作步骤**：
1. 为 TaskStore、ProjectStore、ConnectionStore 添加 `bulkSet` / `bulkRemove` 方法
2. 找到批量调用 `setTask()` 的位置，替换为 `bulkSetTasks()`
3. 添加性能基准测试验证改进

- **Files**:
  - `src/app/core/state/stores.ts` - 添加批量操作方法
  - 批量调用方 - 替换为批量 API
- **Success**:
  - 批量操作只触发 1 次 signal 更新
  - `npm run perf:benchmark` 无回归
- **Research References**:
  - 研究报告 Lines 197-200 - Map 克隆分析
- **Dependencies**:
  - 无

### Task 5.5: 定义 services/ 与 app/core/services/ 层级依赖规则

**当前问题**：
- `src/services/` → `src/app/core/`: 17 处引用
- `src/app/core/` → `src/services/`: 70 处引用
- 无明确的层级关系

**修复策略**：

1. 定义规则：`app/core/services/` 可以引用 `services/`，但反向不可
2. 添加 ESLint `import/no-restricted-paths` 规则
3. 逐步消除 17 处 `services/ → app/core/` 的反向引用

```javascript
// eslint.config.js
{
  rules: {
    'import/no-restricted-paths': ['error', {
      zones: [{
        target: './src/services/**',
        from: './src/app/core/**',
        message: 'services/ 不可引用 app/core/ — 请重构依赖方向'
      }]
    }]
  }
}
```

- **Files**:
  - `eslint.config.js` - 添加层级依赖规则
  - 17 处反向引用文件 - 重构依赖方向
- **Success**:
  - `npm run lint` 无层级依赖违规
  - 依赖方向单一：core → services
- **Research References**:
  - 研究报告 Lines 254-262 - 依赖关系混乱分析
- **Dependencies**:
  - Phase 3 完成（文件拆分可能已解决部分跨层引用）

### Task 5.6: 将 11 个 RxJS Subject 迁移到 Angular Signal

**当前状态**：11 个 RxJS Subject vs 265 个 Signal 使用。

**操作步骤**：
1. `grep -rn 'new Subject\|new BehaviorSubject\|new ReplaySubject' src --include='*.ts' | grep -v '.spec.ts'` 列出所有 Subject
2. 逐个评估：
   - `Subject<void>` 用作事件通知 → 替换为 `signal()` + `effect()`
   - `BehaviorSubject<T>` 用作状态 → 替换为 `signal<T>()`
   - `Subject<T>` 用作流式处理（如 debounce、switchMap）→ 保留 RxJS
3. 迁移可替换的 Subject，保留需要 RxJS 操作符的

```typescript
// Before:
private destroy$ = new Subject<void>();
ngOnDestroy() { this.destroy$.next(); this.destroy$.complete(); }

// After:
private destroyRef = inject(DestroyRef);
// 使用 takeUntilDestroyed(this.destroyRef)
```

- **Files**:
  - 包含 RxJS Subject 的服务/组件文件
- **Success**:
  - 可迁移的 Subject 全部替换为 Signal
  - 保留的 Subject 有明确的 RxJS 操作符依赖原因
  - 无功能回归
- **Research References**:
  - 研究报告 Lines 33 - RxJS Subject 统计
- **Dependencies**:
  - Phase 3+4 完成（确保有测试覆盖）

## Dependencies

- Angular 19.2.x（Signals + standalone + OnPush）
- Vitest 4.0.x
- ESLint + `import/no-restricted-paths` 插件
- `src/utils/result.ts`
- `src/services/logger.service.ts`
- `src/app/core/state/stores.ts`
- knip

## Success Criteria

- 0 个非自动生成文件超过 800 行
- 0 处 catch 错误吞噬（全部有日志或 Result 包装）
- 0 个 @deprecated 标记
- 0 处 .find(t => t.id) 在有 O(1) 替代的位置
- CI 构建 NG_BUILD_TYPE_CHECK=1 通过
- 服务测试覆盖率 ≥ 70%
- 测试 `as any` ≤ 50 处
- 0 处 setCallbacks
- Navigator Lock 修复
- 层级依赖规则 ESLint 强制
