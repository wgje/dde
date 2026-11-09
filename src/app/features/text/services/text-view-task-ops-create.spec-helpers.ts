import { signal } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';

import type { Task } from '../../../../models';
import type { TextViewTaskOpsService } from './text-view-task-ops.service';
import {
  createStage,
  createTask,
  initTextViewTaskOpsContext,
  type StageFixture,
} from './text-view-task-ops.test-helpers';

type AddTaskResult = { ok: true; value: string };

export interface TextViewTaskOpsCreateSpecContext {
  service(): TextViewTaskOpsService;
  mockTaskOpsAdapter(): {
    addTask: ReturnType<typeof vi.fn>;
    repairMissingStageOne: ReturnType<typeof vi.fn>;
  };
  mockToast(): {
    info: ReturnType<typeof vi.fn>;
  };
  mockUiState(): {
    setStageFilter: ReturnType<typeof vi.fn>;
  };
  mockUserSession(): {
    isHintOnlyStartupPlaceholderVisible: ReturnType<typeof vi.fn>;
  };
  setStageFilter(value: number | 'all'): void;
  setCurrentStages(stages: StageFixture[]): void;
}

export function registerTextViewTaskOpsCreateSpecs(
  context: TextViewTaskOpsCreateSpecContext,
): void {
  const initOpsContext = () => initTextViewTaskOpsContext(context.service());

  describe('create actions', () => {
    it('should block create actions while hint-only startup placeholder is read-only', async () => {
      context.mockUserSession().isHintOnlyStartupPlaceholderVisible.mockReturnValue(true);

      await context.service().onCreateUnassigned();

      expect(context.mockTaskOpsAdapter().addTask).not.toHaveBeenCalled();
      expect(context.mockToast().info).toHaveBeenCalledWith(
        '会话确认中',
        '创建任务暂不可用，owner 确认完成前保持只读',
      );
    });

    it('should await durable unassigned creation before editing the new task', async () => {
      const setEditingTask = vi.fn().mockResolvedValue(undefined);
      context.service().init({
        selectedTaskId: signal<string | null>(null),
        deleteConfirmTask: signal<Task | null>(null),
        deleteKeepChildren: signal(false),
        focusFlowNode: { emit: vi.fn() } as never,
        isMobile: signal(false),
        getStagesRef: () => undefined,
        getUnassignedRef: () => ({ setEditingTask } as never),
      });
      context.mockTaskOpsAdapter().addTask.mockResolvedValue({
        ok: true,
        value: 'new-unassigned-task',
      });

      await context.service().onCreateUnassigned();

      expect(context.mockTaskOpsAdapter().addTask)
        .toHaveBeenCalledWith('', '', null, null, false);
      expect(setEditingTask).toHaveBeenCalledWith('new-unassigned-task', true);
    });

    it('should ignore duplicate unassigned create clicks while creation is in flight', async () => {
      const setEditingTask = vi.fn().mockResolvedValue(undefined);
      let resolveCreate!: (value: AddTaskResult) => void;
      context.mockTaskOpsAdapter().addTask.mockReturnValue(new Promise(resolve => {
        resolveCreate = resolve;
      }));
      context.service().init({
        selectedTaskId: signal<string | null>(null),
        deleteConfirmTask: signal<Task | null>(null),
        deleteKeepChildren: signal(false),
        focusFlowNode: { emit: vi.fn() } as never,
        isMobile: signal(false),
        getStagesRef: () => undefined,
        getUnassignedRef: () => ({ setEditingTask } as never),
      });

      const firstCreate = context.service().onCreateUnassigned();
      const secondCreate = context.service().onCreateUnassigned();

      expect(context.mockTaskOpsAdapter().addTask).toHaveBeenCalledTimes(1);

      resolveCreate({ ok: true, value: 'new-unassigned-task' });
      await Promise.all([firstCreate, secondCreate]);

      expect(setEditingTask).toHaveBeenCalledTimes(1);
      expect(setEditingTask).toHaveBeenCalledWith('new-unassigned-task', true);
    });

    it('should ignore duplicate sibling create clicks for the same source task while creation is in flight', async () => {
      initOpsContext();
      const sourceTask = createTask({ id: 'source-task', stage: 2, parentId: 'parent-1' });
      let resolveCreate!: (value: AddTaskResult) => void;
      context.mockTaskOpsAdapter().addTask.mockReturnValue(new Promise(resolve => {
        resolveCreate = resolve;
      }));

      const firstCreate = context.service().onAddSibling(sourceTask);
      const secondCreate = context.service().onAddSibling(sourceTask);

      expect(context.mockTaskOpsAdapter().addTask).toHaveBeenCalledTimes(1);
      expect(context.mockTaskOpsAdapter().addTask)
        .toHaveBeenCalledWith('', '', 2, 'parent-1', true);

      resolveCreate({ ok: true, value: 'new-sibling-task' });
      await Promise.all([firstCreate, secondCreate]);
    });

    it('should allow concurrent sibling creates for different source tasks', async () => {
      initOpsContext();
      context.mockTaskOpsAdapter().addTask
        .mockResolvedValueOnce({ ok: true, value: 'new-sibling-a' })
        .mockResolvedValueOnce({ ok: true, value: 'new-sibling-b' });

      await Promise.all([
        context.service().onAddSibling(createTask({
          id: 'source-a',
          stage: 2,
          parentId: 'parent-a',
        })),
        context.service().onAddSibling(createTask({
          id: 'source-b',
          stage: 2,
          parentId: 'parent-b',
        })),
      ]);

      expect(context.mockTaskOpsAdapter().addTask).toHaveBeenCalledTimes(2);
      expect(context.mockTaskOpsAdapter().addTask)
        .toHaveBeenCalledWith('', '', 2, 'parent-a', true);
      expect(context.mockTaskOpsAdapter().addTask)
        .toHaveBeenCalledWith('', '', 2, 'parent-b', true);
    });

    it('should repair missing stage one instead of creating an extra stage', async () => {
      initOpsContext();
      context.setStageFilter(2);
      context.setCurrentStages([
        createStage(2, [createTask({ id: 'stage-2-root', stage: 2 })]),
      ]);
      context.mockTaskOpsAdapter().repairMissingStageOne.mockResolvedValue(true);

      await context.service().onAddNewStage();

      expect(context.mockTaskOpsAdapter().repairMissingStageOne).toHaveBeenCalledTimes(1);
      expect(context.mockTaskOpsAdapter().addTask).not.toHaveBeenCalled();
      expect(context.mockUiState().setStageFilter).toHaveBeenCalledWith('all');
    });

    it('should append a new stage when stage one is present', async () => {
      initOpsContext();
      context.setCurrentStages([
        createStage(1, [createTask({ id: 'stage-1-root', stage: 1 })]),
        createStage(2, [createTask({ id: 'stage-2-child', stage: 2 })]),
      ]);
      context.mockTaskOpsAdapter().addTask.mockResolvedValue({
        ok: true,
        value: 'new-stage-task',
      });

      await context.service().onAddNewStage();

      expect(context.mockTaskOpsAdapter().repairMissingStageOne).not.toHaveBeenCalled();
      expect(context.mockTaskOpsAdapter().addTask)
        .toHaveBeenCalledWith('', '', 3, null, false);
    });

    it('should ignore archived-only stages when deciding whether stage one is missing', async () => {
      initOpsContext();
      context.setCurrentStages([
        createStage(2, [createTask({
          id: 'archived-stage-2',
          stage: 2,
          status: 'archived',
        })]),
      ]);
      context.mockTaskOpsAdapter().addTask.mockResolvedValue({
        ok: true,
        value: 'new-stage-task',
      });

      await context.service().onAddNewStage();

      expect(context.mockTaskOpsAdapter().repairMissingStageOne).not.toHaveBeenCalled();
      expect(context.mockTaskOpsAdapter().addTask)
        .toHaveBeenCalledWith('', '', 3, null, false);
    });

    it('should not create a stage when missing-stage repair is unavailable', async () => {
      initOpsContext();
      context.setCurrentStages([
        createStage(2, [createTask({ id: 'stage-2-root', stage: 2 })]),
      ]);
      context.mockTaskOpsAdapter().repairMissingStageOne.mockResolvedValue(false);

      await context.service().onAddNewStage();

      expect(context.mockTaskOpsAdapter().repairMissingStageOne).toHaveBeenCalledTimes(1);
      expect(context.mockTaskOpsAdapter().addTask).not.toHaveBeenCalled();
      expect(context.mockUiState().setStageFilter).not.toHaveBeenCalledWith('all');
    });
  });
}
