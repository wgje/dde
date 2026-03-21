import { Component, ChangeDetectionStrategy, input, output, computed, inject } from '@angular/core';
import { CommonModule } from '@angular/common';

import type { LinkActionMenu } from '../../../../models/flow-view-state';
import { UiStateService } from '../../../../services/ui-state.service';

/**
 * 移动端连接线操作菜单组件
 * 
 * 长按连接线时显示，提供：
 * - 编辑：打开连接编辑器
 * - 删除/解除关系：删除连接或解除父子关系
 * 
 * 设计原则：
 * - 移动端友好的操作入口
 * - 统一跨树连接和父子连接的操作体验
 * - 3秒自动消失（与原删除提示一致）
 */
@Component({
  selector: 'app-flow-link-action-menu',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule],
  template: `
    @if (menu(); as m) {
      <div class="fixed z-50 animate-scale-in"
           [style.left.px]="clampedX()"
           [style.top.px]="clampedY()">
        <div class="bg-white dark:bg-stone-900 rounded-lg shadow-xl border border-stone-200 dark:border-stone-700 overflow-hidden">
          <!-- 操作菜单头部 -->
          <div class="px-3 py-1.5 bg-gradient-to-r from-violet-50 to-indigo-50 dark:from-violet-900/30 dark:to-indigo-900/30 border-b border-violet-100 dark:border-violet-800">
            <span class="text-[10px] font-medium text-violet-700 dark:text-violet-300">
              {{ m.isCrossTree ? '🔗 跨树连接' : '🔀 父子关系' }}
            </span>
          </div>
          
          <!-- 操作按钮 -->
          <div class="p-2 flex gap-2">
            <!-- 编辑按钮（仅跨树连接显示） -->
            @if (m.isCrossTree) {
              <button 
                (click)="edit.emit()"
                class="px-3 py-1.5 bg-violet-500 text-white text-xs font-medium rounded hover:bg-violet-600 active:bg-violet-700 transition-all flex items-center gap-1">
                <svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                </svg>
                编辑
              </button>
            }
            
            <!-- 查看/详情按钮（父子关系显示） -->
            @if (!m.isCrossTree) {
              <button 
                (click)="view.emit()"
                class="px-3 py-1.5 bg-indigo-500 text-white text-xs font-medium rounded hover:bg-indigo-600 active:bg-indigo-700 transition-all flex items-center gap-1">
                <svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                </svg>
                查看
              </button>
            }
            
            <!-- 删除/解除按钮 -->
            <button 
              (click)="deleteLink.emit()"
              class="px-3 py-1.5 bg-red-500 text-white text-xs font-medium rounded hover:bg-red-600 active:bg-red-700 transition-all flex items-center gap-1">
              <svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
              {{ m.isCrossTree ? '删除' : '解除' }}
            </button>
            
            <!-- 取消按钮 -->
            <button 
              (click)="cancel.emit()"
              class="px-3 py-1.5 bg-stone-100 dark:bg-stone-800 text-stone-600 dark:text-stone-300 text-xs font-medium rounded hover:bg-stone-200 dark:hover:bg-stone-700 active:bg-stone-300 dark:active:bg-stone-600 transition-all">
              取消
            </button>
          </div>

          <!-- 父子关系提示 -->
          @if (!m.isCrossTree) {
            <div class="px-3 pb-2 text-[10px] text-amber-600 dark:text-amber-400 flex items-center gap-1">
              <span>⚠️</span>
              <span>解除后子任务移到"待分配"</span>
            </div>
          }
        </div>
      </div>
    }
  `
})
export class FlowLinkActionMenuComponent {
  private readonly uiState = inject(UiStateService);
  
  readonly menu = input<LinkActionMenu | null>(null);

  readonly edit = output<void>();
  readonly view = output<void>();
  readonly deleteLink = output<void>();
  readonly cancel = output<void>();
  
  // 计算限制在视口内的位置
  readonly clampedX = computed(() => {
    const m = this.menu();
    if (!m) return 0;
    const menuWidth = 200; // 估算宽度
    const padding = 16;
    const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 400;
    const rawX = m.x - menuWidth / 2; // 居中对齐
    return Math.max(padding, Math.min(rawX, viewportWidth - menuWidth - padding));
  });
  
  readonly clampedY = computed(() => {
    const m = this.menu();
    if (!m) return 0;
    const menuHeight = 100; // 估算高度
    const padding = 16;
    const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : 600;
    const rawY = m.y - menuHeight - 10; // 显示在点击位置上方
    return Math.max(padding, Math.min(rawY, viewportHeight - menuHeight - padding));
  });
}
