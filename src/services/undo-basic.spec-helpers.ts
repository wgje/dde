import { describe, expect, it } from 'vitest';

import type { Project, Task } from '../models';
import type { UndoService } from './undo.service';

interface UndoBasicSpecContext {
  service: () => UndoService;
  createTask: (overrides?: Partial<Task>) => Task;
  createTestProject: (overrides?: Partial<Project>) => Project;
}

export function registerUndoBasicSpecs(context: UndoBasicSpecContext): void {
  describe('基本撤销功能', () => {
    it('初始状态应该没有可撤销的操作', () => {
      expect(context.service().canUndo()).toBe(false);
      expect(context.service().undoCount()).toBe(0);
    });

    it('记录操作后应该有可撤销的操作', () => {
      const service = context.service();
      const project = context.createTestProject();
      const beforeSnapshot = service.createProjectSnapshot(project);

      const afterProject: Project = {
        ...project,
        tasks: [
          ...project.tasks,
          context.createTask({
            id: 'task-2',
            title: '新任务',
            order: 2,
            rank: 2000,
            x: 200,
            displayId: '2',
          }),
        ],
      };
      const afterSnapshot = service.createProjectSnapshot(afterProject);

      service.recordAction({
        type: 'task-update',
        projectId: project.id,
        data: { before: beforeSnapshot, after: afterSnapshot },
      });

      expect(service.canUndo()).toBe(true);
      expect(service.undoCount()).toBe(1);
    });

    it('撤销后应该返回正确的快照', () => {
      const service = context.service();
      const project = context.createTestProject();
      const beforeSnapshot = service.createProjectSnapshot(project);

      const afterProject: Project = {
        ...project,
        tasks: [
          ...project.tasks,
          context.createTask({
            id: 'task-2',
            title: '新任务',
            order: 2,
            rank: 2000,
            x: 200,
            displayId: '2',
          }),
        ],
      };
      const afterSnapshot = service.createProjectSnapshot(afterProject);

      service.recordAction({
        type: 'task-update',
        projectId: project.id,
        data: { before: beforeSnapshot, after: afterSnapshot },
      });

      const result = service.undo();

      expect(result).not.toBeNull();
      expect(result).not.toBe('version-mismatch');
      if (result && typeof result === 'object' && 'data' in result) {
        expect(result.data.before.tasks?.length).toBe(1);
        expect(result.data.after.tasks?.length).toBe(2);
      }
    });

    it('prepareUndo should not consume undo history until commitPreparedUndo succeeds', () => {
      const service = context.service();
      const project = context.createTestProject();
      const beforeSnapshot = service.createProjectSnapshot(project);
      const afterSnapshot = service.createProjectSnapshot({
        ...project,
        tasks: [
          ...project.tasks,
          context.createTask({
            id: 'task-prepare-undo',
            title: '预览撤销',
            order: 2,
            rank: 2000,
            x: 200,
            displayId: '2',
          }),
        ],
      });

      service.recordAction({
        type: 'task-update',
        projectId: project.id,
        data: { before: beforeSnapshot, after: afterSnapshot },
      });

      const prepared = service.prepareUndo();

      expect(prepared).not.toBeNull();
      expect(service.canUndo()).toBe(true);
      expect(service.undoCount()).toBe(1);
      expect(service.canRedo()).toBe(false);
      expect(service.redoCount()).toBe(0);

      if (prepared && typeof prepared === 'object' && 'data' in prepared) {
        service.commitPreparedUndo(prepared);
      }

      expect(service.canUndo()).toBe(false);
      expect(service.undoCount()).toBe(0);
      expect(service.canRedo()).toBe(true);
      expect(service.redoCount()).toBe(1);
    });

    it('prepareRedo should not consume redo history until commitPreparedRedo succeeds', () => {
      const service = context.service();
      const project = context.createTestProject();
      const beforeSnapshot = service.createProjectSnapshot(project);
      const afterSnapshot = service.createProjectSnapshot({
        ...project,
        tasks: [
          ...project.tasks,
          context.createTask({
            id: 'task-prepare-redo',
            title: '预览重做',
            order: 2,
            rank: 2000,
            x: 200,
            displayId: '2',
          }),
        ],
      });

      service.recordAction({
        type: 'task-update',
        projectId: project.id,
        data: { before: beforeSnapshot, after: afterSnapshot },
      });
      const undone = service.undo();
      expect(undone).not.toBeNull();
      expect(service.canRedo()).toBe(true);

      const prepared = service.prepareRedo();

      expect(prepared).not.toBeNull();
      expect(service.canRedo()).toBe(true);
      expect(service.redoCount()).toBe(1);
      expect(service.canUndo()).toBe(false);
      expect(service.undoCount()).toBe(0);

      if (prepared && typeof prepared === 'object' && 'data' in prepared) {
        service.commitPreparedRedo(prepared);
      }

      expect(service.canRedo()).toBe(false);
      expect(service.redoCount()).toBe(0);
      expect(service.canUndo()).toBe(true);
      expect(service.undoCount()).toBe(1);
    });
  });
}
