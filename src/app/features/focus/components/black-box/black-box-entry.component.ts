/**
 * 黑匣子条目组件
 * 
 * 显示单个黑匣子条目
 */

import { 
  Component, 
  ChangeDetectionStrategy, 
  Input,
  Output,
  EventEmitter,
  HostListener
} from '@angular/core';
import { CommonModule, DatePipe } from '@angular/common';
import { BlackBoxEntry } from '../../../../../models';

@Component({
  selector: 'app-black-box-entry',
  standalone: true,
  imports: [CommonModule, DatePipe],
  template: `
    <div 
      class="group mb-1.5 p-2 rounded-lg transition-all duration-150
             hover:bg-amber-100/50 dark:hover:bg-stone-700/50"
      [class.opacity-50]="entry.isRead && !entry.isCompleted"
      [class.line-through]="entry.isCompleted"
      [attr.data-entry-id]="entry.id"
      data-testid="black-box-entry"
      tabindex="0"
      role="article"
      [attr.aria-label]="'黑匣子条目: ' + entry.content.slice(0, 50)">
      
      <!-- 内容 -->
      <p class="text-xs text-stone-600 dark:text-stone-300 
                leading-relaxed break-words">
        {{ entry.content }}
      </p>
      
      <!-- 底部栏 -->
      <div class="mt-1.5 flex items-center justify-between">
        <!-- 时间戳 -->
        <span class="text-[10px] text-stone-400 dark:text-stone-500 font-mono">
          {{ entry.createdAt | date:'HH:mm' }}
        </span>

        <!-- 同步状态指示 -->
        @if (entry.syncStatus === 'pending') {
          <span class="text-[9px] text-amber-500 dark:text-amber-300"
                data-testid="sync-pending-indicator">
            ⏳ 待同步
          </span>
        }
        
        <!-- 操作按钮 -->
        <div class="flex gap-1 opacity-0 group-hover:opacity-100 
                    group-focus-within:opacity-100 transition-opacity duration-150">
          
          <!-- 已读按钮 -->
          @if (!entry.isRead) {
            <button 
              class="entry-action-btn"
              (click)="onMarkRead($event)"
              title="标记已读"
              aria-label="标记已读">
              👁️
            </button>
          }
          
          <!-- 完成按钮 -->
          @if (!entry.isCompleted) {
            <button 
              class="entry-action-btn text-green-600 dark:text-green-400"
              (click)="onMarkCompleted($event)"
              title="标记完成"
              aria-label="标记完成">
              ✅
            </button>
          }
          
          <!-- 归档按钮 -->
          <button 
            class="entry-action-btn text-stone-400 dark:text-stone-500"
            (click)="onArchive($event)"
            title="归档"
            aria-label="归档">
            📁
          </button>

          <!-- 删除按钮 -->
          <button 
            class="entry-action-btn text-red-500 dark:text-red-400"
            (click)="onDelete($event)"
            title="删除"
            aria-label="删除"
            data-testid="black-box-entry-delete">
            🗑️
          </button>
        </div>
      </div>
      
      <!-- 状态标签 -->
      @if (entry.isRead && !entry.isCompleted) {
        <div class="mt-1 inline-block px-1.5 py-0.5 rounded text-[9px] 
                    bg-stone-200 dark:bg-stone-600 
                    text-stone-500 dark:text-stone-400">
          已读
        </div>
      }
      
      @if (entry.isCompleted) {
        <div class="mt-1 inline-block px-1.5 py-0.5 rounded text-[9px] 
                    bg-green-100 dark:bg-green-900/30 
                    text-green-600 dark:text-green-400">
          已完成
        </div>
      }
    </div>
  `,
  styles: [`
    .entry-action-btn {
      @apply w-6 h-6 rounded flex items-center justify-center text-xs
             bg-white/80 dark:bg-stone-600/80
             hover:bg-white dark:hover:bg-stone-500
             active:scale-90 transition-all duration-100
             focus-visible:ring-2 focus-visible:ring-amber-500;
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class BlackBoxEntryComponent {
  @Input({ required: true }) entry!: BlackBoxEntry;
  
  @Output() markRead = new EventEmitter<string>();
  @Output() markCompleted = new EventEmitter<string>();
  @Output() archive = new EventEmitter<string>();
  @Output() delete = new EventEmitter<string>();
  
  /**
   * 键盘快捷键支持
   */
  @HostListener('keydown', ['$event'])
  handleKeydown(event: KeyboardEvent): void {
    const key = event.key.toLowerCase();
    
    if (key === 'r') {
      event.preventDefault();
      this.onMarkRead(event);
    } else if (key === 'c') {
      event.preventDefault();
      this.onMarkCompleted(event);
    } else if (key === 'a') {
      event.preventDefault();
      this.onArchive(event);
    }
  }
  
  onMarkRead(event: Event): void {
    event.stopPropagation();
    this.markRead.emit(this.entry.id);
  }
  
  onMarkCompleted(event: Event): void {
    event.stopPropagation();
    this.markCompleted.emit(this.entry.id);
  }
  
  onArchive(event: Event): void {
    event.stopPropagation();
    this.archive.emit(this.entry.id);
  }

  onDelete(event: Event): void {
    event.stopPropagation();
    this.delete.emit(this.entry.id);
  }
}
