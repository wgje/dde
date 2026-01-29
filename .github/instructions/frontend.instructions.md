---
applyTo: "src/**/*.ts,src/**/*.html,src/**/*.css"
---
# Frontend Development Standards (Angular 19.x)

## Angular Guidelines

### Components
- 必须使用 `standalone: true`
- 变更检测策略 `OnPush`
- 使用 Signals 进行状态管理
- 模板使用 `@if`, `@for`, `@defer` 新语法

### Services
- 禁止在 `StoreService` 门面中添加业务逻辑
- 新代码直接注入子服务，不使用 `inject(StoreService)`
- 使用 `inject()` 函数而非构造函数注入

### State Management
```typescript
// ✅ 推荐：使用 Signals
const tasks = signal<Map<string, Task>>(new Map());
const taskList = computed(() => Array.from(tasks().values()));

// ❌ 避免：深层嵌套对象
```

### Imports
```typescript
// ✅ 按类别分组
import { Component, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { TaskService } from '@services/task.service';
```

## GoJS Guidelines

### 移动端
- 手机默认 Text 视图
- Flow 图使用 `@defer` 懒加载
- 禁止 `visibility:hidden`，必须销毁/重建

### 内存管理
- 切换视图时 `diagram.clear()` + 移除监听
- 避免在模板事件中直接修改 diagram

## CSS/Tailwind

- 优先使用 Tailwind utility classes
- 复杂样式抽取为组件样式
- 响应式优先：mobile-first

## Performance

- 虚拟滚动处理大列表
- 图片懒加载
- 避免在模板中调用函数

## Accessibility

- 语义化 HTML 标签
- ARIA 属性用于交互元素
- 键盘导航支持
