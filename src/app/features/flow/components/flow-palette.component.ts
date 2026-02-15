import { Component, input, output, signal, inject, OnDestroy, ChangeDetectionStrategy, computed, ElementRef, viewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { UiStateService } from '../../../../services/ui-state.service';
import { ProjectStateService } from '../../../../services/project-state.service';
import { BlackBoxService } from '../../../../services/black-box.service';
import { FocusPreferenceService } from '../../../../services/focus-preference.service';
import { Task } from '../../../../models';
import { BlackBoxPanelComponent } from '../../focus/components/black-box/black-box-panel.component';
import { StrataViewComponent } from '../../focus/components/strata/strata-view.component';

/**
 * 流程图侧边栏组件 (原 Palette/Strata Panel)
 * 职责：项目概览、任务列表、待分配池、历史回溯
 */
@Component({
  selector: 'app-flow-palette',
  standalone: true,
  imports: [CommonModule, BlackBoxPanelComponent, StrataViewComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    :host {
      position: absolute;
      top: 0;
      left: 0;
      bottom: 0;
      z-index: 40;
      pointer-events: none;
      display: flex;
      flex-direction: row;
    }

    /* 侧边栏容器 */
    .sidebar-container {
      @apply bg-white dark:bg-stone-900 border-r border-stone-200 dark:border-stone-700 shadow-xl flex flex-col h-full overflow-hidden transition-all duration-300;
      pointer-events: auto;
    }

    /* 通用滚动条 */
    .custom-scroll::-webkit-scrollbar {
      width: 4px;
    }
    .custom-scroll::-webkit-scrollbar-track {
      background: transparent;
    }
    .custom-scroll::-webkit-scrollbar-thumb {
      @apply bg-stone-300 dark:bg-stone-600 rounded-full;
    }
    .custom-scroll::-webkit-scrollbar-thumb:hover {
      @apply bg-stone-400 dark:bg-stone-500;
    }

    /* 选项卡按钮 */
    .tab-btn {
      @apply flex-1 py-2.5 text-xs font-medium text-stone-500 dark:text-stone-400 border-b-2 border-transparent transition-colors hover:text-stone-700 dark:hover:text-stone-300 bg-stone-50 dark:bg-stone-900;
    }
    .tab-btn.active {
      @apply text-indigo-600 dark:text-indigo-400 border-indigo-600 dark:border-indigo-400 bg-white dark:bg-stone-800;
    }

    /* 统计卡片 */
    .stat-card {
      @apply flex flex-col p-3 rounded-lg bg-stone-50 dark:bg-stone-800/50 border border-stone-100 dark:border-stone-800 transition-all hover:bg-white dark:hover:bg-stone-800 hover:shadow-sm cursor-pointer hover:border-stone-200 dark:hover:border-stone-700;
    }

    /* 列表项 - 待办 */
    .task-item {
      @apply relative flex items-center gap-3 p-2.5 rounded-lg border border-transparent hover:bg-stone-50 dark:hover:bg-stone-800/80 transition-all cursor-pointer hover:border-stone-200 dark:hover:border-stone-700 hover:shadow-sm;
    }
    
    /* 拖拽相关 */
    .draggable-item {
      @apply cursor-grab active:cursor-grabbing select-none;
    }
    .dragging-over {
      @apply bg-indigo-50 dark:bg-indigo-900/20 border-indigo-300 dark:border-indigo-700 border-dashed !important;
    }

    /* 动画 */
    .animate-slide-in-bottom {
      animation: slideInBottom 0.3s ease-out;
    }
    @keyframes slideInBottom {
      from { transform: translateY(100%); opacity: 0; }
      to { transform: translateY(0); opacity: 1; }
    }
  `],
  template: `
    <div
      class="sidebar-container"
      [style.width]="isOpen() ? expandedWidth : '0px'"
      [class.w-0]="!isOpen()"
      [class.opacity-0]="!isOpen()">

      <!-- 侧边栏内容 -->
      <div class="flex-1 flex flex-col w-full h-full min-w-[320px]">
        
        <!-- 1. 项目头部 -->
        <div class="shrink-0 px-3 py-2 border-b border-stone-100 dark:border-stone-800 bg-white dark:bg-stone-900">
          @if (projectState.activeProject(); as project) {
            <div class="flex items-start justify-between gap-2 mb-2">
              <div class="overflow-hidden">
                <h2 class="text-base font-bold text-stone-800 dark:text-stone-100 leading-tight truncate" [title]="project.name">
                  {{ project.name || '未命名项目' }}
                </h2>
                <div class="flex items-center gap-2 mt-0.5">
                  <span class="text-[9px] text-stone-400 font-mono">{{ (project.updatedAt || project.createdDate) | date:'MM-dd HH:mm' }}</span>
                  <span class="text-[9px] px-1 py-0.5 rounded-full bg-stone-100 dark:bg-stone-800 text-stone-500 dark:text-stone-400 font-medium">
                   {{ projectStatusLabel() }}
                  </span>
                </div>
              </div>
              <button class="p-1 text-stone-400 hover:text-stone-600 dark:hover:text-stone-200 transition-colors rounded-md hover:bg-stone-100 dark:hover:bg-stone-800 shrink-0">
                <svg xmlns="http://www.w3.org/2000/svg" class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 5v.01M12 12v.01M12 19v.01M12 6a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2z" />
                </svg>
              </button>
            </div>
          } @else {
             <div class="text-center py-2 text-stone-400 text-xs">暂无选中项目</div>
          }
        </div>

        <!-- 2. 仪表盘 (关键指标) -->
        <div class="shrink-0 px-4 py-3 grid grid-cols-3 gap-2 border-b border-stone-100 dark:border-stone-800 bg-stone-50/30 dark:bg-stone-900/30">
          <button (click)="focusDashboardSection('unfinished')" 
             class="stat-card"
             [class.ring-1]="focusedSection() === 'unfinished'"
             [class.ring-indigo-400]="focusedSection() === 'unfinished'">
             <span class="text-[10px] text-stone-500 uppercase tracking-wider font-semibold">进行中</span>
             <span class="text-xl font-bold text-indigo-600 dark:text-indigo-400 mt-0.5 font-mono">{{ unfinishedCount() }}</span>
          </button>
          
          <button (click)="focusDashboardSection('unassigned')" 
             class="stat-card"
             [class.ring-1]="focusedSection() === 'unassigned'"
             [class.ring-teal-400]="focusedSection() === 'unassigned'">
             <span class="text-[10px] text-stone-500 uppercase tracking-wider font-semibold">待分配</span>
             <span class="text-xl font-bold text-teal-600 dark:text-teal-400 mt-0.5 font-mono">{{ unassignedCount() }}</span>
          </button>
          
          <button (click)="focusDashboardSection('blackbox')" 
             class="stat-card"
             [class.ring-1]="focusedSection() === 'blackbox'"
             [class.ring-stone-400]="focusedSection() === 'blackbox'">
             <span class="text-[10px] text-stone-500 uppercase tracking-wider font-semibold">完成率</span>
             <span class="text-xl font-bold text-stone-600 dark:text-stone-300 mt-0.5 font-mono">{{ completionRate() }}%</span>
          </button>
        </div>

        <!-- 3.主要工作区 (Tab切页) -->
        <div class="flex-1 flex flex-col min-h-0 bg-stone-50/50 dark:bg-stone-900/50">
          <div class="flex border-b border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 sticky top-0 z-10 shadow-sm">
            <button class="tab-btn" 
              [class.active]="activeWorkbenchTab() === 'unfinished'"
              (click)="setWorkbenchTab('unfinished')">
              任务列表
            </button>
            <button class="tab-btn" 
              [class.active]="activeWorkbenchTab() === 'unassigned'"
              (click)="setWorkbenchTab('unassigned')">
              待分配区
            </button>
             @if (focusPrefs.isBlackBoxEnabled()) {
              <button class="tab-btn" 
                [class.active]="activeWorkbenchTab() === 'blackbox'"
                (click)="setWorkbenchTab('blackbox')">
                黑匣子
               <span class="ml-1 px-1.5 py-0.5 rounded bg-stone-100 dark:bg-stone-800 text-[9px] text-stone-500">{{ blackBoxPendingCount() }}</span>
              </button>
            }
          </div>

          <div class="flex-1 overflow-y-auto custom-scroll p-3" #workbenchSection>
            @if (activeWorkbenchTab() === 'unfinished') {
              <ul class="space-y-2">
                @for (item of projectState.unfinishedItems(); track item.taskId + item.text + $index) {
                  <li class="task-item bg-white dark:bg-stone-800"
                      (click)="centerOnNode.emit(item.taskId)">
                    <div class="w-1.5 self-stretch rounded-full bg-indigo-500/80 mr-1"></div>
                    <div class="min-w-0 flex-1">
                      <div class="flex items-center justify-between mb-0.5">
                        <span class="text-xs font-medium text-stone-700 dark:text-stone-200 truncate pr-2" [title]="item.text">{{ item.text || '无标题任务' }}</span>
                        <span class="text-[9px] font-mono text-stone-400 bg-stone-100 dark:bg-stone-700 px-1 rounded">{{ projectState.compressDisplayId(item.taskDisplayId) }}</span>
                      </div>
                      <div class="text-[10px] text-stone-400 truncate flex items-center gap-2">
                         <span class="flex items-center gap-1">
                           <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
                           点击定位
                         </span>
                      </div>
                    </div>
                  </li>
                } @empty {
                  <div class="flex flex-col items-center justify-center py-10 text-stone-400 opacity-60">
                    <svg class="w-12 h-12 mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                    </svg>
                    <span class="text-xs">暂无进行中任务</span>
                  </div>
                }
              </ul>
            } @else if (activeWorkbenchTab() === 'unassigned') {
               <div class="space-y-3 h-full flex flex-col">
                 <!-- 拖放区域（可滚动，防止大量任务撑爆布局） -->
                 <div
                   class="flex-1 rounded-xl border-2 border-dashed border-stone-200 dark:border-stone-700 bg-stone-100/50 dark:bg-stone-800/20 p-3 transition-colors grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-2 content-start min-h-[150px] overflow-y-auto custom-scroll"
                   [class.dragging-over]="isDropTargetActive()"
                   (dragover)="onDragOver($event)"
                   (drop)="onDrop($event)">
                    
                   @if (projectState.unassignedTasks().length === 0 && !isDropTargetActive()) {
                      <div class="col-span-full min-h-[120px] flex flex-col items-center justify-center text-stone-400/60 pointer-events-none">
                        <span class="text-2xl mb-2">📥</span>
                        <span class="text-xs">拖放任务至此解除分配</span>
                      </div>
                   }

                   @for (task of displayedUnassignedTasks(); track task.id) {
                     <div
                        draggable="true"
                        (dragstart)="onDragStart($event, task)"
                        (touchstart)="onTouchStart($event, task)"
                        (touchmove)="onTouchMove($event)"
                        (touchend)="onTouchEnd($event)"
                        (click)="taskClick.emit(task)"
                        class="draggable-item w-full min-w-0 px-3 py-2 bg-white dark:bg-stone-800 border border-stone-200 dark:border-stone-600 rounded-lg shadow-sm text-xs text-stone-700 dark:text-stone-300 hover:border-teal-400 dark:hover:border-teal-500 hover:shadow transition-all truncate flex items-center gap-1.5"
                        [ngClass]="{ 'opacity-50': draggingId() === task.id }">
                        <span class="w-1.5 h-1.5 rounded-full bg-teal-400 shrink-0"></span>
                        <span class="truncate">{{ task.title || '无标题' }}</span>
                     </div>
                   }

                   <!-- 加载更多（超过展示上限时显示） -->
                   @if (hasMoreUnassigned()) {
                     <button
                       class="col-span-full w-full py-2 text-[11px] text-teal-600 dark:text-teal-400 hover:bg-teal-50 dark:hover:bg-teal-900/20 rounded-lg transition-colors font-medium"
                       (click)="loadMoreUnassigned()">
                       还有 {{ remainingUnassignedCount() }} 项，点击加载更多
                     </button>
                   }
                 </div>
                 
                 <button
                    data-testid="create-unassigned-btn"
                    (click)="createUnassigned.emit()"
                    class="w-full py-3 bg-white dark:bg-stone-800 border border-stone-200 dark:border-stone-700 hover:border-teal-500 text-stone-500 hover:text-teal-600 dark:text-stone-400 dark:hover:text-teal-400 rounded-lg text-xs font-medium transition-all flex items-center justify-center gap-2 shadow-sm group shrink-0">
                    <span class="w-5 h-5 rounded-full bg-stone-100 dark:bg-stone-700 group-hover:bg-teal-50 dark:group-hover:bg-teal-900/30 flex items-center justify-center text-sm leading-none transition-colors">+</span> 
                    新建待分配任务
                 </button>
               </div>
            } @else if (activeWorkbenchTab() === 'blackbox') {
               <div #blackboxSection>
                 <app-black-box-panel [expandToken]="blackBoxExpandToken()"></app-black-box-panel>
               </div>
            }
          </div>
        </div>
        
        <!-- 4. 底部: 历史沉积 -->
        <div class="shrink-0 bg-white dark:bg-stone-900 border-t border-stone-200 dark:border-stone-800 shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.05)]">
           <button class="w-full px-4 py-3 flex items-center justify-between hover:bg-stone-50 dark:hover:bg-stone-800 transition-colors"
                   (click)="toggleHistory()">
              <span class="text-xs font-bold text-stone-700 dark:text-stone-300 flex items-center gap-2">
                <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4 text-stone-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                </svg>
                项目历史回顾
              </span>
              <span class="transform transition-transform duration-300" [class.rotate-180]="isHistoryExpanded()">
                <svg xmlns="http://www.w3.org/2000/svg" class="w-3 h-3 text-stone-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
                </svg>
              </span>
           </button>
           
           @if (isHistoryExpanded()) {
             <div class="h-48 border-t border-dashed border-stone-200 dark:border-stone-800 bg-stone-50 dark:bg-stone-900/50 animate-slide-in-bottom">
               <app-strata-view class="block h-full w-full"></app-strata-view>
             </div>
           }
        </div>

      </div>
    </div>
    
    <!-- 折叠切换按钮 (悬浮在侧边栏边缘) -->
    <div class="pointer-events-auto absolute top-1/2 left-full z-50 transform -translate-y-1/2 -ml-0.5">
      <button
        (click)="toggleSidebar()"
        class="flex items-center justify-center w-5 h-16 bg-white dark:bg-stone-800 border border-l-0 border-stone-200 dark:border-stone-700 rounded-r-lg shadow-md text-stone-400 hover:text-indigo-600 hover:w-6 transition-all focus:outline-none"
        [title]="isOpen() ? '收起侧边栏' : '展开侧边栏'">
        <svg xmlns="http://www.w3.org/2000/svg" class="w-3 h-3 transition-transform duration-300" [class.rotate-180]="isOpen()" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
        </svg>
      </button>
    </div>
  `,
  providers: []
})
export class FlowPaletteComponent implements OnDestroy {
  readonly uiState = inject(UiStateService);
  readonly projectState = inject(ProjectStateService);
  readonly blackBoxService = inject(BlackBoxService);
  readonly focusPrefs = inject(FocusPreferenceService);
  readonly workbenchSectionRef = viewChild<ElementRef<HTMLElement>>('workbenchSection');
  readonly blackboxSectionRef = viewChild<ElementRef<HTMLElement>>('blackboxSection');

  // 输入
  readonly height = input<number>(200);
  readonly isDropTargetActive = input<boolean>(false);

  // 输出事件
  readonly heightChange = output<number>();
  readonly centerOnNode = output<string>();
  readonly createUnassigned = output<void>();
  readonly taskClick = output<Task>();
  readonly taskDragStart = output<{ event: DragEvent; task: Task }>();
  readonly taskDrop = output<{ event: DragEvent }>();
  readonly taskTouchStart = output<{ event: TouchEvent; task: Task }>();
  readonly taskTouchMove = output<{ event: TouchEvent }>();
  readonly taskTouchEnd = output<{ event: TouchEvent }>();

  // 手势滑动事件
  readonly swipeToText = output<void>();
  readonly swipeToSidebar = output<void>();

  // 内部状态
  readonly draggingId = signal<string | null>(null);
  readonly isOpen = signal<boolean>(true);
  readonly isHistoryExpanded = signal<boolean>(false);
  readonly focusedSection = signal<'unfinished' | 'unassigned' | 'blackbox' | null>(null);
  readonly blackBoxExpandToken = signal(0);
  readonly activeWorkbenchTab = signal<'unfinished' | 'unassigned' | 'blackbox'>('unfinished');

  /** 待分配区每次展示的任务上限，防止 DOM 节点过多导致 UI 崩溃 */
  private readonly UNASSIGNED_PAGE_SIZE = 50;
  readonly unassignedDisplayLimit = signal(50);

  /** 限量展示的待分配任务列表 */
  readonly displayedUnassignedTasks = computed(() =>
    this.projectState.unassignedTasks().slice(0, this.unassignedDisplayLimit())
  );

  /** 是否还有更多未展示的待分配任务 */
  readonly hasMoreUnassigned = computed(() =>
    this.projectState.unassignedTasks().length > this.unassignedDisplayLimit()
  );

  /** 剩余未展示数量 */
  readonly remainingUnassignedCount = computed(() =>
    Math.max(0, this.projectState.unassignedTasks().length - this.unassignedDisplayLimit())
  );

  // 与 FlowToolbar 保持一致，但侧边栏默认展开
  readonly isOpenChange = output<boolean>();

  readonly expandedWidth = '360px'; // 固定宽度，不再使用 clamp 的弹性宽度，保持一致性

  readonly livingTasks = computed(() => this.projectState.tasks().filter(task => !task.deletedAt));
  readonly totalTaskCount = computed(() => this.livingTasks().length);
  readonly activeTaskCount = computed(() => this.livingTasks().filter(task => task.status === 'active').length);
  readonly completedTaskCount = computed(() => this.livingTasks().filter(task => task.status === 'completed').length);
  readonly unfinishedCount = computed(() => this.projectState.unfinishedItems().length);
  readonly unassignedCount = computed(() => this.projectState.unassignedTasks().length);

  readonly blackBoxPendingCount = this.blackBoxService.pendingCount;

  readonly completionRate = computed(() =>
    this.calculatePercent(this.completedTaskCount(), this.totalTaskCount())
  );

  readonly projectStatusLabel = computed(() => {
    const total = this.totalTaskCount();
    if (total === 0) return '初始化';
    if (this.completionRate() >= 70) return '稳态推进';
    if (this.completionRate() >= 35) return '高效执行';
    return '启动阶段';
  });

  toggleSidebar() {
    this.isOpen.set(!this.isOpen());
    this.isOpenChange.emit(this.isOpen());
  }

  toggleHistory() {
    this.isHistoryExpanded.set(!this.isHistoryExpanded());
  }

  setWorkbenchTab(tab: 'unfinished' | 'unassigned' | 'blackbox'): void {
    this.activeWorkbenchTab.set(tab);
    // 切换到待分配 tab 时重置展示上限，避免残留超量 DOM
    if (tab === 'unassigned') {
      this.unassignedDisplayLimit.set(this.UNASSIGNED_PAGE_SIZE);
    }
    // 兼容原有状态逻辑，但不强制绑定
    if (tab === 'unfinished') this.uiState.isFlowUnfinishedOpen.set(true);
    if (tab === 'unassigned') this.uiState.isFlowUnassignedOpen.set(true);
  }

  /** 加载更多待分配任务 */
  loadMoreUnassigned(): void {
    this.unassignedDisplayLimit.update(v => v + this.UNASSIGNED_PAGE_SIZE);
  }

  focusDashboardSection(section: 'unfinished' | 'unassigned' | 'blackbox'): void {
    this.setWorkbenchTab(section);
    
    if (section === 'blackbox') {
      this.blackBoxExpandToken.update(v => v + 1);
    }

    this.focusedSection.set(section);
    
    if (this.sectionFocusTimer) {
      clearTimeout(this.sectionFocusTimer);
    }

    this.sectionFocusTimer = setTimeout(() => {
      this.focusedSection.set(null);
      this.sectionFocusTimer = null;
    }, 1000);
  }

  // 触摸拖动状态
  private touchState = {
    task: null as Task | null,
    startX: 0,
    startY: 0,
    isDragging: false,
    longPressTimer: null as ReturnType<typeof setTimeout> | null,
    ghost: null as HTMLElement | null
  };

  private sectionFocusTimer: ReturnType<typeof setTimeout> | null = null;

  ngOnDestroy() {
    if (this.touchState.longPressTimer) {
      clearTimeout(this.touchState.longPressTimer);
      this.touchState.longPressTimer = null;
    }

    if (this.touchState.ghost) {
      this.touchState.ghost.remove();
      this.touchState.ghost = null;
    }

    if (this.sectionFocusTimer) {
      clearTimeout(this.sectionFocusTimer);
      this.sectionFocusTimer = null;
    }
  }

  // 拖动事件
  onDragStart(event: DragEvent, task: Task) {
    if (event.dataTransfer) {
      event.dataTransfer.setData('text', JSON.stringify(task));
      event.dataTransfer.setData('application/json', JSON.stringify(task));
      event.dataTransfer.effectAllowed = 'move';
    }
    this.taskDragStart.emit({ event, task });
  }

  onDragOver(event: DragEvent) {
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'move';
    }
  }

  onDrop(event: DragEvent) {
    event.preventDefault();

    const data = event.dataTransfer?.getData('application/json') || event.dataTransfer?.getData('text');
    if (!data) {
      this.taskDrop.emit({ event });
      return;
    }

    try {
      const draggedTask = JSON.parse(data) as { id?: string; stage?: number | null };

      if (draggedTask?.id && draggedTask.stage === null) {
        this.taskDrop.emit({ event });
        return;
      }
    } catch (_err) {
      // 数据解析失败时，回落到通用 drop 处理
    }

    this.taskDrop.emit({ event });
  }

  // 触摸事件
  onTouchStart(event: TouchEvent, task: Task) {
    if (event.touches.length !== 1) return;

    const touch = event.touches[0];
    this.touchState = {
      task,
      startX: touch.clientX,
      startY: touch.clientY,
      isDragging: false,
      longPressTimer: null,
      ghost: null
    };

    this.touchState.longPressTimer = setTimeout(() => {
      this.touchState.isDragging = true;
      this.draggingId.set(task.id);
      this.createGhost(task, touch.clientX, touch.clientY);
      if (navigator.vibrate) navigator.vibrate(50);
    }, 250);

    this.taskTouchStart.emit({ event, task });
  }

  onTouchMove(event: TouchEvent) {
    if (!this.touchState.task || event.touches.length !== 1) return;

    const touch = event.touches[0];
    const deltaX = Math.abs(touch.clientX - this.touchState.startX);
    const deltaY = Math.abs(touch.clientY - this.touchState.startY);

    if (!this.touchState.isDragging && (deltaX > 15 || deltaY > 15)) {
      if (this.touchState.longPressTimer) {
        clearTimeout(this.touchState.longPressTimer);
        this.touchState.longPressTimer = null;
      }
      return;
    }

    if (this.touchState.isDragging) {
      if (event.cancelable) {
        event.preventDefault();
      }
      event.stopPropagation();

      if (this.touchState.ghost) {
        this.touchState.ghost.style.left = `${touch.clientX - 40}px`;
        this.touchState.ghost.style.top = `${touch.clientY - 20}px`;
      }
    }

    this.taskTouchMove.emit({ event });
  }

  onTouchEnd(event: TouchEvent) {
    if (this.touchState.longPressTimer) {
      clearTimeout(this.touchState.longPressTimer);
    }

    if (this.touchState.ghost) {
      this.touchState.ghost.remove();
    }

    this.draggingId.set(null);
    this.taskTouchEnd.emit({ event });

    this.touchState = {
      task: null,
      startX: 0,
      startY: 0,
      isDragging: false,
      longPressTimer: null,
      ghost: null
    };
  }

  private createGhost(task: Task, x: number, y: number) {
    const ghost = document.createElement('div');
    ghost.className = 'fixed z-[9999] px-3 py-2 bg-indigo-500/90 text-white rounded-lg shadow-xl text-xs font-medium pointer-events-none whitespace-nowrap';
    ghost.textContent = task.title || '未命名';
    ghost.style.left = `${x - 40}px`;
    ghost.style.top = `${y - 20}px`;
    document.body.appendChild(ghost);
    this.touchState.ghost = ghost;
  }

  private calculatePercent(value: number, total: number): number {
    if (total <= 0) return 0;
    return this.clamp(Math.round((value / total) * 100), 0, 100);
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
  }
}
