import { Component, inject, Input, Output, EventEmitter, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FlowSelectionService } from '../services/flow-selection.service';

/**
 * 批量操作浮动工具栏组件
 * 
 * 当多选节点时显示，提供批量删除等操作
 * 支持移动端和桌面端两种布局
 */
@Component({
  selector: 'app-flow-batch-toolbar',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (selectionService.hasMultipleSelection()) {
      @if (isMobile) {
        <!-- 移动端：紧凑布局 -->
        <div class="absolute left-2 z-40 animate-slide-up" [style.bottom]="bottomOffset">
          <div class="bg-white/95 dark:bg-stone-800/95 backdrop-blur rounded-lg shadow-lg border border-stone-200 dark:border-stone-600 px-2.5 py-1.5 flex items-center gap-1.5">
            <span class="text-xs text-stone-600 dark:text-stone-300">
              已选 <span class="font-semibold text-stone-800 dark:text-stone-100">{{ selectionService.selectionCount() }}</span>
            </span>
            <div class="w-px h-3 bg-stone-200 dark:bg-stone-600"></div>
            <button 
              (click)="batchDelete.emit()"
              class="flex items-center gap-1 px-1.5 py-1 text-xs font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30 rounded transition-colors">
              <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
              删除
            </button>
            <button 
              (click)="selectionService.clearSelection()"
              class="px-1.5 py-1 text-xs font-medium text-stone-500 dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-700 rounded transition-colors">
              取消
            </button>
          </div>
        </div>
      } @else {
        <!-- 桌面端：完整布局 -->
        <div class="absolute left-4 top-4 z-40 animate-slide-up">
          <div class="bg-white/95 dark:bg-stone-800/95 backdrop-blur rounded-xl shadow-lg border border-stone-200 dark:border-stone-600 px-4 py-2.5 flex items-center gap-3">
            <span class="text-sm text-stone-600 dark:text-stone-300">
              已选择 <span class="font-semibold text-stone-800 dark:text-stone-100">{{ selectionService.selectionCount() }}</span> 个任务
            </span>
            <div class="w-px h-4 bg-stone-200 dark:bg-stone-600"></div>
            <button 
              (click)="batchDelete.emit()"
              class="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30 rounded-lg transition-colors">
              <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
              删除
            </button>
            <button 
              (click)="selectionService.clearSelection()"
              class="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-stone-500 dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-700 rounded-lg transition-colors">
              取消选择
            </button>
          </div>
        </div>
      }
    }
  `
})
export class FlowBatchToolbarComponent {
  readonly selectionService = inject(FlowSelectionService);

  /** 是否移动端布局 */
  @Input() isMobile = false;

  /** 移动端底部偏移 */
  @Input() bottomOffset = '56px';

  /** 批量删除事件 */
  @Output() batchDelete = new EventEmitter<void>();
}
