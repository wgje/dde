import { Injector, runInInjectionContext } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Project, Task } from '../models';
import { TombstoneService } from '../core-bridge';
import { LayoutService } from './layout.service';
import { LoggerService } from './logger.service';
import { ParkingService } from './parking.service';
import { ProjectStateService } from './project-state.service';
import { SubtreeOperationsService } from './subtree-operations.service';
import { TaskAttributeService } from './task-attribute.service';
import { TaskConnectionService } from './task-connection.service';
import { TaskCreationService } from './task-creation.service';
import { TaskMoveService } from './task-move.service';
import { TaskOperationService } from './task-operation.service';
import { TaskRecordTrackingService } from './task-record-tracking.service';
import { TaskTrashService } from './task-trash.service';
import { ToastService } from './toast.service';

const mockLoggerCategory = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

const mockLoggerService = {
  category: vi.fn(() => mockLoggerCategory),
};

const mockParkingService = {
  handleTaskSoftDelete: vi.fn(),
  handleTaskStatusChange: vi.fn(),
};

const mockTombstoneService = {
  clearLocalTombstones: vi.fn(),
};

export interface TaskOperationMoveStageSpecContext {
  createTask(overrides: Partial<Task>): Task;
  createProject(overrides: Partial<Project>): Project;
}

export function registerTaskOperationMoveStageSpecs(
  context: TaskOperationMoveStageSpecContext,
): void {
  describe('TaskOperationService (moveTaskToStage parentId validation)', () => {
    let service: TaskOperationService;
    let project: Project;
    let consoleLogSpy: ReturnType<typeof vi.spyOn> | undefined;
    let consoleInfoSpy: ReturnType<typeof vi.spyOn> | undefined;
    let consoleDebugSpy: ReturnType<typeof vi.spyOn> | undefined;

    beforeEach(() => {
      consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      consoleInfoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
      consoleDebugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

      project = context.createProject({});

      const mockProjectState = {
        activeProject: () => project,
        getTask: (taskId: string) => project?.tasks.find(t => t.id === taskId),
      };
      const mockRecorder = {
        recordAndUpdate: (mutator: (p: Project) => Project) => {
          project = mutator(project);
        },
        recordAndUpdateDebounced: (mutator: (p: Project) => Project) => {
          project = mutator(project);
        },
        recordAndUpdateDurably: async (mutator: (p: Project) => Project) => {
          project = mutator(project);
          return true;
        },
        lastUpdateType: 'structure' as const,
      };

      const injector = Injector.create({
        providers: [
          { provide: LayoutService, useClass: LayoutService },
          { provide: ToastService, useClass: ToastService },
          { provide: LoggerService, useValue: mockLoggerService },
          { provide: ParkingService, useValue: mockParkingService },
          { provide: TombstoneService, useValue: mockTombstoneService },
          { provide: TaskTrashService, useClass: TaskTrashService },
          { provide: SubtreeOperationsService, useClass: SubtreeOperationsService },
          { provide: TaskCreationService, useClass: TaskCreationService },
          { provide: TaskMoveService, useClass: TaskMoveService },
          { provide: TaskAttributeService, useClass: TaskAttributeService },
          { provide: TaskConnectionService, useClass: TaskConnectionService },
          { provide: ProjectStateService, useValue: mockProjectState },
          { provide: TaskRecordTrackingService, useValue: mockRecorder },
        ],
      });

      service = runInInjectionContext(injector, () => new TaskOperationService());
    });

    afterEach(() => {
      consoleLogSpy?.mockRestore();
      consoleInfoSpy?.mockRestore();
      consoleDebugSpy?.mockRestore();
    });

    it('移动任务到远距离阶段时应清除无效的 parentId', async () => {
      const root = context.createTask({
        id: 'root',
        stage: 1,
        parentId: null,
        rank: 10000,
        displayId: '1',
      });
      const child = context.createTask({
        id: 'child',
        stage: 2,
        parentId: 'root',
        rank: 20000,
        displayId: '1,a',
      });

      project = context.createProject({ tasks: [root, child] });

      await service.moveTaskToStage({ taskId: 'child', newStage: 5 });

      const movedChild = project.tasks.find(t => t.id === 'child')!;
      expect(movedChild.stage).toBe(5);
      expect(movedChild.parentId).toBeNull();
    });

    it('移动任务到相邻阶段时应保留有效的 parentId', async () => {
      const root = context.createTask({
        id: 'root',
        stage: 1,
        parentId: null,
        rank: 10000,
      });
      const child = context.createTask({
        id: 'child',
        stage: 2,
        parentId: 'root',
        rank: 20000,
      });

      project = context.createProject({ tasks: [root, child] });

      await service.moveTaskToStage({ taskId: 'child', newStage: 2 });

      const movedChild = project.tasks.find(t => t.id === 'child')!;
      expect(movedChild.stage).toBe(2);
      expect(movedChild.parentId).toBe('root');
    });

    it('移动父任务时应级联更新所有子任务的 stage', async () => {
      const stageOneAnchor = context.createTask({
        id: 'stage-one-anchor',
        stage: 1,
        parentId: null,
        rank: 5000,
      });
      const root = context.createTask({
        id: 'root',
        stage: 1,
        parentId: null,
        rank: 10000,
      });
      const child = context.createTask({
        id: 'child',
        stage: 2,
        parentId: 'root',
        rank: 20000,
      });
      const grandchild = context.createTask({
        id: 'grandchild',
        stage: 3,
        parentId: 'child',
        rank: 30000,
      });

      project = context.createProject({ tasks: [stageOneAnchor, root, child, grandchild] });

      await service.moveTaskToStage({ taskId: 'root', newStage: 3 });

      const movedRoot = project.tasks.find(t => t.id === 'root')!;
      const movedChild = project.tasks.find(t => t.id === 'child')!;
      const movedGrandchild = project.tasks.find(t => t.id === 'grandchild')!;

      expect(movedRoot.stage).toBe(3);
      expect(movedChild.stage).toBe(4);
      expect(movedGrandchild.stage).toBe(5);
    });

    it('移动任务到未分配区域应清除 parentId', async () => {
      const root = context.createTask({
        id: 'root',
        stage: 1,
        parentId: null,
        rank: 10000,
      });
      const child = context.createTask({
        id: 'child',
        stage: 2,
        parentId: 'root',
        rank: 20000,
      });

      project = context.createProject({ tasks: [root, child] });

      await service.moveTaskToStage({ taskId: 'child', newStage: null });

      const movedChild = project.tasks.find(t => t.id === 'child')!;
      expect(movedChild.stage).toBeNull();
      expect(movedChild.parentId).toBeNull();
    });
  });
}
