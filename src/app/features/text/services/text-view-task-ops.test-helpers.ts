import { signal } from '@angular/core';

import type { Task } from '../../../../models';
import type { TextViewTaskOpsService } from './text-view-task-ops.service';

export interface StageFixture {
  stageNumber: number;
  tasks: Task[];
}

export function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: overrides.id ?? 'task-1',
    title: overrides.title ?? 'Task',
    content: overrides.content ?? '',
    stage: 'stage' in overrides ? overrides.stage! : 1,
    parentId: overrides.parentId ?? null,
    order: overrides.order ?? 1,
    rank: overrides.rank ?? 1000,
    status: overrides.status ?? 'active',
    x: overrides.x ?? 0,
    y: overrides.y ?? 0,
    createdDate: overrides.createdDate ?? new Date().toISOString(),
    updatedAt: overrides.updatedAt ?? new Date().toISOString(),
    displayId: overrides.displayId ?? '1',
    deletedAt: overrides.deletedAt ?? null,
  };
}

export function createStage(stageNumber: number, tasks: Task[]): StageFixture {
  return { stageNumber, tasks };
}

export function initTextViewTaskOpsContext(service: TextViewTaskOpsService): void {
  service.init({
    selectedTaskId: signal<string | null>(null),
    deleteConfirmTask: signal<Task | null>(null),
    deleteKeepChildren: signal(false),
    focusFlowNode: { emit: () => undefined } as never,
    isMobile: signal(false),
    getStagesRef: () => undefined,
    getUnassignedRef: () => undefined,
  });
}
