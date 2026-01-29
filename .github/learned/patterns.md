# Learned Patterns

> 从 AI 会话中学习到的可复用模式
> 来源：[everything-claude-code Continuous Learning v2](https://github.com/affaan-m/everything-claude-code)

## 代码风格 (Code Style)

### prefer-functional-style
**触发**: 编写新函数时  
**置信度**: ████████░░ 80%  
**动作**: 优先使用函数式模式，避免 class（除非必要）

```typescript
// ✅ 推荐
export const calculateTotal = (items: Item[]): number =>
  items.reduce((sum, item) => sum + item.price, 0);

// ❌ 避免
class Calculator {
  calculateTotal(items: Item[]): number { ... }
}
```

### use-path-aliases
**触发**: 导入模块时  
**置信度**: ██████░░░░ 60%  
**动作**: 使用 @/ 路径别名代替相对路径

```typescript
// ✅ 推荐
import { TaskService } from '@/services/task.service';

// ❌ 避免
import { TaskService } from '../../../services/task.service';
```

### prefer-signals
**触发**: Angular 状态管理  
**置信度**: █████████░ 90%  
**动作**: 使用 Angular Signals 而非 RxJS BehaviorSubject

---

## 测试 (Testing)

### test-first-workflow
**触发**: 添加新功能时  
**置信度**: █████████░ 90%  
**动作**: 先写测试，再写实现（TDD）

### mock-supabase
**触发**: 测试涉及 Supabase 调用时  
**置信度**: ████████░░ 80%  
**动作**: 使用 `vi.mock('@supabase/supabase-js')` 模拟

---

## 工作流 (Workflow)

### grep-before-edit
**触发**: 修改代码时  
**置信度**: ███████░░░ 70%  
**动作**: 先用 Grep 搜索，确认后再 Edit

### small-commits
**触发**: 完成功能点时  
**置信度**: ████████░░ 80%  
**动作**: 保持小步提交，每次 commit 只做一件事

---

## 错误处理 (Error Handling)

### result-pattern
**触发**: 编写可能失败的函数时  
**置信度**: █████████░ 90%  
**动作**: 使用 Result<T, E> 模式而非 try/catch

```typescript
// ✅ 推荐
function fetchData(): Result<Data, ErrorCode> {
  if (condition) return failure(ErrorCodes.NOT_FOUND, '未找到');
  return success(data);
}

// ❌ 避免
function fetchData(): Data {
  if (condition) throw new Error('未找到');
  return data;
}
```

### supabase-error-conversion
**触发**: 处理 Supabase 错误时  
**置信度**: ████████░░ 80%  
**动作**: 使用 `supabaseErrorToError()` 转换错误

---

## 性能 (Performance)

### defer-gojs
**触发**: 移动端渲染 GoJS 时  
**置信度**: █████████░ 90%  
**动作**: 使用 `@defer` 懒加载 GoJS 组件

### iterative-tree-traversal
**触发**: 遍历任务树时  
**置信度**: █████████░ 90%  
**动作**: 使用迭代算法 + 深度限制 100

---

## 如何添加新模式

使用以下格式：

```markdown
### pattern-id
**触发**: 何时触发  
**置信度**: █████░░░░░ 50%  
**动作**: 具体动作

代码示例（可选）
```

置信度级别：
- 0.3 (███░░░░░░░): 试探性，建议但不强制
- 0.5 (█████░░░░░): 中等，相关时应用
- 0.7 (███████░░░): 强，自动应用
- 0.9 (█████████░): 近乎确定，核心行为
