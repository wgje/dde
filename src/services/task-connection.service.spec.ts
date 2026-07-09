import { beforeEach, describe, expect, it } from 'vitest';
import { TaskConnectionService } from './task-connection.service';
import type { Project } from '../models';
import {
  createProject,
  createTaskConnectionServiceSpecContext,
  type TaskConnectionServiceSpecContext,
} from './task-connection.service.spec-helpers';
import {
  registerTaskConnectionRelinkSpecs,
  type TaskConnectionRelinkSpecContext,
} from './task-connection-relink.spec-helpers';

const BASE_CONNECTION_UPDATED_AT = '2026-04-10T00:00:00.000Z';

describe('TaskConnectionService', () => {
  let service: TaskConnectionService;
  let activeProject: Project;
  let recorder: TaskConnectionServiceSpecContext['recorder'];

  beforeEach(() => {
    activeProject = createProject();
    const context = createTaskConnectionServiceSpecContext({
      getActiveProject: () => activeProject,
      setActiveProject: project => {
        activeProject = project;
      },
    });

    service = context.service;
    recorder = context.recorder;
  });

  function getRelinkSpecContext(): TaskConnectionRelinkSpecContext {
    return {
      service,
      recorder,
      getActiveProject: () => activeProject,
      setActiveProject: project => {
        activeProject = project;
      },
    };
  }

  it('addCrossTreeConnection 创建新连接时应走本地持久化路径并写入 updatedAt', async () => {
    const saved = await service.addCrossTreeConnection('task-1', 'task-2');

    expect(saved).toBe(true);
    expect(recorder.recordAndUpdateDurably).toHaveBeenCalledWith(expect.any(Function), {
      updateType: 'structure',
    });
    expect(recorder.recordAndUpdate).not.toHaveBeenCalled();
    expect(activeProject.connections).toHaveLength(1);
    expect(activeProject.connections[0]).toEqual(expect.objectContaining({
      source: 'task-1',
      target: 'task-2',
      updatedAt: expect.any(String),
    }));
  });

  it('addCrossTreeConnection 默认入口本地持久化失败时不提交 UI 连接', async () => {
    recorder.recordAndUpdateDurably.mockResolvedValueOnce(false);

    const saved = await service.addCrossTreeConnection('task-1', 'task-2');

    expect(saved).toBe(false);
    expect(recorder.recordAndUpdate).not.toHaveBeenCalled();
    expect(activeProject.connections).toHaveLength(0);
  });

  it('addCrossTreeConnectionDurably 创建新连接时应先写入本地持久化队列', async () => {
    const saved = await service.addCrossTreeConnectionDurably('task-1', 'task-2');

    expect(saved).toBe(true);
    expect(recorder.recordAndUpdateDurably).toHaveBeenCalledWith(expect.any(Function), {
      updateType: 'structure',
    });
    expect(recorder.recordAndUpdate).not.toHaveBeenCalled();
    expect(activeProject.connections).toHaveLength(1);
    expect(activeProject.connections[0]).toEqual(expect.objectContaining({
      source: 'task-1',
      target: 'task-2',
      updatedAt: expect.any(String),
    }));
  });

  it('addCrossTreeConnectionDurably 在本地持久化失败时不提交 UI 连接', async () => {
    recorder.recordAndUpdateDurably.mockResolvedValueOnce(false);

    const saved = await service.addCrossTreeConnectionDurably('task-1', 'task-2');

    expect(saved).toBe(false);
    expect(activeProject.connections).toHaveLength(0);
  });

  it('addCrossTreeConnection 遇到软删历史时应保留历史并创建新的活跃连接', async () => {
    activeProject = createProject([
      {
        id: 'conn-1',
        source: 'task-1',
        target: 'task-2',
        deletedAt: '2026-04-10T01:00:00.000Z',
        updatedAt: BASE_CONNECTION_UPDATED_AT,
      },
    ]);

    await service.addCrossTreeConnection('task-1', 'task-2');

    expect(activeProject.connections).toHaveLength(2);
    expect(activeProject.connections.find(c => c.id === 'conn-1')).toEqual(expect.objectContaining({
      deletedAt: '2026-04-10T01:00:00.000Z',
      updatedAt: BASE_CONNECTION_UPDATED_AT,
    }));
    expect(activeProject.connections.find(c => c.id !== 'conn-1')).toEqual(expect.objectContaining({
      source: 'task-1',
      target: 'task-2',
      updatedAt: expect.any(String),
    }));
    expect(activeProject.connections.find(c => c.id !== 'conn-1')?.deletedAt).toBeUndefined();
  });

  it('addCrossTreeConnection 恢复前应先校验端点，避免恢复 self-link', async () => {
    activeProject = createProject([
      {
        id: 'conn-self-deleted',
        source: 'task-1',
        target: 'task-1',
        deletedAt: '2026-04-10T01:00:00.000Z',
        updatedAt: BASE_CONNECTION_UPDATED_AT,
      },
    ]);

    const saved = await service.addCrossTreeConnection('task-1', 'task-1');

    expect(saved).toBe(false);
    expect(activeProject.connections).toEqual([
      expect.objectContaining({
        id: 'conn-self-deleted',
        deletedAt: '2026-04-10T01:00:00.000Z',
      }),
    ]);
  });

  it('addCrossTreeConnection 不应连接已删除任务', async () => {
    activeProject = createProject();
    activeProject.tasks = activeProject.tasks.map(task => (
      task.id === 'task-2'
        ? { ...task, deletedAt: '2026-04-10T01:00:00.000Z' }
        : task
    ));

    const saved = await service.addCrossTreeConnection('task-1', 'task-2');

    expect(saved).toBe(false);
    expect(activeProject.connections).toHaveLength(0);
  });

  it('addCrossTreeConnection 不应创建与 parentId 重复的非法连接', async () => {
    activeProject = createProject();
    activeProject.tasks = activeProject.tasks.map(task => (
      task.id === 'task-2'
        ? { ...task, parentId: 'task-1' }
        : task
    ));

    const saved = await service.addCrossTreeConnection('task-1', 'task-2');

    expect(saved).toBe(false);
    expect(activeProject.connections).toHaveLength(0);
  });

  it('addCrossTreeConnection 遇到同端点 active+deleted 混排时不应误恢复 deleted 记录', async () => {
    activeProject = createProject([
      {
        id: 'conn-deleted',
        source: 'task-1',
        target: 'task-2',
        deletedAt: '2026-04-10T01:00:00.000Z',
        updatedAt: '2026-04-10T01:00:00.000Z',
      },
      {
        id: 'conn-active',
        source: 'task-1',
        target: 'task-2',
        updatedAt: '2026-04-10T02:00:00.000Z',
      },
    ]);

    const saved = await service.addCrossTreeConnection('task-1', 'task-2');

    expect(saved).toBe(true);
    expect(activeProject.connections).toHaveLength(2);
    expect(activeProject.connections.find(c => c.id === 'conn-deleted')?.deletedAt).toBe('2026-04-10T01:00:00.000Z');
    expect(activeProject.connections.find(c => c.id === 'conn-active')?.deletedAt).toBeUndefined();
  });

  it('addCrossTreeConnection 遇到同端点多条 active 记录时应自动收口为单条 active', async () => {
    activeProject = createProject([
      {
        id: 'conn-active-old',
        source: 'task-1',
        target: 'task-2',
        updatedAt: '2026-04-10T01:00:00.000Z',
      },
      {
        id: 'conn-active-new',
        source: 'task-1',
        target: 'task-2',
        updatedAt: '2026-04-10T02:00:00.000Z',
      },
    ]);

    const saved = await service.addCrossTreeConnection('task-1', 'task-2');

    expect(saved).toBe(true);
    expect(activeProject.connections).toHaveLength(2);
    expect(activeProject.connections.find(c => c.id === 'conn-active-old')).toEqual(
      expect.objectContaining({
        deletedAt: expect.any(String),
      })
    );
    expect(activeProject.connections.find(c => c.id === 'conn-active-new')?.deletedAt).toBeUndefined();
  });

  it('addCrossTreeConnection 收口同端点 active 记录时在时间戳相同场景也应稳定保留同一 id', async () => {
    activeProject = createProject([
      {
        id: 'conn-b',
        source: 'task-1',
        target: 'task-2',
        updatedAt: '2026-04-10T02:00:00.000Z',
      },
      {
        id: 'conn-a',
        source: 'task-1',
        target: 'task-2',
        updatedAt: '2026-04-10T02:00:00.000Z',
      },
    ]);

    await service.addCrossTreeConnection('task-1', 'task-2');

    expect(activeProject.connections.find(c => c.id === 'conn-b')?.deletedAt).toBeUndefined();
    expect(activeProject.connections.find(c => c.id === 'conn-a')).toEqual(
      expect.objectContaining({
        deletedAt: expect.any(String),
      })
    );
  });

  it('addCrossTreeConnection 遇到多条 deleted history 时应创建新的活跃连接且不复活旧记录', async () => {
    activeProject = createProject([
      {
        id: 'conn-deleted-old',
        source: 'task-1',
        target: 'task-2',
        deletedAt: '2026-04-10T01:00:00.000Z',
        updatedAt: '2026-04-10T01:00:00.000Z',
      },
      {
        id: 'conn-deleted-new',
        source: 'task-1',
        target: 'task-2',
        deletedAt: '2026-04-10T03:00:00.000Z',
        updatedAt: '2026-04-10T03:00:00.000Z',
      },
    ]);

    await service.addCrossTreeConnection('task-1', 'task-2');

    expect(activeProject.connections).toHaveLength(3);
    expect(activeProject.connections.find(c => c.id === 'conn-deleted-old')).toEqual(
      expect.objectContaining({
        deletedAt: '2026-04-10T01:00:00.000Z',
      })
    );
    expect(activeProject.connections.find(c => c.id === 'conn-deleted-new')).toEqual(
      expect.objectContaining({
        deletedAt: '2026-04-10T03:00:00.000Z',
      })
    );
    expect(activeProject.connections.find(c => !['conn-deleted-old', 'conn-deleted-new'].includes(c.id))).toEqual(
      expect.objectContaining({
        source: 'task-1',
        target: 'task-2',
        updatedAt: expect.any(String),
      })
    );
    expect(activeProject.connections.find(c => !['conn-deleted-old', 'conn-deleted-new'].includes(c.id))?.deletedAt).toBeUndefined();
  });

  it('removeConnection 软删时应走本地持久化路径并刷新 updatedAt', async () => {
    activeProject = createProject([
      {
        id: 'conn-1',
        source: 'task-1',
        target: 'task-2',
        updatedAt: BASE_CONNECTION_UPDATED_AT,
      },
    ]);

    const saved = await service.removeConnection('task-1', 'task-2');

    expect(saved).toBe(true);
    expect(recorder.recordAndUpdateDurably).toHaveBeenCalledWith(expect.any(Function), {
      updateType: 'structure',
    });
    expect(recorder.recordAndUpdate).not.toHaveBeenCalled();
    expect(activeProject.connections[0].deletedAt).toBeTruthy();
    expect(activeProject.connections[0].updatedAt).toBeTruthy();
    expect(activeProject.connections[0].updatedAt).not.toBe(BASE_CONNECTION_UPDATED_AT);
  });

  it('removeConnection 默认入口本地持久化失败时不提交 UI 软删', async () => {
    activeProject = createProject([
      {
        id: 'conn-1',
        source: 'task-1',
        target: 'task-2',
        updatedAt: BASE_CONNECTION_UPDATED_AT,
      },
    ]);
    recorder.recordAndUpdateDurably.mockResolvedValueOnce(false);

    const saved = await service.removeConnection('task-1', 'task-2');

    expect(saved).toBe(false);
    expect(recorder.recordAndUpdate).not.toHaveBeenCalled();
    expect(activeProject.connections[0].deletedAt).toBeUndefined();
  });

  it('removeConnectionDurably 应通过本地持久化路径软删连接', async () => {
    activeProject = createProject([
      {
        id: 'conn-1',
        source: 'task-1',
        target: 'task-2',
        updatedAt: BASE_CONNECTION_UPDATED_AT,
      },
    ]);

    const saved = await service.removeConnectionDurably('task-1', 'task-2');

    expect(saved).toBe(true);
    expect(recorder.recordAndUpdateDurably).toHaveBeenCalledWith(expect.any(Function), {
      updateType: 'structure',
    });
    expect(activeProject.connections[0].deletedAt).toBeTruthy();
  });

  it('removeConnection 遇到同端点 active+deleted 混排时只应软删 active 记录', async () => {
    activeProject = createProject([
      {
        id: 'conn-deleted',
        source: 'task-1',
        target: 'task-2',
        deletedAt: '2026-04-10T01:00:00.000Z',
        updatedAt: '2026-04-10T01:00:00.000Z',
      },
      {
        id: 'conn-active',
        source: 'task-1',
        target: 'task-2',
        updatedAt: '2026-04-10T02:00:00.000Z',
      },
    ]);

    await service.removeConnection('task-1', 'task-2');

    expect(activeProject.connections.find(c => c.id === 'conn-deleted')).toEqual(
      expect.objectContaining({
        deletedAt: '2026-04-10T01:00:00.000Z',
        updatedAt: '2026-04-10T01:00:00.000Z',
      })
    );
    expect(activeProject.connections.find(c => c.id === 'conn-active')?.deletedAt).toBeTruthy();
  });

  it('removeConnection 遇到同端点多条 active 记录时应全部软删，避免幽灵连接回流', async () => {
    activeProject = createProject([
      {
        id: 'conn-active-old',
        source: 'task-1',
        target: 'task-2',
        updatedAt: '2026-04-10T01:00:00.000Z',
      },
      {
        id: 'conn-active-new',
        source: 'task-1',
        target: 'task-2',
        updatedAt: '2026-04-10T02:00:00.000Z',
      },
    ]);

    await service.removeConnection('task-1', 'task-2');

    expect(activeProject.connections.find(c => c.id === 'conn-active-old')?.deletedAt).toBeTruthy();
    expect(activeProject.connections.find(c => c.id === 'conn-active-new')?.deletedAt).toBeTruthy();
  });

  it('updateConnectionContent 更新内容时应走本地持久化路径并刷新 updatedAt', async () => {
    activeProject = createProject([
      {
        id: 'conn-1',
        source: 'task-1',
        target: 'task-2',
        title: 'Old',
        description: 'Old description',
        updatedAt: BASE_CONNECTION_UPDATED_AT,
      },
    ]);

    const saved = await service.updateConnectionContent('task-1', 'task-2', 'New', 'New description');

    expect(saved).toBe(true);
    expect(recorder.recordAndUpdateDurably).toHaveBeenCalledWith(expect.any(Function), {
      updateType: 'structure',
    });
    expect(recorder.recordAndUpdateDebounced).not.toHaveBeenCalled();
    expect(activeProject.connections[0]).toEqual(
      expect.objectContaining({
        title: 'New',
        description: 'New description',
        updatedAt: expect.any(String),
      })
    );
    expect(activeProject.connections[0].updatedAt).not.toBe(BASE_CONNECTION_UPDATED_AT);
  });

  it('updateConnectionContent 默认入口本地持久化失败时不提交 UI 内容变更', async () => {
    activeProject = createProject([
      {
        id: 'conn-1',
        source: 'task-1',
        target: 'task-2',
        title: 'Old',
        description: 'Old description',
        updatedAt: BASE_CONNECTION_UPDATED_AT,
      },
    ]);
    recorder.recordAndUpdateDurably.mockResolvedValueOnce(false);

    const saved = await service.updateConnectionContent('task-1', 'task-2', 'New', 'New description');

    expect(saved).toBe(false);
    expect(recorder.recordAndUpdateDebounced).not.toHaveBeenCalled();
    expect(activeProject.connections[0]).toEqual(
      expect.objectContaining({
        title: 'Old',
        description: 'Old description',
      }),
    );
  });

  it('updateConnectionContentDurably 应通过本地持久化路径更新内容', async () => {
    activeProject = createProject([
      {
        id: 'conn-1',
        source: 'task-1',
        target: 'task-2',
        title: 'Old',
        description: 'Old description',
        updatedAt: BASE_CONNECTION_UPDATED_AT,
      },
    ]);

    const saved = await service.updateConnectionContentDurably(
      'task-1',
      'task-2',
      'New',
      'New description'
    );

    expect(saved).toBe(true);
    expect(recorder.recordAndUpdateDurably).toHaveBeenCalledWith(expect.any(Function), {
      updateType: 'structure',
    });
    expect(recorder.recordAndUpdateDebounced).not.toHaveBeenCalled();
    expect(activeProject.connections[0]).toEqual(
      expect.objectContaining({
        title: 'New',
        description: 'New description',
      })
    );
  });

  it('updateConnectionContent 遇到同端点 active+deleted 混排时只应改 active 记录', async () => {
    activeProject = createProject([
      {
        id: 'conn-deleted',
        source: 'task-1',
        target: 'task-2',
        title: 'Deleted title',
        description: 'Deleted description',
        deletedAt: '2026-04-10T01:00:00.000Z',
        updatedAt: '2026-04-10T01:00:00.000Z',
      },
      {
        id: 'conn-active',
        source: 'task-1',
        target: 'task-2',
        title: 'Active title',
        description: 'Active description',
        updatedAt: '2026-04-10T02:00:00.000Z',
      },
    ]);

    await service.updateConnectionContent('task-1', 'task-2', 'New title', 'New description');

    expect(activeProject.connections.find(c => c.id === 'conn-deleted')).toEqual(
      expect.objectContaining({
        title: 'Deleted title',
        description: 'Deleted description',
        deletedAt: '2026-04-10T01:00:00.000Z',
      })
    );
    expect(activeProject.connections.find(c => c.id === 'conn-active')).toEqual(
      expect.objectContaining({
        title: 'New title',
        description: 'New description',
      })
    );
  });

  it('updateConnectionContent 遇到同端点多条 active 记录时应只保留最新一条为 active', async () => {
    activeProject = createProject([
      {
        id: 'conn-active-old',
        source: 'task-1',
        target: 'task-2',
        title: 'Old title',
        description: 'Old description',
        updatedAt: '2026-04-10T01:00:00.000Z',
      },
      {
        id: 'conn-active-new',
        source: 'task-1',
        target: 'task-2',
        title: 'Newer title',
        description: 'Newer description',
        updatedAt: '2026-04-10T02:00:00.000Z',
      },
    ]);

    await service.updateConnectionContent('task-1', 'task-2', 'Merged title', 'Merged description');

    expect(activeProject.connections.find(c => c.id === 'conn-active-old')).toEqual(
      expect.objectContaining({
        deletedAt: expect.any(String),
      })
    );
    expect(activeProject.connections.find(c => c.id === 'conn-active-new')).toEqual(
      expect.objectContaining({
        title: 'Merged title',
        description: 'Merged description',
      })
    );
    expect(activeProject.connections.find(c => c.id === 'conn-active-new')?.deletedAt).toBeUndefined();
  });

  registerTaskConnectionRelinkSpecs(getRelinkSpecContext);
});
