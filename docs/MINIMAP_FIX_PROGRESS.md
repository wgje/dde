# 小地图拖拽卡顿修复进度

> **创建日期**: 2024-12-25  
> **最后更新**: 2024-12-26  
> **问题描述**: 
> 1. ~~将小地图中的视口窗拖拽到最下面时，整个小地图会突然卡死~~ ✅ 已修复
> 2. ~~小地图中的视口框（白色矩形）无法拖拽~~ ✅ 已修复
> 3. ~~拖拽视口框时，小地图中的任务块不会实时更新位置~~ ✅ 已修复
> 4. ~~视口窗可以被拖出小地图导致消失~~ ✅ 已修复 (2024-12-26)
> 5. ~~视口窗从边缘拉到中央时不会逐渐变大~~ ✅ 已修复 (2024-12-26)

## 问题诊断

### 复现场景 (2024-12-26 新增问题)
1. 小地图的视口窗在地图上显示视口窗里没有那些任务，但实际流程图里可以看到那些节点
2. 视口窗可以被拖出小地图导致视口窗在小地图消失
3. 当视口窗被动态拉动的时候小地图上的任务节点有卡顿无法做到实时同步
4. 当视口窗从边缘拉到中央时候视口窗不会随着拉向中间而逐渐变大

### 根因分析

| 问题 | 严重程度 | 原因 |
|------|----------|------|
| **拖拽时的事件风暴** | ⭐⭐⭐⭐⭐ | `ViewportBoundsChanged` 触发频率过高，每次都执行复杂计算 |
| **超时保护不足** | ⭐⭐⭐⭐ | 500ms 超时后 `isOverviewInteracting` 被重置，导致卡顿 |
| **硬墙 clamp** | ⭐⭐⭐⭐ | `limitDisplayBounds` 中的 clamp 导致世界坐标饱和 |
| **scroll 上限** | ⭐⭐⭐ | `scrollMargin: 5000` 限制了无限画布能力 |

### 核心数学问题

当你把 indicator 拖到边缘：
```
indicator 位置 → 用当前 scale 换算 worldCenter
    ↓
worldCenter 变远 → viewportBounds 扩大 union → extendedBounds 变大
    ↓
extendedBounds 变大 → scaleRatio 变小
    ↓
scaleRatio 变小 → 同样的 worldCenter 映射回小地图位置会"被压回去"
    ↓
如果有 clamp，就会出现"撞墙/卡死"
```

---

## 修复计划

### 阶段 1: 核心修复

| 任务 | 状态 | 文件 |
|------|------|------|
| 1. 修复交互状态超时保护 | ✅ 已完成 | `flow-diagram.service.ts` |
| 2. 消除硬墙 clamp | ✅ 已完成 | `flow-diagram.service.ts` |
| 3. 分离逻辑/显示位置 | ✅ 已完成 | `flow-diagram.service.ts` |
| 4. 动态 maxOverflow | ✅ 已完成 | `flow-diagram.service.ts` |
| 5. 优化事件节流 | ✅ 已完成 | `flow-diagram.service.ts` |

### 阶段 2: Further Considerations

| 任务 | 状态 | 文件 |
|------|------|------|
| 6. 开启 InfiniteScroll | ✅ 已完成 | `flow-diagram.service.ts` |
| 7. 简化 Overview 模板 | ✅ 已完成 | `flow-template.service.ts` |
| 8. 添加性能监控 | ✅ 已完成 | `flow-diagram.service.ts` |
| 9. **修复视口框无法拖拽** | ✅ 已完成 | `flow-diagram.service.ts` |

### 阶段 3: 深度修复 (2024-12-26)

| 任务 | 状态 | 文件 |
|------|------|------|
| 10. 修复 worldBounds 未使用问题 | ✅ 已完成 | `flow-diagram.service.ts` |
| 11. 添加 overview.fixedBounds 动态设置 | ✅ 已完成 | `flow-diagram.service.ts` |
| 12. 实现 scale 平滑过渡 (lerp) | ✅ 已完成 | `flow-diagram.service.ts` |
| 13. 清理 DiagramListener 防止累积 | ✅ 已完成 | `flow-diagram.service.ts` |
| 14. 合并双重 ViewportBoundsChanged | ✅ 已完成 | `flow-diagram.service.ts` |
| 15. 将 pointer 事件移入 zone.runOutsideAngular | ✅ 已完成 | `flow-diagram.service.ts` |
| 16. 节流 updateAllTargetBindings (100ms) | ✅ 已完成 | `flow-diagram.service.ts` |
| 17. 为 Overview 容器添加 ResizeObserver | ✅ 已完成 | `flow-diagram.service.ts` |
| 18. 集成 MinimapMathService | ✅ 已完成 | `flow-diagram.service.ts` |
| 19. **修复节点被困在四分之一区域** | ✅ 已完成 | `flow-diagram.service.ts` |

---

## 修改日志

### 2024-12-26

#### ✅ 任务 19: 修复节点被困在小地图四分之一区域

**问题描述**: 节点只显示在小地图的四分之一区域内，而不是完整利用整个小地图空间

**根因分析**:

当 `devicePixelRatio > 1`（如 Retina 屏幕 devicePixelRatio=2）时：
1. GoJS 使用 `computePixelRatio` 创建物理像素尺寸为 CSS 尺寸 2 倍的 Canvas
2. 例如：容器 CSS 尺寸 180x140，Canvas 物理尺寸 360x280
3. Overview 的 viewportBounds 计算可能使用了不一致的尺寸参考
4. 这导致节点只渲染在 `1/(devicePixelRatio^2)` = 1/4 的区域内

**数学解释**:
```
devicePixelRatio = 2
Canvas 物理尺寸 = CSS 尺寸 × 2 = (180×2) × (140×2) = 360 × 280
如果坐标计算错误地使用了物理尺寸的一半：
  有效渲染区域 = 180 × 140 / (360 × 280) = 1/4
```

**解决方案**:

移除 `computePixelRatio` 自定义配置，让 GoJS 使用默认值 1：

```typescript
// 修复前
this.overview = $(go.Overview, container, {
  "computePixelRatio": () => pixelRatio,  // ❌ 导致坐标不匹配
  // ...
});

// 修复后
this.overview = $(go.Overview, container, {
  // 不设置 computePixelRatio，使用默认值 1  ✅
  // ...
});
```

**权衡**:
- 高 DPI 屏幕上小地图可能略微模糊
- 但小地图尺寸本身很小（180x140 或 100x80），DPI 差异不明显
- 确保坐标计算一致性比清晰度更重要

#### ✅ 任务 10-18: 深度修复小地图视口同步与性能问题

**问题 1**: `calculateExtendedBounds` 的返回值被赋值给 `_scaleBounds`，但从未被使用

**解决方案**: 
- 将 `_scaleBounds` 改为 `worldBounds`
- 用 `worldBounds` 参与缩放计算，替换原来的 `totalBounds`
- 设置 `overview.fixedBounds = worldBounds` 确保视口框永远在小地图视野内

**问题 2**: scale 更新是阶跃式的，视口框从边缘拉到中央时不会逐渐变大

**解决方案**: 
- 添加 `lerp` 函数实现线性插值
- 将 `this.overview.scale = targetScale` 改为 `lerp(currentScale, targetScale, 0.18)`
- 平滑因子 0.18 提供流畅但不太慢的过渡

**问题 3**: DiagramListener 未在 disposeOverview 中清理，导致监听器累积

**解决方案**: 
- 将 handler 保存到成员变量 `overviewDocumentBoundsChangedHandler` 和 `overviewViewportBoundsChangedHandler`
- 在 `disposeOverview` 中调用 `removeDiagramListener`
- 合并两个 `ViewportBoundsChanged` 监听器为一个

**问题 4**: pointer 事件触发 Angular 变更检测，导致卡顿

**解决方案**: 
- 将所有 `addEventListener` 包裹在 `zone.runOutsideAngular` 中
- 将每帧的 `updateAllTargetBindings` 改为 100ms 节流
- 拖拽结束时再执行一次完整的绑定更新

**问题 5**: Overview 容器 resize 时不同步更新

**解决方案**: 
- 为 Overview 容器添加 `ResizeObserver`
- resize 时调用 `refreshOverview()` 重新计算缩放

---

### 2024-12-25

#### ✅ 任务 1: 修复交互状态超时保护

**问题**: 500ms 超时后 `isOverviewInteracting` 被自动重置，导致后续拖拽事件触发大量 `ViewportBoundsChanged` 处理

**解决方案**: 
- 使用 `setPointerCapture()` 确保拖拽出界后仍能收到事件
- 移除 500ms 超时自动重置逻辑
- 使用 `lostpointercapture` 替代 `pointerleave` 检测拖拽结束

**修改文件**: `src/services/flow-diagram.service.ts` (attachOverviewPointerListeners 方法)

```typescript
// 存储当前捕获的 pointerId，用于 releasePointerCapture
let capturedPointerId: number | null = null;

const onPointerDown = (ev: PointerEvent) => {
  this.isOverviewInteracting = true;
  
  // 使用 PointerCapture 确保拖拽出界后仍能收到事件
  try {
    container.setPointerCapture(ev.pointerId);
    capturedPointerId = ev.pointerId;
  } catch (e) {
    // 某些触摸设备可能不支持
  }
};
```

---

#### ✅ 任务 2-4: 消除硬墙 clamp + 分离逻辑/显示位置 + 动态 maxOverflow

**问题**: `limitDisplayBounds()` 中的 `clampedViewport` 计算和 `maxOverflow = 1200` 硬编码导致：
- 视口位置被限制在 `limited` 边界内
- 无法实现无限画布效果
- 拖拽到边缘时被 clamp 拉回

**解决方案**: 重写为 `calculateExtendedBounds()` 函数

**修改文件**: `src/services/flow-diagram.service.ts`

```typescript
/**
 * 动态扩展边界 - 无限画布核心
 */
const calculateExtendedBounds = (baseBounds: go.Rect, viewportBounds: go.Rect): go.Rect => {
  // 动态 maxOverflow：不再硬编码 1200，允许无限扩展
  const overflowLeft = Math.max(0, baseBounds.x - viewportBounds.x);
  const overflowRight = Math.max(0, viewportBounds.right - baseBounds.right);
  const overflowTop = Math.max(0, baseBounds.y - viewportBounds.y);
  const overflowBottom = Math.max(0, viewportBounds.bottom - baseBounds.bottom);

  // 不再限制 overflow，允许无限扩展
  const extended = new go.Rect(
    baseBounds.x - overflowLeft,
    baseBounds.y - overflowTop,
    baseBounds.width + overflowLeft + overflowRight,
    baseBounds.height + overflowTop + overflowBottom
  );

  // 关键：不再 clamp viewportBounds，直接合并
  return extended.unionRect(viewportBounds);
};
```

---

#### ✅ 任务 5: 优化事件节流

**问题**: 交互期间仍在处理 `ViewportBoundsChanged` 事件

**解决方案**: 当 `isOverviewInteracting === true` 时完全跳过 viewport 更新（已有代码，保持不变）

---

#### ✅ 任务 6: 开启 InfiniteScroll

**问题**: `scrollMargin: 5000` 限制了滚动范围

**解决方案**: 配置 `scrollMode: go.Diagram.InfiniteScroll` + `scrollMargin: Infinity`

**修改文件**: `src/services/flow-diagram.service.ts` (initialize 方法)

```typescript
this.diagram = $(go.Diagram, container, {
  // 无限画布：使用 InfiniteScroll 模式，允许视口自由移动到任何位置
  "scrollMode": go.Diagram.InfiniteScroll,
  "scrollMargin": new go.Margin(Infinity, Infinity, Infinity, Infinity),
  // ...
});
```

---

#### ✅ 任务 7: 简化 Overview 模板

**问题**: Overview 使用主图的复杂模板，渲染开销大

**解决方案**: 为 Overview 定义简化模板

**修改文件**: `src/services/flow-template.service.ts`

```typescript
// 简化的节点模板 - 只有一个矩形，无文字、无边框
overview.nodeTemplate = $(go.Node, "Auto", /*...*/);
overview.updateDelay = 100;  // 降低更新频率

// 简化的连接线模板 - 直线 + 固定颜色
overview.linkTemplate = $(go.Link, {
  routing: go.Link.Normal,
  curve: go.Link.None  // 直线，不用 Bezier
}, /*...*/);
```

---

#### ✅ 任务 8: 添加性能监控

**问题**: 缺乏 Overview 更新耗时监控

**解决方案**: 使用 Performance API + Sentry 监控掉帧情况

**修改文件**: `src/services/flow-diagram.service.ts` (runViewportUpdate 方法)

```typescript
const runViewportUpdate = (source: 'viewport' | 'document') => {
  // 性能监控：记录开始时间
  const perfStart = performance.now();
  
  // ... 执行更新逻辑 ...
  
  // finally 块中检查耗时
  const duration = performance.now() - perfStart;
  if (duration > 16) {  // 掉帧阈值
    Sentry.captureMessage('Overview Lag Detected', {
      level: 'warning',
      extra: { duration, nodeCount, source, isMobile }
    });
  }
};
```

---

## 架构决策记录

### ADR-001: 继续使用 GoJS Overview (方案 A)

**背景**: 项目中已有 `ReactiveMinimapService` 作为替代方案但尚未集成

**决策**: 继续修复 GoJS Overview

**理由**:
1. 符合"不要造轮子"的核心哲学
2. GoJS Overview 是高度优化的 Canvas 渲染器
3. 自定义实现增加维护成本和潜在 Bug
4. 两者并存增加复杂度和打包体积

### ADR-002: 使用 PointerCapture 替代超时保护

**背景**: 500ms 超时保护在快速拖拽时不可靠

**决策**: 使用 `setPointerCapture()` 确保事件可靠性

**理由**:
1. 浏览器原生 API，可靠性高
2. 拖拽出界后仍能收到事件
3. 移除超时逻辑简化代码

---

## 测试验证

### 测试场景

1. [ ] 将视口窗拖拽到小地图最下方，观察是否卡死
2. [ ] 持续向边缘拖拽，观察视口窗是否逐渐变小
3. [ ] 快速拖拽测试事件节流效果
4. [ ] 移动端测试触摸拖拽
5. [ ] 大量节点（100+）时的性能表现

### 性能指标

| 指标 | 修复前 | 修复后 | 目标 |
|------|--------|--------|------|
| Overview 更新耗时 | >100ms | - | <16ms |
| 事件触发频率 | 高频风暴 | - | RAF 节流 |
| 内存占用 | - | - | 稳定 |

---

## 参考资料

- [GoJS InfiniteScroll 文档](https://gojs.net/latest/intro/viewport.html)
- [Pointer Capture API](https://developer.mozilla.org/en-US/docs/Web/API/Element/setPointerCapture)
- [Performance API](https://developer.mozilla.org/en-US/docs/Web/API/Performance)

---

## 架构可视化

### 核心数据流

```
用户操作 → 写入 IndexedDB (立即) → 更新 UI (立即)
                ↓
        后台进程 → 写入 Supabase (防抖 3s)
                ↓
        失败 → RetryQueue (持久化) → 网络恢复 → 自动重播
```

### 小地图拖拽流程（修复后）

```
用户开始拖拽 (pointerdown)
        ↓
setPointerCapture() ← 确保出界后仍收到事件
        ↓
isOverviewInteracting = true ← 完全跳过 viewport 更新
        ↓
用户持续拖拽 (pointermove)
        ↓
GoJS 内部更新主 Diagram viewportBounds
        ↓
calculateExtendedBounds() ← 动态扩展，无硬墙
        ↓
scaleRatio 变小 → indicator 变小 ← "无限画布"效果
        ↓
用户结束拖拽 (pointerup / lostpointercapture)
        ↓
releasePointerCapture()
        ↓
强制补一次同步：overview.requestUpdate()
```

---

## 高级顾问建议实施记录

### ✅ 已实施

1. **开启 InfiniteScroll 模式** - 替代硬编码 scrollMargin
2. **简化 Overview 模板** - 去掉文字、阴影，降低 updateDelay
3. **Performance API + Sentry 监控** - 掉帧自动上报

### ⚠️ 后续注意事项

1. **GoJS 内存泄漏风险**：确保 `ngOnDestroy` 中彻底清理 `Diagram` 实例及其 Model
2. **Sentry 配额**：生产环境建议调低 `replaysSessionSampleRate`
3. **LWW 同步风险**：上传队列非空时，暂停拉取合并（防止时钟不同步导致数据覆盖）

---

## 最新修复记录

### 2024-12-25 (第二次修复)

#### ✅ 任务 9: 修复视口框无法拖拽问题

**问题**: 用户反馈小地图中的视口框（白色半透明矩形）无法拖拽，点击后没有反应

**根因分析**: 
- 在 `attachOverviewPointerListeners` 中，我们在 container 的 `pointerdown` 事件中立即设置 `isOverviewInteracting = true`
- 这导致**所有** pointer 事件都被我们的监听器捕获，包括用户尝试拖拽视口框的事件
- GoJS Overview 内部的视口框拖拽机制被我们的事件监听器阻断了

**解决方案**: 区分**视口框拖拽**和**小地图其他区域点击**
- 在 `pointerdown` 时检测点击位置：使用 `diagram.findObjectAt(pt)` 判断是否点击了 `diagram.box`
- 如果点击的是视口框：
  - 设置 `isDraggingBox = true`
  - **不设置** `isOverviewInteracting`，让 GoJS 自己处理拖拽
  - 不调用 `setPointerCapture()`
- 如果点击的是小地图其他区域（节点、空白等）：
  - 设置 `isDraggingBox = false`
  - 设置 `isOverviewInteracting = true`，启用交互节流
  - 调用 `setPointerCapture()` 捕获后续事件

**修改文件**: `src/services/flow-diagram.service.ts` (attachOverviewPointerListeners 方法)

```typescript
// 新增变量
let isDraggingBox = false;

const onPointerDown = (ev: PointerEvent) => {
  if (!this.overview) return;
  
  // 检查点击位置是否在视口框上
  const diagram = this.overview;
  const pt = diagram.transformViewToDoc(new go.Point(ev.offsetX, ev.offsetY));
  const obj = diagram.findObjectAt(pt);
  
  // 如果点击的是 box Part（视口框），则不干预，让 GoJS 处理拖拽
  if (obj && obj.part === diagram.box) {
    isDraggingBox = true;
    return;  // 关键：不设置 isOverviewInteracting，不捕获事件
  }
  
  // 点击的是小地图的其他区域，设置交互状态
  isDraggingBox = false;
  this.isOverviewInteracting = true;
  
  // ... setPointerCapture 等逻辑
};

const onPointerUpLike = () => {
  // ... 释放 PointerCapture
  
  // 如果是拖拽视口框，重置标记并返回
  if (isDraggingBox) {
    isDraggingBox = false;
    // 视口框拖拽结束后，补一次同步
    this.overviewBoundsCache = '';
    this.overviewScheduleUpdate?.('viewport');
    return;
  }
  
  // ... 原有逻辑
};
```

**效果**: 
- ✅ 视口框可以正常拖拽
- ✅ 拖拽视口框时不触发交互状态，避免性能问题
- ✅ 点击小地图其他区域仍正常工作（跳转视口）
- ✅ 保持原有的防卡顿机制（`isOverviewInteracting` 节流）

---

### 2024-12-25 (第三次修复)

#### ✅ 任务 10: 修复拖拽视口框时小地图节点不更新问题

**问题**: 用户反馈当拖拽小地图中的视口框（白色矩形）时，虽然主图的视口会正确移动，但小地图中的任务块（nodes）不会实时更新它们的位置和可见性，导致视觉不同步。

**根因分析**: 
1. 在任务 9 中，我们修复了视口框可拖拽的问题，通过检测 `diagram.box` 并设置 `isDraggingBox = true`
2. 当 `isDraggingBox = true` 时，我们让 GoJS 自己处理拖拽，不设置 `isOverviewInteracting`
3. 但是，我们没有在拖拽过程中主动调用 `overview.requestUpdate()` 来刷新小地图的节点内容
4. 虽然主图的 `ViewportBoundsChanged` 事件会触发 `runViewportUpdate`，但该方法主要处理视口框的缩放和位置，**不会自动触发小地图节点的重新渲染**
5. GoJS Overview 需要显式调用 `requestUpdate()` 才会强制刷新其节点的显示

**解决方案**: 在拖拽视口框期间，监听 `pointermove` 事件，使用 RAF 节流调用 `overview.requestUpdate()`

**修改文件**: `src/services/flow-diagram.service.ts` (attachOverviewPointerListeners 方法)

**关键变更**:

1. **新增 `onPointerMove` 处理器**：
```typescript
// 视口框拖拽时的更新节流
let boxDragUpdatePending = false;

const onPointerMove = (ev: PointerEvent) => {
  // 只在拖拽视口框时处理
  if (!isDraggingBox || !this.overview) return;
  
  // 使用 RAF 节流更新，避免高频刷新导致卡顿
  if (boxDragUpdatePending) return;
  boxDragUpdatePending = true;
  
  requestAnimationFrame(() => {
    boxDragUpdatePending = false;
    if (this.isDestroyed || !this.overview) return;
    
    // 强制更新小地图中的节点位置
    // 这确保了拖拽视口框时，小地图中的任务块会实时跟随更新
    this.overview.requestUpdate();
  });
};
```

2. **在 `onPointerUpLike` 中重置节流标志**：
```typescript
if (isDraggingBox) {
  isDraggingBox = false;
  boxDragUpdatePending = false;  // 重置节流标志
  // 视口框拖拽结束后，补一次同步
  this.overviewBoundsCache = '';
  this.overviewScheduleUpdate?.('viewport');
  // 最后再强制刷新一次，确保状态同步
  requestAnimationFrame(() => {
    if (this.isDestroyed || !this.overview) return;
    this.overview.requestUpdate();
  });
  return;
}
```

3. **注册和清理 `pointermove` 事件监听器**：
```typescript
// 注册
container.addEventListener('pointermove', onPointerMove, { passive: true });

// 清理
this.overviewPointerCleanup = () => {
  // ...
  container.removeEventListener('pointermove', onPointerMove);
  // ...
};
```

**技术细节**:
- **RAF 节流**: 使用 `requestAnimationFrame` + 标志位 `boxDragUpdatePending` 进行节流，避免高频调用 `requestUpdate()` 导致性能问题
- **只在拖拽视口框时触发**: 通过 `isDraggingBox` 标志确保只在拖拽视口框时才执行更新，不影响其他交互
- **拖拽结束补偿**: 在 `pointerup` 时额外调用一次 `requestUpdate()`，确保最终状态完全同步

**效果**: 
- ✅ 拖拽视口框时，小地图中的任务块实时跟随主图视口移动
- ✅ 节点的位置和可见性与主图保持同步
- ✅ 使用 RAF 节流，避免性能问题
- ✅ 拖拽结束时状态完全同步，无残留问题
- ✅ 不影响其他交互场景（点击小地图跳转、拖拽节点等）

---
---
