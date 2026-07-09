import {
  ChangeDetectionStrategy,
  Component,
  EventEmitter,
  Input,
  Output,
} from '@angular/core';
import { FormsModule } from '@angular/forms';

import type { CognitiveLoad, DockLane } from '../../../../models/parking-dock';

@Component({
  selector: 'app-dock-inline-task-form',
  standalone: true,
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    .new-task-form {
      animation: slideDown var(--pk-panel-enter) var(--pk-ease-enter);
    }

    @keyframes slideDown {
      0% { opacity: 0; transform: translateY(-6px) scale(0.995); }
      50% { opacity: 0.6; transform: translateY(-1px) scale(0.999); }
      100% { opacity: 1; transform: translateY(0) scale(1); }
    }

    @media (prefers-reduced-motion: reduce) {
      .new-task-form {
        animation: none;
      }
    }
  `],
  template: `
    <div class="new-task-form flex flex-col gap-2.5 px-2" data-testid="dock-v3-new-task-form">
      <div class="flex items-center gap-2">
        <input
          type="text"
          [ngModel]="taskTitle"
          (ngModelChange)="taskTitleChange.emit($event)"
          (keydown.enter)="createTask.emit()"
          class="flex-1 text-xs py-2.5 px-3 rounded-lg bg-slate-800/80 border border-slate-600/40
                 text-slate-200 placeholder:text-slate-500 focus:border-indigo-500/60 outline-none
                 transition-colors"
          placeholder="输入任务名称…" />
        <select
          [ngModel]="taskLane"
          (ngModelChange)="taskLaneChange.emit($event)"
          class="text-xs py-2.5 px-2 rounded-lg bg-slate-800/80 border border-slate-600/40
                 text-slate-300 outline-none focus:border-indigo-500/60 transition-colors">
          <option value="backup">备选区</option>
          <option value="combo-select">组合选择区</option>
        </select>
        <select
          [ngModel]="taskLoad"
          (ngModelChange)="taskLoadChange.emit($event)"
          class="text-xs py-2.5 px-2 rounded-lg bg-slate-800/80 border border-slate-600/40
                 text-slate-300 outline-none focus:border-indigo-500/60 transition-colors">
          <option value="low">低负荷</option>
          <option value="high">高负荷</option>
        </select>
      </div>
      <div class="grid grid-cols-4 gap-2">
        <input
          type="number"
          [ngModel]="expectedMinutes"
          (ngModelChange)="expectedMinutesChange.emit($event)"
          min="1"
          placeholder="预计(min)"
          class="text-xs py-2 px-2.5 rounded-lg bg-slate-800/80 border border-slate-600/40
                 text-slate-200 placeholder:text-slate-500 focus:border-indigo-500/60 outline-none
                 transition-colors" />
        <input
          type="number"
          [ngModel]="waitMinutes"
          (ngModelChange)="waitMinutesChange.emit($event)"
          min="1"
          placeholder="等待(min)"
          class="text-xs py-2 px-2.5 rounded-lg bg-slate-800/80 border border-slate-600/40
                 text-slate-200 placeholder:text-slate-500 focus:border-indigo-500/60 outline-none
                 transition-colors" />
        <input
          type="text"
          [ngModel]="taskDetail"
          (ngModelChange)="taskDetailChange.emit($event)"
          placeholder="任务详情（可选）"
          class="col-span-2 text-xs py-2 px-2.5 rounded-lg bg-slate-800/80 border border-slate-600/40
                 text-slate-200 placeholder:text-slate-500 focus:border-indigo-500/60 outline-none
                 transition-colors" />
      </div>
      <div class="flex justify-end">
        <button
          type="button"
          (click)="createTask.emit()"
          [disabled]="createPending || !taskTitle.trim() || !createEnabled"
          class="px-4 py-2 text-xs rounded-lg bg-indigo-600/90 hover:bg-indigo-500
                 text-white font-medium transition-colors shadow-lg shadow-indigo-600/15
                 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-indigo-600/90"
          style="min-height: 44px;"
          data-testid="dock-v3-create-submit">
          添加到停泊坞
        </button>
      </div>
    </div>
  `,
})
export class DockInlineTaskFormComponent {
  @Input() taskTitle = '';
  @Input() taskLane: DockLane = 'backup';
  @Input() taskLoad: CognitiveLoad = 'low';
  @Input() expectedMinutes: string | number = '';
  @Input() waitMinutes: string | number = '';
  @Input() taskDetail = '';
  @Input() createPending = false;
  @Input() createEnabled = true;

  @Output() readonly taskTitleChange = new EventEmitter<string>();
  @Output() readonly taskLaneChange = new EventEmitter<DockLane>();
  @Output() readonly taskLoadChange = new EventEmitter<CognitiveLoad>();
  @Output() readonly expectedMinutesChange = new EventEmitter<string | number>();
  @Output() readonly waitMinutesChange = new EventEmitter<string | number>();
  @Output() readonly taskDetailChange = new EventEmitter<string>();
  @Output() readonly createTask = new EventEmitter<void>();
}
