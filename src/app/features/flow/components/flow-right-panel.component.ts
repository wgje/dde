import { Component, inject, input, output, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { ProjectStateService } from '../../../../services/project-state.service';
import { UiStateService } from '../../../../services/ui-state.service';
import { FlowSwipeGestureService } from '../services/flow-swipe-gesture.service';

/**
 * 移动端右侧项目面板组件
 * 
 * 从 FlowViewComponent 提取，负责：
 * - 显示项目列表
 * - 处理项目切换
 * - 处理滑动关闭手势
 */
@Component({
  selector: 'app-flow-right-panel',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (isOpen()) {
      <!-- 背景遮罩：点击此区域才关闭面板 -->
      <div 
        class="fixed inset-0 bg-black/20 z-[100]"
        (click)="close.emit()"
        (touchstart)="onBackdropTouchStart($event)"
        (touchmove)="onBackdropTouchMove($event)"
        (touchend)="onBackdropTouchEnd($event)">
      </div>
      
      <!-- 右侧面板：动态宽度为屏幕的 1/3 -->
      <div 
        class="fixed top-0 right-0 bottom-0 bg-white dark:bg-stone-900 z-[101] shadow-xl
               flex flex-col animate-slide-in-right border-l border-stone-200 dark:border-stone-700"
        [style.width]="'calc(100vw / 3)'"
        (touchstart)="onPanelTouchStart($event)"
        (touchmove)="onPanelTouchMove($event)"
        (touchend)="onPanelTouchEnd($event)">
        
        <!-- 面板标题 -->
        <div class="shrink-0 px-3 py-2.5 bg-gradient-to-r from-indigo-500 to-indigo-600 flex items-center justify-between">
          <div class="flex items-center gap-2">
            <svg class="w-4 h-4 text-white/80" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
            </svg>
            <h2 class="text-base font-semibold text-white">项目</h2>
          </div>
          <button 
            (click)="close.emit()"
            class="p-1 rounded hover:bg-white/20 transition-colors">
            <svg class="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        
        <!-- 项目数量统计 -->
        <div class="shrink-0 px-3 py-1.5 bg-stone-50 dark:bg-stone-800/50 border-b border-stone-100 dark:border-stone-700">
          <span class="text-[10px] text-stone-500 dark:text-stone-400">
            共 {{ projectState.projects().length }} 个项目
          </span>
        </div>
        
        <!-- 项目列表 -->
        <div class="flex-1 overflow-y-auto py-1.5">
          @for (project of projectState.projects(); track project.id) {
            <div 
              class="mx-1.5 mb-0.5 px-2.5 py-2 rounded-md cursor-pointer transition-all flex items-center gap-2 group"
              [ngClass]="{
                'bg-indigo-50 dark:bg-indigo-900/30 border-l-2 border-indigo-500': project.id === projectState.activeProjectId(),
                'hover:bg-stone-50 dark:hover:bg-stone-800 active:bg-stone-100 dark:active:bg-stone-700': project.id !== projectState.activeProjectId()
              }"
              (click)="onProjectClick(project.id)">
              <div class="w-1.5 h-1.5 rounded-full shrink-0"
                   [ngClass]="{
                     'bg-indigo-500': project.id === projectState.activeProjectId(),
                     'bg-stone-300 dark:bg-stone-600 group-hover:bg-stone-400': project.id !== projectState.activeProjectId()
                   }">
              </div>
              <span class="text-sm font-medium truncate flex-1"
                    [ngClass]="{
                      'text-indigo-700 dark:text-indigo-300': project.id === projectState.activeProjectId(),
                      'text-stone-600 dark:text-stone-300': project.id !== projectState.activeProjectId()
                    }">
                {{ project.name || '未命名项目' }}
              </span>
              @if (project.id === projectState.activeProjectId()) {
                <svg class="w-3 h-3 text-indigo-500 shrink-0" fill="currentColor" viewBox="0 0 20 20">
                  <path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd" />
                </svg>
              }
            </div>
          }
          
          @if (projectState.projects().length === 0) {
            <div class="px-3 py-6 text-center">
              <svg class="w-8 h-8 mx-auto text-stone-300 dark:text-stone-600 mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
                <path stroke-linecap="round" stroke-linejoin="round" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
              </svg>
              <p class="text-[11px] text-stone-400 dark:text-stone-500">暂无项目</p>
            </div>
          }
        </div>
        
        <!-- 底部操作提示 -->
        <div class="shrink-0 px-3 py-2 bg-stone-50 dark:bg-stone-800/50 border-t border-stone-100 dark:border-stone-700">
          <div class="flex items-center justify-center gap-1 text-[9px] text-stone-400 dark:text-stone-500">
            <svg class="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
            </svg>
            <span>向右滑动关闭</span>
          </div>
        </div>
      </div>
    }
  `
})
export class FlowRightPanelComponent {
  readonly projectState = inject(ProjectStateService);
  private readonly uiState = inject(UiStateService);
  private readonly swipeGesture = inject(FlowSwipeGestureService);
  private readonly router = inject(Router);

  /** 面板是否打开 */
  readonly isOpen = input.required<boolean>();
  
  /** 关闭面板事件 */
  readonly close = output<void>();
  
  /** 项目点击事件 */
  readonly projectClick = output<string>();

  /** 处理项目点击 - 切换项目时保持面板显示，只有点击非面板区域才关闭 */
  onProjectClick(projectId: string): void {
    this.projectState.activeProjectId.set(projectId);
    // 不再调用 close.emit()，项目切换时面板保持显示
    // 用户需点击背景遮罩区域才会关闭面板
    const currentView = this.uiState.activeView() || 'flow';
    void this.router.navigate(['/projects', projectId, currentView]);
  }

  // 面板触摸事件
  onPanelTouchStart(e: TouchEvent): void {
    this.swipeGesture.handleRightPanelTouchStart(e);
  }

  onPanelTouchMove(e: TouchEvent): void {
    this.swipeGesture.handleRightPanelTouchMove(e);
  }

  onPanelTouchEnd(e: TouchEvent): void {
    if (this.swipeGesture.handleRightPanelTouchEnd(e) === 'close-panel') {
      this.close.emit();
    }
  }

  // 背景遮罩触摸事件
  onBackdropTouchStart(e: TouchEvent): void {
    this.swipeGesture.handleRightPanelTouchStart(e);
  }

  onBackdropTouchMove(e: TouchEvent): void {
    this.swipeGesture.handleRightPanelTouchMove(e);
  }

  onBackdropTouchEnd(e: TouchEvent): void {
    if (this.swipeGesture.handleBackdropTouchEnd(e) === 'close-panel') {
      this.close.emit();
    }
  }
}
