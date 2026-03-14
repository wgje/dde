# Parking Dock 模块化重构策划案

> 版本：v1.5（专注控制台集成版：补全跨项目持久化、专注控制台三区协议、停泊坞命名规范更新）
> 日期：2026-02-27
> 状态：Draft for implementation
> 基线：基于 `state-overlap-design.md` v10.0 全部规范
> 原则：**逻辑微调、模块化拆分、强联动原版**——在不改变 State Overlap v10.0 业务语义的前提下，将停泊坞（Parking Dock）及其关联板块重构为**可独立操控、可拖拽编排、可热插拔的模块化组件体系**。

> **v1.5 新增**：停泊坞正式命名为「**停泊坞**」（Docking Bay），专注控制台三区设计详见 [`focus-console-design.md`](./focus-console-design.md)。本文聚焦模块化组件结构；专注会话状态机、调度算法、UI 规范请以该文件为准。
>
> **2026-03-08 联动补记**：
> - 停泊坞是“本轮专注周期的任务资源池”，不是项目列表副本。
> - 专注控制台当前三区术语统一为：主控台 / 组合选择区域 / 备选区域。
> - 主任务与当前 C 位分离；等待调度只推荐不强切。
> - 专注态就地新建任务统一写入共享黑匣子（`sourceProjectId=null`），退出专注不强制归档，后续由用户在共享仓内手动归档。

---

## 目录

1. [M1. 模块化目标与设计哲学](#m1-模块化目标与设计哲学)
2. [M2. 静态组合与懒加载策略](#m2-静态组合与懒加载策略)
3. [M3. 停泊坞容器模块（DockShell）](#m3-停泊坞容器模块dockshell)
4. [M4. 停泊卡片模块（ParkCard）](#m4-停泊卡片模块parkcard)
5. [M5. 预览面板模块（PreviewPane）](#m5-预览面板模块previewpane)
6. [M6. 通知条模块（NoticeBar）](#m6-通知条模块noticebar)
7. [M7. 触发条模块（TriggerCapsule）](#m7-触发条模块triggercapsule)
8. [M8. 提醒徽章模块（ReminderBadge）](#m8-提醒徽章模块reminderbadge)
9. [M9. 拖拽编排系统（DragOrchestrator）](#m9-拖拽编排系统dragorchestrator)
10. [M10. 模块间通信总线（ModuleBus）](#m10-模块间通信总线modulebus)
11. [M11. 与原板块强联动映射表](#m11-与原板块强联动映射表)
12. [M12. 数据流与状态切片](#m12-数据流与状态切片)
13. [M13. 布局引擎与槽位系统](#m13-布局引擎与槽位系统)
14. [M14. 模块生命周期管理](#m14-模块生命周期管理)
15. [M15. 移动端适配策略](#m15-移动端适配策略)
16. [M16. 配置常量（模块化扩展）](#m16-配置常量模块化扩展)
17. [M17. 实施路线图](#m17-实施路线图)
18. [M18. 验收标准](#m18-验收标准)
19. [M19. UX/DX 极致优化增补（17 项高价值改进）](#m19-uxdx-极致优化增补17-项高价值改进)

---

## M1. 模块化目标与设计哲学

### M1.1 为什么需要模块化

现有 `ParkingDockComponent`（840 行）承载了触发条、列表、预览、动画、移动端适配、键盘导航等全部逻辑。随着 State Overlap 功能深入，单文件组件面临：

1. **维护困难**：修改预览区备注功能时可能影响触发条脉冲动画。
2. **复用受限**：停泊卡片无法在搜索结果、Spotlight 队列等其他场景复用。
3. **编排僵化**：用户无法调整模块位置（如把触发条从底部移到侧栏）。
4. **测试隔离差**：集成测试覆盖面大，难以单独验证某个子功能。

### M1.2 设计目标

| 目标 | 描述 |
|------|------|
| 模块可独立渲染 | 每个模块是独立 Angular standalone 组件，通过静态模板组合 |
| 模块可拖拽排序 | 停泊卡片支持用户拖拽调整位置，支持拖出坞外移除 |
| 按需懒加载 | 核心骨架优先渲染，内部模块使用 `@defer` 延迟加载 |
| 逻辑不变语义不破 | 所有模块行为严格遵循 `state-overlap-design.md` A1-A15 规范 |
| 与原板块强联动 | 每个模块与原策划案的对应章节一一映射，无孤立设计 |
| **新手友好（DX）** | 开发者只需看懂 `DockShell` 的 HTML 模板即可上手，无需理解 Registry/Slot 映射 |
| **操作友好（UX）** | 提供快捷备注、拖拽视觉反馈、全键盘流、教育性空状态等微交互 |

### M1.3 设计约束

1. **不引入第三方拖拽库**（ng-dnd、angular-gridster 等）——复用现有 `TextViewDragDropService` 的 HTML5 native drag + touch 模式，保持技术栈统一。
2. **不破坏 Hard Rules**：ID 客户端生成、LWW、Offline-first、OnPush、Signals 架构全部保留。
3. **不改变对外服务契约**：`ParkingService` 的 `previewTask/startWork/removeParkedTask/undoEviction` 四方法签名不变。
4. **移动端行为保真**：模块化拆分不改变移动端 Bottom Sheet 体验。

### M1.4 核心隐喻：船坞（Dock）与集装箱（Container）

停泊坞是一个**船坞**，模块是**集装箱**：

- **船坞（DockShell）**提供布局骨架、动画、展开/收起逻辑。
- **集装箱（各模块）**携带独立内容，可被吊装到不同泊位。
- **龙门吊（DragOrchestrator）**负责集装箱的搬运与排列。
- **港口信号塔（ModuleBus）**协调集装箱之间的通信。

---

## M2. 静态组合与懒加载策略

### M2.1 架构去伪存真——「做减法」

> **决策记录**：曾评估过"动态模块注册表（Module Registry）"方案——即定义 `DockModuleDescriptor`，声明每个模块的 `defaultSlot`、`draggable`、`resizable` 等能力，试图打造一个"动态插槽 + 自由拖拽"的 Dashboard 引擎。
>
> **否决原因**：
> 1. 停泊坞的布局**具有强业务语义**（左列表 + 右预览），允许用户随意拖拽模块到任意位置（如把预览拖到左边、把触发条拖到列表里）不仅毫无业务价值，还会导致 UI 崩溃。
> 2. 动态注册表引入了 Registry → Slot 映射 → 运行时渲染决策的额外状态管理层，**新开发者需要理解 3 层间接调用才能上手**，严重违反项目"不要造轮子"的核心哲学。
> 3. M3.3 的宿主模板已经是 Angular 静态模板（`<app-trigger-capsule slot="trigger" />`），动态注册表与之矛盾，形成"配置说一套、模板做另一套"的认知割裂。
> 4. 砍掉此方案预计**节省约 20% 的冗余代码开发量**（省去 Registry 服务、Descriptor 接口、运行时槽位解析、测试 mock）。

因此，**明确采用静态模板组合（Static Composition）+ @defer 懒加载**：

1. **骨架固定**：`DockShell` 内部的槽位（Slot）是硬编码在 Angular 模板中的，保证布局的绝对稳定。开发者只需看懂 `DockShell` 的 HTML 模板即可上手。
2. **按需加载**：利用 Angular 的 `@defer` 机制，只有在停泊坞展开时，才加载内部的列表、预览等重型组件。
3. **局部自定义**：仅保留两个真正有价值的用户自定义能力：
   - **分割线拖拽调整比例**（M13.3）——用户调整列表/预览的宽度占比。
   - **卡片上下拖拽排序**（M9）——用户调整停泊任务的优先级顺序。
4. **不暴露的能力**：模块不可跨槽位拖拽、不可移除/隐藏、不可替换为其他组件。这些是"伪需求"，屏蔽它们才能确保 UI 的稳定性和可维护性。

### M2.2 用户自定义布局持久化

```typescript
/**
 * 用户自定义停泊坞布局——持久化到 localStorage。
 * 
 * 联动：A14 假设与默认值（UiStateService 停泊坞状态）
 * Key: 'nanoflow:dock-layout'
 * 
 * 注意：不包含任何"模块描述符"或"插槽映射"字段。
 * 布局结构由 DockShell 模板静态定义，此处仅存储用户偏好。
 */
interface DockUserLayout {
  version: number;             // 布局版本号（升级时可迁移）
  /** 用户自定义比例（列表与预览的宽度比，默认 0.4） */
  listRatio: number;
  /** 卡片自定义排序（用户拖拽排序后的 taskId 顺序） */
  cardOrder: string[] | null;  // null = 使用默认 parkedAt 降序
}
```

---

## M3. 停泊坞容器模块（DockShell）

### M3.1 职责定义

`DockShellComponent` 是停泊坞的**骨架容器**，只负责：

1. 管理展开/收起状态与动画
2. 提供槽位（slots）供子模块挂载
3. 计算定位锚点（Resizer 中心）
4. 响应键盘快捷键（Escape 收起、Alt+Shift+P 展开）
5. 委派点击外区域收起

**不负责**：卡片渲染、预览内容、通知逻辑——这些全部下沉到子模块。

### M3.2 联动映射

| DockShell 职责 | 原策划案章节 | 说明 |
|----------------|-------------|------|
| 展开/收起状态 | A6.9.3 / A6.9.4 | 收起态胶囊、展开态面板 |
| 定位锚点 | A6.9.1 / A6.9.5 | Resizer 中心 / 移动端视口底部 |
| 键盘快捷键 | A6.1 / A6.7 | Alt+Shift+P / Escape |
| 动画 | A6.9.4 `DOCK_ANIMATION_MS=200` | slide-up / slide-down |
| 移动端 Bottom Sheet | A6.9.5 | 100vw × 60vh，可拖拽至 70vh |
| 与 Toast 层级 | A6.9.7 | z-index 低于 Toast |
| UiState 协同 | A15.2 UiStateService 行 | `isParkingDockOpen` signal |
| **跨项目持久化** | **focus-console-design.md §2.5** | **切换项目时 DockShell 不销毁不重建，内容保持不变。DockShell 挂载在应用层（AppShell），而非项目层（ProjectShell）** |

> **⚠️ v1.5 架构变更**：停泊坞正式命名为**停泊坞**（Docking Bay），其 DockShell 宿主从 `ProjectShellComponent` 迁移至 `AppShellComponent`，确保跨项目切换时停泊坞状态完整保持。相关模块集成模板调整如下：
>
> ```html
> <!-- AppShellComponent 模板（替代 ProjectShellComponent 中的停泊坞） -->
> @defer (on timer(300)) {
>   <app-dock-shell>
>     <app-trigger-capsule slot="trigger" />
>     <app-dock-header slot="header" />
>     <app-park-card-list slot="list" />
>     <app-preview-pane slot="preview" />
>     <app-notice-bar slot="notice" />
>   </app-dock-shell>
> }
> ```

### M3.3 组件设计

```typescript
/**
 * DockShellComponent——停泊坞骨架容器
 * 
 * 槽位系统：
 *   [trigger-slot]       ← 收起态时渲染触发条模块
 *   [header-slot]        ← 展开态顶部栏
 *   [list-slot]          ← 展开态左半区
 *   [preview-slot]       ← 展开态右半区
 *   [notice-slot]        ← 通知覆盖层
 * 
 * 联动：A6.9 全部布局规范 + A3.2 Hard Rules 对齐
 */
@Component({
  selector: 'app-dock-shell',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <!-- 收起态：仅渲染 TriggerCapsule -->
    @if (!isExpanded()) {
      <div class="dock-trigger-slot" [style.left.px]="anchorX()">
        <ng-content select="[slot=trigger]" />
      </div>
    }

    <!-- 展开态：骨架面板 -->
    @if (isExpanded()) {
      <!-- 背景遮罩（点击收起） -->
      <div class="dock-backdrop" (click)="collapse()"></div>

      <div class="dock-panel"
           [class.dock-mobile-sheet]="isMobile()"
           [style.left.px]="panelLeft()"
           [style.width.px]="panelWidth()"
           [style.height]="panelHeight()">

        <!-- 顶部栏槽位 -->
        <div class="dock-header-slot">
          <ng-content select="[slot=header]" />
        </div>

        <!-- 主体区域：列表 + 预览 -->
        <div class="dock-body" [style.grid-template-columns]="bodyColumns()">
          <!-- 左半区：卡片列表 -->
          <div class="dock-list-slot">
            <ng-content select="[slot=list]" />
          </div>

          <!-- 分割线（可拖拽调整比例） -->
          @if (!isMobile()) {
            <div class="dock-divider"
                 (mousedown)="startDividerResize($event)">
            </div>
          }

          <!-- 右半区：预览面板 -->
          @if (!isMobile()) {
            <div class="dock-preview-slot">
              <ng-content select="[slot=preview]" />
            </div>
          }

          <!-- 移动端：预览内联展开在列表下方 -->
          @if (isMobile()) {
            <ng-content select="[slot=preview]" />
          }
        </div>
      </div>
    }

    <!-- 通知覆盖层（始终可渲染，不受展开/收起影响） -->
    <ng-content select="[slot=notice]" />
  `
})
export class DockShellComponent {
  // 注入
  private readonly uiState = inject(UiStateService);
  private readonly el = inject(ElementRef);
  
  // 状态
  readonly isExpanded = signal(false);
  readonly listRatio = signal(PARKING_CONFIG.DOCK_LIST_RATIO); // 默认 0.4
  
  // 派生
  readonly isMobile = this.uiState.isMobile;
  readonly anchorX = computed(() => {
    // A6.9.5：Resizer 中心位置
    const ratio = this.uiState.contentColumnRatio();
    const width = this.el.nativeElement.offsetWidth;
    return ratio * width;
  });
  readonly panelWidth = computed(() => {
    if (this.isMobile()) return window.innerWidth;
    const vw = window.innerWidth;
    return Math.min(PARKING_CONFIG.DOCK_EXPANDED_MAX_WIDTH, Math.max(480, vw * 0.4));
  });
  readonly panelLeft = computed(() => this.anchorX() - this.panelWidth() / 2);
  readonly panelHeight = computed(() => {
    if (this.isMobile()) return '60vh';
    return `clamp(280px, ${PARKING_CONFIG.DOCK_EXPANDED_HEIGHT_VH}vh, min(480px, 70vh))`;
  });
  readonly bodyColumns = computed(() =>
    this.isMobile() ? '1fr' : `${this.listRatio()}fr ${1 - this.listRatio()}fr`
  );

  expand() { this.isExpanded.set(true); }
  collapse() { this.isExpanded.set(false); }
  toggle() { this.isExpanded.update(v => !v); }

  @HostListener('document:keydown', ['$event'])
  onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape' && this.isExpanded()) {
      this.collapse();
      e.preventDefault();
    }
  }

  startDividerResize(event: MouseEvent) {
    // 拖拽分割线调整 listRatio（同 ProjectShell Resizer 模式）
  }
}
```

### M3.4a 开发环境 Signal 状态监视器（Debug Panel）

> **M19.8 增补**：在开发环境下，DockShell 底部渲染一个微型半透明状态条，实时打印关键 Signal 值，极大降低新人理解数据流的门槛。

```typescript
/**
 * DockDebugPanelComponent——开发环境专属 Signal 状态监视器
 * 
 * 仅在 isDevMode() 下渲染，生产环境自动消失（tree-shaking 友好）。
 * 实时显示停泊坞核心 Signal 状态，帮助新开发者快速理解数据流。
 */
@Component({
  selector: 'app-dock-debug-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (isDevMode) {
      <div class="dock-debug-panel"
           [class.dock-debug-panel--collapsed]="isCollapsed()"
           (dblclick)="isCollapsed.update(v => !v)">
        @if (!isCollapsed()) {
          <div class="dock-debug-panel__row">
            <span class="dock-debug-panel__label">selectedCardId:</span>
            <span class="dock-debug-panel__value">{{ bus.selectedCardId() ?? 'null' }}</span>
          </div>
          <div class="dock-debug-panel__row">
            <span class="dock-debug-panel__label">isDragging:</span>
            <span class="dock-debug-panel__value">{{ bus.isAnyCardDragging() }}</span>
          </div>
          <div class="dock-debug-panel__row">
            <span class="dock-debug-panel__label">listRatio:</span>
            <span class="dock-debug-panel__value">{{ shell.listRatio() | number:'1.2-2' }}</span>
          </div>
          <div class="dock-debug-panel__row">
            <span class="dock-debug-panel__label">parkedCount:</span>
            <span class="dock-debug-panel__value">{{ parkedCount() }}</span>
          </div>
          <div class="dock-debug-panel__row">
            <span class="dock-debug-panel__label">customOrder:</span>
            <span class="dock-debug-panel__value">{{ dragOrch.customCardOrder() ? 'active' : 'default' }}</span>
          </div>
        } @else {
          <span class="dock-debug-panel__minimized">🔧 Debug</span>
        }
      </div>
    }
  `,
  styles: [`
    .dock-debug-panel {
      position: absolute;
      bottom: 0;
      left: 0;
      right: 0;
      background: rgba(0, 0, 0, 0.75);
      color: #0f0;
      font-family: 'Cascadia Code', monospace;
      font-size: 11px;
      padding: 4px 8px;
      z-index: 9999;
      user-select: text;
      cursor: default;
    }
    .dock-debug-panel--collapsed {
      padding: 2px 8px;
      text-align: center;
      cursor: pointer;
    }
    .dock-debug-panel__row {
      display: flex;
      gap: 8px;
    }
    .dock-debug-panel__label { opacity: 0.7; }
    .dock-debug-panel__value { color: #0ff; }
  `]
})
export class DockDebugPanelComponent {
  readonly isDevMode = isDevMode();
  readonly isCollapsed = signal(false);
  
  readonly bus = inject(DockModuleBus);
  readonly shell = inject(DockShellComponent);
  readonly dragOrch = inject(DockDragOrchestratorService);
  readonly parkedCount = computed(() => inject(ParkingService).parkedTasks().length);
}
```

**集成方式**：在 DockShell 模板的 `dock-panel` 内末尾追加：

```html
<!-- 开发环境 Signal 状态监视器（仅 isDevMode 渲染，生产环境不占用任何体积） -->
<app-dock-debug-panel />
```

### M3.4 宿主模板集成

```html
<!-- ProjectShellComponent 模板（替换原单一 <app-parking-dock>） -->
@defer (on timer(300)) {
  <app-dock-shell>
    <app-trigger-capsule slot="trigger" />
    <app-dock-header slot="header" />
    <app-park-card-list slot="list" />
    <app-preview-pane slot="preview" />
    <app-notice-bar slot="notice" />
  </app-dock-shell>
}
```

---


### M3.5 全键盘操作流（Full Keyboard Workflow）

> 高级用户应能**完全脱离鼠标**，仅通过键盘极速处理停泊任务。

#### 焦点管理规则

| 动作 | 快捷键 | 行为 | 焦点变化 |
|------|--------|------|---------|
| 展开停泊坞 | `Alt+Shift+P` | 展开 DockShell | **焦点自动落在列表第一张卡片** |
| 浏览列表 | `↑` / `↓` | 上/下移动选中卡片 | 预览区同步更新为当前选中卡片 |
| 切换到任务 | `Enter` | 执行 `startWork(selectedTaskId)` | 停泊坞收起，焦点回到任务编辑区 |
| 移回任务列表 | `Delete` / `Backspace` | 执行 `removeParkedTask(selectedTaskId)` | 焦点移到下一张卡片（如无则上一张） |
| 卡片排序上移 | `Alt+↑` | 将当前卡片上移一位（同拖拽排序） | 焦点跟随卡片 |
| 卡片排序下移 | `Alt+↓` | 将当前卡片下移一位（同拖拽排序） | 焦点跟随卡片 |
| 跳转预览备注 | `Tab` | 焦点从卡片列表跳到预览区备注输入框 | — |
| 返回列表 | `Shift+Tab` | 焦点从预览区回到卡片列表 | — |
| 收起停泊坞 | `Escape` | 收起 DockShell | 焦点回到触发展开前的元素 |

#### 焦点陷阱（Focus Trap）

展开态的 DockShell 应实现焦点陷阱：`Tab` 循环在坞内元素间流转，不泄露到背后的 ProjectShell。按 `Escape` 退出陷阱并收起。

```typescript
// DockShell 展开时的焦点管理
expand(): void {
  this.isExpanded.set(true);
  this.previousFocus = document.activeElement as HTMLElement;  // 记住展开前焦点
  // 下一帧将焦点放到第一张卡片
  requestAnimationFrame(() => {
    const firstCard = this.el.nativeElement.querySelector('.park-card');
    firstCard?.focus();
  });
}

collapse(): void {
  this.isExpanded.set(false);
  // 焦点回到展开前的元素
  this.previousFocus?.focus();
}
```

#### 键盘导航与拖拽的等价性

| 鼠标/触控操作 | 键盘等价操作 | 同一底层方法 |
|-------------|------------|------------|
| 拖拽卡片到上方 | `Alt+↑` | `DockDragOrchestratorService.moveCardUp(taskId)` |
| 拖拽卡片到下方 | `Alt+↓` | `DockDragOrchestratorService.moveCardDown(taskId)` |
| 拖拽卡片出坞外 | `Delete` | `ParkingService.removeParkedTask(taskId)` |
| 点击卡片 | `↑`/`↓` 选中 + 自动预览 | `DockModuleBus.selectCard(taskId)` |
| 点击 [切换到此任务] | `Enter` | `ParkingService.startWork(taskId)` |

## M4. 停泊卡片模块（ParkCard）

### M4.1 职责定义

**ParkCardComponent** 是单张停泊卡片的独立渲染单元。**ParkCardListComponent** 管理卡片列表的排序、滚动、拖拽排序。

### M4.2 联动映射

| ParkCard 特性 | 原策划案章节 | 说明 |
|---------------|-------------|------|
| 卡片内容 | A6.9.4 左半区 | 标题、项目名、停泊时长、状态标签 |
| 即将清理标签 | A6.4.1 + A2.5 | 64h+ 橙色 inline 标签（原位不移动） |
| 已固定图标 | A6.4.7 | pinned=true 显示图钉图标 |
| 提醒徽章 | A5.3.5 | 连续兜底淡出 2 次后小红点 |
| 排序 | A2.5 | parkedAt 降序 + 即将到期置顶 |
| 删除按钮 | A6.2b | × 按钮 + hover Tooltip "移回任务列表" |
| 选中态 | A6.1b.4 | 同时只能预览一个任务 |
| 左侧标记条 | A6.9.8 | 3px 靛蓝色边框 |
| 拖拽排序 | **新增（模块化）** | 用户可拖拽卡片调整停泊列表顺序 |

### M4.3 单卡片组件

```typescript
/**
 * ParkCardComponent——单张停泊卡片
 * 
 * 独立渲染单元，支持：
 * - 点击选中（触发预览）
 * - 拖拽排序（在列表内重排）
 * - 拖拽到外部（移回普通任务列表——释放在停泊坞外自动执行 removeParkedTask）
 * 
 * 联动：A6.9.4 + A6.4 + A6.2b
 */
@Component({
  selector: 'app-park-card',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="park-card"
         [class.park-card--selected]="isSelected()"
         [class.park-card--dragging]="isDragging()"
         [attr.draggable]="true"
         [attr.data-task-id]="task().id"
         [attr.aria-selected]="isSelected()"
         [attr.aria-label]="ariaLabel()"
         role="option"
         (click)="onCardClick()"
         (dblclick)="onDoubleClick()"
         (contextmenu)="onContextMenu($event)"
         (keydown.enter)="onEnterPress()"
         (dragstart)="onDragStart($event)"
         (dragend)="onDragEnd($event)"
         tabindex="0">

      <!-- 左侧标记条（3px 靛蓝色） -->
      <div class="park-card__marker"></div>

      <!-- 卡片主体 -->
      <div class="park-card__body">
        <!-- 标题行 -->
        <div class="park-card__title">
          {{ task().title }}
          <!-- 提醒徽章（M8 模块内联） -->
          @if (hasBadge()) {
            <app-reminder-badge [taskId]="task().id" />
          }
        </div>

        <!-- 项目名 + 停泊时长 -->
        <div class="park-card__meta">
          <span class="park-card__project">{{ projectName() }}</span>
          <span class="park-card__duration">{{ parkDuration() }}</span>
        </div>

        <!-- 状态标签区 -->
        <div class="park-card__tags">
          @if (isStaleWarning()) {
            <span class="park-card__tag park-card__tag--stale">即将清理</span>
          }
          @if (isPinned()) {
            <span class="park-card__tag park-card__tag--pinned" title="已固定，不自动清理">📌</span>
          }
          @if (reminderCountdown()) {
            <span class="park-card__tag park-card__tag--reminder">⏰ {{ reminderCountdown() }}</span>
          }
        </div>
      </div>

      <!-- 操作区 -->
      <div class="park-card__actions">
        <!-- 桌面端 × 按钮 -->
        @if (!isMobile()) {
          <button class="park-card__remove"
                  (click)="onRemove($event)"
                  title="移回任务列表"
                  aria-label="移回任务列表">
            ×
          </button>
        }

                <!-- 移动端：更多菜单（拖拽的无障碍替代方案） -->
        @if (isMobile()) {
          <button class="park-card__more-menu"
                  (click)="onMoreMenu($event)"
                  aria-label="更多操作"
                  title="更多操作">
            ⋮
          </button>
          @if (showMoreMenu()) {
            <div class="park-card__menu-dropdown" role="menu">
              <button role="menuitem" (click)="onMoveUp()">↑ 上移一层</button>
              <button role="menuitem" (click)="onMoveDown()">↓ 下移一层</button>
              <button role="menuitem" (click)="onMoveToTop()">⤒ 置顶</button>
              <button role="menuitem" (click)="onRemove($event)">✕ 移回任务列表</button>
            </div>
          }
        }

        <!-- 桌面端：拖拽手柄（模块化新增） -->
        @if (!isMobile()) {
          <div class="park-card__drag-handle"
               aria-label="拖拽排序"
               title="拖拽排序">
            ⠿
          </div>
        }
      </div>
      </div>    </div>
  `,
  inputs: ['task', 'isSelected', 'isMobile'],
  outputs: ['cardClick', 'cardDoubleClick', 'cardRemove', 'cardDragStart', 'cardDragEnd', 'cardTogglePin', 'cardSetReminder']
})
export class ParkCardComponent {
  task = input.required<Task>();
  isSelected = input(false);
  isMobile = input(false);
  
  cardClick = output<string>();
  cardDoubleClick = output<string>();   // M19.1 双击极速切换
  cardRemove = output<string>();
  cardDragStart = output<DragEvent>();
  cardDragEnd = output<DragEvent>();
  cardMoveUp = output<string>();
  cardMoveDown = output<string>();
  cardMoveToTop = output<string>();
  cardTogglePin = output<string>();     // M19.2 右键菜单固定
  cardSetReminder = output<string>();   // M19.2 右键菜单提醒
  
  // 派生状态
  projectName = computed(() => /* 从 ProjectStore 获取 */);
  parkDuration = computed(() => /* 计算停泊时长 */);
  isStaleWarning = computed(() => /* 64h+ && !pinned */);
  isPinned = computed(() => this.task().parkingMeta?.pinned ?? false);
  reminderCountdown = computed(() => /* < 1h 到期的倒计时 */);
  hasBadge = computed(() => /* badgedTaskIds 包含该 taskId */);
  isDragging = signal(false);
  showMoreMenu = signal(false);
  showContextMenu = signal(false);      // M19.2 右键菜单状态
  contextMenuPos = signal({ x: 0, y: 0 });
  ariaLabel = computed(() =>
    `停泊任务: ${this.task().title}, 项目: ${this.projectName()}, 停泊: ${this.parkDuration()}`
  );

  /** M19.1 双击极速切换——双击卡片直接执行 startWork 并收起停泊坨 */
  onDoubleClick(): void {
    this.cardDoubleClick.emit(this.task().id);
  }

  /** M19.2 桌面端右键上下文菜单——零视线转移快捷操作 */
  onContextMenu(event: MouseEvent): void {
    if (this.isMobile()) return; // 移动端使用“更多菜单”替代
    event.preventDefault();
    this.contextMenuPos.set({ x: event.offsetX, y: event.offsetY });
    this.showContextMenu.set(true);
    // 点击其他区域时关闭
    const close = () => { this.showContextMenu.set(false); document.removeEventListener('click', close); };
    document.addEventListener('click', close, { once: true });
  }
}
```

### M4.4 卡片列表组件（含拖拽排序）

```typescript
/**
 * ParkCardListComponent——停泊卡片列表容器
 * 
 * 管理排序、滚动、卡片间拖拽换位。
 * 
 * 拖拽排序规则：
 * - 卡片内拖拽：用户手动调整停泊列表顺序（覆盖默认 parkedAt 降序）
 * - 拖拽到坞外：等同 removeParkedTask（移回普通列表，5s Snackbar 可撤回）
 * - 拖拽到坞外的任务列表区域：等同 removeParkedTask（同上）
 * - 用户自定义排序持久化到 DockUserLayout.cardOrder
 * 
 * 联动：A2.5 排序规则 + A6.2b 移除撤回
 */
@Component({
  selector: 'app-park-card-list',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="card-list"
         role="listbox"
         aria-label="停泊任务列表"
         (dragover)="onDragOver($event)"
         (drop)="onDrop($event)"
         (dragleave)="onDragLeave($event)">

      <!-- M19.3 一键恢复默认排序（仅在用户自定义排序激活时显示） -->
      @if (hasCustomOrder()) {
        <div class="card-list__sort-reset">
          <button class="card-list__reset-btn"
                  (click)="resetSortOrder()"
                  aria-label="恢复默认排序"
                  title="清除自定义排序，恢复按停泊时间降序">
            ↺ 恢复默认排序
          </button>
        </div>
      }

      @for (task of sortedTasks(); track task.id) {
        <app-park-card
          [task]="task"
          [isSelected]="selectedTaskId() === task.id"
          [isMobile]="isMobile()"
          (cardClick)="onCardSelect(task.id)"
          (cardDoubleClick)="onCardDoubleClick(task.id)"
          (cardRemove)="onCardRemove(task.id)"
          (cardDragStart)="onCardDragStart($event, task.id)"
          (cardDragEnd)="onCardDragEnd($event, task.id)" />

        <!-- 放置指示线（拖拽排序时显示） -->
        @if (dropIndicatorIndex() === $index) {
          <div class="card-list__drop-indicator"></div>
        }

        <!-- M19.5 撤销操作的“原位幽灵”占位条（In-place Undo Ghost） -->
        @if (undoGhostTaskId() === task.id) {
          <div class="card-list__undo-ghost"
               role="status"
               aria-live="polite">
            <span>已移除</span>
            <button class="card-list__undo-btn"
                    (click)="onUndoRemove(task.id)"
                    aria-label="撤销移除">
              撤销
            </button>
          </div>
        }
      }

      <!-- 空态——教育性引导（新手引导位） -->
      @if (sortedTasks().length === 0) {
        <div class="card-list__empty card-list__empty--dropzone"
             role="region"
             aria-label="空停泊列表引导区">
          <div class="card-list__empty-icon">🚢</div>
          <p class="card-list__empty-title">暂无停泊任务</p>
          <p class="card-list__empty-hint">
            将任务拖拽至此处，或在任务上按 <kbd>Alt+P</kbd> 快速停泊
          </p>
          <div class="card-list__empty-dropzone">
            <!-- 虚线框放置区，dragover 时高亮 -->
          </div>
        </div>
      }

      <!-- 软上限警告（A2.4 PARKED_TASK_SOFT_LIMIT = 10） -->
      @if (sortedTasks().length >= softLimit) {
        <div class="card-list__warning">
          停泊任务较多（{{ sortedTasks().length }}），建议处理部分任务
        </div>
      }
    </div>
  `
})
export class ParkCardListComponent {
  private readonly parkingService = inject(ParkingService);
  private readonly dragOrchestrator = inject(DockDragOrchestratorService);

  selectedTaskId = input<string | null>(null);
  isMobile = input(false);

  taskSelected = output<string>();

  readonly softLimit = PARKING_CONFIG.PARKED_TASK_SOFT_LIMIT;

  // M19.3 是否有自定义排序
  readonly hasCustomOrder = computed(() => this.dragOrchestrator.customCardOrder() !== null);

  // M19.5 撤销幽灵状态（显示 5s 后自动消失）
  readonly undoGhostTaskId = signal<string | null>(null);
  private undoGhostTimer: ReturnType<typeof setTimeout> | null = null;

  // 排序逻辑：用户自定义顺序 > 默认 parkedAt 降序
  sortedTasks = computed(() => {
    const parked = this.parkingService.parkedTasks();
    const customOrder = this.dragOrchestrator.customCardOrder();
    if (customOrder) {
      return this.applyCustomOrder(parked, customOrder);
    }
    return this.applyDefaultSort(parked);
  });

  // 拖拽排序事件处理
  onCardDragStart(event: DragEvent, taskId: string) {
    this.dragOrchestrator.startCardDrag(taskId, event);
  }
  onDragOver(event: DragEvent) {
    this.dragOrchestrator.handleDragOver(event);
    event.preventDefault();
  }
  onDrop(event: DragEvent) {
    this.dragOrchestrator.handleDrop(event);
  }
  onCardDragEnd(event: DragEvent, taskId: string) {
    this.dragOrchestrator.endCardDrag(taskId);
  }

  /** M19.1 双击极速切换——直接执行 startWork 并收起停泊坨 */
  onCardDoubleClick(taskId: string): void {
    this.parkingService.startWork(taskId);
  }

  /** M19.3 一键恢复默认排序 */
  resetSortOrder(): void {
    this.dragOrchestrator.customCardOrder.set(null);
    this.dragOrchestrator.persistLayout();
  }

  /** M19.5 撤销幽灵——卡片移除时原位显示可撤销占位条，5s 后消失 */
  onCardRemove(taskId: string): void {
    this.parkingService.removeParkedTask(taskId);
    // 显示原位幽灵
    this.undoGhostTaskId.set(taskId);
    if (this.undoGhostTimer) clearTimeout(this.undoGhostTimer);
    this.undoGhostTimer = setTimeout(() => this.undoGhostTaskId.set(null), 5000);
  }

  /** M19.5 撤销幽灵——点击撤销 */
  onUndoRemove(taskId: string): void {
    this.parkingService.undoEviction(taskId);
    this.undoGhostTaskId.set(null);
    if (this.undoGhostTimer) clearTimeout(this.undoGhostTimer);
  }
}
```

---

## M5. 预览面板模块（PreviewPane）

### M5.1 职责定义

`PreviewPaneComponent` 承载选中停泊卡片的详情预览——标题可编辑、内容摘要、锚点信息、「+ 备注」输入框、`[切换到此任务]` 按钮。

### M5.2 联动映射

| PreviewPane 特性 | 原策划案章节 | 说明 |
|-----------------|-------------|------|
| 状态明示文案 | A15.1.1 | "稍后处理中（未切换到此任务）" |
| 标题可编辑 | A6.1b.3 | 修改 Task.title，3s 防抖同步 |
| + 备注 | A6.1b.3 | 占位文案 "添加一条备注…"，追加到 content 末尾 |
| 正文不可编辑 | A6.1b.3 | 保护 contentHash 有效性 |
| 切换按钮 | A2.3 / A6.1 | `[切换到此任务]` 唯一切换入口 |
| Spotlight 置灰 | A3.8 | Spotlight 激活时按钮置灰 + Tooltip |
| 锚点信息展示 | A4 structuralAnchor | fallback 且与标题重复时不显示 |
| 更多菜单（移动端） | A6.2 | 移回任务列表、设置提醒、固定/取消固定 |

### M5.3 组件设计

```typescript
/**
 * PreviewPaneComponent——停泊任务预览面板
 * 
 * 联动：A6.1b + A15.1.1 + A3.8
 * 
 * 设计约束：
 * - 不允许自由编辑 content 正文（A6.1b.3）
 * - 视觉上与"正在工作中的编辑器"明显区分（字号较小、背景色区分、无焦点光标）
 * - 预览刷新 lastVisitedAt（A6.1b.5）
 */
@Component({
  selector: 'app-preview-pane',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (task()) {
      <div class="preview-pane">
        <!-- 状态明示（A15.1.1） -->
        <div class="preview-pane__status-banner">
          稍后处理中（未切换到此任务）
        </div>

        <!-- 标题（可编辑——A6.1b.3） -->
        <input class="preview-pane__title"
               [value]="task()!.title"
               (input)="onTitleChange($event)"
               aria-label="任务标题" />

        <!-- 锚点信息 -->
        @if (showAnchorInfo()) {
          <div class="preview-pane__anchor">
            📍 {{ anchorLabel() }}
          </div>
        }

        <!-- 内容摘要（只读） -->
        <div class="preview-pane__content-readonly">
          {{ contentPreview() }}
        </div>

        <!-- 停泊时长与项目信息 -->
        <div class="preview-pane__meta">
          <span>{{ projectName() }}</span>
          <span>已停泊 {{ parkDuration() }}</span>
        </div>

        <!-- + 备注（A6.1b.3）——含快捷标签 -->
        <div class="preview-pane__note-section">
          <!-- 快捷备注标签（Quick Notes Chips）——减少打字成本 -->
          <div class="preview-pane__quick-chips" role="group" aria-label="快捷备注">
            @for (chip of quickNoteChips; track chip) {
              <button class="preview-pane__chip"
                      (click)="appendQuickNote(chip)"
                      [attr.aria-label]="'追加备注: ' + chip">
                {{ chip }}
              </button>
            }
          </div>

          <!-- 自由输入 -->
          <div class="preview-pane__note-input">
            <input [value]="noteInput()"
                   (input)="noteInput.set($any($event.target).value)"
                   (keydown.enter)="submitNote()"
                   placeholder="添加一条备注…"
                   aria-label="添加备注" />
            @if (noteInput()) {
              <button (click)="submitNote()" aria-label="提交备注">↵</button>
            }
          </div>
        </div>

        <!-- 主操作区 -->
        <div class="preview-pane__actions">
          <button class="preview-pane__switch-btn"
                  [disabled]="isSpotlightActive()"
                  [title]="switchBtnTooltip()"
                  (click)="onSwitchToTask()">
            切换到此任务
          </button>

          <!-- 提醒设置 -->
          <button (click)="toggleReminderMenu()" aria-label="设置提醒">
            ⏰ 提醒
          </button>

          <!-- 固定/取消固定 -->
          <button (click)="togglePinned()" [attr.aria-label]="isPinned() ? '取消固定' : '固定'">
            {{ isPinned() ? '📌 已固定' : '📍 固定' }}
          </button>
        </div>

        <!-- 提醒预设菜单（A6.5） -->
        @if (showReminderMenu()) {
          <div class="preview-pane__reminder-menu">
            <button (click)="setReminder('5m')">5 分钟</button>
            <button (click)="setReminder('30m')">30 分钟</button>
            <button (click)="setReminder('2h')">2 小时后</button>
          </div>
        }
      </div>
    } @else {
      <!-- M19.4 预览区空态变身"快捷键备忘录"（Cheat Sheet）——教育新手发现全键盘流 -->
      <div class="preview-pane preview-pane--empty preview-pane--cheatsheet">
        <div class="preview-pane__cheatsheet-header">快捷操作</div>
        <p class="preview-pane__cheatsheet-hint">点击左侧任务查看详情，或使用键盘快捷键：</p>
        <table class="preview-pane__cheatsheet-table" aria-label="停泊坞快捷键备忘录">
          <tbody>
            <tr><td><kbd>↑</kbd> / <kbd>↓</kbd></td><td>浏览卡片</td></tr>
            <tr><td><kbd>Enter</kbd></td><td>极速切换任务</td></tr>
            <tr><td>双击卡片</td><td>快速切换并收起</td></tr>
            <tr><td><kbd>Alt</kbd>+<kbd>↑</kbd> / <kbd>↓</kbd></td><td>键盘排序</td></tr>
            <tr><td><kbd>Delete</kbd></td><td>移回任务列表</td></tr>
            <tr><td><kbd>Tab</kbd></td><td>跳转备注输入框</td></tr>
            <tr><td><kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd></td><td>展开/收起停泊坞</td></tr>
            <tr><td><kbd>Escape</kbd></td><td>收起停泊坞</td></tr>
            <tr><td>右键卡片</td><td>快捷菜单（固定/提醒/置顶）</td></tr>
          </tbody>
        </table>
      </div>
    }
  `
})
export class PreviewPaneComponent {
  task = input<Task | null>(null);
  
  switchToTask = output<string>();
  
  private readonly parkingService = inject(ParkingService);
  private readonly spotlightService = inject(SpotlightService);
  
  readonly noteInput = signal('');

  /** 快捷备注标签——点击一键追加，减少碎片化时间的输入成本 */
  readonly quickNoteChips = ['等待回复', '高优先级', '稍后阅读', '需要讨论'] as const;
  
  /** 追加快捷备注 */
  appendQuickNote(chip: string): void {
    const task = this.task();
    if (!task) return;
    const timestamp = new Date().toLocaleString();
    const noteText = `[${chip}] - ${timestamp}`;
    // 追加到 content 末尾（同 submitNote 逻辑）
    this.parkingService.appendNote(task.id, noteText);
  }
  readonly showReminderMenu = signal(false);
  readonly isSpotlightActive = computed(() => spotlightMode() !== null);
  readonly switchBtnTooltip = computed(() =>
    this.isSpotlightActive() ? '请先退出 Spotlight 模式' : '切换到此任务'
  );
  
  // 内容预览（截取前 200 字符）
  readonly contentPreview = computed(() => {
    const content = this.task()?.content ?? '';
    return content.length > 200 ? content.slice(0, 200) + '…' : content;
  });
  
  // 锚点展示规则（A4 structuralAnchor）
  readonly showAnchorInfo = computed(() => {
    const task = this.task();
    const anchor = task?.parkingMeta?.contextSnapshot?.structuralAnchor;
    if (!anchor || anchor.type === 'fallback') {
      return anchor?.label !== task?.title;
    }
    return !!anchor;
  });
}
```

---

## M6. 通知条模块（NoticeBar）

### M6.1 职责定义

`NoticeBarComponent` 承载提醒通知和清理通知的多按钮交互——独立于 ToastService、独立于 DockShell 的展开/收起状态。

### M6.2 联动映射

| NoticeBar 特性 | 原策划案章节 | 说明 |
|---------------|-------------|------|
| 多按钮布局 | A3.13 | 独立组件，不修改通用 Toast |
| 提醒通知三阶段消散 | A6.3 | 5s 免疫 → 点击可消散 → 15s 兜底 |
| 清理通知消散 | A6.3 | 2.5s minVisible + intent 消散 |
| 批量清理 | A5.1.4 | "N 个停泊任务已移回列表 [查看并撤回]" |
| 与 Gate 优先级 | A3.5 | Gate 激活时排队 |

### M6.3 组件设计

```typescript
/**
 * NoticeBarComponent——停泊通知条
 * 
 * 独立于 DockShell 展开/收起状态渲染，z-index 高于 DockShell 低于 Toast。
 * 
 * 联动：A3.13 + A6.3 + A5.1.4
 */
@Component({
  selector: 'app-notice-bar',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @for (notice of visibleNotices(); track notice.id) {
      <div class="notice-bar"
           [class.notice-bar--reminder]="notice.type === 'reminder'"
           [class.notice-bar--eviction]="notice.type === 'eviction'"
           [class.notice-bar--immune]="isImmune(notice)"
           role="alert"
           aria-live="assertive">

        <!-- 通知内容 -->
        <div class="notice-bar__content">
          @if (notice.type === 'reminder') {
            <span>⏰ 「{{ notice.taskTitle }}」提醒到达</span>
            @if (notice.snoozeExceeded) {
              <span class="notice-bar__hint">已延后 {{ notice.snoozeCount }} 次，建议处理或忽略</span>
            }
          }
          @if (notice.type === 'eviction') {
            @if (notice.batchCount > 1) {
              <span>{{ notice.batchCount }} 个停泊任务已移回列表</span>
            } @else {
              <span>「{{ notice.taskTitle }}」已移回任务列表（72 小时未访问）</span>
            }
          }
        </div>

        <!-- 操作按钮 -->
        <div class="notice-bar__actions">
          @for (action of notice.actions; track action.key) {
            <button class="notice-bar__action"
                    [class.notice-bar__action--primary]="action.primary"
                    [class.notice-bar__action--dimmed]="action.dimmed"
                    (click)="onAction(notice, action)"
                    [attr.aria-label]="action.label">
              {{ action.label }}
            </button>
          }
        </div>

        <!-- 三阶段消散进度指示（仅提醒类） -->
        @if (notice.type === 'reminder') {
          <div class="notice-bar__timer"
               [style.width.%]="noticeTimerProgress(notice)">
          </div>
        }
      </div>
    }
  `
})
export class NoticeBarComponent {
  private readonly parkingService = inject(ParkingService);
  
  visibleNotices = computed(() => this.parkingService.pendingNotices());
  
  isImmune(notice: ParkingNotice): boolean {
    // 前 5s 免疫期内返回 true，提供视觉区分
    const elapsed = Date.now() - notice.createdAt;
    return notice.type === 'reminder' && elapsed < PARKING_CONFIG.REMINDER_IMMUNE_MS;
  }
}
```

---

## M7. 触发条模块（TriggerCapsule）

### M7.1 职责定义

`TriggerCapsuleComponent` 是收起态时的唯一可见入口——胶囊条「停泊 (N) ▲」。

### M7.2 联动映射

| TriggerCapsule 特性 | 原策划案章节 | 说明 |
|--------------------|-------------|------|
| 显隐逻辑 | A6.8.1 | N=0 时隐藏，无视觉负担 |
| 定位 | A6.9.3 | Resizer 中心底部 |
| hover 微动 | A6.9.3 | 上移 2px |
| 提醒脉冲 | A6.8.3 | < 1h 到期时琥珀色脉冲 |
| 移动端安全距离 | A6.9.5 | safe-area-inset-bottom |

### M7.3 组件设计

```typescript
/**
 * TriggerCapsuleComponent——停泊坞触发条
 * 
 * 联动：A6.8 + A6.9.3
 * 
 * 独立模块，可在任何容器中挂载。
 * 触发展开事件通过 Output 向上冒泡给 DockShell。
 */
@Component({
  selector: 'app-trigger-capsule',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (parkedCount() > 0) {
      <button class="trigger-capsule"
              [class.trigger-capsule--pulse]="hasUrgentReminder()"
              (click)="onTriggerClick()"
              [attr.aria-label]="'展开停泊坞，' + parkedCount() + ' 个停泊任务'"
              role="button">
        停泊 ({{ parkedCount() }})
        @if (urgentReminderText()) {
          <span class="trigger-capsule__reminder">
            · {{ urgentReminderText() }}
          </span>
        }
        <span class="trigger-capsule__arrow">▲</span>
      </button>
    }
  `
})
export class TriggerCapsuleComponent {
  private readonly parkingService = inject(ParkingService);
  
  triggerClick = output<void>();
  
  readonly parkedCount = computed(() => this.parkingService.parkedTasks().length);
  readonly hasUrgentReminder = computed(() => /* < 1h 到期 */);
  readonly urgentReminderText = computed(() => /* "1 个提醒即将到期" */);
  
  onTriggerClick() {
    this.triggerClick.emit();
  }
}
```

---

## M8. 提醒徽章模块（ReminderBadge）

### M8.1 职责定义

红点徽章——在停泊卡片上内联显示，当提醒通知连续被兜底淡出 2 次时激活。

### M8.2 联动映射

| 特性 | 原策划案章节 |
|-----|-------------|
| 触发条件 | A5.3.5 连续兜底淡出 2 次 |
| 位置 | 卡片标题右侧内联 |
| 清除条件 | 用户在通知中执行任意操作后清除 |

### M8.3 组件设计

```typescript
@Component({
  selector: 'app-reminder-badge',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (isActive()) {
      <span class="reminder-badge" aria-label="有未处理的提醒">
        <span class="reminder-badge__dot"></span>
      </span>
    }
  `
})
export class ReminderBadgeComponent {
  taskId = input.required<string>();
  
  private readonly parkingService = inject(ParkingService);
  
  readonly isActive = computed(() =>
    this.parkingService.badgedTaskIds().has(this.taskId())
  );
}
```

---

## M9. 拖拽编排系统（DragOrchestrator）

### M9.1 设计哲学

复用 NanoFlow 现有的 **HTML5 native drag + touch** 模式（与 `TextViewDragDropService` 同源），不引入第三方库。

### M9.2 联动映射

| 拖拽场景 | 联动 |
|---------|------|
| 卡片列表内重排 | 新增行为——A2.5 排序规则增加"用户自定义排序"优先级 |
| 卡片拖出坞外 | 等效于 A6.2b removeParkedTask + 5s Snackbar 撤回 |
| 移动端长按拖拽 | 复用 TextViewDragDropService 的 500ms 长按 + ghost 元素模式 |
| 列表/预览分割比例 | A6.9.4 DockShell 内 divider 拖拽 |

### M9.3 服务设计

```typescript
/**
 * DockDragOrchestratorService——停泊坞拖拽编排
 * 
 * 复用 HTML5 DragEvent + touchmove 模式（同 TextViewDragDropService）。
 * 
 * 三种拖拽场景：
 * 1. 卡片列表内重排（cardReorder）
 * 2. 卡片拖出坞外（cardEject）
 * 3. 分割线拖拽调整比例（dividerResize）
 * 
 * 状态管理使用 Angular Signals，与 DockShell/ParkCardList 联动。
 */
@Injectable()
export class DockDragOrchestratorService {
  private readonly parkingService = inject(ParkingService);
  private readonly logger = inject(LoggerService);

  // ─── 拖拽状态 ───
  readonly draggingCardId = signal<string | null>(null);
  readonly dropTargetIndex = signal<number | null>(null);
  readonly isDraggingOutside = signal(false);
  
  // ─── 用户自定义排序 ───
  readonly customCardOrder = signal<string[] | null>(null);

  /** 卡片拖拽开始 */
  startCardDrag(taskId: string, event: DragEvent): void {
    this.draggingCardId.set(taskId);
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', taskId);
    }
    this.logger.debug('Card drag start', taskId);
  }

  /** 拖拽悬停处理（计算放置位置） */
  handleDragOver(event: DragEvent): void {
    if (!this.draggingCardId()) return;
    
    const target = (event.target as HTMLElement).closest('[data-task-id]');
    if (target) {
      // 坞内：计算插入索引
      const rect = target.getBoundingClientRect();
      const isAbove = event.clientY < rect.top + rect.height / 2;
      // ... 计算 dropTargetIndex
      this.isDraggingOutside.set(false);
    } else {
      // 坞外：标记为弹出
      this.isDraggingOutside.set(true);
    }
  }

  /** 放置处理 */
  handleDrop(event: DragEvent): void {
    const taskId = this.draggingCardId();
    if (!taskId) return;

    if (this.isDraggingOutside()) {
      // 拖出坞外 = 移回普通任务列表
      this.parkingService.removeParkedTask(taskId);
    } else {
      // 坞内重排
      this.applyReorder(taskId, this.dropTargetIndex());
    }

    this.cleanup();
  }

  /** 重排并持久化 */
  private applyReorder(taskId: string, targetIndex: number | null): void {
    if (targetIndex === null) return;
    const currentOrder = this.customCardOrder() ??
      this.parkingService.parkedTasks().map(t => t.id);
    const newOrder = [...currentOrder];
    const fromIndex = newOrder.indexOf(taskId);
    if (fromIndex >= 0) newOrder.splice(fromIndex, 1);
    newOrder.splice(targetIndex, 0, taskId);
    this.customCardOrder.set(newOrder);
    this.persistLayout();
  }

  /** 清理拖拽状态 */
  endCardDrag(taskId: string): void {
    this.cleanup();
  }

  private cleanup(): void {
    this.draggingCardId.set(null);
    this.dropTargetIndex.set(null);
    this.isDraggingOutside.set(false);
  }

  // ─── 触控拖拽（移动端 500ms 长按） ───

  private touchState: {
    taskId: string | null;
    startY: number;
    longPressTimer: ReturnType<typeof setTimeout> | null;
    ghostEl: HTMLElement | null;
  } = { taskId: null, startY: 0, longPressTimer: null, ghostEl: null };

  startTouchDrag(taskId: string, event: TouchEvent): void {
    this.touchState.taskId = taskId;
    this.touchState.startY = event.touches[0].clientY;
    this.touchState.longPressTimer = setTimeout(() => {
      this.draggingCardId.set(taskId);
      this.createGhostElement(event);
    }, 500); // 500ms 长按阈值，同 TextViewDragDropService
  }

  handleTouchMove(event: TouchEvent): void {
    if (!this.draggingCardId()) {
      // 未到长按阈值——取消
      const deltaY = Math.abs(event.touches[0].clientY - this.touchState.startY);
      if (deltaY > 10) this.cancelTouchDrag();
      return;
    }
    this.moveGhostElement(event);
    this.updateDropTarget(event.touches[0].clientX, event.touches[0].clientY);
  }

  handleTouchEnd(): void {
    if (this.draggingCardId()) {
      if (this.isDraggingOutside()) {
        this.parkingService.removeParkedTask(this.draggingCardId()!);
      } else {
        this.applyReorder(this.draggingCardId()!, this.dropTargetIndex());
      }
    }
    this.cleanupTouch();
  }

  private createGhostElement(event: TouchEvent): void { /* 创建拖拽幽灵元素 */ }
  private moveGhostElement(event: TouchEvent): void { /* 移动幽灵元素 */ }
  private cancelTouchDrag(): void { /* 取消触控拖拽 */ }
  private cleanupTouch(): void { /* 清理触控状态 & 幽灵元素 */ }
  private updateDropTarget(x: number, y: number): void { /* 计算放置位置 */ }
  private persistLayout(): void { /* 持久化到 localStorage */ }
}
```

### M9.4 拖拽交互详解

```
卡片列表内重排流程：
┌──────────────┐      ┌──────────────┐
│  Task A      │ ←──  │  Task A      │ 拖拽 Task C
│  Task B      │      │  ── ── ── ── │ ← 放置指示线
│  Task C ⠿   │ ───→ │  Task C      │
│  Task D      │      │  Task B      │ 
│  Task E      │      │  Task D      │
└──────────────┘      │  Task E      │
                      └──────────────┘

卡片拖出坞外流程：
┌──────────────┐
│  Task A      │
│  Task B ⠿   │ ── 拖动到坞外 ──→ Snackbar: "Task B 已移回任务列表 [撤回]"
│  Task C      │
└──────────────┘
```

---


### M9.5 拖出坞外的「防错与视觉强化」

当卡片被拖拽到 DockShell 边缘之外（触发 `isDraggingOutside` 信号）时，必须给予用户**明确的"松手即移除"视觉反馈**，避免误操作或"不敢操作"：

#### 视觉反馈规则

| 拖拽位置 | 卡片样式 | 鼠标指针 | 放置区域 |
|---------|---------|---------|---------|
| 坞内列表 | 正常 + 放置指示线 | `grabbing` | 蓝色指示线 |
| 坞内但未命中目标 | 半透明 | `grabbing` | 无 |
| **坞外（边缘外 40px）** | **红色边框 + 红色半透明背景** | **`no-drop` + 移除图标** | **DockShell 边缘出现红色虚线** |
| 坞外释放后 | 卡片消失 + 弹出动画 | 恢复默认 | Snackbar "已移回任务列表 [撤回]" |

#### CSS Class 联动

```typescript
// ParkCard 模板中——根据 DragOrchestrator 的 isDraggingOutside 信号切换样式
<div class="park-card"
     [class.park-card--dragging]="isDragging()"
     [class.park-card--eject-warning]="isDragging() && dragOrchestrator.isDraggingOutside()">
```

```css
/* 拖出坞外时的红色警告样式 */
.park-card--eject-warning {
  border-color: var(--color-danger);
  background-color: rgba(var(--color-danger-rgb), 0.1);
  opacity: 0.8;
  transition: border-color 150ms, background-color 150ms;
}

/* DockShell 边缘的红色虚线提示 */
.dock-panel--eject-zone {
  outline: 2px dashed var(--color-danger);
  outline-offset: -2px;
}
```

#### 移动端等效反馈

在移动端长按拖拽模式下，当手指移出 DockShell Bottom Sheet 区域时：
- 卡片 ghost 元素同样变为红色半透明
- 触发轻微震动反馈（`navigator.vibrate(50)`，如果设备支持）
- 松手后执行 `removeParkedTask`，同样弹出 Snackbar 可撤回

---

### M9.6 拖拽"让位"物理动画（Spring Animation）

> **M19.6 增补**：增强拖拽操作的物理质感——拖拽经过时，目标位置的卡片产生平滑的"挤开/让位"动画，让用户明确知道松手后卡片会落在哪里。

#### 设计规则

| 状态 | 动画行为 | CSS 实现 |
|------|---------|---------|
| 拖拽卡片悬停在目标上方 | 目标卡片及其下方所有卡片向下平移一整张卡片高度 | `transform: translateY(var(--card-height))` |
| 拖拽卡片悬停在目标下方 | 目标卡片及其上方所有卡片向上平移 | `transform: translateY(calc(-1 * var(--card-height)))` |
| 拖拽离开时 | 卡片弹回原位 | `transition: transform 200ms cubic-bezier(0.2, 0.8, 0.2, 1)` |
| `prefers-reduced-motion` | 无动画，静态指示线替代 | PM-12 已定义 |

#### CSS 实现

```css
/* 让位动画——替代纯指示线方案 */
.park-card {
  --card-height: 64px; /* 卡片标准高度 */
  transition: transform 200ms cubic-bezier(0.2, 0.8, 0.2, 1);
}

/* 拖拽经过时——目标位置下方的卡片向下挤开 */
.park-card--shift-down {
  transform: translateY(var(--card-height));
}

/* 拖拽经过时——目标位置上方的卡片向上挤开 */
.park-card--shift-up {
  transform: translateY(calc(-1 * var(--card-height)));
}

/* reduced-motion 降级 */
@media (prefers-reduced-motion: reduce) {
  .park-card {
    transition: none;
  }
  .park-card--shift-down,
  .park-card--shift-up {
    transform: none;
  }
}
```

#### DragOrchestrator 联动

```typescript
// DockDragOrchestratorService 内增加让位计算
/** 需要让位（shift）的卡片 taskId 集合及方向 */
readonly shiftedCards = signal<Map<string, 'up' | 'down'>>(new Map());

/** 在 handleDragOver 核心逻辑内更新 shiftedCards */
private updateShiftAnimations(insertIndex: number, currentOrder: string[]): void {
  const dragging = this.draggingCardId();
  if (!dragging) return;
  const fromIndex = currentOrder.indexOf(dragging);
  const newShifted = new Map<string, 'up' | 'down'>();
  
  if (insertIndex > fromIndex) {
    // 向下拖拽——中间卡片向上让位
    for (let i = fromIndex + 1; i <= insertIndex; i++) {
      newShifted.set(currentOrder[i], 'up');
    }
  } else if (insertIndex < fromIndex) {
    // 向上拖拽——中间卡片向下让位
    for (let i = insertIndex; i < fromIndex; i++) {
      newShifted.set(currentOrder[i], 'down');
    }
  }
  this.shiftedCards.set(newShifted);
}
```

#### ParkCard 模板绑定

```html
<!-- ParkCardComponent 增加让位动画 class 绑定 -->
<div class="park-card"
     [class.park-card--shift-down]="shiftDirection() === 'down'"
     [class.park-card--shift-up]="shiftDirection() === 'up'"
     ...>
```

---

## M10. 模块间通信总线（ModuleBus）

### M10.1 设计哲学

轻量级事件转发——不引入 RxJS Store（遵循 Hard Rule：Angular Signals 优先），使用 Angular Signals + 回调注册模式实现模块解耦通信。

### M10.2 事件契约

```typescript
/**
 * DockModuleBus——模块间事件总线
 * 
 * 使用 Angular Signals 作为事件载体，避免 RxJS Store 化（Hard Rule）。
 * 每个事件是一个 signal，消费方 computed/effect 自动响应。
 */
@Injectable()
export class DockModuleBus {
  // ─── 卡片 → DockShell/PreviewPane ───
  /** 当前选中的卡片 taskId（null = 无选中） */
  readonly selectedCardId = signal<string | null>(null);
  
  // ─── TriggerCapsule → DockShell ───
  /** 触发条点击事件（用于展开停泊坞） */
  readonly triggerClicked = signal(0); // 递增计数器触发 effect

  // ─── PreviewPane → ParkingService ───
  /** 切换任务请求 */
  readonly switchRequest = signal<string | null>(null);

  // ─── NoticeBar → ParkCardList ───
  /** 通知操作后，需刷新卡片列表 */
  readonly listRefreshToken = signal(0);

  // ─── DragOrchestrator → DockShell ───
  /** 正在拖拽状态（用于 DockShell 显示拖拽区域高亮） */
  readonly isAnyCardDragging = signal(false);

  // ─── 快捷方法 ───
  selectCard(taskId: string | null): void {
    this.selectedCardId.set(taskId);
  }

  requestSwitch(taskId: string): void {
    this.switchRequest.set(taskId);
  }
}
```

### M10.3 模块间通信流向图

```
┌────────────────┐   click    ┌────────────────┐
│ TriggerCapsule │ ────────→  │   DockShell    │ expand/collapse
└────────────────┘            └───────┬────────┘
                                      │ slot hosting
                           ┌──────────┼──────────┐
                           ▼          ▼          ▼
                    ┌──────────┐ ┌──────────┐ ┌──────────┐
                    │CardList  │ │Preview   │ │NoticeBar │
                    │          │ │Pane      │ │          │
                    └────┬─────┘ └────┬─────┘ └────┬─────┘
                         │            │            │
                    select card   switch task   notice action
                         │            │            │
                         ▼            ▼            ▼
                    ┌─────────────────────────────────────┐
                    │          DockModuleBus              │
                    │  (Signals: selectedCardId,          │
                    │   switchRequest, listRefreshToken)  │
                    └─────────────────┬───────────────────┘
                                      │
                                      ▼
                    ┌─────────────────────────────────────┐
                    │          ParkingService             │
                    │  (previewTask, startWork,           │
                    │   removeParkedTask, undoEviction)   │
                    └─────────────────────────────────────┘
```

---

## M11. 与原板块强联动映射表

> 本表将每个模块化组件/服务映射回 `state-overlap-design.md` 的具体章节编号，确保模块化拆分不脱离原始规范。

### M11.1 组件级联动

| 模块化组件 | 替代/拆分自 | 原策划案映射 | 联动要点 |
|-----------|-----------|-------------|---------|
| `DockShellComponent` | `ParkingDockComponent` 骨架部分 | A6.9 全部 | 布局锚点、展开/收起、动画、移动端 Bottom Sheet |
| `TriggerCapsuleComponent` | `ParkingDockComponent` 触发条部分 | A6.8 + A6.9.3 | 显隐逻辑、定位、hover、脉冲 |
| `ParkCardComponent` | `ParkingDockComponent` 卡片渲染部分 | A2.5 + A6.4 + A6.9.4 左半区 | 排序、状态标签、拖拽属性、选中态 |
| `ParkCardListComponent` | `ParkingDockComponent` 列表容器部分 | A2.5 + A6.2b + A6.4 | 排序逻辑、软上限警告、拖拽排序 |
| `PreviewPaneComponent` | `ParkingDockComponent` 预览部分 | A6.1b + A15.1.1 + A3.8 | 只读正文、标题编辑、备注、切换按钮 |
| `NoticeBarComponent` | `ParkingNoticeComponent` | A3.13 + A6.3 + A5.1.4 | 三阶段消散、批量清理、多按钮 |
| `ReminderBadgeComponent` | `ParkingDockComponent` 徽章部分 | A5.3.5 | 小红点、兜底淡出计数 |
| `DockKeyboardManager` *(M3.5 新增)* | 无（新增） | A6.1 + A6.7 | 全键盘流：↑/↓浏览、Enter切换、Delete移除、Alt+↑/↓排序 |
| `DockDebugPanelComponent` *(M19.8 新增)* | 无（新增） | — | 开发环境 Signal 状态监视器，仅 isDevMode() 渲染 |
| `DockVisualConnectorComponent` *(M19.15 新增)* | 无（新增） | — | 弹性视觉连线，SVG 贝塞尔曲线连接停泊卡片与源锚点（仅桌面端） |

### M11.2 服务级联动

| 模块化服务 | 新增/拆分自 | 原策划案映射 | 联动要点 |
|-----------|-----------|-------------|---------|
| `DockModuleBus` | 新增 | A6.1 + A6.9 | 模块间通信——替代组件内部 signal 直连 |
| `DockDragOrchestratorService` | 新增 | A2.5（排序）+ A6.2b（移除） | 复用 TextViewDragDropService 模式 |
| `DockLayoutPersistService` | 新增 | A14.22（UiState 持久化） | 用户自定义布局 localStorage 读写 |
| `DockConnectorCoordService` *(M19.15 新增)* | 新增 | — | 跨容器 DOM 坐标计算（getBoundingClientRect + 贝塞尔控制点） |
| `ParkingService` | 不变 | A5.1 | 对外四方法契约不动 |
| `ContextRestoreService` | 不变 | A5.2 | 快照保存/恢复不动 |
| `SimpleReminderService` | 不变 | A5.3 | 提醒三档不动 |

### M11.3 数据模型联动

| 数据结构 | 变更 | 原策划案映射 |
|---------|------|------------|
| `TaskParkingMeta` | 不变 | A4 |
| `ParkingSnapshot` | 不变 | A4 |
| `ParkingReminder` | 不变 | A4 |
| `ParkingNotice` | 不变 | A4 |
| ~~`DockModuleDescriptor`~~ | **已移除** | M2.1 决策记录（动态注册表已否决） |
| `DockUserLayout` | 新增 | M2.3（用户自定义布局） |

---

## M12. 数据流与状态切片

### M12.1 数据流架构图

```
┌────────────────────────────────────────────────────────────┐
│                    Supabase (Remote)                       │
└──────┬─────────────────────────────────────────────────────┘
       │ 增量拉取 (parking_meta IS NOT NULL)
       ▼
┌──────────────────────────┐
│   SimpleSyncService      │  LWW + RetryQueue
└──────┬───────────────────┘
       │ write to tasksMap
       ▼
┌──────────────────────────────────────────────────────┐
│                   TaskStore (Signals)                 │
│                                                      │
│   tasksMap: Map<string, Task>     ← 主体数据         │
│   parkedTaskIds: Set<string>      ← 二级索引（A3.4.4）│
│                                                      │
└──────┬──────────────────┬──────────────────┬─────────┘
       │                  │                  │
       ▼                  ▼                  ▼
┌──────────────┐  ┌───────────────┐  ┌──────────────────┐
│ParkingService│  │ContextRestore │  │SimpleReminder    │
│              │  │Service        │  │Service           │
│ focusedTask  │  │ saveSnapshot  │  │ setReminder      │
│ parkedTasks  │  │ restore       │  │ snoozeReminder   │
│ previewTask  │  │               │  │ cancelReminder   │
│ startWork    │  │               │  │                  │
│ remove       │  │               │  │                  │
│ undoEviction │  │               │  │                  │
└──────┬───────┘  └───────────────┘  └──────────────────┘
       │
       │  computed signals
       ▼
┌──────────────────────────────────────────────────────┐
│               DockModuleBus (Signals)                │
│                                                      │
│   selectedCardId ← 当前选中卡片                        │
│   switchRequest  ← 切换请求                            │
│   isAnyCardDragging ← 拖拽状态                         │
│   listRefreshToken  ← 列表刷新信号                      │
└──────┬──────────────────┬──────────────────┬─────────┘
       │                  │                  │
       ▼                  ▼                  ▼
┌──────────────┐  ┌───────────────┐  ┌──────────────┐
│ DockShell    │  │ ParkCardList  │  │ PreviewPane  │
│              │  │ + ParkCard    │  │              │
│ TriggerCaps  │  │ + Badge       │  │ NoticeBar    │
└──────────────┘  └───────────────┘  └──────────────┘
```

### M12.2 状态切片说明

| 状态切片 | 所有者 | 消费者 | 持久化 |
|---------|-------|--------|-------|
| `tasksMap` | TaskStore | ParkingService → 所有模块 | IndexedDB + Supabase |
| `parkedTaskIds` | TaskStore | ParkingService | IndexedDB |
| `isParkingDockOpen` | UiStateService | DockShell | localStorage |
| `selectedCardId` | DockModuleBus | ParkCardList、PreviewPane | 不持久化 |
| `customCardOrder` | DockDragOrchestrator | ParkCardList | localStorage (DockUserLayout) |
| `draggingCardId` | DockDragOrchestrator | ParkCardList、DockShell | 不持久化 |
| `pendingNotices` | ParkingService | NoticeBar | 不持久化 |
| `badgedTaskIds` | ParkingService | ReminderBadge | 不持久化 |

---

## M13. 布局引擎与槽位系统

### M13.1 槽位拓扑

```
┌──────────────────────────────────────────────────┐
│           ProjectShellComponent                  │
│                                                  │
│   ┌─────────────┐  │Resizer│  ┌──────────────┐  │
│   │ Text Column │  │       │  │ Flow Column  │  │
│   └─────────────┘  │       │  └──────────────┘  │
│                    │       │                     │
│            ┌───────┴───────┴───────┐             │
│            │     [header-slot]     │             │
│            ├───────────┬───────────┤             │
│            │[list-slot]│[preview]  │             │
│            │           │  [slot]   │             │
│            └───────────┴───────────┘             │
│            │      DockShell        │             │
│            └───────────────────────┘             │
│                [trigger-slot]                    │
│           ┌───────────────────────┐              │
│           │ [notice-slot] (overlay)│              │
│           └───────────────────────┘              │
└──────────────────────────────────────────────────┘
```

### M13.2 槽位尺寸约束

| 槽位 | 桌面端 | 移动端 |
|------|--------|--------|
| `trigger` | W: 180-220px, H: 32px | W: 180-220px, H: 32px + safe-area |
| `header-top` | W: 100%, H: 40px | W: 100%, H: 40px |
| `list-left` | W: `listRatio * panelWidth`, H: calc(100% - 40px) | W: 100%, H: auto |
| `preview-right` | W: `(1-listRatio) * panelWidth`, H: calc(100% - 40px) | W: 100%, H: auto（内联展开） |
| `notice-overlay` | W: max(320px, 30vw), H: auto | W: 100vw - 16px, H: auto |

### M13.3 分割线（Divider）拖拽

分割线拖拽调整列表/预览比例，复用 `ProjectShellComponent` 中 Resizer 的鼠标追踪模式：

```typescript
// DockShell 内
startDividerResize(event: MouseEvent): void {
  event.preventDefault();
  const startX = event.clientX;
  const startRatio = this.listRatio();
  const panelWidth = this.panelWidth();

  const onMove = (e: MouseEvent) => {
    const deltaX = e.clientX - startX;
    const newRatio = Math.max(0.25, Math.min(0.65, startRatio + deltaX / panelWidth));
    this.listRatio.set(newRatio);
  };

  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    // 持久化比例
    this.persistListRatio(this.listRatio());
  };

  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}
```

---

## M14. 模块生命周期管理

### M14.1 加载时序

```
应用启动
  │
  ├─ P0: Auth + 基础 UI
  │
  ├─ P1: 数据就绪 (StartupTierOrchestratorService.isTierReady('p1'))
  │    │
  │    ├─ ParkingService 初始化
  │    │   ├─ 轻量跨项目查询 (A3.4)
  │    │   ├─ IndexedDB parked_tasks 缓存读取
  │    │   └─ BeforeUnload 回调注册 (A3.12)
  │    │
  │    └─ DockShell @defer (on timer(300))
  │         ├─ TriggerCapsule (loadPriority: 0, 非 lazy)
  │         ├─ DockHeader (loadPriority: 1, lazy)
  │         ├─ ParkCardList (loadPriority: 2, lazy)
  │         ├─ PreviewPane (loadPriority: 3, lazy)
  │         └─ NoticeBar (loadPriority: 4, lazy)
  │
  ├─ 首次用户交互 + 3s 延迟
  │    └─ 衰老清理检查 (A5.1.6 / A6.4.5)
  │
  └─ 后台：增量同步 + 衰老巡检（60s 间隔）
```

### M14.2 销毁策略

| 组件 | 销毁时机 | 清理内容 |
|------|---------|---------|
| DockShell | 项目切换（ProjectShell 重建）| 移除键盘监听 |
| ParkCardList | DockShell 销毁时 | 取消拖拽状态 |
| PreviewPane | DockShell 销毁时 | 取消标题编辑防抖 |
| NoticeBar | DockShell 销毁时 | 清理消散定时器 |
| TriggerCapsule | DockShell 销毁时 | 无特殊清理 |
| DockDragOrchestrator | DockShell 提供的 providers scope | 清理 ghost 元素、touch 监听 |

### M14.3 模块提供者范围

```typescript
/**
 * DockShell 提供模块级 DI 范围
 * DockModuleBus 和 DockDragOrchestratorService 限定在 DockShell 生命周期内
 */
@Component({
  providers: [
    DockModuleBus,
    DockDragOrchestratorService,
    DockLayoutPersistService,
  ],
  // ...
})
export class DockShellComponent { }
```

---

## M15. 移动端适配策略

### M15.1 模块级移动端差异

| 模块 | 桌面端 | 移动端 | 差异要点 |
|------|--------|--------|---------|
| DockShell | 面板从底部弹出 | Bottom Sheet 100vw × 60-70vh | 下拉 80px 收起 |
| TriggerCapsule | Resizer 中心 | 视口底部中央 + safe-area | 固定底部 |
| ParkCardList | 左半区 40% | 全宽纵向 | 单栏 |
| ParkCard | 拖拽手柄 + × 按钮 | 长按拖拽 + 更多菜单 | 操作入口差异 |
| PreviewPane | 右半区 60% | 列表下方内联展开 | 单栏 |
| NoticeBar | 底部浮层 | 底部全宽 Snackbar | 大按钮 ≥44px |
| DragOrchestrator | HTML5 dragstart/dragend | 500ms touchstart + ghost | 触控适配 |

### M15.2 移动端拖拽细节

```
移动端卡片操作矩阵：
┌──────────────────────────────────────────────┐
│ 操作          │ 手势              │ 结果      │
├──────────────────────────────────────────────┤
│ 预览          │ 单击              │ 内联展开  │
│ 切换          │ [切换到此任务] ≥44px │ 切换      │
│ 拖拽排序      │ 长按 500ms + 移动  │ 卡片重排  │
│ **排序（替代）** │ **更多菜单 > ↑上移/↓下移/⤒置顶** │ **卡片重排（无障碍替代）** │
│ 移回列表      │ 更多菜单 > 移回    │ 5s 撤回   │
│ 固定/提醒     │ 更多菜单          │ 操作面板  │
│ 收起坞        │ 下拉 > 80px       │ 收起      │
└──────────────────────────────────────────────┘
```

---

## M16. 配置常量（模块化扩展）

```typescript
/**
 * 在 PARKING_CONFIG 基础上追加模块化相关常量
 * 
 * 联动：A9 配置常量规范
 */
export const DOCK_MODULAR_CONFIG = {
  // ─── 拖拽 ───
  /** 触控长按阈值（ms），同 TextViewDragDropService */
  TOUCH_LONG_PRESS_MS: 500,
  /** 拖拽幽灵元素透明度 */
  DRAG_GHOST_OPACITY: 0.6,
  /** 拖拽排序时放置指示线高度（px） */
  DROP_INDICATOR_HEIGHT: 2,
  /** 拖出坞外的检测阈值（拖拽元素离开坞面板边缘 px） */
  EJECT_THRESHOLD_PX: 40,

  // ─── 分割线 ───
  /** 列表/预览最小比例（不可小于 25%） */
  DIVIDER_MIN_RATIO: 0.25,
  /** 列表/预览最大比例（不可大于 65%） */
  DIVIDER_MAX_RATIO: 0.65,
  /** 分割线拖拽热区宽度（px） */
  DIVIDER_HIT_AREA: 8,

  // ─── 模块 ───
  /** 布局持久化 localStorage key */
  LAYOUT_STORAGE_KEY: 'nanoflow:dock-layout',
  /** 自定义排序持久化 localStorage key */
  CARD_ORDER_STORAGE_KEY: 'nanoflow:dock-card-order',
  /** 布局版本号 */
  LAYOUT_VERSION: 1,

  // ─── 移动端 ───
  /** 移动端下拉收起阈值（px） */
  MOBILE_DISMISS_THRESHOLD: 80,
  /** 移动端更多菜单位置偏移 */
  MOBILE_MENU_OFFSET: 8,

  // ─── M19 极致 UX/DX 增补 ───
  /** M19.1 双击/单击区分延迟（ms） */
  DBLCLICK_DELAY_MS: 300,
  /** M19.5 撤销原位幽灵持续时间（ms） */
  UNDO_GHOST_DURATION_MS: 5000,
  /** M19.6 让位动画时长（ms） */
  SHIFT_ANIMATION_MS: 200,
  /** M19.6 让位动画缓动函数 */
  SHIFT_ANIMATION_EASING: 'cubic-bezier(0.2, 0.8, 0.2, 1)',

  // ─── 跨区联动（M19 维度四） ───
  /** 拖拽悬停在触发条上自动展开的延迟（ms） */
  SPRING_OPEN_DELAY_MS: 500,
  /** 双向高亮防抖延迟（ms） */
  HOVER_HIGHLIGHT_DELAY_MS: 150,

  // ─── 跨区深度融合（M19 维度五） ───
  /** M19.13 语义放置区——卡片 drop-target 高亮 CSS 类 */
  CARD_DROP_TARGET_CLASS: 'dock-card--drop-target',
  /** M19.14 自定义 ghost 跟随节流（0 = 使用 rAF，不额外节流） */
  CUSTOM_GHOST_THROTTLE_MS: 0,
  /** M19.15 视觉连线 z-index（介于停泊坞面板 1000 与 Toast 1100 之间） */
  CONNECTOR_Z_INDEX: 1050,
  /** M19.15 视觉连线坐标计算性能预算（ms，半帧） */
  CONNECTOR_CALC_BUDGET_MS: 8,
  /** M19.15 视觉连线消失动画时长（ms） */
  CONNECTOR_FADE_MS: 200,
  /** M19.16 Edge 点击检测容差半径（px） */
  EDGE_HIT_TOLERANCE: 8,
  /** M19.17 段落停泊后原文徽章显示时长（ms） */
  PARK_BADGE_DISPLAY_MS: 2000,
} as const;
```

---

## M17. 实施路线图

### Phase 1：模块拆分（第 1-2 天）

| 任务 | 输入 | 输出 | 门禁 |
|------|------|------|------|
| 创建模块化目录结构 | 当前 `parking-dock.component.ts` | `features/parking/modules/` 目录 | 目录可列出所有子模块 |
| 拆分 DockShell | 原组件骨架逻辑 | `dock-shell.component.ts` | 展开/收起/动画/键盘快捷键通过 |
| 拆分 TriggerCapsule | 原触发条逻辑 | `trigger-capsule.component.ts` | 显隐/定位/脉冲通过 |
| 拆分 ParkCard + ParkCardList | 原卡片渲染逻辑 | 两个独立组件 | 选中/排序/标签通过 |
| 拆分 PreviewPane | 原预览逻辑 | `preview-pane.component.ts` | 编辑/备注/切换按钮通过 |
| 保留 NoticeBar 原有实现 | `parking-notice.component.ts` | 仅调整导入路径 | 通知三阶段消散通过 |

### Phase 2：通信与拖拽（第 3-4 天）

| 任务 | 输入 | 输出 | 门禁 |
|------|------|------|------|
| 实现 DockModuleBus | 模块间通信需求 | `dock-module-bus.service.ts` | 选卡/切换/刷新信号传递正确 |
| 实现 DockDragOrchestrator | 拖拽排序需求 | `dock-drag-orchestrator.service.ts` | 坞内重排 + 坞外弹出 + 触控长按 |
| 集成到 DockShell | 所有子模块 | 完整停泊坞功能 | 全部 P-01 ~ P-40 验收通过 |
| 实现 DockLayoutPersist | 用户自定义持久化 | `dock-layout-persist.service.ts` | 刷新后自定义排序保持 |

### Phase 3：优化与验收（第 5 天）

| 任务 | 输入 | 输出 | 门禁 |
|------|------|------|------|
| 移动端拖拽适配 | 触控交互 | 500ms 长按 + ghost 元素 | 移动端排序可用 |
| 分割线拖拽 | 列表/预览比例调整 | 可拖拽分割线 | 比例 0.25-0.65 范围约束 |
| Accessibility | 键盘导航 + 读屏 | ARIA 标签完整 | A6.7 验证通过 |
| 性能验证 | 模块化后的 bundle | 无回归 | 模块化后整体 JS 增量 < 3KB gzip |
| 全量验收 | A11/A12 测试场景 | 通过率 | 全部 P-01 ~ P-40 + 模块化新增项 |

### Phase 4：极致 UX/DX 增强（第 6 天）——M19 增补

| 任务 | 输入 | 输出 | 门禁 |
|------|------|------|------|
| 双击极速切换 (M19.1) | ParkCard dblclick 事件 | 双击卡片直接 startWork + collapse | PM-25 通过，单击/双击 300ms 区分无冲突 |
| 桌面端右键菜单 (M19.2) | ParkCard contextmenu 事件 | 鼠标位置弹出菜单（固定/提醒/置顶/移回） | PM-26 通过，移动端不触发 |
| 一键恢复默认排序 (M19.3) | ParkCardList 顶部按钮 | 清除 customCardOrder，恢复 parkedAt 降序 | PM-27 通过，无自定义排序时按钮隐藏 |
| 预览区空态 Cheat Sheet (M19.4) | PreviewPane 空态模板 | 快捷键表格（≥8 行）| PM-28 通过 |
| 撤销原位幽灵 (M19.5) | ParkCardList undo ghost | 原位"已移除 [撤销]"占位条 5s 消失 | PM-29 通过，与全局 Snackbar 共存 |
| 拖拽让位动画 (M19.6) | DragOrchestrator shiftedCards | CSS translateY 200ms spring | PM-30 通过，reduced-motion 降级 |
| 纯组件沙箱契约 (M19.7) | ParkCard/PreviewPane 重构 | 纯 @Input/@Output，无直接 inject 业务服务 | PM-31 通过，10 种极端状态测试 |
| Dev Debug Panel (M19.8) | DockDebugPanel 组件 | isDevMode() 下渲染状态条 | PM-32 通过，生产环境不渲染 |

### Phase 5：跨区域空间联动（第 7 天）——M19 维度四增补

| 任务 | 输入 | 输出 | 门禁 |
|------|------|------|------|
| 跨区拖拽入坞 (M19.9) | 文本/流程图拖拽事件 | 悬停触发条 500ms 展开，放入列表创建任务 | PM-33 通过，Spring-open 顺滑 |
| 跨区拖拽出坞 (M19.10) | DragOrchestrator 扩展 | 拖入文本栏插入链接，拖入流程图生成节点 | PM-34 通过，无效区域回退为移除 |
| 划词/框选快捷停泊 (M19.11) | 文本/流程图选区事件 | 悬浮菜单点击停泊，生成幽灵卡片飞入动画 | PM-35 通过，抛物线动画不卡顿 |
| 双向高亮联动 (M19.12) | ModuleBus 状态同步 | Hover 卡片高亮原文，Hover 原文高亮卡片 | PM-36 通过，150ms 防抖无闪烁 |

### Phase 6：跨区域深度融合（第 8 天）——M19 维度五增补

> **前置门禁**：Phase 5 全部 PM-33~PM-36 通过时方可开始。

| 任务 | 输入 | 输出 | 门禁 |
|------|------|------|------|
| 智能语义放置区 (M19.13) | CardList drop 事件扩展 | 拖拽到已有卡片追加备注，不新建卡片 | PM-37 通过，ParkingService 签名无变更 |
| 多模态拖拽释放 (M19.14) | DragOrch 自定义 ghost 机制 | 修饰键切换插入格式，ghost 实时预览 | PM-38 通过，移动端 ActionSheet 可用 |
| 弹性视觉连线 (M19.15) | DockVisualConnectorComponent | SVG 贝塞尔曲线连接卡片与源锚点 | PM-39 通过，坐标计算 < 8ms，z-index 1050 |
| 流程图连线打断 (M19.16) | FlowEventService 落点检测 | 释放在 Edge 上自动拆分插入节点 | PM-40 通过，Ctrl+Z 单步撤销 |
| 零鼠标上下文停泊 (M19.17) | 文本栏快捷键注册 | Alt+Shift+K 停泊当前段落 | PM-41 通过，空段落不执行 |

### 目录结构预览

```
src/app/features/parking/
├── index.ts                          // 公共导出
├── parking.types.ts                  // DockModuleDescriptor, DockUserLayout 等
├── parking.constants.ts              // DOCK_MODULAR_CONFIG 常量
├── modules/
│   ├── dock-shell/
│   │   ├── dock-shell.component.ts
│   │   ├── dock-shell.component.spec.ts
│   │   ├── dock-debug-panel.component.ts    // M19.8 开发环境 Signal 监视器
│   │   └── dock-debug-panel.component.spec.ts
│   ├── trigger-capsule/
│   │   ├── trigger-capsule.component.ts
│   │   └── trigger-capsule.component.spec.ts
│   ├── park-card/
│   │   ├── park-card.component.ts
│   │   ├── park-card.component.spec.ts
│   │   ├── park-card-list.component.ts
│   │   └── park-card-list.component.spec.ts
│   ├── preview-pane/
│   │   ├── preview-pane.component.ts
│   │   └── preview-pane.component.spec.ts
│   ├── notice-bar/
│   │   ├── notice-bar.component.ts
│   │   └── notice-bar.component.spec.ts
│   └── reminder-badge/
│       ├── reminder-badge.component.ts
│       └── reminder-badge.component.spec.ts
├── services/
│   ├── dock-module-bus.service.ts
│   ├── dock-module-bus.service.spec.ts
│   ├── dock-drag-orchestrator.service.ts
│   ├── dock-drag-orchestrator.service.spec.ts
│   ├── dock-layout-persist.service.ts
│   ├── dock-layout-persist.service.spec.ts
│   ├── dock-connector-coord.service.ts       // M19.15 跨容器坐标计算
│   └── dock-connector-coord.service.spec.ts
├── modules/
│   └── visual-connector/
│       ├── dock-visual-connector.component.ts   // M19.15 弹性视觉连线
│       └── dock-visual-connector.component.spec.ts
└── components/
    └── (spec files — legacy, 可逐步迁移)
```

---

## M18. 验收标准

### M18.1 原策划案验收（必须全量通过）

模块化重构后，`state-overlap-design.md` A12 的 **P-01 ~ P-40** 全部验收项不得退化。这是基线门禁。

### M18.2 模块化新增验收项

| 编号 | 场景 | 预期结果 |
|------|------|---------|
| PM-01 | 卡片列表内拖拽排序 | 拖拽卡片到目标位置，放置指示线正确显示，释放后排序生效 |
| PM-02 | 卡片拖出坞外 | 拖拽卡片离开停泊坞面板，释放后执行 removeParkedTask，5s Snackbar 可撤回 |
| PM-03 | 移动端长按拖拽排序 | 长按 500ms 激活拖拽，ghost 元素跟随手指，排序生效 |
| PM-04 | 分割线拖拽 | 拖拽内部分割线，列表/预览比例在 25%-65% 范围内变化，释放后持久化 |
| PM-05 | 自定义排序持久化 | 用户拖拽排序后刷新页面，排序保持不变 |
| PM-06 | 自定义排序 + 新停泊 | 有自定义排序时新任务被停泊，插入到列表顶部 |
| PM-07 | 模块独立渲染 | 在测试环境中单独挂载 ParkCard 组件，正常渲染且不依赖 DockShell |
| PM-08 | DockShell 展开/收起不影响 NoticeBar | 收起停泊坞时，已显示的通知不消失 |
| PM-09 | 拖拽中按 Escape | 取消当前拖拽，卡片回到原位，无副作用 |
| PM-10 | 分割线比例跨设备不同步 | 分割线比例仅存 localStorage（设备私有），不同步到 Supabase |
| PM-11 | 模块化 bundle 增量 | 模块化拆分后总 JS bundle 增量 < 3KB (gzip) |
| PM-12 | reduced-motion 下拖拽 | 拖拽无动画，放置指示线为静态显示 |
| PM-13 | 键盘操作拖拽替代 | 选中卡片后 Alt+↑/Alt+↓ 上移/下移排序（键盘可达替代拖拽） |
| PM-14 | 空列表拖拽 | 列表为空时无法进入拖拽状态，无异常 |
| PM-15 | 高频拖拽防抖 | 快速连续拖拽排序不产生 signal 抖动或界面闪烁 |
| PM-16 | 拖出坞外红色警告 | 卡片拖到坞外 40px 时，卡片变红色边框+半透明背景；释放后弹出 Snackbar 可撤回 |
| PM-17 | 快捷备注标签 | 预览面板显示 4 个快捷标签（等待回复/高优先级/稍后阅读/需要讨论），点击一键追加备注 |
| PM-18 | 教育性空状态 | 列表为空时显示虚线框 Dropzone + 引导文案"将任务拖拽至此处，或按 Alt+P 快速停泊" |
| PM-19 | 全键盘流——展开后焦点 | 按 Alt+Shift+P 展开停泊坞后，焦点自动落在第一张卡片 |
| PM-20 | 全键盘流——↑/↓浏览 | 用 ↑/↓ 箭头在卡片间移动，预览区同步更新 |
| PM-21 | 全键盘流——Enter切换 | 选中卡片后按 Enter，直接执行"切换到此任务" |
| PM-22 | 全键盘流——Delete移除 | 选中卡片后按 Delete/Backspace，执行"移回任务列表" + 5s Snackbar |
| PM-23 | 全键盘流——焦点陷阱 | 展开态 Tab 不泄露到坞外，Escape 退出焦点陷阱并收起 |
| PM-24 | 移动端上移/下移菜单 | 移动端卡片更多菜单包含"上移一层/下移一层/置顶"操作项，可替代拖拽排序 |
| **PM-25** | **双击极速切换（M19.1）** | **双击卡片直接执行 startWork 并收起停泊坞，与单击选中不冲突，300ms 通过 setTimeout 区分单击/双击** |
| **PM-26** | **桌面端右键上下文菜单（M19.2）** | **右键卡片在鼠标位置弹出菜单（📌固定、⏰提醒、⤒置顶、❌移回列表），点击菜单外区域关闭，移动端不触发** |
| **PM-27** | **一键恢复默认排序（M19.3）** | **自定义排序激活时列表顶部显示"↺ 恢复默认排序"按钮，点击后清除 customCardOrder 并恢复 parkedAt 降序** |
| **PM-28** | **预览区空态快捷键备忘录（M19.4）** | **未选中卡片时，右侧预览区显示快捷键表格（≥ 8 行快捷键），选中卡片后自动切换为任务详情** |
| **PM-29** | **撤销原位幽灵（M19.5）** | **卡片移除后原位置显示"已移除 [撤销]"占位条，点击撤销恢复卡片，5s 后自动消失。与全局 Snackbar 共存不冲突** |
| **PM-30** | **拖拽让位动画（M19.6）** | **拖拽经过时目标位置卡片 translateY 平滑挤开（200ms cubic-bezier），reduced-motion 下降级为静态指示线** |
| **PM-31** | **纯展示组件沙箱契约（M19.7）** | **ParkCard 和 PreviewPane 全部数据通过 @Input 传入、全部操作通过 @Output 抛出，可在测试环境中不启动后端独立渲染十种极端状态** |
| **PM-32** | **开发环境 Debug Panel（M19.8）** | **isDevMode() 下 DockShell 底部显示半透明状态条，实时显示 selectedCardId/isDragging/listRatio/parkedCount/customOrder，生产环境不渲染** |
| **PM-33** | **跨区拖拽入坞（M19.9）** | **从文本栏/流程图栏拖拽任务，悬停在触发条 500ms 自动展开停泊坞，放入列表后成功创建停泊任务** |
| **PM-34** | **跨区拖拽出坞（M19.10）** | **将停泊卡片拖入文本栏光标处插入 Markdown 链接；拖入流程图栏生成新节点或建立连线** |
| **PM-35** | **划词/框选快捷停泊（M19.11）** | **文本栏划词弹出悬浮菜单点击"停泊"；流程图栏框选节点右键"停泊"，均能快速生成停泊卡片** |
| **PM-36** | **双向高亮联动（M19.12）** | **鼠标悬停停泊卡片 150ms，文本栏/流程图栏对应内容高亮；反之亦然（收起态时触发条微光闪烁）** |
| **PM-37** | **智能语义放置区（M19.13）** | **从外部拖拽内容悬停在已有停泊卡片上，卡片显示 drop-target 高亮与“追加为备注”覆盖层；释放后内容作为带时间戳的备注追加到该任务详情中，不生成新卡片；ParkingService 四方法签名未变** |
| **PM-38** | **多模态拖拽释放（M19.14）** | **拖出卡片到文本栏时，默认插入链接；按住 Alt 释放插入完整正文；按住 Shift 释放插入待办列表项。自定义 ghost 实时预览格式（📎/📝/☑️）。移动端释放后弹出 ActionSheet 选择格式** |
| **PM-39** | **弹性视觉连线（M19.15）** | **悬停停泊卡片时，屏幕上层出现 SVG 贝塞尔曲线（z-index: 1050）连接卡片与正文/节点；坐标计算 < 8ms；仅渲染一条连线；目标不可见时终点吸附到栏边缘并显示方向箭头；reduced-motion 降级为静态虚线；移开鼠标后 200ms ease-out 消失** |
| **PM-40** | **流程图智能连线打断（M19.16）** | **将卡片拖拽释放在流程图现有的连线上（8px 容差），连线自动打断，新节点无缝插入到原连线的两个节点之间；整个操作为单一撤销单元（Ctrl+Z 一步回退）；Node/Edge 重叠时 Node 优先** |
| **PM-41** | **零鼠标上下文停泊（M19.17）** | **在文本栏光标处按下 `Alt+Shift+K`，当前段落瞬间被停泊并飞入底部动画；空段落不执行；原文段落显示“📌 已停泊”徽章 2s 后淡出；移动端段落工具栏提供等效按钮** |

### M18.3 通过阈值

- 原 A11.3 通过阈值全部满足
- 模块化新增 PM-01 ~ PM-41 通过率 = 100%
- 模块化后无新增 Sentry 错误
- 首次停泊坞展开 TTI < 200ms（模块懒加载不增加延迟）

### M18.4 纯展示组件沙箱契约（Component Sandbox）

> **M19.7 增补**：强制要求 `ParkCardComponent` 和 `PreviewPaneComponent` 必须是**纯展示组件（Dumb Components）**。

#### 契约规则

| 规则 | 说明 |
|------|------|
| 禁止直接 `inject(ParkingService)` | 所有业务数据通过 `input()` 传入 |
| 禁止直接调用服务方法 | 所有用户操作通过 `output()` 向上抛出 |
| 允许 `inject(UiStateService)` | 仅用于响应式布局判断（`isMobile`） |
| 组件必须可独立挂载 | 在 Angular Component Testing 中可不启动任何后端服务测试 |

#### 测试场景矩阵（ParkCard 沙箱×10 种极端状态）

| # | 测试极端状态 | 验证要点 |
|---|----------|----------|
| 1 | 超长标题（120 字符） | 文本截断 + ellipsis，卡片不溢出 |
| 2 | 多个标签（即将清理 + 固定 + 提醒倒计时） | 标签区不换行、不被截断 |
| 3 | 空项目名 | 显示"未分组"占位，不留空 |
| 4 | 停泊时长 > 72h | 橙色"即将清理"标签显示 |
| 5 | 停泊时长 < 1min | 显示"刚刚停泊"，不显示"0分钟" |
| 6 | 有提醒徽章（小红点） | 徽章在标题右侧内联显示 |
| 7 | 拖拽中状态 | 卡片半透明 + 拖拽手柄高亮 |
| 8 | 选中态 | 左侧 3px 靛蓝边框 + 背景色区分 |
| 9 | 倒计时 < 5min | "⏰ 4:32" 实时更新（effect 每分钟刷新） |
| 10 | RTL 布局 | 左右镜像，标记条在右侧 |

---

## M19. UX/DX 极致优化增补（17 项高价值改进）

> **设计审查增补**：基于对 v1.1 策划案的深度审查，提炼出 5 个维度、17 个高价值优化点。每个优化点的代码设计已集成到对应模块章节中（M3/M4/M5/M9/M10），本节提供汇总索引和设计决策记录。

### 维度一：交互操作极速化（极致 UX：减少鼠标移动与视线转移）

#### M19.1 双击极速切换（Double-Click to Switch）

| 项目 | 说明 |
|------|------|
| **痛点** | 当前切换路径：单击卡片 → 视线转移到右侧预览 → 点击 [切换到此任务]，路径较长 |
| **方案** | ParkCard 增加 `(dblclick)` 事件，双击直接执行 `startWork` 并收起停泊坞 |
| **直觉基础** | 桌面端文件管理器双击打开文件的通用心智模型 |
| **实现位置** | M4.3 ParkCardComponent 模板 + M4.4 ParkCardListComponent `onCardDoubleClick` |
| **防冲突** | 单击延迟 300ms（setTimeout）区分单击选中 vs 双击切换 |
| **验收** | PM-25 |

#### M19.2 桌面端右键上下文菜单（Desktop Context Menu）

| 项目 | 说明 |
|------|------|
| **痛点** | 桌面端要对卡片"固定、设置提醒"，必须先单击选中再去右侧找按钮 |
| **方案** | ParkCard 增加 `(contextmenu)` 事件，右键在鼠标位置弹出菜单：📌固定、⏰提醒、⤒置顶、❌移回列表 |
| **设计约束** | 复用移动端"更多菜单"的逻辑，移动端 `contextmenu` 不触发（保留原生长按） |
| **实现位置** | M4.3 ParkCardComponent `onContextMenu()` + `showContextMenu` signal |
| **关闭机制** | `document.addEventListener('click', close, { once: true })` 点击任意区域关闭 |
| **验收** | PM-26 |

#### M19.3 一键恢复默认排序（Reset Sort Order）

| 项目 | 说明 |
|------|------|
| **痛点** | 引入自定义拖拽排序后，用户排乱了很难恢复最初的"按停泊时间降序"状态 |
| **方案** | 卡片列表顶部条件渲染"↺ 恢复默认排序"按钮，一键清除 `customCardOrder` 缓存 |
| **显示条件** | 仅当 `hasCustomOrder()` 为 true 时显示，避免无意义的 UI 噪音 |
| **实现位置** | M4.4 ParkCardListComponent 模板 + `resetSortOrder()` |
| **持久化** | 清除后同步更新 localStorage |
| **验收** | PM-27 |

### 维度二：新手引导与防错增强（更容易上手：降低认知负荷）

#### M19.4 预览区空态变身"快捷键备忘录"（Cheat Sheet）

| 项目 | 说明 |
|------|------|
| **痛点** | 未选中卡片时右侧预览区只显示"点击左侧任务查看详情"，空间浪费，全键盘流快捷键难以发现 |
| **方案** | 将空态预览区设计为教育面板，展示 ≥8 行快捷键表格 |
| **内容** | ↑/↓ 浏览、Enter 切换、双击切换、Alt+↑/↓ 排序、Delete 移除、Tab 跳转备注、Alt+Shift+P 展开/收起、Escape 收起、右键菜单 |
| **实现位置** | M5.3 PreviewPaneComponent else 分支模板 |
| **过渡** | 选中卡片后自动切换为任务详情（信号驱动，零延迟） |
| **验收** | PM-28 |

#### M19.5 撤销操作的"原位幽灵"（In-place Undo Ghost）

| 项目 | 说明 |
|------|------|
| **痛点** | 卡片移除后依赖屏幕底部 Snackbar 撤回，用户视线和鼠标需大幅移动 |
| **方案** | 卡片移除后在列表原位置留下折叠的"已移除 [撤销]"占位条，持续 5s 后消失 |
| **共存策略** | 原位幽灵与全局 Snackbar 共存——幽灵是"就近撤销"，Snackbar 是"全局兜底" |
| **实现位置** | M4.4 ParkCardListComponent `undoGhostTaskId` signal + `onCardRemove()` / `onUndoRemove()` |
| **样式** | 高度折叠（32px）、灰色背景、淡入淡出 transition |
| **验收** | PM-29 |

#### M19.6 拖拽"让位"物理动画（Spring Animation）

| 项目 | 说明 |
|------|------|
| **痛点** | 拖拽只显示 2px 指示线，缺乏物理质感，用户不确定松手后卡片落在哪里 |
| **方案** | 拖拽经过时目标位置的卡片使用 CSS `transform: translateY` 产生平滑的"挤开/让位"动画 |
| **动画参数** | `200ms cubic-bezier(0.2, 0.8, 0.2, 1)` —— 轻量 spring 效果 |
| **无障碍降级** | `prefers-reduced-motion` 下取消动画，静态指示线替代（PM-12 已定义） |
| **实现位置** | M9.6（新增） DockDragOrchestratorService `shiftedCards` signal + ParkCard CSS class 绑定 |
| **验收** | PM-30 |

### 维度三：开发者体验优化（极致 DX：让新同事秒懂）

#### M19.7 强制纯 UI 组件的"沙箱契约"（Component Sandbox）

| 项目 | 说明 |
|------|------|
| **痛点** | 拆分了组件但如果内部强依赖 ParkingService，新人很难单独调试 UI |
| **方案** | 强制 ParkCard/PreviewPane 为纯展示组件：全部数据 `@Input`，全部操作 `@Output` |
| **好处** | 开发者可在 Angular Component Testing 中不启动后端服务，直接调试 10 种极端状态 |
| **实现位置** | M18.4 沙箱契约规则 + 10 种极端状态测试矩阵 |
| **验证方式** | ESLint 自定义规则禁止 ParkCard/PreviewPane 内出现 `inject(ParkingService)` |
| **验收** | PM-31 |

#### M19.8 开发环境专属的 Signal 状态监视器（Debug Panel）

| 项目 | 说明 |
|------|------|
| **痛点** | Signal 状态流转在后台，新人排查"为什么卡片没选中"时需要打断点 |
| **方案** | 开发环境（`isDevMode()`）下 DockShell 底部渲染微型半透明状态条 |
| **显示内容** | `selectedCardId`、`isDragging`、`listRatio`、`parkedCount`、`customOrder` 状态 |
| **交互** | 双击折叠/展开，不影响功能测试 |
| **实现位置** | M3.4a DockDebugPanelComponent（独立组件，DockShell 内import） |
| **生产安全** | `isDevMode()` 为 false 时整个组件不渲染，tree-shaking 可进一步消除 |
| **验收** | PM-32 |

### M19.9 优化点汇总索引

| # | 优化点 | 维度 | 影响模块 | 验收编号 |
|---|--------|------|---------|---------|
| 1 | 双击极速切换 | UX | M4 ParkCard | PM-25 |
| 2 | 桌面端右键菜单 | UX | M4 ParkCard | PM-26 |
| 3 | 一键恢复默认排序 | UX | M4 CardList, M9 DragOrch | PM-27 |
| 4 | 预览区空态 Cheat Sheet | 新手引导 | M5 PreviewPane | PM-28 |
| 5 | 撤销原位幽灵 | 新手引导 | M4 CardList | PM-29 |
| 6 | 拖拽让位动画 | 新手引导 | M9 DragOrch | PM-30 |
| 7 | 纯组件沙箱契约 | DX | M4 ParkCard, M5 PreviewPane, M18.4 | PM-31 |
| 8 | Dev Signal 监视器 | DX | M3 DockShell | PM-32 |
| 9 | 跨区拖拽入坞 | UX | M7 TriggerCapsule, M9 DragOrch | PM-33 |
| 10 | 跨区拖拽出坞 | UX | M9 DragOrch | PM-34 |
| 11 | 划词/框选快捷停泊 | UX | 文本栏/流程图栏 | PM-35 |
| 12 | 视线锚点双向高亮 | UX | M10 ModuleBus, 各区域 | PM-36 |
| 13 | 智能语义放置区 | 跨区深度融合 | M4 CardList, M9 DragOrch | PM-37 |
| 14 | 多模态拖拽释放 | 跨区深度融合 | M9 DragOrch | PM-38 |
| 15 | 弹性视觉连线 | 跨区深度融合 | M10 ModuleBus, 新增 Connector | PM-39 |
| 16 | 流程图智能连线打断 | 跨区深度融合 | 流程图组件, M9 DragOrch | PM-40 |
| 17 | 零鼠标上下文停泊 | 跨区深度融合 | 文本栏组件 | PM-41 |

### 维度四：跨区域空间联动（全局拖拽与视觉映射）

> **设计审查增补**：打破停泊坞的"孤岛"状态，将其与主工作区（文本栏 Text Column、流程图栏 Flow Column）深度融合，实现符合直觉的物理空间交互。

#### M19.9 跨区拖拽入坞（Drag-to-Park & Spring-open）

| 项目 | 说明 |
|------|------|
| **痛点** | 目前停泊任务依赖快捷键 `Alt+P` 或菜单点击，缺乏"把东西放进抽屉"的物理直觉 |
| **方案** | 支持从文本栏（拖拽文本块/任务项）或流程图栏（拖拽节点）直接拖入停泊坞 |
| **弹簧门机制** | 当停泊坞收起时，拖拽物悬停在 TriggerCapsule 上 500ms，DockShell 自动展开（Spring-open），方便放入 |
| **实现位置** | `TriggerCapsuleComponent` 增加 `dragover` 监听与定时器；`ParkCardListComponent` 增加外部 drop 解析 |
| **验收** | PM-33 |

#### M19.10 跨区拖拽出坞（Drag-to-Insert/Connect）

| 项目 | 说明 |
|------|------|
| **痛点** | 停泊卡片拖出坞外目前仅等效于"移除"，浪费了拖拽到具体区域的上下文语义 |
| **方案** | 赋予拖出坞外更丰富的语义：<br>1. **拖入文本栏**：在光标释放处插入该任务的 Markdown 引用链接（如 `[任务标题](#task-id)`）。<br>2. **拖入流程图栏**：在释放位置生成该任务的关联节点，或拖拽到现有节点上建立连线。 |
| **防错机制** | 拖拽到非有效输入区（如两栏中间的空白处）仍执行默认的 `removeParkedTask`（移回列表） |
| **实现位置** | `DockDragOrchestratorService` 扩展 `handleDrop`，通过 `event.target` 判断落点区域并派发对应事件 |
| **验收** | PM-34 |

#### M19.11 划词/框选快捷停泊（Selection-to-Park）

| 项目 | 说明 |
|------|------|
| **痛点** | 阅读长文本或复杂流程图时，想把某部分"先存起来"，必须先建任务再停泊，步骤繁琐 |
| **方案** | 1. **文本栏划词**：选中文本后弹出轻量悬浮工具栏，点击"📌 停泊"，自动以选中文本为摘要创建停泊任务。<br>2. **流程图栏框选**：框选多个节点后右键选择"停泊选中项"，将其作为一个组合任务停泊。 |
| **视觉反馈** | 点击停泊后，选区内容化作一个"幽灵卡片"飞入底部的 TriggerCapsule（抛物线动画） |
| **实现位置** | 文本栏/流程图栏组件内部，调用 `ParkingService.parkSelection()` |
| **验收** | PM-35 |

#### M19.12 视线锚点双向高亮（Bi-directional Hover Highlight）

| 项目 | 说明 |
|------|------|
| **痛点** | 停泊卡片与正文内容脱节，用户忘记这个停泊任务在原文的哪里 |
| **方案** | 建立基于 `structuralAnchor` 的双向视觉映射：<br>1. **Hover 卡片**：文本栏自动滚动到对应锚点并短暂高亮背景；流程图栏对应节点发光。<br>2. **Hover 原文/节点**：如果该内容已被停泊，停泊坞内的对应卡片高亮；若停泊坞收起，TriggerCapsule 产生微光脉冲提示。 |
| **性能优化** | 增加 150ms 防抖（`HOVER_HIGHLIGHT_DELAY_MS`），避免鼠标快速划过时引发滚动抖动 |
| **实现位置** | `DockModuleBus` 新增 `hoveredTaskId` signal，各区域监听并应用 CSS 高亮类 |
| **验收** | PM-36 |

### 维度五：跨区域深度融合与心智减负（极致空间直觉）

> **深度审查增补**：在 M19.9-M19.12 建立的基础跨区联动之上，进一步打破"点对点"的机械映射，赋予拖拽和标记操作**上下文感知能力**与**真实的物理空间直觉**，将停泊坞从"侧边栏列表"升级为与主工作区物理交织的现代化工作台。
>
> **维度四 → 五依赖关系**：维度五全部功能以维度四（M19.9-M19.12）为前提。实施时必须在维度四 PM-33~PM-36 全量通过后方可开始。

#### M19.13 智能语义放置区（Smart Semantic Dropzones）

| 项目 | 说明 |
|------|------|
| **痛点** | 用户在阅读长文本或复杂流程图时，往往会发现多处信息都指向同一个待办事项。如果每次拖拽都新建一个停泊卡片，坞内会迅速变得杂乱。 |
| **方案** | 当从文本栏/流程图栏拖拽内容进入停泊坞时，**不仅可以放在空白处（新建任务），还可以直接拖拽到某张已有的停泊卡片上**。 |
| **视觉反馈** | 悬停在已有卡片上时，目标卡片高亮（`dock-card--drop-target` CSS 类），并显示提示覆盖层"➕ 追加为备注 (Append as Note)"。覆盖层使用半透明蒙版 + 居中文字，不遮挡卡片标题以保持可识别性。 |
| **操作结果** | 释放后，拖拽的内容自动作为一条带时间戳的备注，追加到该停泊任务的详情中，不产生新卡片。 |
| **实现位置** | `ParkCardListComponent` 的 `dragover` 和 `drop` 事件处理扩展，识别目标卡片 ID 并通过 `cardAppendNote` output 事件向上抛出，由 `DockShell` 编排层代理调用 `ParkingService.updateParkedTaskNotes()`。 |
| **契约保护** | **不新增 `ParkingService` 公共方法**（M1.3 四方法签名不变）。追加备注走已有的任务备注更新通道（等效于在 PreviewPane 手动输入备注），由 `DockShell` 作为编排层完成粘合，ParkCardList 仅抛 output 事件（符合 M19.7 沙箱契约）。 |
| **移动端行为** | 移动端无外部拖入卡片的交互路径（维度四 M19.9 在移动端已降级为菜单操作），因此本功能**仅桌面端可用**。 |
| **验收** | PM-37 |

#### M19.14 多模态拖拽释放（Multi-modal Drag-out）

| 项目 | 说明 |
|------|------|
| **痛点** | M19.10 规定拖出卡片到文本栏默认插入 Markdown 链接。但很多时候，用户希望直接把停泊的任务**展开为正文**，或者变成一个**待办列表项**。 |
| **方案** | 引入键盘修饰键（Modifier Keys）实时改变拖拽意图：<br>1. **默认拖拽**：插入引用链接 `[任务标题](#task-id)`。<br>2. **按住 `Alt` 拖拽**：插入该任务的**完整正文内容**（展开任务）。<br>3. **按住 `Shift` 拖拽**：插入为 Markdown 待办项 `- [ ] 任务标题`。 |
| **视觉反馈——修正方案** | HTML5 原生 DnD 的 `setDragImage()` 在 `dragstart` 时锁定，**无法在拖拽过程中动态更换 ghost**。因此采用**自定义覆盖层 ghost**（与 M9 现有的 `DRAG_GHOST_OPACITY` ghost 机制一致）：在 `dragstart` 时隐藏原生 ghost（设为 1×1 透明像素），改由 `DockDragOrchestratorService` 维护一个绝对定位的 `<div class="dock-custom-ghost">` 跟随鼠标。拖拽过程中监听 `altKey`/`shiftKey` 状态，实时更新 ghost 内部的预览文本和模式标签（📎链接 / 📝正文 / ☑️待办）。 |
| **修饰键检测时机** | 在 `drag` 事件（持续触发）和 `drop` 事件中均读取 `event.altKey` / `event.shiftKey`，以 `drop` 时刻的修饰键状态为准确定最终插入格式。 |
| **移动端行为** | 触控设备无修饰键。移动端拖出卡片时，释放后弹出底部 ActionSheet 让用户选择插入格式（链接 / 正文 / 待办），而非依赖修饰键。 |
| **实现位置** | `DockDragOrchestratorService` 监听 `drag` 过程中的 `altKey` 和 `shiftKey` 状态，动态更新 `dragData` 载荷与自定义 ghost 内容。 |
| **验收** | PM-38 |

#### M19.15 弹性视觉连线（Elastic Visual Connectors）

| 项目 | 说明 |
|------|------|
| **痛点** | M19.12 的"双向高亮"在小屏幕上有效，但在宽屏或分屏状态下，用户很难瞬间在密密麻麻的文本/节点中找到那个高亮块，缺乏物理联系感。 |
| **方案** | 当鼠标悬停在停泊卡片上（或选中卡片）时，不仅高亮原文，还在屏幕上层绘制一条**半透明的 SVG 贝塞尔曲线（Bezier Curve）**连接停泊卡片与其源锚点。 |
| **视觉表现** | 曲线从停泊卡片的左侧边缘水平出发，经两个控制点形成平滑 S 型弯曲，连接到文本栏对应段落或流程图栏对应节点。曲线使用 `stroke-dashoffset` 动画产生轻微的"流动"效果（非"呼吸"膨胀），鼠标移开时 `opacity` 从 1 过渡到 0（200ms ease-out），配合 `path` 长度收缩的回弹效果。 |
| **z-index 层级（修正）** | 使用 `z-index: var(--dock-connector-z, 1050)`，介于停泊坞面板（1000）与 Toast（1100）之间。**不使用 9999**——原提案的 `z-index: 9999` 会遮挡全局 Toast 和模态对话框，违反 M3.2 层级规范。 |
| **跨容器坐标计算** | 新增 `DockConnectorCoordService`（纯函数服务），使用 `getBoundingClientRect()` 获取源卡片与目标锚点的视口坐标，计算贝塞尔控制点。当目标锚点不在可视区域内时，曲线终点吸附到对应栏的可见边缘并显示箭头指示方向（"↑ 在上方" / "↓ 在下方"）。 |
| **性能预算** | 单次坐标计算 + SVG 渲染必须 < 8ms（半帧预算）。仅渲染**当前 hover 的一条连线**，不同时渲染多条。使用 `requestAnimationFrame` 节流，避免 `mousemove` 触发过频。 |
| **降级策略** | `prefers-reduced-motion` 下取消流动动画和回弹效果，仅显示静态虚线。移动端不渲染连线（屏幕空间不足，M19.12 双向高亮已够用）。 |
| **实现位置** | 新增 `DockVisualConnectorComponent`（全局单例，挂载在 `DockShell` 内部最外层），监听 `DockModuleBus.hoveredTaskId`，配合 `DockConnectorCoordService` 计算 DOM 元素坐标并动态渲染 SVG `<path>`。 |
| **验收** | PM-39 |

#### M19.16 流程图智能连线打断（Flowchart Edge Splitting）

| 项目 | 说明 |
|------|------|
| **痛点** | 在流程图中，如果想把一个停泊任务插入到现有的 A→B 连线之间，通常需要：删除连线 → 拖入生成新节点 → 连接 A 到新节点 → 连接新节点到 B。操作极其繁琐。 |
| **方案** | 当用户将停泊卡片拖入流程图栏时，如果**直接释放在一条现有的连线（Edge）上**，该连线高亮变粗（`strokeWidth` 从 1 变为 3，颜色变为主题色）。 |
| **操作结果** | 释放鼠标后，系统自动**打断该连线，并将新生成的节点无缝插入到中间**（即自动建立 A → 新节点 → B 的连接）。整个操作作为**单个撤销单元**注册到 `UndoManager`，用户按 `Ctrl+Z` 可一步回退到拆分前状态。 |
| **GoJS API 依赖** | 使用 GoJS `Diagram.findObjectAt(point)` 检测落点是否在 Edge 上，命中容差半径 `EDGE_HIT_TOLERANCE = 8px`。连线拆分调用 `diagram.model.startTransaction('edge-split')` → 删除旧 Link → 创建新 Node → 创建两条新 Link → `commitTransaction()`，确保原子性。 |
| **冲突处理** | 若落点同时命中 Edge 和 Node（重叠区域），**Node 优先**——等效于拖到已有节点上建立连线（M19.10 已定义的语义）。 |
| **移动端行为** | 移动端默认 Text 视图（Hard Rule 5.3），流程图按需 `@defer` 加载。本功能仅在流程图可见时生效，移动端概率极低，不做额外适配。 |
| **实现位置** | 流程图组件的 `drop` 事件处理，通过 `FlowEventService` 检测落点并调用图表引擎的连线拆分逻辑。 |
| **验收** | PM-40 |

#### M19.17 零鼠标上下文停泊（Zero-Mouse Contextual Parking）

| 项目 | 说明 |
|------|------|
| **痛点** | M19.11 划词停泊仍需要使用鼠标选中文字。在沉浸式输入时，手离开键盘去拿鼠标会打断心流。 |
| **方案** | 在文本栏输入时，无需选中文字，直接按下全局快捷键 **`Alt+Shift+K`**（"K" = Keep，助记"保留当前段落"），即可将**光标当前所在的整个段落**瞬间停泊。 |
| **快捷键选择理由** | 否决 `Ctrl+Shift+P`：① 与 Chrome DevTools / 部分浏览器扩展的命令面板冲突；② 与已有 `Alt+Shift+P`（展开停泊坞）仅差一个修饰键，用户学习时极易混淆。选用 `Alt+Shift+K`：① 无已知浏览器/系统快捷键冲突；② "K = Keep" 助记清晰；③ 与 `Alt+Shift+P`（Park dock toggle）形成 Alt+Shift 系列但字母不同，认知区分度高。 |
| **视觉反馈** | 伴随一个幽灵卡片从光标位置飞入底部 TriggerCapsule 的抛物线动画（复用 M19.11 的 `parkSelection()` 动画通道），停泊坞无需展开即可完成收集。段落停泊后原文该段落短暂显示 `📌 已停泊` 徽章（2s 后淡出），确认操作已生效。 |
| **空段落防误触** | 若光标所在段落为空（仅有空白字符），快捷键不执行任何操作，避免创建空内容卡片。可选：显示轻量 Toast "当前段落为空，无法停泊"（`SILENT` 级别，2s 自动消失）。 |
| **移动端替代** | 移动端无 `Alt+Shift+K`。替代方案：在段落工具栏（已有的移动端浮动菜单）中增加"📌 停泊段落"按钮，一键停泊当前焦点段落。 |
| **实现位置** | 文本编辑器组件内注册快捷键（`@HostListener('document:keydown')`），获取当前光标所在 Block 的内容，调用 `ParkingService.parkSelection()`。 |
| **验收** | PM-41 |

---

## 附录 A：与原策划案章节交叉索引

| 原策划案章节 | 本文对应章节 | 关系 |
|-------------|-------------|------|
| A1 产品边界与目标 | M1.2 设计目标 | 扩展（模块化目标不改边界） |
| A2 唯一真值表 | M11.3 数据模型联动 | 不变（模型不动） |
| A3 架构映射 | M11.2 服务级联动 | 不变（ParkingService 契约不动） |
| A4 数据模型 | M11.3 数据模型联动 | 不变 + 新增 DockUserLayout（DockModuleDescriptor 已移除） |
| A5 服务层 | M11.2 服务级联动 | 不变 + 新增 DockModuleBus/DockDragOrchestrator/DockLayoutPersist |
| A6 交互语义 | M4/M5/M6/M7/M8/M9 | 拆分细化到模块级（语义不变） |
| A7 桌面/移动矩阵 | M15 移动端适配 | 模块级桌面/移动差异矩阵 |
| A8 核心流程时序 | M14.1 加载时序 | 模块化加载时序细化 |
| A9 配置常量 | M16 配置常量 | 扩展（DOCK_MODULAR_CONFIG） |
| A10 实施路线图 | M17 实施路线图 | 模块化拆分专属路线 |
| A11 测试验证 | M18 验收标准 | 基线通过 + 模块化新增 PM-01~PM-41 |
| A12 验收标准 | M18.1 | 全量 P-01~P-40 不退化 |
| A13 术语表 | 继承 | 新增：DockShell、ModuleBus、DragOrchestrator |
| A14 假设与默认 | M1.3 设计约束 | 继承 + 模块化约束 |
| A15 联动门禁 | M11 联动映射表 | 全量对齐 A15.2 + 模块化新增服务行 |

---

## 附录 B：术语表（模块化新增）

| 术语 | 定义 |
|------|------|
| DockShell | 停泊坞骨架容器，提供布局槽位、动画、展开/收起逻辑 |
| DockSlot | 停泊坞内的模块挂载位 (`trigger`, `list-left`, `preview-right` 等) |
| ~~DockModuleDescriptor~~ | **已废弃**——动态注册表方案已否决（见 M2.1 决策记录），改为静态模板组合 |
| DockModuleBus | 模块间轻量通信总线，基于 Angular Signals |
| DockDragOrchestrator | 拖拽编排服务，管理卡片排序、坞外弹出、触控长按 |
| DockUserLayout | 用户自定义布局快照，持久化到 localStorage |
| Ghost Element | 拖拽时跟随鼠标/手指的半透明卡片复制件 |
| Drop Indicator | 拖拽排序时显示的放置位置指示线 |
| Card Eject | 卡片被拖出停泊坞面板（等效于 removeParkedTask） |
| Undo Ghost | M19.5 撤销原位幽灵——卡片移除后原位置显示的可撤销占位条 |
| Spring Animation | M19.6 拖拽让位动画——目标位置卡片平滑挤开的物理反馈动画 |
| Component Sandbox | M19.7 纯展示组件沙箱契约——强制纯 @Input/@Output，禁止直接注入业务服务 |
| Debug Panel | M19.8 开发环境 Signal 状态监视器——仅 isDevMode() 下渲染的底部状态条 |
| Cheat Sheet | M19.4 预览区空态快捷键备忘录——未选中卡片时显示的教育面板 |
| Smart Semantic Dropzone | M19.13 智能语义放置区——拖拽内容到已有卡片上追加为备注，避免新建卡片泛滥 |
| Multi-modal Drag-out | M19.14 多模态拖拽释放——通过修饰键（Alt/Shift）选择插入格式（链接/正文/待办） |
| Elastic Visual Connector | M19.15 弹性视觉连线——SVG 贝塞尔曲线连接停泊卡片与其在主工作区的源锚点 |
| DockConnectorCoordService | M19.15 跨容器坐标计算纯函数服务——getBoundingClientRect() + 控制点计算 |
| Edge Splitting | M19.16 流程图智能连线打断——释放在 Edge 上自动拆分为 A→新节点→B |
| Zero-Mouse Parking | M19.17 零鼠标上下文停泊——Alt+Shift+K 一键停泊光标所在段落 |

---

> **防误用提示**：本策划案的全部模块化设计均建立在 `state-overlap-design.md` v10.0 之上。任何与 A1-A15 冲突的模块化实现，以 A1-A15 为准。模块化不是功能新增——而是同一功能的更好组织形式。
