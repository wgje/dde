import { describe, expect, it, vi } from 'vitest';

import type { Connection, Project, Task } from '../models';
import { ErrorCodes } from '../utils/result';
import type { TaskMoveService } from './task-move.service';

type SpecMock = ReturnType<typeof vi.fn>;

export interface TaskMoveTreeReparentSpecContext {
  service(): TaskMoveService;
  activeProject(): Project | null;
  setActiveProject(project: Project | null): void;
  createTask(overrides?: Partial<Task>): Task;
  createProject(overrides?: Partial<Project>): Project;
  recordedMutators(): Array<(project: Project) => Project>;
  mockLayoutService(): { detectCycle: SpecMock };
  mockRecorder(): {
    recordAndUpdate: SpecMock;
    recordAndUpdateDurably: SpecMock;
  };
  mockSubtreeOps(): {
    collectSubtreeIds: SpecMock;
    computeNewRankForMigratedTask: SpecMock;
    updateParentChildConnections: SpecMock;
    updateSubtreeStages: SpecMock;
  };
}

export function registerTaskMoveTreeReparentSpecs(context: TaskMoveTreeReparentSpecContext): void {
  const {
    activeProject,
    createProject,
    createTask,
    mockLayoutService,
    mockRecorder,
    mockSubtreeOps,
    recordedMutators,
    service,
    setActiveProject,
  } = context;

  describe('getDirectChildren', () => {
    it('返回直接子任务（排除已删除）', () => {
      const parent = createTask({ id: 'p1', stage: 1 });
      const child1 = createTask({ id: 'c1', parentId: 'p1', stage: 2 });
      const child2 = createTask({ id: 'c2', parentId: 'p1', stage: 2, deletedAt: new Date().toISOString() });
      const child3 = createTask({ id: 'c3', parentId: 'p1', stage: 2 });
      setActiveProject(createProject({ tasks: [parent, child1, child2, child3] }));

      const children = service().getDirectChildren('p1');

      expect(children).toHaveLength(2);
      expect(children.map(child => child.id)).toContain('c1');
      expect(children.map(child => child.id)).toContain('c3');
    });

    it('没有活动项目时返回空数组', () => {
      setActiveProject(null);
      expect(service().getDirectChildren('any')).toEqual([]);
    });
  });

  describe('getUnassignedParent', () => {
    it('返回待分配区的父任务 ID', () => {
      const parent = createTask({ id: 'up', stage: null });
      const child = createTask({ id: 'uc', stage: null, parentId: 'up' });
      setActiveProject(createProject({ tasks: [parent, child] }));

      expect(service().getUnassignedParent('uc')).toBe('up');
    });

    it('父任务在已分配区时返回 null', () => {
      const parent = createTask({ id: 'ap', stage: 1 });
      const child = createTask({ id: 'uc', stage: null, parentId: 'ap' });
      setActiveProject(createProject({ tasks: [parent, child] }));

      expect(service().getUnassignedParent('uc')).toBeNull();
    });

    it('任务自身在已分配区时返回 null', () => {
      const task = createTask({ id: 't1', stage: 1, parentId: null });
      setActiveProject(createProject({ tasks: [task] }));

      expect(service().getUnassignedParent('t1')).toBeNull();
    });

    it('没有活动项目时返回 null', () => {
      setActiveProject(null);
      expect(service().getUnassignedParent('any')).toBeNull();
    });

    it('任务无父节点时返回 null', () => {
      const task = createTask({ id: 't1', stage: null, parentId: null });
      setActiveProject(createProject({ tasks: [task] }));

      expect(service().getUnassignedParent('t1')).toBeNull();
    });
  });

  describe('detachTask', () => {
    it('默认入口通过本地持久化路径将任务分离到待分配区且子节点提升', async () => {
      const grandParent = createTask({ id: 'gp', stage: 1, parentId: null });
      const parent = createTask({ id: 'p', stage: 2, parentId: 'gp' });
      const child = createTask({ id: 'c', stage: 3, parentId: 'p' });
      setActiveProject(createProject({ tasks: [grandParent, parent, child] }));

      const saved = await service().detachTask('p');

      expect(saved).toBe(true);
      expect(mockRecorder().recordAndUpdateDurably).toHaveBeenCalledWith(
        expect.any(Function),
        { updateType: 'structure' },
      );
      expect(mockRecorder().recordAndUpdate).not.toHaveBeenCalled();
      const updatedParent = activeProject()!.tasks.find(task => task.id === 'p');
      const updatedChild = activeProject()!.tasks.find(task => task.id === 'c');

      expect(updatedParent?.stage).toBeNull();
      expect(updatedParent?.parentId).toBeNull();
      expect(updatedChild?.parentId).toBe('gp');
    });

    it('任务不存在时不出错', async () => {
      setActiveProject(createProject({ tasks: [] }));
      await service().detachTask('nonexistent');
      expect(recordedMutators()).toHaveLength(1);
    });

    it('detachTaskDurably 通过本地持久化路径分离任务', async () => {
      const grandParent = createTask({ id: 'gp', stage: 1, parentId: null });
      const parent = createTask({ id: 'p', stage: 2, parentId: 'gp' });
      const child = createTask({ id: 'c', stage: 3, parentId: 'p' });
      setActiveProject(createProject({ tasks: [grandParent, parent, child] }));

      const saved = await service().detachTaskDurably('p');

      expect(saved).toBe(true);
      expect(mockRecorder().recordAndUpdateDurably).toHaveBeenCalledWith(
        expect.any(Function),
        { updateType: 'structure' },
      );
      expect(mockRecorder().recordAndUpdate).not.toHaveBeenCalled();
      expect(activeProject()!.tasks.find(task => task.id === 'p')?.stage).toBeNull();
      expect(activeProject()!.tasks.find(task => task.id === 'c')?.parentId).toBe('gp');
    });
  });

  describe('deleteTaskKeepChildren', () => {
    it('默认入口通过本地持久化路径删除任务、提升子节点并移除相关连接', async () => {
      const parent = createTask({ id: 'p', stage: 1, parentId: null });
      const target = createTask({ id: 't', stage: 2, parentId: 'p' });
      const child = createTask({ id: 'c', stage: 3, parentId: 't' });
      const conn: Connection = { id: 'conn1', source: 't', target: 'c' };
      const otherConn: Connection = { id: 'conn2', source: 'p', target: 'c' };
      setActiveProject(createProject({
        tasks: [parent, target, child],
        connections: [conn, otherConn],
      }));

      const saved = await service().deleteTaskKeepChildren('t');

      expect(saved).toBe(true);
      expect(mockRecorder().recordAndUpdateDurably).toHaveBeenCalledWith(
        expect.any(Function),
        { updateType: 'structure' },
      );
      expect(mockRecorder().recordAndUpdate).not.toHaveBeenCalled();
      expect(activeProject()!.tasks.find(task => task.id === 't')).toBeUndefined();
      const updatedChild = activeProject()!.tasks.find(task => task.id === 'c');
      expect(updatedChild?.parentId).toBe('p');
      expect(activeProject()!.connections.find(connection => connection.id === 'conn1')).toBeUndefined();
      expect(activeProject()!.connections.find(connection => connection.id === 'conn2')).toBeDefined();
    });

    it('没有活动项目时静默返回', async () => {
      setActiveProject(null);
      const saved = await service().deleteTaskKeepChildren('any');
      expect(saved).toBe(false);
      expect(recordedMutators()).toHaveLength(0);
    });
  });

  describe('moveSubtreeToNewParent', () => {
    it('默认入口通过本地持久化路径迁移子树到新父节点', async () => {
      const oldParent = createTask({ id: 'op', stage: 1 });
      const newParent = createTask({ id: 'np', stage: 1 });
      const task = createTask({ id: 't1', stage: 2, parentId: 'op' });
      setActiveProject(createProject({ tasks: [oldParent, newParent, task] }));
      mockSubtreeOps().collectSubtreeIds.mockReturnValue(new Set(['t1']));

      const result = await service().moveSubtreeToNewParent('t1', 'np');

      expect(result.ok).toBe(true);
      expect(mockRecorder().recordAndUpdateDurably).toHaveBeenCalledWith(
        expect.any(Function),
        { updateType: 'structure' },
      );
      expect(mockRecorder().recordAndUpdate).not.toHaveBeenCalled();
      expect(mockSubtreeOps().updateSubtreeStages).toHaveBeenCalled();
      expect(mockSubtreeOps().computeNewRankForMigratedTask).toHaveBeenCalled();
      expect(mockSubtreeOps().updateParentChildConnections).toHaveBeenCalled();
    });

    it('新旧父节点相同时直接返回成功', async () => {
      const parent = createTask({ id: 'p', stage: 1 });
      const task = createTask({ id: 't1', stage: 2, parentId: 'p' });
      setActiveProject(createProject({ tasks: [parent, task] }));

      const result = await service().moveSubtreeToNewParent('t1', 'p');

      expect(result.ok).toBe(true);
      expect(recordedMutators()).toHaveLength(0);
    });

    it('检测到循环依赖时返回 LAYOUT_CYCLE_DETECTED', async () => {
      mockLayoutService().detectCycle.mockReturnValue(true);
      const parent = createTask({ id: 'p', stage: 1 });
      const task = createTask({ id: 't1', stage: 2, parentId: null });
      setActiveProject(createProject({ tasks: [parent, task] }));

      const result = await service().moveSubtreeToNewParent('t1', 'p');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.LAYOUT_CYCLE_DETECTED);
      }
    });

    it('没有活动项目时返回 DATA_NOT_FOUND', async () => {
      setActiveProject(null);
      const result = await service().moveSubtreeToNewParent('t1', 'p');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.DATA_NOT_FOUND);
      }
    });

    it('目标任务不存在时返回 DATA_NOT_FOUND', async () => {
      setActiveProject(createProject({ tasks: [] }));
      const result = await service().moveSubtreeToNewParent('missing', 'p');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.DATA_NOT_FOUND);
      }
    });

    it('迁移到 null 父节点（根级）成功', async () => {
      const parent = createTask({ id: 'p', stage: 1 });
      const task = createTask({ id: 't1', stage: 2, parentId: 'p' });
      setActiveProject(createProject({ tasks: [parent, task] }));
      mockSubtreeOps().collectSubtreeIds.mockReturnValue(new Set(['t1']));

      const result = await service().moveSubtreeToNewParent('t1', null);

      expect(result.ok).toBe(true);
      const updated = activeProject()!.tasks.find(candidate => candidate.id === 't1');
      expect(updated?.parentId).toBeNull();
    });

    it('moveSubtreeToNewParentDurably 通过本地持久化路径迁移子树', async () => {
      const oldParent = createTask({ id: 'op', stage: 1 });
      const newParent = createTask({ id: 'np', stage: 1 });
      const task = createTask({ id: 't1', stage: 2, parentId: 'op' });
      setActiveProject(createProject({ tasks: [oldParent, newParent, task] }));
      mockSubtreeOps().collectSubtreeIds.mockReturnValue(new Set(['t1']));

      const result = await service().moveSubtreeToNewParentDurably('t1', 'np');

      expect(result.ok).toBe(true);
      expect(mockRecorder().recordAndUpdateDurably).toHaveBeenCalledWith(
        expect.any(Function),
        { updateType: 'structure' },
      );
      expect(mockRecorder().recordAndUpdate).not.toHaveBeenCalled();
      expect(activeProject()!.tasks.find(candidate => candidate.id === 't1')?.parentId).toBe('np');
    });
  });
}
