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
  EventEmitter
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
          (archive)="archive.emit($event)"
          (delete)="delete.emit($event)" />
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
  @Output() archive = new EventEmitter<string>();
  @Output() delete = new EventEmitter<string>();

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
}
