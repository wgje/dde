import { describe, expect, it, vi } from 'vitest';

import type { Mock } from 'vitest';

import type { Project, Task } from '../models';
import { ErrorCodes } from '../utils/result';
import type { TaskMoveService } from './task-move.service';

type SpecMock = ReturnType<typeof vi.fn>;

export interface TaskMoveAssignmentSpecContext {
  service(): TaskMoveService;
  setActiveProject(project: Project | null): void;
  createTask(overrides?: Partial<Task>): Task;
  createProject(overrides?: Partial<Project>): Project;
  mockRecorder(): {
    recordAndUpdate: SpecMock;
    recordAndUpdateDurably: SpecMock;
  };
  mockSubtreeOps(): {
    collectSubtreeIds: SpecMock;
    assignSubtreeToStage: SpecMock;
    fixSubtreeRanks: SpecMock;
  };
}

export function registerTaskMoveAssignmentSpecs(context: TaskMoveAssignmentSpecContext): void {
  const { createTask, createProject, mockRecorder, service, setActiveProject } = context;

  describe('replaceChildSubtreeWithUnassigned', () => {
    it('默认入口通过本地持久化路径执行替换操作', async () => {
      const source = createTask({ id: 'src', stage: 1 });
      const target = createTask({ id: 'tgt', stage: null });
      setActiveProject(createProject({ tasks: [source, target] }));
      const mockSubtreeOps = context.mockSubtreeOps();
      mockSubtreeOps.collectSubtreeIds.mockReturnValue(new Set(['tgt']));

      const result = await service().replaceChildSubtreeWithUnassigned('src', 'tgt');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveProperty('detachedSubtreeRootId');
      }
      expect(mockRecorder().recordAndUpdateDurably).toHaveBeenCalledWith(
        expect.any(Function),
        { updateType: 'structure' },
      );
      expect(mockRecorder().recordAndUpdate).not.toHaveBeenCalled();
      expect(mockSubtreeOps.assignSubtreeToStage).toHaveBeenCalled();
    });

    it('没有活动项目时返回 DATA_NOT_FOUND', async () => {
      setActiveProject(null);
      const result = await service().replaceChildSubtreeWithUnassigned('src', 'tgt');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.DATA_NOT_FOUND);
      }
    });

    it('源任务在待分配区时返回 VALIDATION_ERROR', async () => {
      const source = createTask({ id: 'src', stage: null });
      const target = createTask({ id: 'tgt', stage: null });
      setActiveProject(createProject({ tasks: [source, target] }));

      const result = await service().replaceChildSubtreeWithUnassigned('src', 'tgt');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.VALIDATION_ERROR);
      }
    });

    it('目标任务在已分配区时返回 VALIDATION_ERROR', async () => {
      const source = createTask({ id: 'src', stage: 1 });
      const target = createTask({ id: 'tgt', stage: 2 });
      setActiveProject(createProject({ tasks: [source, target] }));

      const result = await service().replaceChildSubtreeWithUnassigned('src', 'tgt');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.VALIDATION_ERROR);
      }
    });
  });

  describe('assignUnassignedToTask', () => {
    it('默认入口通过本地持久化路径将待分配块分配给任务', async () => {
      const source = createTask({ id: 'src', stage: 1 });
      const target = createTask({ id: 'tgt', stage: null });
      setActiveProject(createProject({ tasks: [source, target] }));
      const mockSubtreeOps = context.mockSubtreeOps();
      mockSubtreeOps.collectSubtreeIds.mockReturnValue(new Set(['tgt']));

      const result = await service().assignUnassignedToTask('src', 'tgt');

      expect(result.ok).toBe(true);
      expect(mockRecorder().recordAndUpdateDurably).toHaveBeenCalledWith(
        expect.any(Function),
        { updateType: 'structure' },
      );
      expect(mockRecorder().recordAndUpdate).not.toHaveBeenCalled();
      expect(mockSubtreeOps.assignSubtreeToStage).toHaveBeenCalled();
      expect(mockSubtreeOps.fixSubtreeRanks).toHaveBeenCalled();
    });

    it('没有活动项目时返回 DATA_NOT_FOUND', async () => {
      setActiveProject(null);
      const result = await service().assignUnassignedToTask('src', 'tgt');
      expect(result.ok).toBe(false);
    });

    it('源任务在待分配区时返回 VALIDATION_ERROR', async () => {
      const source = createTask({ id: 'src', stage: null });
      const target = createTask({ id: 'tgt', stage: null });
      setActiveProject(createProject({ tasks: [source, target] }));

      const result = await service().assignUnassignedToTask('src', 'tgt');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.VALIDATION_ERROR);
      }
    });

    it('目标任务在已分配区时返回 VALIDATION_ERROR', async () => {
      const source = createTask({ id: 'src', stage: 1 });
      const target = createTask({ id: 'tgt', stage: 2 });
      setActiveProject(createProject({ tasks: [source, target] }));

      const result = await service().assignUnassignedToTask('src', 'tgt');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.VALIDATION_ERROR);
      }
    });
  });
}
