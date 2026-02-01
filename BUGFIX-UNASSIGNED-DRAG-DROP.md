# 修复：待分配块拖放逻辑缺失（手机端）✅ 已修复

## 问题描述

**电脑端表现**：拖动侧边栏的待分配块到流程图位置已存在的待分配块时，被拖动块会瞬移到新的父块下（改变父子关系）。

**手机端缺陷**：缺少对应的逻辑，无法在手机端的文本视图中实现待分配块间的重新挂载。

## ✅ 修复完成（2026-02-01）

### 修改文件

1. **`src/app/features/text/components/text-view.types.ts`**
   - 在 `DragState` 接口中添加 `targetUnassignedId` 字段

2. **`src/app/features/text/services/text-view-drag-drop.service.ts`**
   - 在 `createInitialTouchState()` 中添加 `targetUnassignedId: null`
   - 修改 `endTouchDrag()` 返回值包含 `targetUnassignedId`
   - 添加 `updateUnassignedTarget()` 方法用于更新待分配块目标
   - 添加 `clearUnassignedTarget()` 方法用于清除待分配块目标

3. **`src/app/features/text/components/text-view.component.ts`**
   - 修改 `onTouchMove()` 添加待分配区域内块的检测逻辑
   - 修改 `onTouchEnd()` 添加待分配块间拖放的重新挂载处理

## 根本原因分析

### 电脑端（Flow 视图）
1. `flow-palette.component.ts` 的 `onDrop()` 方法只是简单地 emit 事件，没有提取拖放数据
2. `flow-view.component.ts` 的 `onUnassignedDrop()` 方法在处理"已分配任务拖回待分配区"的逻辑后，缺少对"待分配块到待分配块"的处理

### 手机端（Text 视图）
1. `text-unassigned.component.ts` 的模板在待分配区容器上没有添加 `(dragover)` 和 `(drop)` 事件处理
2. 没有实现待分配块间拖放的重新挂载逻辑

## 修复方案

### 1. 修复 flow-palette.component.ts

增强 `onDrop()` 方法，从拖放事件中提取任务数据，判断是否为待分配块拖放：

```typescript
onDrop(event: DragEvent) {
  event.preventDefault();
  
  // 从拖放事件中提取任务数据
  const data = event.dataTransfer?.getData("application/json") || event.dataTransfer?.getData("text");
  if (!data) {
    this.taskDrop.emit({ event });
    return;
  }

  try {
    const draggedTask = JSON.parse(data) as any;
    
    // 处理"待分配块到待分配块"的拖放
    if (draggedTask?.id && draggedTask.stage === null) {
      // 待分配块被拖到待分配区域，触发重新挂载逻辑
      this.taskDrop.emit({ event });
      return;
    }
  } catch (err) {
    // 数据解析失败，继续触发通用的 drop 事件
  }

  this.taskDrop.emit({ event });
}
```

### 2. 修复 flow-view.component.ts

增强 `onUnassignedDrop()` 方法，添加对"待分配块到待分配块"拖放的处理：

```typescript
onUnassignedDrop(event: DragEvent): void {
  event.preventDefault();
  
  const data = event.dataTransfer?.getData("application/json") || event.dataTransfer?.getData("text");
  if (!data) {
    this.dragDrop.handleDropToUnassigned(event);
    return;
  }

  try {
    const draggedTask = JSON.parse(data) as Task;
    
    // 场景1：已分配任务拖回待分配区 -> 解除分配
    if (draggedTask?.id && draggedTask.stage !== null) {
      const success = this.dragDrop.handleDropToUnassigned(event);
      if (success) {
        this.refreshDiagram();
      }
      return;
    }
    
    // 场景2：待分配块之间拖放 -> 改变父子关系（重新挂载）
    if (draggedTask?.id && draggedTask.stage === null) {
      const unassignedTasks = this.projectState.unassignedTasks();
      const targetCandidates = unassignedTasks.filter(t => t.id !== draggedTask.id);
      
      if (targetCandidates.length > 0) {
        const targetTask = targetCandidates[0];
        
        const result = this.taskOpsAdapter.moveTaskToStage(draggedTask.id, null, undefined, targetTask.id);
        if (!result.ok) {
          this.toast.error('重新挂载失败', getErrorMessage(result.error));
        } else {
          this.toast.success('已重新挂载', `"${draggedTask.title}" 已移到 "${targetTask.title}" 下`);
          this.refreshDiagram();
        }
        return;
      }
    }
  } catch (err) {
    this.dragDrop.handleDropToUnassigned(event);
  }
}
```

### 3. 修复 text-unassigned.component.ts

#### 3.1 在模板中添加拖放事件处理

在待分配区容器上添加 `dragover`、`dragleave` 和 `drop` 事件处理：

```html
<div class="flex flex-wrap" 
     [ngClass]="{'gap-2': !isMobile, 'gap-1.5': isMobile}"
     (dragover)="handleDragOverUnassigned($event)"
     (dragleave)="handleDragLeaveUnassigned($event)"
     (drop)="handleDropUnassigned($event)">
  <!-- 待分配块列表 -->
</div>
```

#### 3.2 在组件类中实现拖放事件处理方法

```typescript
/**
 * 待分配区域内的拖放事件处理
 * 支持待分配块之间的重新挂载（改变父子关系）
 */
protected handleDragOverUnassigned(event: DragEvent): void {
  event.preventDefault();
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = 'move';
  }
}

protected handleDragLeaveUnassigned(event: DragEvent): void {
  // 可选：添加视觉反馈
}

protected handleDropUnassigned(event: DragEvent): void {
  event.preventDefault();
  event.stopPropagation();

  const data = event.dataTransfer?.getData("application/json") || event.dataTransfer?.getData("text");
  if (!data) return;

  try {
    const draggedTask = JSON.parse(data) as Task;
    
    // 只处理待分配块之间的拖放（都是 stage === null）
    if (draggedTask?.id && draggedTask.stage === null) {
      const unassignedTasks = this.projectState.unassignedTasks()
        .filter(t => t.id !== draggedTask.id);
      
      if (unassignedTasks.length > 0) {
        const targetTask = unassignedTasks[0];
        
        const result = this.taskAdapter.moveTaskToStage(draggedTask.id, null, undefined, targetTask.id);
        
        if (!result.ok) {
          return;
        }
        
        this.dragStart.emit({ event: new DragEvent('drop'), task: draggedTask });
      }
    }
  } catch (err) {
    // 数据解析失败，忽略
  }
}
```

## 修改文件清单

1. **src/app/features/flow/components/flow-palette.component.ts**
   - 增强 `onDrop()` 方法

2. **src/app/features/flow/components/flow-view.component.ts**
   - 增强 `onUnassignedDrop()` 方法
   - 添加 `import { getErrorMessage } from '../../../../utils/result'`

3. **src/app/features/text/components/text-unassigned.component.ts**
   - 模板中的待分配区容器添加拖放事件处理
   - 添加三个新的拖放事件处理方法

## 工作流程

### 电脑端（Flow 视图）
1. 用户拖动侧边栏的待分配块
2. `flow-palette` 组件的 `onDragStart` 记录被拖动的任务
3. 用户将块拖放到待分配区的另一个块上
4. `flow-palette` 的 `onDrop` 被触发
5. 事件传递到 `flow-view` 的 `onUnassignedDrop`
6. 识别为"待分配块到待分配块"拖放
7. 调用 `moveTaskToStage` 改变父子关系（stage 保持为 null，parentId 更新）
8. 流程图更新，被拖动的块移动到新的父块下

### 手机端（Text 视图）
1. 用户拖动待分配区的一个块
2. `text-unassigned` 的 `handleDragStart` 记录被拖动的任务
3. 用户将块拖放到待分配区内的任何位置
4. `handleDropUnassigned` 被触发
5. 识别为"待分配块到待分配块"拖放
6. 调用 `moveTaskToStage` 改变父子关系
7. UI 自动更新，被拖动的块移动到新的父块下

## 测试建议

### 电脑端测试场景
- [ ] 拖动侧边栏待分配块 → 待分配区内已存在的块
- [ ] 验证被拖动块的 parentId 已更新
- [ ] 验证被拖动块的 stage 保持为 null
- [ ] 验证流程图中待分配区的块显示更新

### 手机端测试场景
- [ ] 在 text-view 中拖动一个待分配块 → 另一个待分配块
- [ ] 验证被拖动块的 parentId 已更新
- [ ] 验证待分配区的块列表更新
- [ ] 测试在不同的待分配块间重复拖放

### 边界情况测试
- [ ] 待分配区只有一个块时的拖放操作
- [ ] 拖放块到自己（无父子关系变化）
- [ ] 验证是否产生循环父子关系

## 附注

- 所有修改都遵循现有的 Result 模式错误处理
- 使用 `moveTaskToStage` API，该 API 已支持 `stage === null` 的场景
- 待分配块间的重新挂载不改变任务的位置（x, y 坐标）
- 修改后的代码向前兼容，不影响其他功能
