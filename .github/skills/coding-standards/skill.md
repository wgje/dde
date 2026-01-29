---
name: coding-standards
description: NanoFlow 项目编码标准和约定
version: 1.0.0
triggers:
  - "@implementation"
  - "@code-reviewer"
  - "@refactor-cleaner"
---

# 编码标准技能

NanoFlow 项目的统一编码标准和最佳实践。

## 核心原则

1. **不要造轮子**: 使用成熟的工具和库
2. **代码简洁、可读、可维护**
3. **小步迭代、频繁提交**
4. **中文注释，英文代码**

## Angular 规范

### 组件规范

```typescript
@Component({
  selector: 'app-task-card',
  standalone: true,            // ✅ 独立组件
  changeDetection: ChangeDetectionStrategy.OnPush,  // ✅ OnPush
  imports: [CommonModule, ...],
  template: `...`
})
export class TaskCardComponent {
  // ✅ 使用 Signals
  private readonly store = inject(StoreService);
  
  // ✅ input/output 信号
  task = input.required<Task>();
  taskSelected = output<string>();
  
  // ✅ computed 派生状态
  isCompleted = computed(() => this.task().status === 'completed');
}
```

### 服务规范

```typescript
@Injectable({ providedIn: 'root' })
export class TaskOperationService {
  // ✅ 使用 Result 模式
  async createTask(data: TaskInput): Promise<Result<Task, AppError>> {
    try {
      const task = await this.repository.create(data);
      return success(task);
    } catch (error) {
      return failure(ErrorCodes.CREATE_FAILED, '创建任务失败');
    }
  }
}
```

## 文件大小限制

| 类型 | 建议行数 | 最大行数 |
|------|----------|----------|
| 组件 | 100-200 | 400 |
| 服务 | 150-300 | 500 |
| 工具函数 | 50-100 | 200 |
| 测试文件 | 100-300 | 600 |

**超过限制的处理**：
1. 提取子组件
2. 提取工具函数
3. 拆分为多个服务

## 命名约定

```typescript
// 文件命名：kebab-case
task-operation.service.ts
flow-view.component.ts
result.utils.ts

// 类命名：PascalCase
class TaskOperationService {}
class FlowViewComponent {}

// 变量/函数：camelCase
const taskList = [];
function calculateTotal() {}

// 常量：SCREAMING_SNAKE_CASE
const MAX_RETRY_COUNT = 3;
const SYNC_DEBOUNCE_DELAY = 3000;

// 接口：PascalCase，不加 I 前缀
interface Task {}  // ✅
interface ITask {} // ❌
```

## 错误处理

### Result 模式

```typescript
// ✅ 使用 Result 类型
type Result<T, E> = 
  | { ok: true; value: T } 
  | { ok: false; error: E };

// 使用
const result = await service.createTask(data);
if (result.ok) {
  console.log(result.value);
} else {
  console.error(result.error);
}
```

### 错误分级

| 级别 | 处理方式 | 示例 |
|------|----------|------|
| SILENT | 仅日志 | ResizeObserver 循环 |
| NOTIFY | Toast 提示 | 保存失败 |
| RECOVERABLE | 恢复对话框 | 同步冲突 |
| FATAL | 错误页面 | Store 初始化失败 |

## 注释规范

```typescript
// ✅ 中文注释描述业务逻辑
/**
 * 计算任务的 displayId
 * 格式：父任务序号 + 当前任务字母，如 "1,a"
 * 
 * @param task 目标任务
 * @param siblings 同级任务列表
 * @returns 格式化的 displayId
 */
function calculateDisplayId(task: Task, siblings: Task[]): string {
  // 获取父任务的序号
  const parentIndex = getParentIndex(task.parentId);
  
  // 计算当前任务在同级中的位置
  const siblingIndex = siblings.findIndex(t => t.id === task.id);
  
  return `${parentIndex},${indexToLetter(siblingIndex)}`;
}
```

## 测试规范

```typescript
describe('TaskOperationService', () => {
  // ✅ 清晰的测试描述
  it('should create task with generated UUID', async () => {
    // Arrange
    const input = { title: 'Test Task' };
    
    // Act
    const result = await service.createTask(input);
    
    // Assert
    expect(result.ok).toBe(true);
    expect(result.value.id).toMatch(UUID_REGEX);
  });

  // ✅ 测试边界情况
  it('should return error when title is empty', async () => {
    const result = await service.createTask({ title: '' });
    
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe(ErrorCodes.VALIDATION_FAILED);
  });
});
```

## 与 everything-claude-code 的映射

| everything-claude-code | 本项目实现 |
|------------------------|------------|
| `rules/coding-style.md` | `.github/instructions/frontend.instructions.md` |
| Code style instincts | 本 skill 文件 |
| Linting hooks | ESLint + Prettier 配置 |

## 工具配置

项目使用的工具：

- **ESLint**: 代码质量检查
- **Prettier**: 代码格式化
- **TypeScript**: 严格类型检查
- **Husky**: Git hooks
- **lint-staged**: 暂存文件检查

## 快捷检查命令

```bash
# 检查 + 修复
npm run lint:fix

# 仅检查
npm run lint

# 类型检查
npx tsc --noEmit

# 格式化
npx prettier --write .
```
