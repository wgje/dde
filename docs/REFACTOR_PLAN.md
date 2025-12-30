# NanoFlow 重构计划 v2.0

> **创建日期**: 2024-12-30  
> **状态**: 进行中  
> **基于**: 高级顾问代码审查 + 冗余深度分析

---

## 📋 执行摘要

本计划整合了两方面输入：
1. **40年资深顾问的代码审查**：聚焦架构反模式和离线优先可靠性
2. **项目冗余深度分析**：识别代码膨胀和重复模式

**核心目标**：在不破坏现有功能的前提下，消除冗余、强化可靠性。

---

## ✅ 顾问意见审计结果

### 1. UUID 策略 ✅ PASS
- 客户端 `crypto.randomUUID()` 生成所有 ID
- 无需 ID 映射，离线创建无障碍

### 2. Optimistic UI ✅ PASS  
- `simple-sync.service.ts` 正确实现：`操作 → 本地写入 → UI 更新 → 后台推送`

### 3. RetryQueue 持久化 ✅ PASS（已验证）
- 已实现双层持久化：`localStorage + IndexedDB 备份`
- 存储失败触发逃生模式（`storageFailure` signal）
- **代码位置**: [action-queue.service.ts#L981-L1050](../src/services/action-queue.service.ts)

### 4. Sentry Breadcrumbs ⚠️ 缺失
- 当前：仅 `captureException` 和 `captureMessage`
- 需要：在 ActionQueue 关键操作添加 breadcrumbs

### 5. StoreService 门面模式 ⚠️ 待评估
- 顾问建议移除，但项目已标记 `@deprecated` 并提供子服务直接访问
- 渐进式迁移：保留门面但鼓励新代码直接注入子服务

---

## 🎯 重构任务清单

### Phase 1: 可靠性强化（P0）

| ID | 任务 | 状态 | 验证方式 |
|----|------|------|----------|
| P0-1 | 添加 Sentry Breadcrumbs 到 ActionQueue | ✅ 完成 | 单元测试通过 |
| P0-2 | 验证 RetryQueue IndexedDB 持久化 | ✅ 已确认 | 代码审查 |
| P0-3 | 确保 Realtime 优先于轮询 | ✅ 已确认 | 代码审查 |

### Phase 2: 代码清理（P1）

| ID | 任务 | 状态 | 预计削减 |
|----|------|------|----------|
| P1-1 | 移除双重导出（Flow 服务） | ✅ 完成 | 10 行导出 |
| P1-2 | 清理 @deprecated 透传方法 | ✅ 完成 | 13 行（StoreService） |
| P1-3 | 精简配置常量 | ✅ 完成 | 70 行（移除 5 个未使用配置） |

### Phase 3: 架构简化（P2，长期）

| ID | 任务 | 状态 | 复杂度 |
|----|------|------|--------|
| P2-1 | 评估 StoreService 门面去留 | ⏳ 待定 | 高 |
| P2-2 | 合并 Flow 服务（14→5） | ⏳ 待定 | 高 |
| P2-3 | 清理更多 deprecated 代码 | ✅ 完成 | 低 |
| P2-4 | 移除未使用的导出 | ✅ 完成 | 低 |
| P2-5 | 移除无效的 authGuard 导出 | ✅ 完成 | 低 |
| P2-6 | 移除未使用的依赖注入 | ✅ 完成 | 低 |
| P2-7 | 移除未使用的 deprecated 方法 | ✅ 完成 | 低 |
| P2-8 | 清理测试文件 ESLint 错误 | ✅ 完成 | 低 |

---

## 📊 完成度追踪

```
Phase 1: ████████████████████ 100% (3/3)
Phase 2: ████████████████████ 100% (3/3)  
Phase 3: ██████████████████░░  86% (6/7)
Overall: ██████████████████░░  92% (12/13)
```

---

## 🔧 已完成的变更记录

### 2024-12-30

#### 1. Sentry Breadcrumbs (P0-1)
**文件**: [action-queue.service.ts](../src/services/action-queue.service.ts)

添加位置：
- `enqueue()`: 记录入队操作（entityType, entityId, priority, queueSize）
- `processQueue()`: 记录队列处理开始/结束（queueSize, actionTypes, processed/failed）
- `moveToDeadLetter()`: 记录死信转移（reason, deadLetterSize）

```typescript
Sentry.addBreadcrumb({
  category: 'sync',
  message: 'Action enqueued',
  level: 'info',
  data: { entityType, entityId, type, priority, queueSize }
});
```

#### 2. 移除双重导出 (P1-1)
**文件**: [index.ts](../src/services/index.ts)

移除了 Flow 服务的再导出（FlowDiagramService, FlowDragDropService 等），
强制从 `@app/features/flow/services` 导入。保留 FlowCommandService（位于 src/services）。

#### 3. 清理 @deprecated 别名 (P1-2)
**文件**: [store.service.ts](../src/services/store.service.ts)

- 移除 6 个 deprecated 私有别名（uiState, projectState, syncCoordinator, userSession, preference, taskAdapter）
- 将 128 处内部引用替换为 public readonly 属性（ui, project, sync, session, pref, taskOps）
- 减少 13 行代码（932 → 919 行）

#### 4. 精简配置常量 (P1-3)
**文件**: [sync.config.ts](../src/config/sync.config.ts)

移除 5 个未使用的配置对象：
- `UNDO_SYNC_CONFIG` - 未使用
- `SYNC_PERCEPTION_CONFIG` - 未使用
- `SYNC_MODE_CONFIG` - 未使用
- `SYNC_CHECKPOINT_CONFIG` - 未使用  
- `CONFLICT_HISTORY_CONFIG` - 未使用

减少 70 行代码（204 → 134 行）

#### 5. 清理更多 deprecated 代码 (P2-3)

**action-queue.service.ts**:
- 移除 `isBusinessError()` 方法（-9 行）

**auth.service.ts**:
- 移除 deprecated getters `success` 和 `error`（-17 行）

#### 6. 移除未使用的导出 (P2-4)

**models/index.ts**:
- 移除 `export * from './api-types'` - api-types.ts 中的类型未被使用
- 移除 `export * from './supabase-mapper'` - simple-sync.service.ts 有私有 mapper

**发现的代码重复**（记录供后续优化）：
- `simple-sync.service.ts` 中有私有的 `rowToTask()` / `rowToProject()`
- `supabase-mapper.ts` 中有公共的 `mapTaskFromDb()` / `mapProjectFromDb()`
- 建议：后续可统一使用 supabase-mapper.ts 中的映射器

#### 7. 移除无效的 authGuard 导出 (P2-5)

**services/index.ts**:
- 移除 `authGuard` 导出（函数已被移除但导出语句遗留）
- 更新注释说明迁移到 `requireAuthGuard`

#### 8. 移除未使用的依赖注入 (P2-6)

**store.service.ts**:
- 移除未使用的 `authService = inject(AuthService)` 依赖
- 移除对应的 `import { AuthService } from './auth.service'`
- 减少 2 行代码

---

#### 9. 清理测试文件 ESLint 错误 (P2-8)

**清理的文件**:
- `simple-sync.service.spec.ts`: 移除未使用的 fakeAsync, tick, flush
- `action-queue.service.spec.ts`: 移除未使用的 QueuedAction, DeadLetterItem
- `change-tracker.service.spec.ts`: 移除未使用的 vi
- `conflict-resolution.service.spec.ts`: 移除未使用的 ConflictResolutionStrategy, MergeResult
- `data-loss-detection.integration.spec.ts`: 移除未使用的 Project
- `request-throttle.service.spec.ts`: 标记调试变量为有意未使用
- `sync-coordinator.service.spec.ts`: 移除未使用的 Subject, failure, ErrorCodes
- `task-trash.service.spec.ts`: 移除未使用的 DeleteResult
- `undo-integration.spec.ts`: 移除未使用的变量声明
- `test-setup.ts`: 标记参数为有意未使用

**结果**: ESLint 从 22 个错误降至 0 个

---

## 🚫 明确不做的事项

1. **不移除 StoreService 门面**
   - 原因：太多现有代码依赖，需渐进式迁移
   - 策略：新代码鼓励直接注入子服务，旧代码逐步迁移

2. **不合并 Flow 服务**
   - 原因：GoJS 集成复杂，需专门规划
   - 策略：作为 Phase 3 长期任务

3. **不实现复杂冲突解决**
   - 顾问建议：单用户应用 LWW 足够
   - 保留简单的 LWW 策略，移除冲突模态框（V1）

---

## 📝 验证检查清单

运行以下命令验证变更：

```bash
# 类型检查
npm run typecheck

# 单元测试
npm run test:run

# Lint 检查
npm run lint

# E2E 测试（可选）
npm run test:e2e
```

---

## 📚 参考文档

- [copilot-instructions.md](../.github/copilot-instructions.md)
- [AGENTS.md](../AGENTS.md)
- 高级顾问代码审查（2024-12-30）
