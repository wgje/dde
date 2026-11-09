import { beforeEach, describe, expect, it, type Mock } from 'vitest';

import type { Project, Task } from '../models';
import type { ConflictResolutionService } from './conflict-resolution.service';

export interface ConflictResolutionStrategiesSpecContext {
  service(): ConflictResolutionService;
  createTestProject(overrides?: Partial<Project>): Project;
  createTestTask(overrides?: Partial<Task>): Task;
  mockSyncService: {
    update: Mock;
  };
  mockLayoutService: {
    validateAndFixTree: Mock;
  };
  mockToastService: {
    info: Mock;
  };
}

export function registerConflictResolutionStrategySpecs(
  context: ConflictResolutionStrategiesSpecContext,
): void {
  let service: ConflictResolutionService;
  const {
    createTestProject,
    createTestTask,
    mockSyncService,
    mockLayoutService,
    mockToastService,
  } = context;

  beforeEach(() => {
    service = context.service();
  });

  describe('冲突解决策略', () => {
    describe('local 策略', () => {
      it('应该使用本地版本并递增版本号', async () => {
        const localProject = createTestProject({ id: 'proj-1', version: 5 });
        const remoteProject = createTestProject({ id: 'proj-1', version: 7 });

        const result = await service.resolveConflict('proj-1', 'local', localProject, remoteProject);

        expect(result.ok).toBe(true);
        if (result.ok) {
          // LWW: max(local, remote) + 1 = max(5, 7) + 1 = 8
          expect(result.value.version).toBe(8);
        }
        expect(mockSyncService.update).toHaveBeenCalledWith({ hasConflict: false, conflictData: null });
      });

      it('版本为 undefined 时应该使用 1', async () => {
        const localProject = createTestProject({ id: 'proj-1', version: undefined });

        const result = await service.resolveConflict('proj-1', 'local', localProject);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.version).toBe(1);
        }
      });
    });

    describe('remote 策略', () => {
      it('应该使用远程版本', async () => {
        const localProject = createTestProject({ id: 'proj-1', version: 5 });
        const remoteProject = createTestProject({
          id: 'proj-1',
          version: 7,
          name: 'Remote Name',
        });

        const result = await service.resolveConflict('proj-1', 'remote', localProject, remoteProject);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.name).toBe('Remote Name');
        }
        expect(mockSyncService.update).toHaveBeenCalledWith({ hasConflict: false, conflictData: null });
      });

      it('远程项目为空时应该返回错误', async () => {
        const localProject = createTestProject({ id: 'proj-1' });

        const result = await service.resolveConflict('proj-1', 'remote', localProject);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.message).toContain('远程项目数据不存在');
        }
      });
    });

    describe('merge 策略', () => {
      it('应该合并双方的更改', async () => {
        const localProject = createTestProject({
          id: 'proj-1',
          version: 5,
          tasks: [createTestTask({ id: 'task-1', title: 'Local Task' })],
        });
        const remoteProject = createTestProject({
          id: 'proj-1',
          version: 7,
          tasks: [createTestTask({ id: 'task-2', title: 'Remote Task' })],
        });

        const result = await service.resolveConflict('proj-1', 'merge', localProject, remoteProject);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.tasks.length).toBe(2);
          expect(result.value.version).toBe(8); // max(5, 7) + 1
        }
      });

      it('远程项目为空时应该返回错误', async () => {
        const localProject = createTestProject({ id: 'proj-1' });

        const result = await service.resolveConflict('proj-1', 'merge', localProject);

        expect(result.ok).toBe(false);
      });

      it('合并有问题时应该显示提示', async () => {
        const localProject = createTestProject({
          id: 'proj-1',
          tasks: [createTestTask({ id: 'task-1' })],
        });
        const remoteProject = createTestProject({
          id: 'proj-1',
          tasks: [createTestTask({ id: 'task-1', title: 'Different Title' })],
        });

        mockLayoutService.validateAndFixTree.mockReturnValueOnce({
          project: { ...localProject },
          issues: ['Fixed orphan task'],
        });

        await service.resolveConflict('proj-1', 'merge', localProject, remoteProject);

        expect(mockToastService.info).toHaveBeenCalled();
      });
    });

    describe('逐任务计划策略', () => {
      it('应该按任务分别采用本地或云端版本', async () => {
        const localProject = createTestProject({
          id: 'proj-1',
          version: 2,
          tasks: [
            createTestTask({
              id: 'task-1',
              title: 'Local Task',
              content: 'local body',
              updatedAt: '2025-01-01T00:00:00.000Z',
            }),
            createTestTask({ id: 'task-2', title: 'Only Local' }),
          ],
        });
        const remoteProject = createTestProject({
          id: 'proj-1',
          version: 3,
          tasks: [
            createTestTask({
              id: 'task-1',
              title: 'Remote Task',
              content: 'remote body',
              updatedAt: '2025-01-02T00:00:00.000Z',
            }),
            createTestTask({ id: 'task-3', title: 'Only Remote' }),
          ],
        });

        const result = await service.resolveConflictWithPlan(
          'proj-1',
          {
            taskChoices: {
              'task-1': 'remote',
              'task-2': 'local',
              'task-3': 'remote',
            },
            appliedBy: 'mixed',
          },
          localProject,
          remoteProject,
        );

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.version).toBe(4);
          expect(result.value.tasks.find(task => task.id === 'task-1')?.title).toBe('Remote Task');
          expect(result.value.tasks.some(task => task.id === 'task-2')).toBe(true);
          expect(result.value.tasks.some(task => task.id === 'task-3')).toBe(true);
        }
        expect(mockSyncService.update).toHaveBeenCalledWith({ hasConflict: false, conflictData: null });
      });

      it('显式选择版本时不应额外创建冲突副本', async () => {
        const localProject = createTestProject({
          id: 'proj-1',
          tasks: [createTestTask({
            id: 'task-1',
            title: '原任务',
            content: 'Common prefix here 111222333444555666777888999000 unique local numbers',
            updatedAt: '2025-01-01T00:00:00.000Z',
          })],
        });
        const remoteProject = createTestProject({
          id: 'proj-1',
          tasks: [createTestTask({
            id: 'task-1',
            title: '原任务',
            content: 'Common prefix here @@##$$%%^^&&**()!!~~``|| unique remote symbols',
            updatedAt: '2025-01-02T00:00:00.000Z',
          })],
        });

        const result = await service.resolveConflictWithPlan(
          'proj-1',
          {
            taskChoices: { 'task-1': 'remote' },
            appliedBy: 'user',
          },
          localProject,
          remoteProject,
        );

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.tasks.find(task => task.id === 'task-1')?.content).toContain('remote symbols');
          expect(result.value.tasks.filter(task => task.title.includes('(冲突副本)'))).toHaveLength(0);
        }
      });

      it('local-only 和 remote-only 任务也应支持按计划覆写', async () => {
        const localProject = createTestProject({
          id: 'proj-1',
          tasks: [createTestTask({ id: 'task-local-only', title: 'Only Local' })],
        });
        const remoteProject = createTestProject({
          id: 'proj-1',
          tasks: [createTestTask({ id: 'task-remote-only', title: 'Only Remote' })],
        });

        const result = await service.resolveConflictWithPlan(
          'proj-1',
          {
            taskChoices: {
              'task-local-only': 'remote',
              'task-remote-only': 'local',
            },
            appliedBy: 'user',
          },
          localProject,
          remoteProject,
        );

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.tasks.some(task => task.id === 'task-local-only')).toBe(false);
          expect(result.value.tasks.some(task => task.id === 'task-remote-only')).toBe(false);
        }
      });
    });
  });
}
