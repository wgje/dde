---
name: tdd
description: 测试驱动开发技能，包含红绿重构循环和测试模式
triggers:
  - "@tdd-guide"
  - "/tdd"
---

# TDD Skill

## 概述

测试驱动开发技能包，遵循红绿重构循环：
1. 🔴 **Red** - 写一个失败的测试
2. 🟢 **Green** - 用最少代码让测试通过
3. 🔵 **Refactor** - 改进代码，保持测试通过

## 使用方法

### 开始 TDD 循环
```
/tdd start "用户可以创建任务"
```

### 运行测试
```
/tdd run
```

### 查看覆盖率
```
/tdd coverage
```

## TDD 流程

### 1. 写失败的测试
```typescript
describe('TaskService', () => {
  it('should create task with valid title', () => {
    const service = new TaskService();
    const task = service.create({ title: 'Test' });
    expect(task.id).toBeDefined();
    expect(task.title).toBe('Test');
  });
});
```

### 2. 运行测试（应该失败）
```bash
npm run test:run -- --grep "should create task"
```

### 3. 写最少实现
```typescript
class TaskService {
  create(data: { title: string }): Task {
    return {
      id: crypto.randomUUID(),
      title: data.title,
    };
  }
}
```

### 4. 运行测试（应该通过）
```bash
npm run test:run -- --grep "should create task"
```

### 5. 重构
- 提取常量
- 改进命名
- 减少重复

## 测试模式

### Arrange-Act-Assert
```typescript
it('should update task title', () => {
  // Arrange
  const task = createTask({ title: 'Old' });
  
  // Act
  const updated = service.update(task.id, { title: 'New' });
  
  // Assert
  expect(updated.title).toBe('New');
});
```

### Given-When-Then (BDD)
```typescript
describe('给定一个已完成的任务', () => {
  describe('当用户归档任务时', () => {
    it('那么任务状态应该是 archived', () => {
      // ...
    });
  });
});
```

## 常用命令

| 命令 | 描述 |
|------|------|
| `npm run test` | 监听模式运行测试 |
| `npm run test:run` | 单次运行测试 |
| `npm run test:e2e` | 运行 E2E 测试 |
| `npx vitest --coverage` | 生成覆盖率报告 |

## 技巧

1. **小步前进** - 一次只测试一个行为
2. **测试行为，不测实现** - 测试「做什么」而非「怎么做」
3. **快速反馈** - 保持测试运行时间短
4. **隔离** - 每个测试独立，无依赖
