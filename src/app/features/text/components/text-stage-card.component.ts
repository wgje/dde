import { Component, inject, input, output, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ProjectStateService } from '../../../../services/project-state.service';
import { Task } from '../../../../models';
import { StageData, DropTargetInfo, TaskTouchStartPayload } from './text-view.types';
import { TextTaskCardComponent } from './text-task-card.component';

/**
 * 阶段卡片组件
 * 显示单个阶段及其任务列表，支持折叠和拖拽放置
 */
@Component({
  selector: 'app-text-stage-card',
  standalone: true,
  imports: [CommonModule, TextTaskCardComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './text-stage-card.component.html',
  styleUrl: './text-stage-card.component.css',
})
export class TextStageCardComponent {
  private readonly projectState = inject(ProjectStateService);
  
  readonly stage = input.required<StageData>();
  readonly isMobile = input(false);
  readonly isExpanded = input(true);
  readonly selectedTaskId = input<string | null>(null);
  readonly draggingTaskId = input<string | null>(null);
  readonly isDragOver = input(false);
  readonly dropTargetInfo = input<DropTargetInfo | null>(null);
  readonly userId = input<string | null>(null);
  readonly projectId = input<string | null>(null);
  
  // 阶段事件
  readonly toggleExpand = output<number>();
  readonly stageDragOver = output<{ event: DragEvent; stageNumber: number }>();
  readonly stageDragLeave = output<{ event: DragEvent; stageNumber: number }>();
  readonly stageDrop = output<{ event: DragEvent; stageNumber: number }>();
  
  // 任务事件
  readonly taskSelect = output<Task>();
  readonly addSibling = output<Task>();
  readonly addChild = output<Task>();
  readonly deleteTask = output<Task>();
  readonly parkTask = output<Task>();
  readonly attachmentError = output<string>();
  readonly openLinkedTask = output<{ taskId: string; event: Event }>();
  
  // 拖拽事件
  readonly taskDragStart = output<{ event: DragEvent; task: Task }>();
  readonly taskDragEnd = output<void>();
  readonly taskDragOver = output<{ event: DragEvent; task: Task; stageNumber: number }>();
  readonly taskTouchStart = output<TaskTouchStartPayload>();
  readonly taskTouchMove = output<TouchEvent>();
  readonly taskTouchEnd = output<TouchEvent>();
  readonly taskTouchCancel = output<TouchEvent>();
  
  getConnections(taskId: string) {
    return this.projectState.getTaskConnections(taskId);
  }
  
  toggleCollapse() {
    this.toggleExpand.emit(this.stage().stageNumber);
  }
  
  onStageDragOver(event: DragEvent) {
    event.preventDefault();
    this.stageDragOver.emit({ event, stageNumber: this.stage().stageNumber });
  }
  
  onStageDragLeave(event: DragEvent) {
    this.stageDragLeave.emit({ event, stageNumber: this.stage().stageNumber });
  }
  
  onStageDrop(event: DragEvent) {
    event.preventDefault();
    this.stageDrop.emit({ event, stageNumber: this.stage().stageNumber });
  }
}
