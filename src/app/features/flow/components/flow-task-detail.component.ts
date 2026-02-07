import { Component, input, output, computed, inject, OnDestroy, HostListener, ElementRef, effect, untracked, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { UiStateService } from '../../../../services/ui-state.service';
import { ProjectStateService } from '../../../../services/project-state.service';
import { UserSessionService } from '../../../../services/user-session.service';
import { Task, Attachment } from '../../../../models';
import { renderMarkdown } from '../../../../utils/markdown';
import { FlowTaskDetailFormService } from '../services/flow-task-detail-form.service';
/** 任务详情面板 - 桌面端:浮动面板, 移动端:底部抽屉, 默认预览模式 */
@Component({
  selector: 'app-flow-task-detail',
  standalone: true,
  imports: [CommonModule, FormsModule],
  providers: [FlowTaskDetailFormService],
  template: `
    <!-- 桌面端可拖动浮动面板 -->
    @if (!uiState.isMobile() && uiState.isFlowDetailOpen()) {
      <div class="absolute z-20 pointer-events-auto"
           [style.right.px]="position().x < 0 ? 0 : null"
           [style.top.px]="position().y < 0 ? 24 : position().y"
           [style.left.px]="position().x >= 0 ? position().x : null">
         <div class="w-64 max-h-96 bg-white/95 dark:bg-stone-800/95 backdrop-blur-xl border border-stone-200/50 dark:border-stone-600/50 shadow-xl overflow-hidden flex flex-col rounded-xl">
             <!-- 可拖动标题栏 - 双击重置位置 -->
             <div class="px-3 py-2 border-b border-stone-100 dark:border-stone-700 flex justify-between items-center cursor-move select-none bg-gradient-to-r from-stone-50 dark:from-stone-700 to-white dark:to-stone-800"
                  (mousedown)="startDrag($event)"
                  (touchstart)="startDrag($event)"
                  (dblclick)="resetPosition()"
                  title="拖动移动面板，双击重置位置">
                 <div class="flex items-center gap-1.5">
                     <span class="text-[8px] text-stone-400 dark:text-stone-500">☰</span>
                     <h3 class="font-bold text-stone-700 dark:text-stone-200 text-xs">任务详情</h3>
                 </div>
                 <button (click)="uiState.isFlowDetailOpen.set(false)" class="text-stone-400 dark:text-stone-500 hover:text-stone-600 dark:hover:text-stone-300 p-1">
                   <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                     <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
                   </svg>
                 </button>
             </div>
                 
             <div class="flex-1 overflow-y-auto px-3 py-2 space-y-2">
                 @if (task(); as t) {
                     <ng-container *ngTemplateOutlet="taskContent; context: { $implicit: t }"></ng-container>
                 } @else if (projectState.activeProject()) {
                     <div class="text-[11px] space-y-1">
                         <div class="font-bold text-stone-800 dark:text-stone-100">{{projectState.activeProject()?.name}}</div>
                         <div class="text-stone-400 dark:text-stone-500 font-mono text-[10px]">{{projectState.activeProject()?.createdDate | date:'yyyy-MM-dd'}}</div>
                         <div class="text-stone-500 dark:text-stone-400 mt-1">{{projectState.activeProject()?.description}}</div>
                     </div>
                 } @else {
                     <div class="py-4 text-center text-stone-400 dark:text-stone-500 text-[10px]">
                         双击节点查看详情
                     </div>
                 }
             </div>
         </div>
      </div>
    }
    
    <!-- 桌面端详情开启按钮 -->
    @if (!uiState.isMobile() && !uiState.isFlowDetailOpen()) {
      <button (click)="uiState.isFlowDetailOpen.set(true)" 
              class="absolute top-6 right-2 z-20 bg-white/90 dark:bg-stone-800/90 backdrop-blur border border-stone-200 dark:border-stone-600 rounded-lg p-2 shadow-sm hover:bg-white dark:hover:bg-stone-700 text-stone-400 dark:text-stone-500 hover:text-stone-600 dark:hover:text-stone-300 transition-all flex items-center gap-1">
          <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span class="text-[10px] font-medium">详情</span>
      </button>
    }

    <!-- 移动端顶部小型标签触发器 -->
    @if (uiState.isMobile() && !uiState.isFlowDetailOpen()) {
      <button 
        (click)="uiState.isFlowDetailOpen.set(true)"
        class="absolute top-2 right-2 z-25 bg-white/90 dark:bg-stone-800/90 backdrop-blur rounded-lg shadow-sm border border-stone-200 dark:border-stone-600 px-2 py-1 flex items-center gap-1 text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-200">
        <svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <span class="text-[10px] font-medium">详情</span>
      </button>
    }
    
    <!-- 移动端顶部下拉抽屉面板 -->
    @if (uiState.isMobile() && uiState.isFlowDetailOpen()) {
       <div
         #mobileDrawer
         class="absolute left-0 right-0 z-30 bg-white/95 dark:bg-stone-800/95 backdrop-blur-xl border-b border-stone-200 dark:border-stone-700 shadow-[0_4px_20px_rgba(0,0,0,0.1)] rounded-b-2xl flex flex-col transition-all duration-100"
           [style.top.px]="0"
           [style.height.vh]="drawerHeight()"
           style="transform: translateZ(0); backface-visibility: hidden;">
        <!-- 标题栏 - 左边留出空间避开导航按钮，紧凑布局 -->
         <div
           #mobileDrawerTitle
           class="pr-3 flex justify-between items-center flex-shrink-0"
             [class.pl-28]="drawerHeight() >= 20"
             [class.pl-3]="drawerHeight() < 20"
             [class.pt-1.5]="drawerHeight() >= 20"
             [class.pt-0.5]="drawerHeight() < 20"
             [class.pb-0.5]="drawerHeight() >= 20"
             [class.pb-0]="drawerHeight() < 20">
          <h3 class="font-bold text-stone-700 dark:text-stone-200 text-xs transition-opacity duration-100"
              [class.opacity-0]="drawerHeight() < 20"
              [class.opacity-100]="drawerHeight() >= 20">任务详情</h3>
        </div>
        
        <!-- 内容区域 - 更紧凑 -->
        <div
             #mobileDrawerContent
             class="mobile-drawer-content flex-1 overflow-y-auto px-3 pb-1 overscroll-contain"
             (touchstart)="onContentTouchStart($event)"
             (touchmove)="onContentTouchMove($event)"
             style="-webkit-overflow-scrolling: touch; touch-action: pan-y; transform: translateZ(0); contain: layout style paint;">
          @if (task(); as t) {
            <ng-container *ngTemplateOutlet="mobileTaskContent; context: { $implicit: t }"></ng-container>
          } @else {
            <div class="text-center text-stone-400 text-xs py-1">双击节点查看详情</div>
          }
        </div>
        
        <!-- 拖动条 - 紧凑 -->
           <div
             #mobileDrawerHandle
             class="relative flex justify-center py-1 cursor-grab active:cursor-grabbing touch-none flex-shrink-0"
             (touchstart)="startDrawerResize($event)"
             (mousedown)="startDrawerResize($event)"
             style="transform: translateZ(0); will-change: transform;">
          <div class="w-10 h-1 bg-stone-300 rounded-full"></div>
          <button (click)="uiState.isFlowDetailOpen.set(false); $event.stopPropagation()" 
                  (touchstart)="$event.stopPropagation()"
                  (mousedown)="$event.stopPropagation()"
                  class="absolute right-3 top-1/2 -translate-y-1/2 text-stone-400 hover:text-stone-600 transition-all pointer-events-auto">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" class="transition-all h-3 w-3">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
            </svg>
          </button>
        </div>
      </div>
    }
    
    <!-- 桌面端任务内容模板 -->
    <ng-template #taskContent let-task>
      <div class="space-y-2">
          <div class="flex items-center justify-between">
              <div class="flex items-center gap-2 text-[10px]">
                  <span class="font-bold text-retro-muted dark:text-stone-400 bg-stone-100 dark:bg-stone-700 px-1.5 py-0.5 rounded">{{projectState.compressDisplayId(task.displayId)}}</span>
                  <span class="text-stone-400">{{task.createdDate | date:'MM-dd'}}</span>
                <span data-testid="flow-task-status-badge" class="px-1.5 py-0.5 rounded"
                        [ngClass]="{
                          'bg-emerald-100': task.status === 'completed',
                          'dark:bg-emerald-900/30': task.status === 'completed',
                          'text-emerald-700': task.status === 'completed',
                          'dark:text-emerald-300': task.status === 'completed',
                          'bg-amber-100': task.status !== 'completed',
                          'dark:bg-amber-900/30': task.status !== 'completed',
                          'text-amber-700': task.status !== 'completed',
                          'dark:text-amber-300': task.status !== 'completed'
                        }">
                    {{task.status === 'completed' ? '完成' : '进行中'}}
                  </span>
              </div>
              <button 
                  (click)="toggleEditMode()"
                data-testid="flow-edit-toggle-btn"
                  class="text-[9px] px-1.5 py-0.5 rounded transition-all duration-200"
                  [ngClass]="{
                    'bg-indigo-100 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-300': isEditMode(),
                    'bg-stone-100 dark:bg-stone-700 text-stone-500 dark:text-stone-400 hover:bg-indigo-50 dark:hover:bg-indigo-900/20': !isEditMode(),
                    'scale-95 opacity-70': isTogglingMode
                  }"
                  [disabled]="isTogglingMode">
                  {{ isEditMode() ? '预览' : '编辑' }}
              </button>
          </div>

          @if (!isEditMode()) {
              <div class="cursor-pointer" (click)="toggleEditMode(); $event.stopPropagation()">
                <h4 data-testid="flow-task-title" class="text-xs font-medium text-stone-800 dark:text-stone-200 mb-1">{{ task.title || '无标题' }}</h4>
                  @if (task.content) {
                      <div 
                          class="text-[11px] text-stone-600 dark:text-stone-300 leading-relaxed markdown-preview bg-retro-muted/5 border border-retro-muted/20 rounded-lg p-2 max-h-32 overflow-y-auto overflow-x-hidden"
                          [innerHTML]="renderMarkdownContent(task.content)">
                      </div>
                  } @else {
                      <div class="text-[11px] text-stone-400 dark:text-stone-500 italic">点击编辑内容...</div>
                  }
              </div>
          } @else {
              <input data-testid="flow-task-title-input" type="text" 
                  [ngModel]="localTitle()" 
                  (ngModelChange)="onLocalTitleChange($event)"
                  (focus)="onInputFocus('title')"
                  (blur)="onInputBlur('title')"
                  (mousedown)="formService.isSelecting = true"
                  (mouseup)="formService.isSelecting = false"
                  spellcheck="false"
                  class="w-full text-xs font-medium text-stone-800 dark:text-stone-100 border border-stone-200 dark:border-stone-600 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-indigo-300 dark:focus:ring-indigo-500 bg-white dark:bg-stone-700"
                  placeholder="任务标题">
              
              <textarea 
                  [ngModel]="localContent()" 
                  (ngModelChange)="onLocalContentChange($event)" 
                  rows="4"
                  (focus)="onInputFocus('content')"
                  (blur)="onInputBlur('content')"
                  (mousedown)="formService.isSelecting = true"
                  (mouseup)="formService.isSelecting = false"
                  spellcheck="false"
                  class="w-full text-[11px] text-stone-600 dark:text-stone-300 border border-stone-200 dark:border-stone-600 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-indigo-300 dark:focus:ring-indigo-500 bg-white dark:bg-stone-700 resize-none font-mono leading-relaxed"
                  placeholder="输入内容（支持 Markdown）..."></textarea>
          }

          <div class="flex gap-1.5 pt-1">
              <button (click)="addSibling.emit(task)"
                  class="flex-1 px-2 py-1 bg-retro-teal/10 hover:bg-retro-teal text-retro-teal hover:text-white border border-retro-teal/30 text-[10px] font-medium rounded transition-all">
                  +同级
              </button>
              <button (click)="addChild.emit(task)"
                  class="flex-1 px-2 py-1 bg-retro-rust/10 hover:bg-retro-rust text-retro-rust hover:text-white border border-retro-rust/30 text-[10px] font-medium rounded transition-all">
                  +下级
              </button>
              <button (click)="toggleStatus.emit(task)"
                  data-testid="toggle-task-status-btn"
                  class="flex-1 px-2 py-1 text-[10px] font-medium rounded transition-all border"
                  [ngClass]="{
                    'bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-700': task.status !== 'completed',
                    'bg-stone-50 dark:bg-stone-700 text-stone-600 dark:text-stone-300 border-stone-200 dark:border-stone-600': task.status === 'completed'
                  }">
                  {{task.status === 'completed' ? '撤销' : '完成'}}
              </button>
          </div>
          <div class="flex gap-1.5">
              <button (click)="archiveTask.emit(task)"
                  class="flex-1 px-2 py-1 text-[10px] font-medium rounded transition-all border"
                  [ngClass]="{
                    'bg-violet-50 dark:bg-violet-900/30 text-violet-600 dark:text-violet-300 border-violet-200 dark:border-violet-700': task.status !== 'archived',
                    'bg-stone-50 dark:bg-stone-700 text-stone-600 dark:text-stone-300 border-stone-200 dark:border-stone-600': task.status === 'archived'
                  }"
                  title="归档后任务将从主视图隐藏，可在回收站中恢复">
                  {{task.status === 'archived' ? '取消归档' : '归档'}}
              </button>
                <button data-testid="delete-task-btn" (click)="deleteTask.emit(task)"
                  class="px-2 py-1 bg-stone-50 dark:bg-stone-700 hover:bg-red-500 dark:hover:bg-red-600 text-stone-400 dark:text-stone-500 hover:text-white border border-stone-200 dark:border-stone-600 text-[10px] font-medium rounded transition-all">
                  删除
              </button>
          </div>
      </div>
    </ng-template>
    
    <!-- 移动端任务内容模板 -->
    <ng-template #mobileTaskContent let-task>
      <div class="flex items-center gap-1.5 mb-1 flex-wrap">
        <span class="font-bold text-retro-muted dark:text-stone-400 text-[8px] tracking-wider bg-stone-100 dark:bg-stone-700 px-1.5 py-0.5 rounded">{{projectState.compressDisplayId(task.displayId)}}</span>
        <span class="text-[9px] text-stone-400">{{task.createdDate | date:'MM-dd'}}</span>
        <span class="text-[9px] px-1 py-0.5 rounded"
              [ngClass]="{
                'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300': task.status === 'completed',
                'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300': task.status !== 'completed'
              }">
          {{task.status === 'completed' ? '完成' : '进行'}}
        </span>
        <button 
          (click)="toggleEditMode()"
          class="ml-auto text-[9px] px-1.5 py-0.5 rounded transition-all duration-200"
          [ngClass]="{
            'bg-indigo-100 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-300': !isEditMode(),
            'bg-stone-100 dark:bg-stone-700 text-stone-500 dark:text-stone-400': isEditMode(),
            'scale-95 opacity-70': isTogglingMode
          }"
          [disabled]="isTogglingMode">
          {{ isEditMode() ? '预览' : '编辑' }}
        </button>
      </div>

      @if (!isEditMode()) {
        <div class="cursor-pointer space-y-1" (click)="toggleEditMode(); $event.stopPropagation()">
          <h4 class="text-xs font-medium text-stone-800 dark:text-stone-100 leading-tight" [class.line-clamp-1]="isCompactMode()">{{ task.title || '无标题' }}</h4>
          @if (task.content) {
            <div class="text-[11px] text-stone-600 leading-relaxed markdown-preview overflow-hidden max-h-28" [innerHTML]="renderMarkdownContent(task.content)"></div>
          }
        </div>
      } @else {
        <div class="space-y-1.5">
          <input type="text" 
            [ngModel]="localTitle()" 
            (ngModelChange)="onLocalTitleChange($event)"
            (focus)="onInputFocus('title')"
            (blur)="onInputBlur('title')"
            (mousedown)="formService.isSelecting = true"
            (mouseup)="formService.isSelecting = false"
            spellcheck="false"
            class="w-full text-xs font-medium text-stone-800 dark:text-stone-100 border border-stone-200 dark:border-stone-600 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-indigo-300 dark:focus:ring-indigo-500 bg-white dark:bg-stone-700"
            placeholder="任务标题">
          <textarea 
            [ngModel]="localContent()" 
            (ngModelChange)="onLocalContentChange($event)" 
            rows="3"
            (focus)="onInputFocus('content')"
            (blur)="onInputBlur('content')"
            (mousedown)="formService.isSelecting = true"
            (mouseup)="formService.isSelecting = false"
            spellcheck="false"
            class="w-full text-[11px] text-stone-600 dark:text-stone-300 border border-stone-200 dark:border-stone-600 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-indigo-300 dark:focus:ring-indigo-500 bg-white dark:bg-stone-700 resize-none font-mono"
            placeholder="任务内容（支持 Markdown）..."></textarea>
          <div class="flex items-center gap-1 bg-retro-rust/5 border border-retro-rust/20 rounded overflow-hidden p-0.5">
            <span class="text-retro-rust flex-shrink-0 text-[10px] pl-1">☐</span>
            <input
              #quickTodoInput
              type="text"
              (keydown.enter)="addQuickTodo(task.id, quickTodoInput)"
              spellcheck="false"
              class="flex-1 bg-transparent border-none outline-none text-stone-600 placeholder-stone-400 text-[10px] py-0.5 px-1"
              placeholder="待办，回车添加...">
            <button
              (click)="addQuickTodo(task.id, quickTodoInput)"
              class="flex-shrink-0 bg-retro-rust/10 hover:bg-retro-rust text-retro-rust hover:text-white rounded p-0.5 mr-0.5 transition-all">
              <svg class="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            </button>
          </div>
        </div>
      }
      
      <!-- 操作按钮 -->
      <div class="overflow-hidden transition-all duration-150"
           [class.max-h-0]="isCompactMode()"
           [class.opacity-0]="isCompactMode()"
           [class.pointer-events-none]="isCompactMode()"
           [class.max-h-32]="!isCompactMode()"
           [class.opacity-100]="!isCompactMode()">
        <div class="flex gap-1 mt-2">
          <button (click)="addSibling.emit(task)"
            class="flex-1 px-1.5 py-1 bg-retro-teal/10 text-retro-teal border border-retro-teal/30 text-[9px] font-medium rounded transition-all">
            +同级
          </button>
          <button (click)="addChild.emit(task)"
            class="flex-1 px-1.5 py-1 bg-retro-rust/10 text-retro-rust border border-retro-rust/30 text-[9px] font-medium rounded transition-all">
            +下级
          </button>
          <button (click)="toggleStatus.emit(task)"
            class="flex-1 px-1.5 py-1 text-[9px] font-medium rounded border transition-all"
            [ngClass]="{
              'bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-700': task.status !== 'completed',
              'bg-stone-50 dark:bg-stone-700 text-stone-600 dark:text-stone-300 border-stone-200 dark:border-stone-600': task.status === 'completed'
            }">
            {{task.status === 'completed' ? '撤销' : '完成'}}
          </button>
        </div>
        <div class="flex gap-1 mt-1">
          <button (click)="archiveTask.emit(task)"
            class="flex-1 px-1.5 py-1 text-[9px] font-medium rounded transition-all border"
            [ngClass]="{
              'bg-violet-50 dark:bg-violet-900/30 text-violet-600 dark:text-violet-300 border-violet-200 dark:border-violet-700': task.status !== 'archived',
              'bg-stone-50 dark:bg-stone-700 text-stone-600 dark:text-stone-300 border-stone-200 dark:border-stone-600': task.status === 'archived'
            }">
            {{task.status === 'archived' ? '取消归档' : '归档'}}
          </button>
          <button (click)="deleteTask.emit(task)"
            class="px-1.5 py-1 bg-stone-50 dark:bg-stone-700 text-stone-400 dark:text-stone-500 border border-stone-200 dark:border-stone-600 hover:bg-red-500 dark:hover:bg-red-600 hover:text-white hover:border-red-500 text-[9px] font-medium rounded transition-all">
            删除
          </button>
        </div>
      </div>
    </ng-template>
  `
})
export class FlowTaskDetailComponent implements OnDestroy {
  // P2-1 迁移：直接注入子服务
  readonly uiState = inject(UiStateService);
  readonly projectState = inject(ProjectStateService);
  readonly userSession = inject(UserSessionService);
  private readonly elementRef = inject(ElementRef);
  readonly formService = inject(FlowTaskDetailFormService);

  @ViewChild('mobileDrawer') private mobileDrawer?: ElementRef<HTMLDivElement>;
  @ViewChild('mobileDrawerTitle') private mobileDrawerTitle?: ElementRef<HTMLDivElement>;
  @ViewChild('mobileDrawerContent') private mobileDrawerContent?: ElementRef<HTMLDivElement>;
  @ViewChild('mobileDrawerHandle') private mobileDrawerHandle?: ElementRef<HTMLDivElement>;

  private static readonly MOBILE_DRAWER_MIN_VISIBLE_PX = 84;
  private static readonly MOBILE_DRAWER_MEASURE_BUFFER_PX = 12;
  
  // 输入
  readonly task = input<Task | null>(null);
  readonly position = input<{ x: number; y: number }>({ x: -1, y: -1 });
  readonly drawerHeight = input<number>(35); // vh 单位
  // 当用户手动拖拽抽屉时，父组件可关闭自动高度补偿，避免“弹回”
  readonly autoHeightEnabled = input<boolean>(true);
  
  // 表单状态委托给 FlowTaskDetailFormService
  readonly localTitle = this.formService.localTitle;
  readonly localContent = this.formService.localContent;
  readonly isEditMode = this.formService.isEditMode;
  readonly isTogglingMode = this.formService.isTogglingMode;
  
  // 紧凑模式：只有当抽屉高度非常小（< 12vh）时才启用，隐藏操作按钮
  // 日期和状态应该一直显示，除非抽屉几乎完全收起
  readonly isCompactMode = computed(() => this.drawerHeight() < 12);
  
  // 内容预览最大高度：根据抽屉高度动态计算
  readonly contentMaxHeight = computed(() => {
    const height = this.drawerHeight();
    if (height < 15) return 'max-h-8'; // 非常紧凑：只显示一行
    if (height < 25) return 'max-h-16'; // 较小：显示约2行
    if (height < 35) return 'max-h-24'; // 中等：显示约3行
    return 'max-h-28'; // 正常：显示更多
  });
  
  // 位置变更输出
  readonly positionChange = output<{ x: number; y: number }>();
  readonly drawerHeightChange = output<number>();
  readonly isResizingChange = output<boolean>();
  
  // 任务操作输出
  readonly titleChange = output<{ taskId: string; title: string }>();
  readonly contentChange = output<{ taskId: string; content: string }>();
  readonly addSibling = output<Task>();
  readonly addChild = output<Task>();
  readonly toggleStatus = output<Task>();
  readonly archiveTask = output<Task>();
  readonly deleteTask = output<Task>();
  readonly quickTodoAdd = output<{ taskId: string; text: string }>();
  
  // 附件操作输出
  readonly attachmentAdd = output<{ taskId: string; attachment: Attachment }>();
  readonly attachmentRemove = output<{ taskId: string; attachmentId: string }>();
  readonly attachmentsChange = output<{ taskId: string; attachments: Attachment[] }>();
  readonly attachmentError = output<string>();
  
  // 拖动状态
  private dragState = { isDragging: false, startX: 0, startY: 0, offsetX: 0, offsetY: 0 };
  private isResizingDrawer = false;
  private drawerStartY = 0;
  private drawerStartHeight = 0;
  
  constructor() {
    // Split-Brain 核心逻辑：委托给 formService
    this.formService.initSyncEffect(() => this.task());

    // 🔴 移动端：当任务、编辑模式或面板打开状态变化时，自动调整高度
    effect(() => {
      this.task();
      this.isEditMode();
      const isOpen = this.uiState.isFlowDetailOpen();
      
      if (this.uiState.isMobile() && isOpen) {
        untracked(() => this.requestAutoHeight());
      }
    });

    // 🔴 移动端：切回 Flow 视图后，强制校准一次抽屉高度（防止提示语被挤没）
    effect(() => {
      const view = this.uiState.activeView();
      const isOpen = this.uiState.isFlowDetailOpen();

      if (this.uiState.isMobile() && view === 'flow' && isOpen) {
        untracked(() => this.requestAutoHeight());
      }
    });
  }
  
  // ========== 表单事件委托 ==========

  /** 移动端：请求自动调整高度以适应内容 */
  private requestAutoHeight() {
    if (!this.uiState.isMobile() || !this.uiState.isFlowDetailOpen()) return;
    if (!this.autoHeightEnabled()) return; // 手动覆盖时不自动调整

    const measureOnce = () => {
      const container = this.mobileDrawer?.nativeElement
        ?? this.elementRef.nativeElement.querySelector('.absolute.left-0.right-0.z-30');
      const title = this.mobileDrawerTitle?.nativeElement
        ?? container?.querySelector('.flex-shrink-0');
      const content = this.mobileDrawerContent?.nativeElement
        ?? container?.querySelector('.overflow-y-auto');
      const handle = this.mobileDrawerHandle?.nativeElement
        ?? container?.querySelector('.touch-none.flex-shrink-0');

      if (!container || !title || !content || !handle) return;
      if (typeof window === 'undefined' || window.innerHeight <= 0) return;

      const titleH = (title as HTMLElement).offsetHeight || 0;
      const handleH = (handle as HTMLElement).offsetHeight || 0;

      // 关键：不要用 content.scrollHeight 做自适应。
      // 否则在点击任务块自动展开时，会把抽屉撑到“内容全量可见”，导致遮挡过大。
      // 这里仅做“最小可见校准”：确保标题栏/拖动条不会被挤没。
      const minPx = Math.max(
        // 即使测量为 0，也至少保证拖动条可用
        handleH + 12,
        // 标题 + 拖动条 + 少量缓冲（避免 vh 四舍五入导致抖动）
        titleH + handleH + FlowTaskDetailComponent.MOBILE_DRAWER_MEASURE_BUFFER_PX
      );

      const minVh = (minPx / window.innerHeight) * 100;
      const desiredVh = Math.min(Math.max(minVh, 5), 70);

      // 只做“向上补齐”，不主动缩小（避免用户手动调大后被自动收回）
      if (this.drawerHeight() + 0.5 < desiredVh) {
        this.drawerHeightChange.emit(desiredVh);
      }
    };

    // 两段式测量：rAF 等待布局稳定，再补一次 timeout 防止字体/内容延迟导致高度为 0
    requestAnimationFrame(() => {
      requestAnimationFrame(() => measureOnce());
    });
    setTimeout(() => measureOnce(), 200);
  }
  
  /** 输入框聚焦处理 */
  onInputFocus(field: 'title' | 'content') {
    this.uiState.markEditing();
    this.formService.onInputFocus(field, this.task());
  }

  /** 输入框失焦处理 */
  onInputBlur(field: 'title' | 'content') {
    const result = this.formService.onInputBlur(field, this.task());
    if (result) {
      if (result.field === 'title') {
        this.titleChange.emit({ taskId: result.taskId, title: result.value });
      } else {
        this.contentChange.emit({ taskId: result.taskId, content: result.value });
      }
    }
  }
  
  /** 本地标题变更 */
  onLocalTitleChange(value: string) {
    const result = this.formService.onLocalTitleChange(value, this.task());
    if (result) {
      this.titleChange.emit(result);
    }
  }

  /** 本地内容变更 */
  onLocalContentChange(value: string) {
    const result = this.formService.onLocalContentChange(value, this.task());
    if (result) {
      this.contentChange.emit(result);
    }
  }

  /** 切换编辑模式 */
  toggleEditMode(): void { this.formService.toggleEditMode(); }
  
  /** 监听 document 点击事件，编辑模式下点击非交互区域退出编辑 */
  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    if (this.formService.shouldExitEditMode(event.target as HTMLElement, this.elementRef.nativeElement)) {
      this.isEditMode.set(false);
    }
  }

  /** 监听 document 触摸事件（移动端），编辑模式下触摸非交互区域退出编辑 */
  @HostListener('document:touchstart', ['$event'])
  onDocumentTouchStart(event: TouchEvent): void {
    // 检查是否有输入框正在使用
    const activeElement = document.activeElement;
    if (activeElement && (activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA')) {
      return;
    }
    if (this.formService.shouldExitEditMode(event.target as HTMLElement, this.elementRef.nativeElement)) {
      this.isEditMode.set(false);
    }
  }
  
  /** 渲染 Markdown 内容 */
  renderMarkdownContent(content: string): string { return renderMarkdown(content); }
  
  // 桌面端面板拖动
  startDrag(event: MouseEvent | TouchEvent) {
    event.preventDefault();
    const _pos = this.position();
    const clientX = event instanceof MouseEvent ? event.clientX : event.touches[0].clientX;
    const clientY = event instanceof MouseEvent ? event.clientY : event.touches[0].clientY;
    
    // 获取面板的实际位置（相对于父容器）
    const target = event.target as HTMLElement;
    const panelEl = target.closest('.absolute') as HTMLElement;
    if (!panelEl) return;
    
    const parentEl = panelEl.parentElement;
    if (!parentEl) return;
    
    const parentRect = parentEl.getBoundingClientRect();
    const panelRect = panelEl.getBoundingClientRect();
    
    // 计算面板相对于父容器的当前位置
    const currentX = panelRect.left - parentRect.left;
    const currentY = panelRect.top - parentRect.top;
    
    this.dragState = {
      isDragging: true,
      startX: clientX,
      startY: clientY,
      offsetX: currentX,
      offsetY: currentY
    };
    
    document.addEventListener('mousemove', this.onDrag);
    document.addEventListener('mouseup', this.stopDrag);
    document.addEventListener('touchmove', this.onDrag);
    document.addEventListener('touchend', this.stopDrag);
  }
  
  private onDrag = (event: MouseEvent | TouchEvent) => {
    if (!this.dragState.isDragging) return;
    
    const clientX = event instanceof MouseEvent ? event.clientX : event.touches[0].clientX;
    const clientY = event instanceof MouseEvent ? event.clientY : event.touches[0].clientY;
    
    const deltaX = clientX - this.dragState.startX;
    const deltaY = clientY - this.dragState.startY;
    
    // 限制面板不能被拖出可视区域
    // 面板宽度 256px，高度最大 384px (max-h-96)
    const panelWidth = 256;
    const panelHeight = 384;
    const maxX = Math.max(0, window.innerWidth - panelWidth - 20); // 留 20px 边距
    const maxY = Math.max(0, window.innerHeight - panelHeight - 20);
    
    const newX = Math.max(0, Math.min(maxX, this.dragState.offsetX + deltaX));
    const newY = Math.max(0, Math.min(maxY, this.dragState.offsetY + deltaY));
    
    this.positionChange.emit({ x: newX, y: newY });
  };
  
  private stopDrag = () => {
    this.dragState.isDragging = false;
    document.removeEventListener('mousemove', this.onDrag);
    document.removeEventListener('mouseup', this.stopDrag);
    document.removeEventListener('touchmove', this.onDrag);
    document.removeEventListener('touchend', this.stopDrag);
  };

  /** 重置面板位置到默认位置（右上角） */
  resetPosition() { this.positionChange.emit({ x: -1, y: -1 }); }
  
  // 移动端抽屉高度调整（顶部下拉：向下拖增大，向上拖减小）
  startDrawerResize(event: TouchEvent | MouseEvent) {
    event.preventDefault();
    
    // 获取起始位置
    let startY: number;
    if (event instanceof TouchEvent) {
      if (event.touches.length !== 1) return;
      startY = event.touches[0].clientY;
    } else {
      startY = event.clientY;
    }
    
    this.isResizingDrawer = true;
    this.isResizingChange.emit(true);
    this.drawerStartY = startY;
    this.drawerStartHeight = this.drawerHeight();

    // 固定最小高度为 8vh，避免频繁的 DOM 查询
    const minHeight = 8;
    
    // 添加 will-change 提示浏览器优化
    const drawerEl = this.elementRef.nativeElement.querySelector('.absolute.z-30') as HTMLElement;
    if (drawerEl) {
      drawerEl.style.willChange = 'height';
    }
    
    let rafId: number | null = null;
    // 缓存最后计算的高度，用于磁吸（在 onEnd 中会更新）
    let _lastCalculatedHeight: number = this.drawerStartHeight;
    
    const onMove = (ev: TouchEvent | MouseEvent) => {
      if (!this.isResizingDrawer) return;
      ev.preventDefault();
      
      // 获取当前位置
      let currentY: number;
      if (ev instanceof TouchEvent) {
        if (ev.touches.length !== 1) return;
        currentY = ev.touches[0].clientY;
      } else {
        currentY = ev.clientY;
      }
      
      // 使用 requestAnimationFrame 节流，确保滑动丝滑
      if (rafId) return;
      
      rafId = requestAnimationFrame(() => {
        rafId = null;
        if (!this.isResizingDrawer) return;

        // 顶部抽屉：向下拖（正 deltaY）增大高度
        const deltaY = currentY - this.drawerStartY;
        const deltaVh = (deltaY / window.innerHeight) * 100;
        
        const newHeight = Math.max(minHeight, Math.min(70, this.drawerStartHeight + deltaVh));
        _lastCalculatedHeight = newHeight; // 更新缓存值
        this.drawerHeightChange.emit(newHeight);
      });
    };
    
    const onEnd = () => {
      this.isResizingDrawer = false;
      this.isResizingChange.emit(false);
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      
      // 移除 will-change，释放资源
      if (drawerEl) {
        drawerEl.style.willChange = 'auto';
      }
      
      // 移除自动关闭逻辑，允许用户自由调整到最小高度
      // 最小高度由 Math.max(8, ...) 控制
      window.removeEventListener('touchmove', onMove as EventListener);
      window.removeEventListener('touchend', onEnd);
      window.removeEventListener('touchcancel', onEnd);
      window.removeEventListener('mousemove', onMove as EventListener);
      window.removeEventListener('mouseup', onEnd);
    };
    
    window.addEventListener('touchmove', onMove as EventListener, { passive: false });
    window.addEventListener('touchend', onEnd);
    window.addEventListener('touchcancel', onEnd);
    window.addEventListener('mousemove', onMove as EventListener);
    window.addEventListener('mouseup', onEnd);
  }
  
  // 内容区域触摸处理 - 防止无限下拉
  onContentTouchStart(event: TouchEvent): void {
    const target = event.target as HTMLElement;
    // 检查是否是内容区域本身或可滚动的子元素
    const scrollableParent = target.closest('.overflow-y-auto') as HTMLElement;
    if (scrollableParent) {
      // 记录初始滚动位置
      scrollableParent.dataset['touchStartScrollTop'] = String(scrollableParent.scrollTop);
    }
  }

  onContentTouchMove(event: TouchEvent): void {
    const target = event.target as HTMLElement;
    const scrollableParent = target.closest('.overflow-y-auto') as HTMLElement;
    
    if (scrollableParent && !this.isResizingDrawer) {
      const scrollTop = scrollableParent.scrollTop;
      const scrollHeight = scrollableParent.scrollHeight;
      const clientHeight = scrollableParent.clientHeight;
      
      // 获取触摸移动的方向
      const touchStartScrollTop = Number(scrollableParent.dataset['touchStartScrollTop']) || 0;
      const _touch = event.touches[0];
      
      // 阻止在顶部继续向下拉或在底部继续向上拉
      if ((scrollTop === 0 && scrollTop >= touchStartScrollTop) || 
          (scrollTop + clientHeight >= scrollHeight && scrollTop <= touchStartScrollTop)) {
        // 允许内部滚动，不阻止事件
        return;
      }
      
      // 更新滚动位置记录
      scrollableParent.dataset['touchStartScrollTop'] = String(scrollTop);
    }
  }

  // 快速待办
  addQuickTodo(taskId: string, inputEl: HTMLInputElement) {
    const text = inputEl.value.trim();
    if (text) {
      this.quickTodoAdd.emit({ taskId, text });
      inputEl.value = '';
      inputEl.focus();
    }
  }
  
  // ========== 生命周期管理 ==========
  
  ngOnDestroy(): void {
    this.stopDrag();
    this.dragState.isDragging = false;
    this.isResizingDrawer = false;
    this.formService.cleanup();
  }
}
