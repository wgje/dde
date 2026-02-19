/**
 * 黑匣子日期分组组件
 * 
 * 按日期分组显示黑匣子条目
 */

import { 
  Component, 
  ChangeDetectionStrategy, 
  Input,
  Output,
  EventEmitter,
  signal
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { BlackBoxDateGroup } from '../../../../../models';
import { BlackBoxEntryComponent } from './black-box-entry.component';

@Component({
  selector: 'app-black-box-date-group',
  standalone: true,
  imports: [CommonModule, BlackBoxEntryComponent],
  template: `
    <div class="mt-3">
      <!-- 日期标题 -->
      <div class="text-[10px] font-mono mb-1.5 px-1 flex items-center gap-2" [class]="dateLabelClass()">
        <span class="flex-1 h-px" [class]="dividerClass()"></span>
        <span>{{ getDateLabel() }}</span>
        <span class="flex-1 h-px" [class]="dividerClass()"></span>
      </div>
      
      <!-- 条目列表 -->
      @for (entry of group.entries; track entry.id) {
        <app-black-box-entry 
          [entry]="entry"
          [appearance]="appearance"
          (markRead)="markRead.emit($event)"
          (markCompleted)="markCompleted.emit($event)"
          (delete)="onDeleteRequested($event)" />

        <!-- 删除确认栏（紧跟在条目下方） -->
        @if (pendingDeleteId() === entry.id) {
          <div class="mt-2 px-2 py-1.5 bg-red-900/30 rounded-lg text-xs text-red-200 flex items-center justify-between gap-2">
            <span>确认删除该条目？</span>
            <div class="flex items-center gap-1.5">
              <button
                class="px-2 py-1 rounded bg-red-500 text-white text-[10px] hover:bg-red-600 transition-colors"
                data-testid="confirm-delete"
                aria-label="确认删除"
                (click)="onConfirmDelete()">
                删除
              </button>
              <button
                class="px-2 py-1 rounded bg-stone-700 text-stone-300 text-[10px] hover:bg-stone-600 transition-colors"
                aria-label="取消删除"
                (click)="cancelDelete()">
                取消
              </button>
            </div>
          </div>
        }
      }
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class BlackBoxDateGroupComponent {
  @Input({ required: true }) group!: BlackBoxDateGroup;
  @Input() appearance: 'default' | 'obsidian' = 'default';
  
  @Output() markRead = new EventEmitter<string>();
  @Output() markCompleted = new EventEmitter<string>();
  @Output() confirmDelete = new EventEmitter<string>();

  // 追踪待删除的条目 ID
  pendingDeleteId = signal<string | null>(null);

  dateLabelClass(): string {
    if (this.appearance === 'obsidian') {
      return 'text-stone-400';
    }
    return 'text-stone-400 dark:text-stone-500';
  }

  dividerClass(): string {
    if (this.appearance === 'obsidian') {
      return 'bg-stone-700/80';
    }
    return 'bg-stone-200 dark:bg-stone-600';
  }
  
  /**
   * 获取日期显示标签
   */
  getDateLabel(): string {
    const today = new Date().toISOString().split('T')[0];
    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
    
    if (this.group.date === today) return '今天';
    if (this.group.date === yesterday) return '昨天';
    
    // 格式化日期
    const d = new Date(this.group.date);
    const month = d.getMonth() + 1;
    const day = d.getDate();
    return `${month}月${day}日`;
  }

  /**
   * 请求删除条目
   */
  onDeleteRequested(id: string): void {
    this.pendingDeleteId.set(id);
  }

  /**
   * 确认删除
   */
  onConfirmDelete(): void {
    const id = this.pendingDeleteId();
    if (!id) return;
    this.confirmDelete.emit(id);
    this.pendingDeleteId.set(null);
  }

  /**
   * 取消删除
   */
  cancelDelete(): void {
    this.pendingDeleteId.set(null);
  }
}
