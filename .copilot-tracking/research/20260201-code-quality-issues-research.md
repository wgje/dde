<!-- markdownlint-disable-file -->

# Task Research Notes: NanoFlow Code Quality Issues Deep Analysis

## Research Executed

### File Analysis

- `/workspaces/dde/src/services/store.service.ts` (956 lines)
  - God Object 模式，14 个子服务注入，大量透传方法
  - 文档声明"禁止添加业务逻辑"但设计本身有问题

- `/workspaces/dde/src/services/` 目录
  - **108 个服务文件**，超过 20 个文件超过 500 行
  - 最大文件：`action-queue.service.ts` (1429 行)

- `/workspaces/dde/e2e/critical-paths.spec.ts` (1683 lines)
  - 单个 E2E 测试文件过大，违反单一职责

- `/workspaces/dde/src/app.component.ts` (1494 lines)
  - 入口组件过大，应拆分

### Code Search Results

- `catch { return null }` 模式
  - 约 **55+ 处** `return null` 在 catch 块中
  - 分布在 21+ 个服务文件中
  - 关键文件：migration.service.ts (8处), recovery.service.ts (7处), attachment.service.ts (5处)

- `console.(log|warn|error)` 直接调用
  - **37 处** 非测试文件中使用 console.*
  - 同时有 **106 处** 正确使用 LoggerService
  - 主要违规文件：
    - `text-stages.component.ts` (2处)
    - `text-task-card.component.ts` (1处)
    - `reset-password.component.ts` (2处)
    - `black-box-recorder.component.ts` (1处)
    - `storage-adapter.service.ts` (2处)

- `any` 类型使用 (测试文件)
  - **149 处** 在 `.spec.ts` 文件中使用 `any`
  - 包括 mock 对象声明、类型断言
  - 关键违规：`task-repository.service.spec.ts`, `global-error-handler.service.spec.ts`

- `setCallbacks` 回调模式
  - **8 个服务** 使用 `setCallbacks` 回调链
  - 形成深度回调依赖链：
    ```
    TaskOperationService.setCallbacks() 
      → TaskCreationService.setCallbacks()
      → TaskMoveService.setCallbacks()
      → TaskAttributeService.setCallbacks()
      → TaskConnectionService.setCallbacks()
      → TaskTrashService.setCallbacks()
    ```

### Project Conventions

- Standards referenced: 
  - `.github/instructions/frontend.instructions.md` - 禁止 StoreService 添加逻辑
  - `.github/instructions/testing.instructions.md` - 测试规范
  - `AGENTS.md` - 核心规则和目录结构

- Instructions followed:
  - Result 模式应用于错误处理 (部分实施)
  - LoggerService 替代 console.* (部分实施)
  - Signals 状态管理 (良好实施)

## Key Discoveries

### 问题 1: StoreService God Object (优先级: P1)

**现状分析**:
- 956 行代码
- 注入 14 个子服务
- 混合透传和直接暴露子服务
- 文档与实现矛盾

**根本原因**:
- 历史遗留：从单一 Store 演化而来
- 渐进式重构未完成
- 透传方法和直接访问混用

**影响**:
- 新开发者混淆
- 循环依赖风险
- 测试复杂度高

### 问题 2: Error Swallowing Pattern (优先级: P0)

**现状分析**:
```typescript
// 典型模式 (55+ 处)
} catch {
  return null;
}
```

**分布统计**:
| 服务 | 数量 |
|------|------|
| migration.service.ts | 8 |
| recovery.service.ts | 7 |
| attachment.service.ts | 5 |
| auth.service.ts | 5 |
| circuit-breaker.service.ts | 5 |
| storage-adapter.service.ts | 5 |

**根本原因**:
- 快速开发时的捷径
- 缺乏统一的错误处理策略
- Result 模式实施不完整

**影响**:
- 调试困难：无法追踪错误源
- 生产问题：Sentry 收不到关键错误
- 用户体验：静默失败

### 问题 3: console.* 遗留使用 (优先级: P1)

**现状分析**:
- 37 处 console.* 调用 (非测试)
- 106 处正确使用 LoggerService
- 比例：74% 合规

**违规位置**:
```
src/app/features/text/components/text-stages.component.ts:256
src/app/features/text/components/text-task-card.component.ts:110
src/app/shared/components/reset-password.component.ts:227,272
src/app/shared/components/sync-status.component.ts:627
src/app/shared/modals/migration-modal.component.ts:254
src/services/storage-adapter.service.ts:66,81
src/utils/markdown.ts:100
src/utils/validation.ts:387
```

### 问题 4: 测试类型安全 (优先级: P2)

**现状分析**:
- 149 处 `any` 类型在测试文件
- 模式：`let mockService: any`
- 模式：`(service as any).privateMethod`

**根本原因**:
- mock 对象难以完整类型化
- 访问私有成员需要类型断言
- 缺乏类型安全的 mock 工具

### 问题 5: Callback Hell (优先级: P2)

**现状分析**:
- 8 个服务使用 setCallbacks 模式
- 级联回调传递
- 初始化顺序依赖

**架构问题**:
```
TaskOperationAdapterService
  ↓ setCallbacks
TaskOperationService
  ↓ setCallbacks (6个子服务)
  ├── TaskCreationService
  ├── TaskMoveService
  ├── TaskAttributeService
  ├── TaskConnectionService
  ├── TaskTrashService
  └── SubtreeOperationsService
```

### 问题 6: 大文件违规 (优先级: P2)

**超过 800 行限制的文件 (18个)**:
| 文件 | 行数 | 建议 |
|------|------|------|
| app.component.ts | 1494 | 拆分为多个组件 |
| action-queue.service.ts | 1429 | 拆分处理器 |
| task-operation-adapter.service.ts | 1394 | 已在拆分中 |
| task-repository.service.ts | 1235 | 拆分读写操作 |
| flow-template.service.ts | 1231 | 拆分节点/链接模板 |
| critical-paths.spec.ts | 1683 | 按功能拆分 |

## Recommended Approach

### 阶段 1: P0 - Error Swallowing 修复 (1-2 周)

**策略**: 渐进式替换 `return null` 为 Result 模式

**实施步骤**:
1. 创建 `wrapWithResult<T>()` 辅助函数
2. 按服务优先级修复：
   - Week 1: migration, recovery, auth (关键路径)
   - Week 2: attachment, circuit-breaker, storage-adapter
3. 添加 ESLint 规则禁止新的 `catch { return null }`

**代码模式**:
```typescript
// Before
async loadData(): Promise<Data | null> {
  try {
    const data = await fetch(...);
    return data;
  } catch {
    return null;
  }
}

// After
async loadData(): Promise<Result<Data, OperationError>> {
  try {
    const data = await fetch(...);
    return success(data);
  } catch (e) {
    this.logger.error('loadData', 'Failed to load data', e);
    return failure(ErrorCodes.DATA_NOT_FOUND, 'Failed to load data');
  }
}
```

### 阶段 2: P1 - console.* 替换 (3 天)

**策略**: 批量替换 + Git hook 预防

**实施步骤**:
1. 创建替换脚本
2. 批量替换 37 处违规
3. 添加 ESLint 规则 `no-console`
4. 配置 pre-commit hook

### 阶段 3: P1 - StoreService 精简 (2 周)

**策略**: 完成渐进式迁移

**实施步骤**:
1. 移除所有透传方法 (仅保留子服务引用)
2. 更新所有调用点直接注入子服务
3. 最终 StoreService 仅作为初始化协调器

### 阶段 4: P2 - 测试类型安全 (持续)

**策略**: 创建类型安全的 mock 工具

**实施步骤**:
1. 创建 `createMock<T>()` 泛型函数
2. 逐步替换 `any` 类型
3. 使用 `vi.spyOn` 替代 `(x as any)`

### 阶段 5: P2 - 大文件拆分 (持续)

**策略**: 功能驱动拆分

**优先级**:
1. `critical-paths.spec.ts` → 按用户路径拆分
2. `app.component.ts` → 抽取 auth、modal 逻辑
3. `action-queue.service.ts` → 抽取处理器到单独文件

## Implementation Guidance

- **Objectives**: 
  - 消除调试盲区
  - 统一日志/错误处理
  - 提高代码可维护性
  - 符合 800 行文件限制

- **Key Tasks**: 
  - P0: 修复 55+ 处错误吞噬
  - P1: 替换 37 处 console.*
  - P1: 精简 StoreService
  - P2: 测试类型安全
  - P2: 大文件拆分

- **Dependencies**: 
  - Result 模式已定义 (src/utils/result.ts)
  - LoggerService 已完善 (src/services/logger.service.ts)
  - ESLint 配置可扩展

- **Success Criteria**: 
  - 零 `catch { return null }` 模式
  - 零 `console.*` 在非测试代码
  - StoreService < 200 行
  - 所有文件 < 800 行
  - 测试 `any` 使用 < 50 处

## Metrics Summary

| 指标 | 当前值 | 目标值 |
|------|--------|--------|
| `return null` in catch | 55+ | 0 |
| console.* (非测试) | 37 | 0 |
| `any` in tests | 149 | <50 |
| StoreService 行数 | 956 | <200 |
| 超过 800 行的文件 | 18 | 0 |
| LoggerService 采用率 | 74% | 100% |
