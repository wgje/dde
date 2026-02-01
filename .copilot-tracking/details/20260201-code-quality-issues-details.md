<!-- markdownlint-disable-file -->

# Task Details: NanoFlow Code Quality Issues 修复

## Research Reference

- `.copilot-tracking/research/20260201-code-quality-issues-research.md` (完整分析)

---

## Phase 1: P0 - Error Swallowing 关键路径修复

### Task 1.1: 创建 wrapWithResult 辅助函数和 ESLint 规则

**目标**: 创建辅助工具来简化 Result 模式的应用，并通过 ESLint 防止新的错误吞噬

**实施步骤**:

1. 在 `src/utils/result.ts` 中添加 `wrapWithResult<T>()` 函数
2. 创建 ESLint 自定义规则禁止 `catch { return null }` 模式

**代码模板**:
```typescript
// src/utils/result.ts - 新增函数
/**
 * 将可能抛出异常的异步操作包装为 Result 类型
 * @param fn - 异步操作函数
 * @param errorCode - 失败时使用的错误码
 * @param errorMessage - 失败时的错误消息
 * @param logger - 可选的 LoggerService 实例用于记录错误
 */
export async function wrapWithResult<T>(
  fn: () => Promise<T>,
  errorCode: string,
  errorMessage: string,
  logger?: LoggerService
): Promise<Result<T, OperationError>> {
  try {
    const value = await fn();
    return success(value);
  } catch (e) {
    logger?.error('wrapWithResult', errorMessage, e);
    return failure(errorCode, errorMessage);
  }
}

// 同步版本
export function wrapWithResultSync<T>(
  fn: () => T,
  errorCode: string,
  errorMessage: string,
  logger?: LoggerService
): Result<T, OperationError> {
  try {
    const value = fn();
    return success(value);
  } catch (e) {
    logger?.error('wrapWithResultSync', errorMessage, e);
    return failure(errorCode, errorMessage);
  }
}
```

**ESLint 规则配置** (eslint.config.js):
```javascript
// 在 rules 中添加
'no-restricted-syntax': [
  'error',
  {
    selector: 'CatchClause > BlockStatement > ReturnStatement[argument.value=null]',
    message: '禁止在 catch 块中 return null。请使用 Result 模式：failure(ErrorCodes.XXX, "message")'
  }
]
```

- **Files**:
  - `src/utils/result.ts` - 添加 wrapWithResult 函数
  - `eslint.config.js` - 添加禁止规则
- **Success**:
  - wrapWithResult 函数可正常使用
  - ESLint 能检测出 `catch { return null }` 模式
- **Dependencies**: 无

---

### Task 1.2: 修复 migration.service.ts 中 8 处错误吞噬

**目标**: 将 migration.service.ts 中的 8 处 `return null` 替换为 Result 模式

**需修复位置** (使用 grep 确认具体行号):
```bash
grep -n "return null" src/services/migration.service.ts
```

**修复模式**:
```typescript
// Before
async loadLegacyData(): Promise<LegacyData | null> {
  try {
    const data = await this.fetchLegacy();
    return data;
  } catch {
    return null;
  }
}

// After
async loadLegacyData(): Promise<Result<LegacyData, OperationError>> {
  try {
    const data = await this.fetchLegacy();
    return success(data);
  } catch (e) {
    this.logger.error('loadLegacyData', '加载遗留数据失败', e);
    return failure(ErrorCodes.MIGRATION_ERROR, '加载遗留数据失败');
  }
}
```

- **Files**:
  - `src/services/migration.service.ts` - 修改 8 处
- **Success**:
  - 所有 8 处 `return null` 已替换
  - 调用者已更新为处理 Result 类型
  - 单元测试通过
- **Research References**:
  - 研究文件 Lines 100-120: migration.service.ts 分析
- **Dependencies**:
  - Task 1.1 完成

---

### Task 1.3: 修复 recovery.service.ts 中 7 处错误吞噬

**目标**: 将 recovery.service.ts 中的 7 处 `return null` 替换为 Result 模式

**需修复位置**:
```bash
grep -n "return null" src/services/recovery.service.ts
```

**关键函数** (预计需修复):
- `recoverFromBackup()`
- `loadRecoveryPoint()`
- `validateRecoveryData()`
- `restoreState()`

**修复策略**:
- 恢复失败使用 `ErrorCodes.RECOVERY_FAILED`
- 数据验证失败使用 `ErrorCodes.VALIDATION_ERROR`
- 备份读取失败使用 `ErrorCodes.BACKUP_ERROR`

- **Files**:
  - `src/services/recovery.service.ts` - 修改 7 处
- **Success**:
  - 所有 7 处 `return null` 已替换
  - 错误能正确上报到 Sentry
  - 单元测试通过
- **Dependencies**:
  - Task 1.1 完成

---

### Task 1.4: 修复 auth.service.ts 中 5 处错误吞噬

**目标**: 将 auth.service.ts 中的 5 处 `return null` 替换为 Result 模式

**关键函数** (预计需修复):
- `getCurrentUser()`
- `refreshSession()`
- `validateToken()`

**特殊考虑**:
- 未登录状态返回 `success(null)` 而非 `failure`
- 认证失败需要区分网络错误和凭证错误

- **Files**:
  - `src/services/auth.service.ts` - 修改 5 处
- **Success**:
  - 认证错误能被正确捕获和处理
  - 登录流程正常工作
  - 单元测试通过
- **Dependencies**:
  - Task 1.1 完成

---

## Phase 2: P0 - Error Swallowing 次要路径修复

### Task 2.1: 修复 attachment.service.ts 中 5 处错误吞噬

**目标**: 修复附件服务中的错误处理

**关键函数**:
- `uploadAttachment()`
- `downloadAttachment()`
- `deleteAttachment()`
- `getAttachmentUrl()`

**错误码策略**:
- 上传失败: `ErrorCodes.UPLOAD_FAILED`
- 下载失败: `ErrorCodes.DOWNLOAD_FAILED`
- 文件不存在: `ErrorCodes.FILE_NOT_FOUND`

- **Files**:
  - `src/services/attachment.service.ts` - 修改 5 处
- **Success**:
  - 附件操作错误能被追踪
  - 用户看到有意义的错误提示
  - 单元测试通过
- **Dependencies**:
  - Phase 1 完成

---

### Task 2.2: 修复 circuit-breaker.service.ts 中 5 处错误吞噬

**目标**: 修复断路器服务中的错误处理

**特殊考虑**:
- 断路器的设计本身就是处理错误的
- 需要区分"预期的熔断"和"意外的错误"
- 熔断状态变化需要日志记录

- **Files**:
  - `src/services/circuit-breaker.service.ts` - 修改 5 处
- **Success**:
  - 熔断事件正确记录
  - 意外错误能被追踪
  - 单元测试通过
- **Dependencies**:
  - Phase 1 完成

---

### Task 2.3: 修复 storage-adapter.service.ts 中 5 处错误吞噬

**目标**: 修复存储适配器中的错误处理

**关键函数**:
- `getItem()`
- `setItem()`
- `removeItem()`
- `clear()`

**特殊考虑**:
- IndexedDB 和 localStorage 可能抛出 QuotaExceededError
- 需要区分存储满和其他错误

- **Files**:
  - `src/services/storage-adapter.service.ts` - 修改 5 处
- **Success**:
  - 存储错误能被正确分类
  - 配额超限有特殊处理
  - 单元测试通过
- **Dependencies**:
  - Phase 1 完成

---

### Task 2.4: 修复剩余服务中的错误吞噬模式 (约 20 处)

**目标**: 修复所有剩余的 `return null` 在 catch 块中的模式

**需扫描的文件**:
```bash
grep -rn "catch.*{" --include="*.ts" src/services/ | grep -v ".spec.ts" | head -30
```

**批量处理策略**:
1. 运行 ESLint 找出所有违规位置
2. 按服务文件逐个修复
3. 每修复一个服务，运行相关测试

**预计涉及服务**:
- preference.service.ts
- local-backup.service.ts
- sync-coordinator.service.ts
- conflict-resolution.service.ts
- 其他

- **Files**:
  - 多个服务文件 (约 15-20 个)
- **Success**:
  - `npm run lint` 不报告错误吞噬
  - 所有测试通过
- **Dependencies**:
  - Tasks 2.1-2.3 完成

---

## Phase 3: P1 - console.* 统一替换

### Task 3.1: 替换组件中的 console.* 调用 (5 个文件)

**目标**: 将组件中的 console.* 调用替换为 LoggerService

**违规位置**:
| 文件 | 行号 | 类型 |
|------|------|------|
| `src/app/features/text/components/text-stages.component.ts` | 256 | console.error |
| `src/app/features/text/components/text-task-card.component.ts` | 110 | console.warn |
| `src/app/shared/components/reset-password.component.ts` | 227, 272 | console.error |
| `src/app/shared/components/sync-status.component.ts` | 627 | console.log |
| `src/app/shared/modals/migration-modal.component.ts` | 254 | console.error |

**替换模式**:
```typescript
// Before
console.error('Operation failed:', error);

// After
this.logger.error('methodName', 'Operation failed', error);
```

**组件注入**:
```typescript
private readonly logger = inject(LoggerService);
```

- **Files**:
  - 5 个组件文件 (见上表)
- **Success**:
  - 组件中无 console.* 调用
  - 日志正确输出到 LoggerService
- **Dependencies**:
  - 无 (可与 Phase 2 并行)

---

### Task 3.2: 替换服务和工具中的 console.* 调用 (4 个文件)

**目标**: 将服务和工具文件中的 console.* 调用替换

**违规位置**:
| 文件 | 行号 | 类型 |
|------|------|------|
| `src/services/storage-adapter.service.ts` | 66, 81 | console.warn |
| `src/utils/markdown.ts` | 100 | console.error |
| `src/utils/validation.ts` | 387 | console.warn |

**工具文件特殊处理**:
- 工具函数需要接收 logger 参数或使用静态日志
- 考虑创建单例 logger 或传参模式

- **Files**:
  - 4 个服务/工具文件 (见上表)
- **Success**:
  - 服务和工具中无 console.* 调用
- **Dependencies**:
  - 无 (可与 Phase 2 并行)

---

### Task 3.3: 添加 ESLint no-console 规则

**目标**: 配置 ESLint 禁止直接使用 console.*

**规则配置**:
```javascript
// eslint.config.js
rules: {
  'no-console': ['error', { 
    allow: [] // 完全禁止
  }]
}
```

**例外处理**:
- 测试文件 (*.spec.ts) 允许 console
- scripts/ 目录允许 console

- **Files**:
  - `eslint.config.js` - 添加 no-console 规则
- **Success**:
  - ESLint 检测出任何新的 console 使用
  - 现有代码通过检查
- **Dependencies**:
  - Tasks 3.1, 3.2 完成

---

## Phase 4: P1 - StoreService 精简

### Task 4.1: 分析 StoreService 透传方法和依赖关系

**目标**: 完整分析 StoreService 的透传方法和所有调用点

**分析步骤**:
1. 列出所有 StoreService 的公共方法
2. 识别哪些是透传方法 (直接调用子服务)
3. 查找所有 `inject(StoreService)` 的使用点
4. 创建迁移计划

**执行命令**:
```bash
# 查找所有 StoreService 调用
grep -rn "inject(StoreService)" --include="*.ts" src/

# 列出 StoreService 的方法
grep -n "^\s\+\(async\)\?\s\+[a-zA-Z]\+(" src/services/store.service.ts
```

**输出**: 创建迁移清单文档

- **Files**:
  - `src/services/store.service.ts` - 分析 (不修改)
  - 创建迁移清单
- **Success**:
  - 完整的透传方法列表
  - 所有调用点清单
  - 迁移顺序确定
- **Dependencies**:
  - 无

---

### Task 4.2: 更新调用点直接注入子服务 (批次 1)

**目标**: 更新约 50% 的调用点直接注入子服务

**优先级**:
1. 新代码 (容易修改)
2. 测试文件 (影响小)
3. 组件 (用户交互相关)

**修改模式**:
```typescript
// Before
private readonly store = inject(StoreService);
// 使用
this.store.createTask(...)

// After
private readonly taskOps = inject(TaskOperationAdapterService);
// 使用
this.taskOps.createTask(...)
```

- **Files**:
  - 多个组件和服务文件 (约 20-30 个)
- **Success**:
  - 批次 1 调用点已迁移
  - 应用正常运行
  - 测试通过
- **Dependencies**:
  - Task 4.1 完成

---

### Task 4.3: 更新调用点直接注入子服务 (批次 2)

**目标**: 更新剩余 50% 的调用点

**涵盖范围**:
- 核心服务
- 复杂组件
- 模态框

- **Files**:
  - 剩余的组件和服务文件
- **Success**:
  - 所有调用点已迁移
  - 无代码使用 StoreService 的透传方法
- **Dependencies**:
  - Task 4.2 完成

---

### Task 4.4: 移除 StoreService 透传方法，仅保留初始化协调

**目标**: 精简 StoreService 至仅保留初始化逻辑

**保留内容**:
- 构造函数初始化逻辑
- 子服务引用 (只读)
- 初始化状态信号

**移除内容**:
- 所有透传方法
- 业务逻辑包装

**最终 StoreService 结构**:
```typescript
@Injectable({ providedIn: 'root' })
export class StoreService {
  // 子服务引用 (只读，用于特殊场景)
  readonly taskOps = inject(TaskOperationAdapterService);
  readonly projectState = inject(ProjectStateService);
  // ... 其他子服务

  // 初始化状态
  readonly isInitialized = signal(false);
  
  constructor() {
    // 初始化协调逻辑
  }
}
```

- **Files**:
  - `src/services/store.service.ts` - 大幅精简
- **Success**:
  - StoreService < 200 行
  - 应用正常运行
  - 所有测试通过
- **Dependencies**:
  - Tasks 4.2, 4.3 完成

---

## Phase 5: P2 - 测试类型安全改进

### Task 5.1: 创建类型安全的 createMock<T> 工具函数

**目标**: 创建可复用的类型安全 mock 工具

**实现**:
```typescript
// src/test-setup.mocks.ts 或新文件 src/tests/mock-utils.ts

import { vi } from 'vitest';

/**
 * 创建类型安全的 mock 对象
 * @param overrides - 需要覆盖的方法/属性
 */
export function createMock<T>(overrides: Partial<Record<keyof T, unknown>> = {}): T {
  return new Proxy({} as T, {
    get: (target, prop) => {
      if (prop in overrides) {
        return overrides[prop as keyof T];
      }
      // 返回 mock 函数
      return vi.fn();
    }
  });
}

/**
 * 创建服务 mock 的辅助函数
 */
export function createServiceMock<T extends object>(
  ServiceClass: new (...args: unknown[]) => T,
  overrides: Partial<T> = {}
): T {
  const mock = {} as T;
  // 遍历原型链获取所有方法
  const proto = ServiceClass.prototype;
  Object.getOwnPropertyNames(proto).forEach(name => {
    if (name !== 'constructor' && typeof proto[name] === 'function') {
      (mock as Record<string, unknown>)[name] = vi.fn();
    }
  });
  return { ...mock, ...overrides };
}
```

- **Files**:
  - `src/tests/mock-utils.ts` - 新建
  - `src/test-setup.mocks.ts` - 可能更新
- **Success**:
  - createMock<T> 函数可用
  - 类型检查能发现 mock 的错误属性
- **Dependencies**:
  - 无

---

### Task 5.2: 替换高优先级测试文件中的 any 类型

**目标**: 在核心服务测试中替换 any 类型

**高优先级测试文件**:
- `task-repository.service.spec.ts`
- `global-error-handler.service.spec.ts`
- `sync-coordinator.service.spec.ts`
- `auth.service.spec.ts`

**替换模式**:
```typescript
// Before
let mockService: any;
mockService = { foo: vi.fn() };

// After
let mockService: MockType<FooService>;
mockService = createMock<FooService>({ foo: vi.fn() });
```

- **Files**:
  - 约 10 个高优先级测试文件
- **Success**:
  - 高优先级测试中无 any 类型
  - 测试通过
- **Dependencies**:
  - Task 5.1 完成

---

### Task 5.3: 替换中等优先级测试文件中的 any 类型

**目标**: 在其他测试文件中替换 any 类型

**目标**: 将 any 使用从 149 处降至 < 50 处

**策略**:
- 使用 vi.spyOn 替代 (service as any).privateMethod
- 对于必须访问私有成员的情况，使用类型断言到具体类型

- **Files**:
  - 剩余测试文件
- **Success**:
  - 测试 any 使用 < 50 处
  - 所有测试通过
- **Dependencies**:
  - Task 5.2 完成

---

## Phase 6: P2 - 大文件拆分

### Task 6.1: 拆分 critical-paths.spec.ts (1683 行)

**目标**: 按用户路径拆分为多个专注的测试文件

**拆分方案**:
```
e2e/critical-paths.spec.ts (1683 行)
  ↓ 拆分为
e2e/critical-paths/
  ├── auth-flow.spec.ts          # 认证流程
  ├── project-management.spec.ts  # 项目管理
  ├── task-crud.spec.ts           # 任务 CRUD
  ├── sync-flow.spec.ts           # 同步流程
  └── offline-mode.spec.ts        # 离线模式
```

**迁移步骤**:
1. 创建目录结构
2. 按 describe 块拆分测试
3. 抽取共享 fixtures 到 helpers 文件
4. 更新 playwright.config.ts 如需要

- **Files**:
  - `e2e/critical-paths.spec.ts` - 删除
  - `e2e/critical-paths/*.spec.ts` - 新建 5 个文件
  - `e2e/critical-paths/helpers.ts` - 共享工具
- **Success**:
  - 每个文件 < 400 行
  - E2E 测试全部通过
- **Dependencies**:
  - 无

---

### Task 6.2: 拆分 app.component.ts (1494 行)

**目标**: 将入口组件逻辑拆分到专门组件

**拆分方案**:
```
app.component.ts (1494 行)
  ↓ 抽取到
src/app/core/
  ├── app.component.ts              # 精简入口 (<400 行)
  ├── shell/
  │   ├── auth-handler.component.ts # 认证处理
  │   ├── modal-host.component.ts   # 模态框宿主
  │   └── error-boundary.component.ts # 已存在，确认使用
```

**抽取内容**:
- 认证状态监听逻辑 → auth-handler
- 模态框管理逻辑 → modal-host
- 全局键盘快捷键 → 保留或抽取

- **Files**:
  - `src/app.component.ts` - 精简
  - `src/app/core/shell/auth-handler.component.ts` - 新建
  - `src/app/core/shell/modal-host.component.ts` - 新建
- **Success**:
  - app.component.ts < 400 行
  - 应用正常运行
  - 测试通过
- **Dependencies**:
  - 无

---

### Task 6.3: 拆分 action-queue.service.ts (1429 行)

**目标**: 将操作队列服务拆分为核心 + 处理器

**拆分方案**:
```
action-queue.service.ts (1429 行)
  ↓ 拆分为
src/services/action-queue/
  ├── action-queue.service.ts       # 核心队列逻辑 (<400 行)
  ├── action-queue-processor.ts     # 处理器逻辑
  ├── action-queue-persistence.ts   # 持久化逻辑
  └── action-queue.types.ts         # 类型定义
```

- **Files**:
  - `src/services/action-queue.service.ts` - 精简
  - `src/services/action-queue/` - 新建目录和文件
- **Success**:
  - 每个文件 < 400 行
  - 队列功能正常
  - 测试通过
- **Dependencies**:
  - 无

---

### Task 6.4: 拆分其他超过 800 行的大文件

**目标**: 将剩余的大文件拆分到符合规范

**文件清单** (按行数排序):
| 文件 | 行数 | 拆分策略 |
|------|------|----------|
| task-operation-adapter.service.ts | 1394 | 按操作类型拆分 |
| task-repository.service.ts | 1235 | 分离读写操作 |
| flow-template.service.ts | 1231 | 分离节点/链接模板 |
| store.service.ts | 956 | Phase 4 处理 |
| 其他 | ... | 逐一分析 |

**分批处理策略**:
1. 优先处理改动频繁的文件
2. 每次拆分后运行测试验证
3. 保持 API 兼容性 (使用 re-export)

- **Files**:
  - 多个大文件 (约 15 个)
- **Success**:
  - 所有文件 < 800 行
  - 应用正常运行
  - 所有测试通过
- **Dependencies**:
  - Phases 1-5 完成

---

## Dependencies

- `src/utils/result.ts` - Result 模式已定义
- `src/services/logger.service.ts` - LoggerService 已完善
- `eslint.config.js` - ESLint 配置可扩展
- Angular 19.x Signals 状态管理
- Vitest 测试框架

## Success Criteria

- [ ] 零 `catch { return null }` 模式
- [ ] 零 `console.*` 在非测试代码
- [ ] StoreService < 200 行
- [ ] 测试 `any` 使用 < 50 处
- [ ] 所有文件 < 800 行
- [ ] LoggerService 采用率 100%
- [ ] 所有测试通过
- [ ] ESLint 检查通过
- [ ] E2E 测试通过
