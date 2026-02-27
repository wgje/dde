import { Component, ChangeDetectionStrategy, input, output, computed, inject, OnDestroy, HostListener, ElementRef, effect, untracked, ViewChild, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { UiStateService } from '../../../../services/ui-state.service';
import { ProjectStateService } from '../../../../services/project-state.service';
import { UserSessionService } from '../../../../services/user-session.service';
import { Task, Attachment } from '../../../../models';
import { SafeMarkdownPipe } from '../../../shared/pipes/safe-markdown.pipe';
import { FlowTaskDetailFormService } from '../services/flow-task-detail-form.service';
import { toggleMarkdownTodo, getTodoIndexFromClick } from '../../../../utils/markdown';
import { TaskOperationAdapterService } from '../../../../services/task-operation-adapter.service';
/** 浠诲姟璇︽儏闈㈡澘 - 妗岄潰绔?娴姩闈㈡澘, 绉诲姩绔?搴曢儴鎶藉眽, 榛樿棰勮妯″紡 */
@Component({
  selector: 'app-flow-task-detail',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, SafeMarkdownPipe],
  providers: [FlowTaskDetailFormService],
  // Host defaults to pointer-events none; interactive children explicitly opt in.
  host: { style: 'pointer-events: none' },
  template: `
    <!-- 妗岄潰绔彲鎷栧姩娴姩闈㈡澘 -->
    @if (!uiState.isMobile() && uiState.isFlowDetailOpen()) {
      <div class="absolute z-20 pointer-events-auto"
           draggable="false"
           (dragstart)="$event.preventDefault(); $event.stopPropagation()"
           [style.right.px]="position().x < 0 ? 0 : null"
           [style.top.px]="position().y < 0 ? 24 : position().y"
           [style.left.px]="position().x >= 0 ? position().x : null">
         <div class="w-64 max-h-96 bg-white/95 dark:bg-stone-800/95 backdrop-blur-xl border border-stone-200/50 dark:border-stone-600/50 shadow-xl overflow-hidden flex flex-col rounded-xl">
             <!-- 鍙嫋鍔ㄦ爣棰樻爮 - 鍙屽嚮閲嶇疆浣嶇疆 -->
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
                 
             <div class="flex-1 overflow-y-auto px-3 py-2 space-y-2 select-none">
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
                         鍙屽嚮鑺傜偣鏌ョ湅璇︽儏
                     </div>
                 }
             </div>
         </div>
      </div>
    }
    
    <!-- 妗岄潰绔鎯呭紑鍚寜閽?-->
    @if (!uiState.isMobile() && !uiState.isFlowDetailOpen()) {
      <button (click)="uiState.isFlowDetailOpen.set(true)" 
              class="absolute top-6 right-2 z-20 pointer-events-auto bg-white/90 dark:bg-stone-800/90 backdrop-blur border border-stone-200 dark:border-stone-600 rounded-lg p-2 shadow-sm hover:bg-white dark:hover:bg-stone-700 text-stone-400 dark:text-stone-500 hover:text-stone-600 dark:hover:text-stone-300 transition-all flex items-center gap-1">
          <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span class="text-[10px] font-medium">璇︽儏</span>
      </button>
    }

    <!-- 绉诲姩绔《閮ㄥ皬鍨嬫爣绛捐Е鍙戝櫒 -->
    @if (uiState.isMobile() && !uiState.isFlowDetailOpen()) {
      <button 
        (click)="uiState.isFlowDetailOpen.set(true)"
        class="absolute top-2 right-2 z-25 pointer-events-auto bg-white/90 dark:bg-stone-800/90 backdrop-blur rounded-lg shadow-sm border border-stone-200 dark:border-stone-600 px-2 py-1 flex items-center gap-1 text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-200">
        <svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <span class="text-[10px] font-medium">璇︽儏</span>
      </button>
    }
    
    <!-- 绉诲姩绔《閮ㄤ笅鎷夋娊灞夐潰鏉?-->
    @if (uiState.isMobile() && uiState.isFlowDetailOpen()) {
       <div
         #mobileDrawer
         draggable="false"
         (dragstart)="$event.preventDefault(); $event.stopPropagation()"
         class="absolute left-0 right-0 z-30 pointer-events-auto bg-white/95 dark:bg-stone-800/95 backdrop-blur-xl border-b border-stone-200 dark:border-stone-700 shadow-[0_4px_20px_rgba(0,0,0,0.1)] rounded-b-2xl flex flex-col transition-all duration-100"
           [style.top.px]="0"
           [style.height.vh]="drawerHeight()"
           style="transform: translateZ(0); backface-visibility: hidden;">
        <!-- 鏍囬鏍?- 宸﹁竟鐣欏嚭绌洪棿閬垮紑瀵艰埅鎸夐挳锛岀揣鍑戝竷灞€ -->
         <div
           #mobileDrawerTitle
           class="pr-3 pl-3 pt-0.5 pb-0 flex justify-between items-center flex-shrink-0">
          <h3 class="font-bold text-stone-700 dark:text-stone-200 text-xs">浠诲姟璇︽儏</h3>
        </div>
        
        <!-- 鍐呭鍖哄煙 - 鏇寸揣鍑?-->
        <div
             #mobileDrawerContent
             class="mobile-drawer-content flex-1 overflow-y-auto px-3 pb-1 overscroll-contain"
             (touchstart)="onContentTouchStart($event)"
             (touchmove)="onContentTouchMove($event)"
             style="-webkit-overflow-scrolling: touch; touch-action: pan-y; transform: translateZ(0); contain: layout style paint;">
          @if (task(); as t) {
            <ng-container *ngTemplateOutlet="mobileTaskContent; context: { $implicit: t }"></ng-container>
          } @else {
            <div class="text-center text-stone-400 text-xs py-1">鍙屽嚮鑺傜偣鏌ョ湅璇︽儏</div>
          }
        </div>
        
        <!-- 鎷栧姩鏉?- 绱у噾 -->
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
    
    <!-- 妗岄潰绔换鍔″唴瀹规ā鏉?-->
    <ng-template #taskContent let-task>
      <div class="space-y-2">
          <div class="flex items-center justify-between">
              <div class="flex items-center gap-2 text-[10px]">
                  <span class="font-bold text-retro-muted dark:text-stone-400 bg-stone-100 dark:bg-stone-700 px-1.5 py-0.5 rounded">{{projectState.compressDisplayId(task.displayId)}}</span>
                  <span class="text-stone-400">{{task.createdDate | date:'MM-dd'}}</span>
                @if (task.parkingMeta?.state === 'parked') {
                  <span class="px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400 font-medium" title="已停泊">⛵ 停泊</span>
                }
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
                  {{ isEditMode() ? '棰勮' : '缂栬緫' }}
              </button>
          </div>

          @if (!isEditMode()) {
              <div class="cursor-pointer" (click)="onPreviewClick($event)">
                <h4 data-testid="flow-task-title" class="text-xs font-medium text-stone-800 dark:text-stone-200 mb-1">{{ task.title || '鏃犳爣棰? }}</h4>
                  @if (localContent() || task.content) {
                      <div 
                          class="text-[11px] text-stone-600 dark:text-stone-300 leading-relaxed markdown-preview bg-retro-muted/5 border border-retro-muted/20 rounded-lg p-2 max-h-32 overflow-y-auto overflow-x-hidden"
                          [innerHTML]="(localContent() || task.content) | safeMarkdown:'raw'">
                      </div>
                  } @else {
                      <div class="text-[11px] text-stone-400 dark:text-stone-500 italic">鐐瑰嚮缂栬緫鍐呭...</div>
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
                  placeholder="浠诲姟鏍囬">
              
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
                  placeholder="杈撳叆鍐呭锛堟敮鎸?Markdown锛?.."></textarea>
              <div class="grid grid-cols-3 gap-1.5">
                <input
                  type="number"
                  min="1"
                  [ngModel]="task.expected_minutes ?? ''"
                  (ngModelChange)="onExpectedMinutesChange(task.id, $event)"
                  class="w-full text-[10px] border border-stone-200 dark:border-stone-600 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-indigo-300 dark:focus:ring-indigo-500 bg-white dark:bg-stone-700"
                  placeholder="预计(min)">
                <select
                  [ngModel]="task.cognitive_load ?? ''"
                  (ngModelChange)="onCognitiveLoadChange(task.id, $event)"
                  class="w-full text-[10px] border border-stone-200 dark:border-stone-600 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-indigo-300 dark:focus:ring-indigo-500 bg-white dark:bg-stone-700 text-stone-600 dark:text-stone-300">
                  <option value="">负荷未设</option>
                  <option value="low">低负荷</option>
                  <option value="high">高负荷</option>
                </select>
                <input
                  type="number"
                  min="1"
                  [ngModel]="task.wait_minutes ?? ''"
                  (ngModelChange)="onWaitMinutesChange(task.id, $event)"
                  class="w-full text-[10px] border border-stone-200 dark:border-stone-600 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-indigo-300 dark:focus:ring-indigo-500 bg-white dark:bg-stone-700"
                  placeholder="等待(min)">
              </div>
          }

          <div class="flex gap-1.5 pt-1">
              <button (click)="addSibling.emit(task)"
                  class="flex-1 px-2 py-1 bg-retro-teal/10 hover:bg-retro-teal text-retro-teal hover:text-white border border-retro-teal/30 text-[10px] font-medium rounded transition-all">
                  +鍚岀骇
              </button>
              <button (click)="addChild.emit(task)"
                  class="flex-1 px-2 py-1 bg-retro-rust/10 hover:bg-retro-rust text-retro-rust hover:text-white border border-retro-rust/30 text-[10px] font-medium rounded transition-all">
                  +涓嬬骇
              </button>
              <button (click)="toggleStatus.emit(task)"
                  data-testid="toggle-task-status-btn"
                  class="flex-1 px-2 py-1 text-[10px] font-medium rounded transition-all border"
                  [ngClass]="{
                    'bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-700': task.status !== 'completed',
                    'bg-stone-50 dark:bg-stone-700 text-stone-600 dark:text-stone-300 border-stone-200 dark:border-stone-600': task.status === 'completed'
                  }">
                  {{task.status === 'completed' ? '鎾ら攢' : '瀹屾垚'}}
              </button>
          </div>
          <div class="flex gap-1.5">
              <button (click)="archiveTask.emit(task)"
                  class="flex-1 px-2 py-1 text-[10px] font-medium rounded transition-all border"
                  [ngClass]="{
                    'bg-violet-50 dark:bg-violet-900/30 text-violet-600 dark:text-violet-300 border-violet-200 dark:border-violet-700': task.status !== 'archived',
                    'bg-stone-50 dark:bg-stone-700 text-stone-600 dark:text-stone-300 border-stone-200 dark:border-stone-600': task.status === 'archived'
                  }"
                  title="归档后任务将从主视图隐藏，可在回收站恢复">
                  {{task.status === 'archived' ? '鍙栨秷褰掓。' : '褰掓。'}}
              </button>
              <button (click)="parkTask.emit(task)"
                  class="flex-1 px-2 py-1 bg-amber-50 dark:bg-amber-900/20 hover:bg-amber-500 text-amber-600 dark:text-amber-400 hover:text-white border border-amber-200 dark:border-amber-700 hover:border-amber-500 text-[10px] font-medium rounded transition-all"
                  title="停泊任务，稍后处理">
                  鍋滄硦
              </button>
                <button data-testid="delete-task-btn" (click)="deleteTask.emit(task)"
                  class="px-2 py-1 bg-stone-50 dark:bg-stone-700 hover:bg-red-500 dark:hover:bg-red-600 text-stone-400 dark:text-stone-500 hover:text-white border border-stone-200 dark:border-stone-600 text-[10px] font-medium rounded transition-all">
                  鍒犻櫎
              </button>
          </div>
      </div>
    </ng-template>
    
    <!-- 绉诲姩绔换鍔″唴瀹规ā鏉?-->
    <ng-template #mobileTaskContent let-task>
      <div class="flex items-center gap-1.5 mb-1 flex-wrap">
        <span class="font-bold text-retro-muted dark:text-stone-400 text-[8px] tracking-wider bg-stone-100 dark:bg-stone-700 px-1.5 py-0.5 rounded">{{projectState.compressDisplayId(task.displayId)}}</span>
        <span class="text-[9px] text-stone-400">{{task.createdDate | date:'MM-dd'}}</span>
        @if (task.parkingMeta?.state === 'parked') {
          <span class="text-[8px] px-1 py-0.5 rounded bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400 font-medium" title="已停泊">⛵ 停泊</span>
        }
        <span class="text-[9px] px-1 py-0.5 rounded"
              [ngClass]="{
                'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300': task.status === 'completed',
                'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300': task.status !== 'completed'
              }">
          {{task.status === 'completed' ? '完成' : '进行中'}}
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
          {{ isEditMode() ? '棰勮' : '缂栬緫' }}
        </button>
      </div>

      @if (!isEditMode()) {
        <div class="cursor-pointer space-y-1" (click)="onPreviewClick($event)">
          <h4 class="text-xs font-medium text-stone-800 dark:text-stone-100 leading-tight" [class.line-clamp-1]="isCompactMode()">{{ task.title || '鏃犳爣棰? }}</h4>
          @if (localContent() || task.content) {
            <div class="text-[11px] text-stone-600 leading-relaxed markdown-preview overflow-hidden max-h-28" [innerHTML]="(localContent() || task.content) | safeMarkdown:'raw'"></div>
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
            placeholder="浠诲姟鏍囬">
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
            placeholder="浠诲姟鍐呭锛堟敮鎸?Markdown锛?.."></textarea>
          <div class="grid grid-cols-3 gap-1">
            <input
              type="number"
              min="1"
              [ngModel]="task.expected_minutes ?? ''"
              (ngModelChange)="onExpectedMinutesChange(task.id, $event)"
              class="w-full text-[10px] border border-stone-200 dark:border-stone-600 rounded px-1.5 py-1 focus:outline-none focus:ring-1 focus:ring-indigo-300 dark:focus:ring-indigo-500 bg-white dark:bg-stone-700"
              placeholder="预计(min)">
            <select
              [ngModel]="task.cognitive_load ?? ''"
              (ngModelChange)="onCognitiveLoadChange(task.id, $event)"
              class="w-full text-[10px] border border-stone-200 dark:border-stone-600 rounded px-1.5 py-1 focus:outline-none focus:ring-1 focus:ring-indigo-300 dark:focus:ring-indigo-500 bg-white dark:bg-stone-700 text-stone-600 dark:text-stone-300">
              <option value="">负荷未设</option>
              <option value="low">低负荷</option>
              <option value="high">高负荷</option>
            </select>
            <input
              type="number"
              min="1"
              [ngModel]="task.wait_minutes ?? ''"
              (ngModelChange)="onWaitMinutesChange(task.id, $event)"
              class="w-full text-[10px] border border-stone-200 dark:border-stone-600 rounded px-1.5 py-1 focus:outline-none focus:ring-1 focus:ring-indigo-300 dark:focus:ring-indigo-500 bg-white dark:bg-stone-700"
              placeholder="等待(min)">
          </div>
          <div class="flex items-center gap-1 bg-retro-rust/5 border border-retro-rust/20 rounded overflow-hidden p-0.5">
            <span class="text-retro-rust flex-shrink-0 text-[10px] pl-1">☰</span>
            <input
              #quickTodoInput
              type="text"
              (keydown.enter)="addQuickTodo(task.id, quickTodoInput)"
              spellcheck="false"
              class="flex-1 bg-transparent border-none outline-none text-stone-600 placeholder-stone-400 text-[10px] py-0.5 px-1"
              placeholder="寰呭姙锛屽洖杞︽坊鍔?..">
            <button
              (click)="addQuickTodo(task.id, quickTodoInput)"
              class="flex-shrink-0 bg-retro-rust/10 hover:bg-retro-rust text-retro-rust hover:text-white rounded p-0.5 mr-0.5 transition-all">
              <svg class="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            </button>
          </div>
        </div>
      }
      
      <!-- 鎿嶄綔鎸夐挳 -->
      <div
           #mobileActionSection
           data-mobile-action-section
           class="overflow-hidden transition-all duration-150"
           [class.max-h-0]="isCompactMode()"
           [class.opacity-0]="isCompactMode()"
           [class.pointer-events-none]="isCompactMode()"
           [class.max-h-32]="!isCompactMode()"
           [class.opacity-100]="!isCompactMode()">
        <div class="flex gap-1 mt-2">
          <button (click)="addSibling.emit(task)"
            class="flex-1 px-1.5 py-1 bg-retro-teal/10 text-retro-teal border border-retro-teal/30 text-[9px] font-medium rounded transition-all">
            +鍚岀骇
          </button>
          <button (click)="addChild.emit(task)"
            class="flex-1 px-1.5 py-1 bg-retro-rust/10 text-retro-rust border border-retro-rust/30 text-[9px] font-medium rounded transition-all">
            +涓嬬骇
          </button>
          <button (click)="toggleStatus.emit(task)"
            class="flex-1 px-1.5 py-1 text-[9px] font-medium rounded border transition-all"
            [ngClass]="{
              'bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-700': task.status !== 'completed',
              'bg-stone-50 dark:bg-stone-700 text-stone-600 dark:text-stone-300 border-stone-200 dark:border-stone-600': task.status === 'completed'
            }">
            {{task.status === 'completed' ? '鎾ら攢' : '瀹屾垚'}}
          </button>
        </div>
        <div class="flex gap-1 mt-1">
          <button (click)="archiveTask.emit(task)"
            class="flex-1 px-1.5 py-1 text-[9px] font-medium rounded transition-all border"
            [ngClass]="{
              'bg-violet-50 dark:bg-violet-900/30 text-violet-600 dark:text-violet-300 border-violet-200 dark:border-violet-700': task.status !== 'archived',
              'bg-stone-50 dark:bg-stone-700 text-stone-600 dark:text-stone-300 border-stone-200 dark:border-stone-600': task.status === 'archived'
            }">
            {{task.status === 'archived' ? '鍙栨秷褰掓。' : '褰掓。'}}
          </button>
          <button (click)="parkTask.emit(task)"
            class="flex-1 px-1.5 py-1 bg-amber-50 dark:bg-amber-900/20 hover:bg-amber-500 text-amber-600 dark:text-amber-400 hover:text-white border border-amber-200 dark:border-amber-700 hover:border-amber-500 text-[9px] font-medium rounded transition-all"
            title="停泊任务，稍后处理">
            鍋滄硦
          </button>
          <button
            #mobileDeleteButton
            data-mobile-delete-button
            (click)="deleteTask.emit(task)"
            class="px-1.5 py-1 bg-stone-50 dark:bg-stone-700 text-stone-400 dark:text-stone-500 border border-stone-200 dark:border-stone-600 hover:bg-red-500 dark:hover:bg-red-600 hover:text-white hover:border-red-500 text-[9px] font-medium rounded transition-all">
            鍒犻櫎
          </button>
        </div>
      </div>
    </ng-template>
  `
})
export class FlowTaskDetailComponent implements OnDestroy {
  // P2-1 杩佺Щ锛氱洿鎺ユ敞鍏ュ瓙鏈嶅姟
  readonly uiState = inject(UiStateService);
  readonly projectState = inject(ProjectStateService);
  readonly userSession = inject(UserSessionService);
  private readonly elementRef = inject(ElementRef);
  private readonly cdr = inject(ChangeDetectorRef);
  readonly formService = inject(FlowTaskDetailFormService);
  private readonly taskOpsAdapter = inject(TaskOperationAdapterService);

  @ViewChild('mobileDrawer') private mobileDrawer?: ElementRef<HTMLDivElement>;
  @ViewChild('mobileDrawerTitle') private mobileDrawerTitle?: ElementRef<HTMLDivElement>;
  @ViewChild('mobileDrawerContent') private mobileDrawerContent?: ElementRef<HTMLDivElement>;
  @ViewChild('mobileDrawerHandle') private mobileDrawerHandle?: ElementRef<HTMLDivElement>;

  private static readonly MOBILE_DRAWER_GUARD_PX = 4;
  private static readonly MOBILE_DRAWER_MIN_VH = 8;
  private static readonly MOBILE_DRAWER_MAX_VH = 70;
  private static readonly MOBILE_DRAWER_HEIGHT_EPSILON_VH = 0.3;
  
  // 杈撳叆
  readonly task = input<Task | null>(null);
  readonly position = input<{ x: number; y: number }>({ x: -1, y: -1 });
  readonly drawerHeight = input<number>(35); // vh unit
  readonly autoHeightEnabled = input<boolean>(true);
  readonly layoutTick = input<number>(0);

  // Form state delegated to FlowTaskDetailFormService
  readonly localTitle = this.formService.localTitle;
  readonly localContent = this.formService.localContent;
  readonly isEditMode = this.formService.isEditMode;
  readonly isTogglingMode = this.formService.isTogglingMode;

  readonly isCompactMode = computed(() => !this.autoHeightEnabled() && this.drawerHeight() < 12);
  readonly contentMaxHeight = computed(() => {
    const height = this.drawerHeight();
    if (height < 15) return 'max-h-8';
    if (height < 25) return 'max-h-16';
    if (height < 35) return 'max-h-24';
    return 'max-h-28';
  });

  // Outputs
  readonly positionChange = output<{ x: number; y: number }>();
  readonly drawerHeightChange = output<number>();
  readonly isResizingChange = output<boolean>();
  
  // 浠诲姟鎿嶄綔杈撳嚭
  readonly titleChange = output<{ taskId: string; title: string }>();
  readonly contentChange = output<{ taskId: string; content: string }>();
  readonly addSibling = output<Task>();
  readonly addChild = output<Task>();
  readonly toggleStatus = output<Task>();
  readonly archiveTask = output<Task>();
  readonly deleteTask = output<Task>();
  readonly parkTask = output<Task>();
  readonly quickTodoAdd = output<{ taskId: string; text: string }>();
  
  // 闄勪欢鎿嶄綔杈撳嚭
  readonly attachmentAdd = output<{ taskId: string; attachment: Attachment }>();
  readonly attachmentRemove = output<{ taskId: string; attachmentId: string }>();
  readonly attachmentsChange = output<{ taskId: string; attachments: Attachment[] }>();
  readonly attachmentError = output<string>();
  
  // 拖动状态
  private dragState = { isDragging: false, startX: 0, startY: 0, offsetX: 0, offsetY: 0 };
  private isResizingDrawer = false;
  private drawerStartY = 0;
  private drawerStartHeight = 0;
  private autoHeightRafId: number | null = null;
  private autoHeightTimer: ReturnType<typeof setTimeout> | null = null;
  private lastAutoHeightSignature = '';
  private lastEmittedVh = -1;
  private isComponentDestroyed = false;
  
  constructor() {
    // Split-Brain 鏍稿績閫昏緫锛氬鎵樼粰 formService
    this.formService.initSyncEffect(() => this.task());

    // 馃敶 绉诲姩绔嚜鍔ㄩ珮搴︼細缁熶竴鐨勮Е鍙戝叆鍙ｏ紙浠诲姟/缂栬緫妯″紡鍙樺寲 + layoutTick 鍙樺寲锛?    // 鍚堝苟涓哄崟涓€ effect锛岄€氳繃绛惧悕鍘婚噸锛岄伩鍏嶅涓?effect 骞跺彂瑙﹀彂瀵艰嚧鎶栧姩
    effect(() => {
      const task = this.task();
      const isEdit = this.isEditMode();
      const isOpen = this.uiState.isFlowDetailOpen();
      const tick = this.layoutTick();
      
      if (this.uiState.isMobile() && isOpen) {
        const signature = task
          ? `${task.id}|${task.title}|${task.content}|${task.status}|${isEdit ? '1' : '0'}|${tick}`
          : `empty|${isEdit ? '1' : '0'}|${tick}`;
        if (signature === this.lastAutoHeightSignature) return;
        this.lastAutoHeightSignature = signature;
        // 重置发射缓存，允许新一轮测量
        this.lastEmittedVh = -1;
        untracked(() => this.requestAutoHeight());
      } else {
        this.lastAutoHeightSignature = '';
        this.lastEmittedVh = -1;
      }
    });
  }

  // ========== 琛ㄥ崟浜嬩欢濮旀墭 ==========

  /**
   * 绉诲姩绔細璇锋眰鑷姩璋冩暣楂樺害浠ラ€傚簲鍐呭銆?   *
   * 鏍稿績绠楁硶锛歵argetPx = titleH + intrinsicContentH + handleH + guard
   * 鍙娇鐢ㄥ唴瀹瑰瓙鍏冪礌鐨勫浐鏈夐珮搴︼紝涓嶅紩鐢?containerH 鎴?contentClientH锛?   * 浠庤€岀‘淇濈畻娉曞箓绛夆€斺€旀棤璁哄綋鍓嶆娊灞夊楂橈紝璁＄畻缁撴灉閮芥槸涓€鏍风殑銆?   */
  private requestAutoHeight(): void {
    if (this.isComponentDestroyed) return;
    if (!this.uiState.isMobile() || !this.uiState.isFlowDetailOpen()) return;
    if (!this.autoHeightEnabled()) return;

    // 鍙栨秷鍏堝墠鐨勬寕璧锋祴閲忥紝閬垮厤澶氭 emit
    this.cancelPendingAutoHeight();

    this.autoHeightRafId = requestAnimationFrame(() => {
      this.autoHeightRafId = null;
      if (this.isComponentDestroyed) return;
      this.measureAndEmitHeight();
      // 涓€娆″欢杩熸敹鏁涳細绛夊瓧浣?鏍峰紡绋冲畾鍚庡啀鏍￠獙
      this.autoHeightTimer = setTimeout(() => {
        this.autoHeightTimer = null;
        if (!this.isComponentDestroyed) this.measureAndEmitHeight();
      }, 150);
    });
  }

  /**
   * 绾祴閲?+ 鍙戝皠锛氫笉渚濊禆褰撳墠瀹瑰櫒楂樺害锛屽彧鐢ㄥ瓙鍏冪礌鍥烘湁灏哄銆?   * 骞傜瓑锛氬悓鏍风殑鍐呭璋冪敤 N 娆＄粨鏋滀竴鑷达紝绗簩娆′笉浼?emit銆?   */
  private measureAndEmitHeight(): void {
    const container = this.mobileDrawer?.nativeElement
      ?? this.elementRef.nativeElement.querySelector('.absolute.left-0.right-0.z-30');
    const title = this.mobileDrawerTitle?.nativeElement
      ?? container?.querySelector('.flex-shrink-0');
    const content = this.mobileDrawerContent?.nativeElement
      ?? container?.querySelector('.overflow-y-auto');
    const handle = this.mobileDrawerHandle?.nativeElement
      ?? container?.querySelector('.touch-none.flex-shrink-0');

    if (!container || !title || !content || !handle) return;
    const viewportHeight = this.getViewportHeight();
    if (viewportHeight <= 0) return;

    const titleH = (title as HTMLElement).offsetHeight || 0;
    const handleH = (handle as HTMLElement).offsetHeight || 0;
    const intrinsicContentH = this.measureIntrinsicContentHeight(content as HTMLElement);

    const targetPx = titleH + intrinsicContentH + handleH
      + FlowTaskDetailComponent.MOBILE_DRAWER_GUARD_PX;
    const maxPx = (FlowTaskDetailComponent.MOBILE_DRAWER_MAX_VH / 100) * viewportHeight;
    const clampedPx = Math.max(titleH + handleH + 10, Math.min(targetPx, maxPx));
    const targetVh = Math.max(
      FlowTaskDetailComponent.MOBILE_DRAWER_MIN_VH,
      Math.min((clampedPx / viewportHeight) * 100, FlowTaskDetailComponent.MOBILE_DRAWER_MAX_VH)
    );

    // 鍙湪涓庝笂涓€娆″彂灏勫€兼湁鏄捐憲宸紓鏃?emit
    if (Math.abs(this.lastEmittedVh - targetVh) > FlowTaskDetailComponent.MOBILE_DRAWER_HEIGHT_EPSILON_VH) {
      this.lastEmittedVh = targetVh;
      this.drawerHeightChange.emit(targetVh);
    }
  }

  private getViewportHeight(): number {
    if (typeof window === 'undefined') return 0;
    const visualHeight = window.visualViewport?.height ?? 0;
    return visualHeight > 0 ? visualHeight : window.innerHeight;
  }

  /**
   * 娴嬮噺鍐呭鍖烘墍鏈夊瓙鍏冪礌鐨勫浐鏈夐珮搴︽€诲拰锛堝惈 padding/margin锛夈€?   * 涓嶄緷璧?scrollHeight/clientHeight锛堝畠浠細闅忓鍣ㄥ昂瀵稿彉鍖栵級銆?   */
  private measureIntrinsicContentHeight(contentEl: HTMLElement): number {
    if (typeof window === 'undefined') return 0;
    const children = Array.from(contentEl.children) as HTMLElement[];
    if (children.length === 0) return 0;

    const contentStyle = window.getComputedStyle(contentEl);
    const paddingTop = Number.parseFloat(contentStyle.paddingTop || '0') || 0;
    const paddingBottom = Number.parseFloat(contentStyle.paddingBottom || '0') || 0;

    let totalChildrenHeight = 0;
    for (const child of children) {
      const rect = child.getBoundingClientRect();
      const style = window.getComputedStyle(child);
      const marginTop = Number.parseFloat(style.marginTop || '0') || 0;
      const marginBottom = Number.parseFloat(style.marginBottom || '0') || 0;
      totalChildrenHeight += rect.height + marginTop + marginBottom;
    }

    return Math.max(0, totalChildrenHeight + paddingTop + paddingBottom);
  }

  private cancelPendingAutoHeight(): void {
    if (this.autoHeightRafId !== null) {
      cancelAnimationFrame(this.autoHeightRafId);
      this.autoHeightRafId = null;
    }
    if (this.autoHeightTimer !== null) {
      clearTimeout(this.autoHeightTimer);
      this.autoHeightTimer = null;
    }
  }
  
  /** 杈撳叆妗嗚仛鐒﹀鐞?*/
  onInputFocus(field: 'title' | 'content') {
    this.uiState.markEditing();
    this.formService.onInputFocus(field, this.task());
  }

  /** 杈撳叆妗嗗け鐒﹀鐞?*/
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
  
  /** 鏈湴鏍囬鍙樻洿 */
  onLocalTitleChange(value: string) {
    const result = this.formService.onLocalTitleChange(value, this.task());
    if (result) {
      this.titleChange.emit(result);
    }
  }

  /** 鏈湴鍐呭鍙樻洿 */
  onLocalContentChange(value: string) {
    const result = this.formService.onLocalContentChange(value, this.task());
    if (result) {
      this.contentChange.emit(result);
    }
  }
  onExpectedMinutesChange(taskId: string, raw: string | number | null): void {
    this.taskOpsAdapter.updateTaskExpectedMinutes(taskId, this.parseOptionalMinutes(raw));
  }

  onWaitMinutesChange(taskId: string, raw: string | number | null): void {
    this.taskOpsAdapter.updateTaskWaitMinutes(taskId, this.parseOptionalMinutes(raw));
  }

  onCognitiveLoadChange(taskId: string, raw: string | null): void {
    const normalized = raw === 'high' || raw === 'low' ? raw : null;
    this.taskOpsAdapter.updateTaskCognitiveLoad(taskId, normalized);
  }

  /** 鍒囨崲缂栬緫妯″紡 */
  toggleEditMode(): void { this.formService.toggleEditMode(); }

  /**
   * Markdown 棰勮鍖哄煙鐐瑰嚮澶勭悊
   * 鐐瑰嚮寰呭姙 checkbox 鏃跺垏鎹㈠畬鎴愮姸鎬侊紱鐐瑰嚮鍏朵粬鍖哄煙杩涘叆缂栬緫妯″紡
   */
  onPreviewClick(event: MouseEvent): void {
    event.stopPropagation();
    const todoIndex = getTodoIndexFromClick(event);
    if (todoIndex !== null) {
      const currentTask = this.task();
      if (!currentTask) return;
      const currentContent = this.formService.localContent() || currentTask.content || '';
      const newContent = toggleMarkdownTodo(currentContent, todoIndex);
      this.formService.localContent.set(newContent);
      // 鐩存帴鏇存柊 Store锛岀‘淇濋『搴忓悓姝ワ紝閬垮厤鐖剁粍浠?Output 寤惰繜
      this.taskOpsAdapter.updateTaskContent(currentTask.id, newContent);
      // 寮哄埗鏍囪缁勪欢闇€瑕侀噸鏂版娴嬶紝纭繚 OnPush 妯″紡涓?UI 鍒锋柊
      this.cdr.markForCheck();
    } else {
      this.toggleEditMode();
    }
  }
  
  /** 鐩戝惉 document 鐐瑰嚮浜嬩欢锛岀紪杈戞ā寮忎笅鐐瑰嚮闈炰氦浜掑尯鍩熼€€鍑虹紪杈?*/
  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    if (this.formService.shouldExitEditMode(event.target as HTMLElement, this.elementRef.nativeElement)) {
      this.isEditMode.set(false);
    }
  }

  /** 鐩戝惉 document 瑙︽懜浜嬩欢锛堢Щ鍔ㄧ锛夛紝缂栬緫妯″紡涓嬭Е鎽搁潪浜や簰鍖哄煙閫€鍑虹紪杈?*/
  @HostListener('document:touchstart', ['$event'])
  onDocumentTouchStart(event: TouchEvent): void {
    const activeElement = document.activeElement;
    if (activeElement && (activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA')) {
      return;
    }
    if (this.formService.shouldExitEditMode(event.target as HTMLElement, this.elementRef.nativeElement)) {
      this.isEditMode.set(false);
    }
  }


  
  startDrag(event: MouseEvent | TouchEvent) {
    event.preventDefault();
    const _pos = this.position();
    const clientX = event instanceof MouseEvent ? event.clientX : event.touches[0].clientX;
    const clientY = event instanceof MouseEvent ? event.clientY : event.touches[0].clientY;
    
    const target = event.target as HTMLElement;
    const panelEl = target.closest('.absolute') as HTMLElement;
    if (!panelEl) return;
    
    const parentEl = panelEl.parentElement;
    if (!parentEl) return;
    
    const parentRect = parentEl.getBoundingClientRect();
    const panelRect = panelEl.getBoundingClientRect();
    
    // 计算面板相对父容器的当前位置
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
    window.addEventListener('blur', this.stopDrag);
  }
  
  private onDrag = (event: MouseEvent | TouchEvent) => {
    if (!this.dragState.isDragging) return;
    if (event instanceof MouseEvent && event.buttons === 0) {
      this.stopDrag();
      return;
    }
    if (event instanceof TouchEvent && event.touches.length === 0) {
      this.stopDrag();
      return;
    }
    
    const clientX = event instanceof MouseEvent ? event.clientX : event.touches[0].clientX;
    const clientY = event instanceof MouseEvent ? event.clientY : event.touches[0].clientY;
    
    const deltaX = clientX - this.dragState.startX;
    const deltaY = clientY - this.dragState.startY;
    
    // 闄愬埗闈㈡澘涓嶈兘琚嫋鍑哄彲瑙嗗尯鍩?    // 闈㈡澘瀹藉害 256px锛岄珮搴︽渶澶?384px (max-h-96)
    const panelWidth = 256;
    const panelHeight = 384;
    const maxX = Math.max(0, window.innerWidth - panelWidth - 20); // 鐣?20px 杈硅窛
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
    window.removeEventListener('blur', this.stopDrag);
  };

  /** 閲嶇疆闈㈡澘浣嶇疆鍒伴粯璁や綅缃紙鍙充笂瑙掞級 */
  resetPosition() { this.positionChange.emit({ x: -1, y: -1 }); }
  
  startDrawerResize(event: TouchEvent | MouseEvent) {
    event.preventDefault();
    
    // 鑾峰彇璧峰浣嶇疆
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

    // 鍥哄畾鏈€灏忛珮搴︿负 8vh锛岄伩鍏嶉绻佺殑 DOM 鏌ヨ
    const minHeight = 8;
    
    const drawerEl = this.elementRef.nativeElement.querySelector('.absolute.z-30') as HTMLElement;
    if (drawerEl) {
      drawerEl.style.willChange = 'height';
    }
    
    let rafId: number | null = null;
    let _lastCalculatedHeight: number = this.drawerStartHeight;
    
    const onMove = (ev: TouchEvent | MouseEvent) => {
      if (!this.isResizingDrawer) return;
      ev.preventDefault();
      
      // 鑾峰彇褰撳墠浣嶇疆
      let currentY: number;
      if (ev instanceof TouchEvent) {
        if (ev.touches.length !== 1) return;
        currentY = ev.touches[0].clientY;
      } else {
        currentY = ev.clientY;
      }
      
      if (rafId) return;
      
      rafId = requestAnimationFrame(() => {
        rafId = null;
        if (!this.isResizingDrawer) return;

        const deltaY = currentY - this.drawerStartY;
        const viewportHeight = this.getViewportHeight();
        if (viewportHeight <= 0) return;
        const deltaVh = (deltaY / viewportHeight) * 100;
        
        const newHeight = Math.max(minHeight, Math.min(70, this.drawerStartHeight + deltaVh));
        _lastCalculatedHeight = newHeight;
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
      
      if (drawerEl) {
        drawerEl.style.willChange = 'auto';
      }
      
      // 绉婚櫎鑷姩鍏抽棴閫昏緫锛屽厑璁哥敤鎴疯嚜鐢辫皟鏁村埌鏈€灏忛珮搴?      // 鏈€灏忛珮搴︾敱 Math.max(8, ...) 鎺у埗
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
  
  // 鍐呭鍖哄煙瑙︽懜澶勭悊 - 闃叉鏃犻檺涓嬫媺
  onContentTouchStart(event: TouchEvent): void {
    const target = event.target as HTMLElement;
    // 妫€鏌ユ槸鍚︽槸鍐呭鍖哄煙鏈韩鎴栧彲婊氬姩鐨勫瓙鍏冪礌
    const scrollableParent = target.closest('.overflow-y-auto') as HTMLElement;
    if (scrollableParent) {
      // 璁板綍鍒濆婊氬姩浣嶇疆
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
      
      const touchStartScrollTop = Number(scrollableParent.dataset['touchStartScrollTop']) || 0;
      const _touch = event.touches[0];
      
      if ((scrollTop === 0 && scrollTop >= touchStartScrollTop) || 
          (scrollTop + clientHeight >= scrollHeight && scrollTop <= touchStartScrollTop)) {
        // 鍏佽鍐呴儴婊氬姩锛屼笉闃绘浜嬩欢
        return;
      }
      
      // 鏇存柊婊氬姩浣嶇疆璁板綍
      scrollableParent.dataset['touchStartScrollTop'] = String(scrollTop);
    }
  }

  addQuickTodo(taskId: string, inputEl: HTMLInputElement) {
    const text = inputEl.value.trim();
    if (text) {
      this.quickTodoAdd.emit({ taskId, text });
      inputEl.value = '';
      inputEl.focus();
    }
  }
  

  private parseOptionalMinutes(raw: string | number | null): number | null {
    if (raw === null || raw === undefined) return null;
    const value = String(raw).trim();
    if (!value) return null;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    return Math.floor(parsed);
  }

  // ========== 鐢熷懡鍛ㄦ湡绠＄悊 ==========  
  ngOnDestroy(): void {
    this.isComponentDestroyed = true;
    this.cancelPendingAutoHeight();
    this.stopDrag();
    this.dragState.isDragging = false;
    this.isResizingDrawer = false;
    this.formService.cleanup();
  }
}


