---
name: tdd
description: 严格 TDD 驱动开发：先写失败测试 → 再实现 → 再重构。确保 80%+ 测试覆盖率。
argument-hint: "描述要实现的行为/接口（最好给例子）"
agent: "tdd-guide"
---

你将以严格 TDD 驱动实现：先测试，后实现，再重构。

任务：${input:behavior:描述要实现的行为/接口}

## TDD 循环

```
RED     → 写失败测试
GREEN   → 写最小实现使测试通过
REFACTOR → 重构保持测试绿色
REPEAT  → 下一个测试用例
```

## 流程要求（必须按顺序执行）

### Step 1: 定义接口 (SCAFFOLD)
```typescript
// 先定义类型/接口
export interface InputType { ... }
export function myFunction(input: InputType): ReturnType {
  throw new Error('Not implemented')
}
```

### Step 2: 写失败测试 (RED)
找到最合适的测试位置与测试框架约定（尊重现有项目结构）。
先写最小"失败测试"（只覆盖这一行为），并说明为什么会失败。

```typescript
describe('myFunction', () => {
  it('should handle normal case', () => {
    const result = myFunction(input)
    expect(result).toBe(expected)
  })
})
```

### Step 3: 运行测试（验证失败）
指导运行最小测试命令：
```bash
npm run test -- --testPathPattern="myFunction"
```
确认测试失败，且失败原因正确。

### Step 4: 写最小实现 (GREEN)
在不破坏现有行为前提下实现，使测试通过。
只写刚好能让测试通过的代码，不要过度设计。

### Step 5: 运行测试（验证通过）
```bash
npm run test
```

### Step 6: 重构 (REFACTOR)
- 移除重复代码
- 改善命名
- 优化性能
- 增强可读性

### Step 7: 验证覆盖率
```bash
npm run test:run -- --coverage
```
确保覆盖率 >= 80%。

## 测试类型

### 必须包含的边界情况
1. **Null/Undefined**: 输入为空
2. **Empty**: 空数组/空字符串
3. **Invalid Types**: 错误类型输入
4. **Boundaries**: 最大/最小值
5. **Errors**: 网络失败、数据库错误
6. **Race Conditions**: 并发操作

## 输出格式

每一步先给"计划"，再给"具体修改"，再给"如何验证"：

```markdown
### Step N: [步骤名]
**计划**: [要做什么]
**修改**:
[代码块]
**验证**:
```bash
[验证命令]
```
```

**记住**：永远不要在写测试之前写实现代码！
