/**
 * 黑匣子条目组件
 *
 * 显示单个黑匣子条目
 */

import {
  Component,
  ChangeDetectionStrategy,
  input,
  output,
  HostListener
} from '@angular/core';
import { CommonModule, DatePipe } from '@angular/common';
import { BlackBoxEntry } from '../../../../../models';
import { AUTH_CONFIG } from '../../../../../config/auth.config';

@Component({
  selector: 'app-black-box-entry',
  standalone: true,
  imports: [CommonModule, DatePipe],
  template: `
    <div
      class="group mb-1.5 p-2 rounded-lg transition-all duration-150"
      [class]="entryShellClass()"
      [class.opacity-50]="entry().isRead && !entry().isCompleted"
      [class.line-through]="entry().isCompleted"
      [attr.data-entry-id]="entry().id"
      data-testid="black-box-entry"
      tabindex="0"
      role="article"
      [attr.aria-label]="'黑匣子条目: ' + (entry().content || '').slice(0, 50)">

      <!-- 内容 -->
      <p class="text-xs leading-relaxed break-words" [class]="contentClass()">
        {{ entry().content || '' }}
      </p>

      <!-- 底部栏 -->
      <div class="mt-1.5 flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5">
        <!-- 时间戳 -->
        <span class="text-[10px] font-mono" [class]="timeClass()">
          {{ entry().createdAt | date:'HH:mm' }}
        </span>

        <!-- 同步状态指示 -->
        @if (shouldShowSyncPendingIndicator()) {
          <span class="inline-flex items-center gap-1 text-[9px]" [class]="syncPendingClass()"
                data-testid="sync-pending-indicator"
                [attr.data-sync-debug]="syncDebugAttribute()">
            <svg class="h-3 w-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"
                 stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
              <path d="M20 7v5h-5M4 17v-5h5" />
              <path d="M6.1 7a7 7 0 0 1 11.6-1L20 9M4 15l2.3 3A7 7 0 0 0 17.9 17" />
            </svg>
            待同步
          </span>
        } @else if (shouldShowSyncConflictIndicator()) {
          <span class="text-[9px]" [class]="syncConflictClass()"
                data-testid="sync-conflict-indicator"
                [attr.data-sync-debug]="syncDebugAttribute()">
            需确认
          </span>
        }

        <!-- 操作按钮 -->
        <div class="ml-auto flex shrink-0 gap-1" data-testid="black-box-entry-actions">

          <!-- 已读按钮 -->
          @if (!entry().isRead) {
            <button
              class="entry-action-btn"
              [class.obsidian]="appearance() === 'obsidian'"
              (click)="onMarkRead($event)"
              title="标记已读"
              aria-label="标记已读">
              <svg class="h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"
                   stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
                <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
              <span>已读</span>
            </button>
          }

          <!-- 完成按钮 -->
          @if (!entry().isCompleted) {
            <button
              class="entry-action-btn text-green-600 dark:text-green-400"
              [class.obsidian]="appearance() === 'obsidian'"
              (click)="onMarkCompleted($event)"
              title="标记完成"
              aria-label="标记完成">
              <svg class="h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"
                   stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
                <path d="m5 12 4 4L19 6" />
              </svg>
              <span>完成</span>
            </button>
          }

          <!-- 删除按钮 -->
          <button
            class="entry-action-btn text-red-500 dark:text-red-400"
            [class.obsidian]="appearance() === 'obsidian'"
            (click)="onDelete($event)"
            title="删除"
            aria-label="删除"
            data-testid="black-box-entry-delete">
            <svg class="h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"
                 stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
              <path d="M3 6h18M9 6V4h6v2M5 6l1 14h12l1-14M10 10v6M14 10v6" />
            </svg>
            <span>删除</span>
          </button>
        </div>
      </div>

      <!-- 状态标签 -->
      @if (entry().isRead && !entry().isCompleted) {
        <div class="mt-1 inline-block px-1.5 py-0.5 rounded text-[9px]" [class]="readBadgeClass()">
          已读
        </div>
      }

      @if (entry().isCompleted) {
        <div class="mt-1 inline-block px-1.5 py-0.5 rounded text-[9px]" [class]="completedBadgeClass()">
          已完成
        </div>
      }
    </div>
  `,
  styles: [`
    .entry-action-btn {
      @apply min-h-7 px-1.5 rounded inline-flex items-center justify-center gap-1 text-[10px] whitespace-nowrap
             bg-white/80 dark:bg-stone-600/80
             hover:bg-white dark:hover:bg-stone-500
             active:scale-90 transition-all duration-100
             focus-visible:ring-2 focus-visible:ring-amber-500;
    }

    @media (pointer: coarse) {
      .entry-action-btn { min-height: 36px; padding-inline: 8px; }
    }

    .entry-action-btn.obsidian {
      @apply bg-stone-800/85 hover:bg-stone-700 border border-stone-600/70;
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class BlackBoxEntryComponent {
  entry = input.required<BlackBoxEntry>();
  appearance = input<'default' | 'obsidian'>('default');

  markRead = output<string>();
  markCompleted = output<string>();
  delete = output<string>();

  /**
   * 键盘快捷键支持
   */
  @HostListener('keydown', ['$event'])
  handleKeydown(event: KeyboardEvent): void {
    const key = typeof event.key === 'string' ? event.key.toLowerCase() : '';
    if (!key) return;


    // 【修复 2026-02-19】排除修饰键组合，避免 Ctrl+C/Cmd+C 误触发标记完成
    if (event.ctrlKey || event.metaKey || event.altKey) return;

    if (key === 'r') {
      if (this.entry().isRead) return;
      event.preventDefault();
      this.onMarkRead(event);
    } else if (key === 'c') {
      if (this.entry().isCompleted) return;
      event.preventDefault();
      this.onMarkCompleted(event);
    }
  }

  onMarkRead(event: Event): void {
    event.stopPropagation();
    if (this.entry().isRead) return;
    this.markRead.emit(this.entry().id);
  }

  onMarkCompleted(event: Event): void {
    event.stopPropagation();
    if (this.entry().isCompleted) return;
    this.markCompleted.emit(this.entry().id);
  }

  onDelete(event: Event): void {
    event.stopPropagation();
    this.delete.emit(this.entry().id);
  }

  entryShellClass(): string {
    if (this.appearance() === 'obsidian') {
      return `bg-stone-900/70 border border-stone-700/70
              hover:bg-stone-800/80 hover:border-amber-400/45`;
    }
    return 'hover:bg-amber-100/50 dark:hover:bg-stone-700/50';
  }

  contentClass(): string {
    if (this.appearance() === 'obsidian') {
      return 'text-stone-300';
    }
    return 'text-stone-600 dark:text-stone-300';
  }

  timeClass(): string {
    if (this.appearance() === 'obsidian') {
      return 'text-stone-500';
    }
    return 'text-stone-400 dark:text-stone-500';
  }

  syncPendingClass(): string {
    if (this.appearance() === 'obsidian') {
      return 'text-amber-300';
    }
    return 'text-amber-500 dark:text-amber-300';
  }

  syncConflictClass(): string {
    if (this.appearance() === 'obsidian') {
      return 'text-rose-300';
    }
    return 'text-rose-500 dark:text-rose-300';
  }

  shouldShowSyncPendingIndicator(): boolean {
    const currentEntry = this.entry();
    return currentEntry.syncStatus === 'pending'
      && currentEntry.userId !== AUTH_CONFIG.LOCAL_MODE_USER_ID;
  }

  shouldShowSyncConflictIndicator(): boolean {
    return this.entry().syncStatus === 'conflict';
  }

  /**
   * 调试用属性：把当前条目的 syncStatus 与 updatedAt 暴露到 DOM，
   * 便于真机/远程截图直接读取真实同步状态，定位"UI 显示待同步但实际已 synced"类问题。
   * 仅作为非语义化的 data-* 属性，不影响渲染。
   */
  syncDebugAttribute(): string {
    const current = this.entry();
    return `${current.syncStatus ?? 'unknown'}|${current.updatedAt ?? ''}`;
  }

  readBadgeClass(): string {
    if (this.appearance() === 'obsidian') {
      return 'bg-stone-700 text-stone-300';
    }
    return 'bg-stone-200 dark:bg-stone-600 text-stone-500 dark:text-stone-400';
  }

  completedBadgeClass(): string {
    if (this.appearance() === 'obsidian') {
      return 'bg-emerald-900/35 text-emerald-300';
    }
    return 'bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400';
  }
}
