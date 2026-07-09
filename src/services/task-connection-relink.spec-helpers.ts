import { expect, it } from 'vitest';

import type { Project } from '../models';
import { createProject, type TaskConnectionServiceSpecContext } from './task-connection.service.spec-helpers';

const BASE_CONNECTION_UPDATED_AT = '2026-04-10T00:00:00.000Z';

export interface TaskConnectionRelinkSpecContext {
  service: TaskConnectionServiceSpecContext['service'];
  recorder: TaskConnectionServiceSpecContext['recorder'];
  getActiveProject(): Project;
  setActiveProject(project: Project): void;
}

export function registerTaskConnectionRelinkSpecs(
  getContext: () => TaskConnectionRelinkSpecContext,
): void {
  it('relinkCrossTreeConnection 应走本地持久化路径并为旧连接删除和新连接创建都写入 updatedAt', async () => {
    const { service, recorder, getActiveProject, setActiveProject } = getContext();
    setActiveProject(createProject([
      {
        id: 'conn-1',
        source: 'task-1',
        target: 'task-2',
        updatedAt: BASE_CONNECTION_UPDATED_AT,
      },
    ]));

    const saved = await service.relinkCrossTreeConnection('task-1', 'task-2', 'task-3', 'task-4');
    const activeProject = getActiveProject();

    expect(saved).toBe(true);
    expect(recorder.recordAndUpdateDurably).toHaveBeenCalledWith(expect.any(Function), {
      updateType: 'structure',
    });
    expect(recorder.recordAndUpdate).not.toHaveBeenCalled();
    const oldConnection = activeProject.connections.find(c => c.source === 'task-1' && c.target === 'task-2');
    const newConnection = activeProject.connections.find(c => c.source === 'task-3' && c.target === 'task-4');

    expect(oldConnection).toEqual(
      expect.objectContaining({
        deletedAt: expect.any(String),
        updatedAt: expect.any(String),
      })
    );
    expect(oldConnection?.updatedAt).not.toBe(BASE_CONNECTION_UPDATED_AT);
    expect(newConnection).toEqual(
      expect.objectContaining({
        updatedAt: expect.any(String),
      })
    );
  });

  it('relinkCrossTreeConnection 默认入口本地持久化失败时不提交 UI 重连', async () => {
    const { service, recorder, getActiveProject, setActiveProject } = getContext();
    setActiveProject(createProject([
      {
        id: 'conn-1',
        source: 'task-1',
        target: 'task-2',
        updatedAt: BASE_CONNECTION_UPDATED_AT,
      },
    ]));
    recorder.recordAndUpdateDurably.mockResolvedValueOnce(false);

    const saved = await service.relinkCrossTreeConnection('task-1', 'task-2', 'task-3', 'task-4');
    const activeProject = getActiveProject();

    expect(saved).toBe(false);
    expect(recorder.recordAndUpdate).not.toHaveBeenCalled();
    expect(activeProject.connections).toEqual([
      expect.objectContaining({
        id: 'conn-1',
        source: 'task-1',
        target: 'task-2',
      }),
    ]);
    expect(activeProject.connections[0].deletedAt).toBeUndefined();
  });

  it('relinkCrossTreeConnectionDurably 应原子持久化旧连接删除和新连接创建', async () => {
    const { service, recorder, getActiveProject, setActiveProject } = getContext();
    setActiveProject(createProject([
      {
        id: 'conn-1',
        source: 'task-1',
        target: 'task-2',
        updatedAt: BASE_CONNECTION_UPDATED_AT,
      },
    ]));

    const saved = await service.relinkCrossTreeConnectionDurably('task-1', 'task-2', 'task-3', 'task-4');
    const activeProject = getActiveProject();

    expect(saved).toBe(true);
    expect(recorder.recordAndUpdateDurably).toHaveBeenCalledWith(expect.any(Function), {
      updateType: 'structure',
    });
    expect(activeProject.connections.find(c => c.id === 'conn-1')?.deletedAt).toBeTruthy();
    expect(activeProject.connections.find(c => c.source === 'task-3' && c.target === 'task-4')).toEqual(
      expect.objectContaining({
        updatedAt: expect.any(String),
      })
    );
  });

  it('relinkCrossTreeConnection 指向软删同端点连接时应保留 deleted history 并创建新连接', async () => {
    const { service, getActiveProject, setActiveProject } = getContext();
    setActiveProject(createProject([
      {
        id: 'conn-1',
        source: 'task-1',
        target: 'task-2',
        updatedAt: BASE_CONNECTION_UPDATED_AT,
      },
      {
        id: 'conn-2',
        source: 'task-3',
        target: 'task-4',
        deletedAt: '2026-04-10T01:00:00.000Z',
        updatedAt: '2026-04-10T01:00:00.000Z',
      },
    ]));

    await service.relinkCrossTreeConnection('task-1', 'task-2', 'task-3', 'task-4');
    const activeProject = getActiveProject();

    expect(activeProject.connections).toHaveLength(3);
    expect(activeProject.connections.find(c => c.id === 'conn-1')).toEqual(
      expect.objectContaining({
        deletedAt: expect.any(String),
      })
    );
    expect(activeProject.connections.find(c => c.id === 'conn-2')).toEqual(
      expect.objectContaining({
        source: 'task-3',
        target: 'task-4',
        deletedAt: '2026-04-10T01:00:00.000Z',
        updatedAt: '2026-04-10T01:00:00.000Z',
      })
    );
    expect(activeProject.connections.find(c => !['conn-1', 'conn-2'].includes(c.id))).toEqual(
      expect.objectContaining({
        source: 'task-3',
        target: 'task-4',
        updatedAt: expect.any(String),
      })
    );
    expect(activeProject.connections.find(c => !['conn-1', 'conn-2'].includes(c.id))?.deletedAt).toBeUndefined();
  });

  it('relinkCrossTreeConnection 指向已有重复 active 目标对时应删除旧对并收口目标对', async () => {
    const { service, getActiveProject, setActiveProject } = getContext();
    setActiveProject(createProject([
      {
        id: 'conn-old',
        source: 'task-1',
        target: 'task-2',
        updatedAt: BASE_CONNECTION_UPDATED_AT,
      },
      {
        id: 'conn-target-a',
        source: 'task-3',
        target: 'task-4',
        updatedAt: '2026-04-10T02:00:00.000Z',
      },
      {
        id: 'conn-target-b',
        source: 'task-3',
        target: 'task-4',
        updatedAt: '2026-04-10T03:00:00.000Z',
      },
    ]));

    await service.relinkCrossTreeConnection('task-1', 'task-2', 'task-3', 'task-4');
    const activeProject = getActiveProject();

    expect(activeProject.connections.find(c => c.id === 'conn-old')).toEqual(
      expect.objectContaining({
        deletedAt: expect.any(String),
      })
    );
    expect(activeProject.connections.find(c => c.id === 'conn-target-a')).toEqual(
      expect.objectContaining({
        deletedAt: expect.any(String),
      })
    );
    expect(activeProject.connections.find(c => c.id === 'conn-target-b')?.deletedAt).toBeUndefined();
  });

  it('relinkCrossTreeConnection 在新端点非法时不应删除旧连接或恢复无效目标', async () => {
    const { service, getActiveProject, setActiveProject } = getContext();
    setActiveProject(createProject([
      {
        id: 'conn-old',
        source: 'task-1',
        target: 'task-2',
        updatedAt: BASE_CONNECTION_UPDATED_AT,
      },
      {
        id: 'conn-invalid-deleted',
        source: 'task-3',
        target: 'task-3',
        deletedAt: '2026-04-10T01:00:00.000Z',
        updatedAt: '2026-04-10T01:00:00.000Z',
      },
    ]));

    const saved = await service.relinkCrossTreeConnection('task-1', 'task-2', 'task-3', 'task-3');
    const activeProject = getActiveProject();

    expect(saved).toBe(false);
    expect(activeProject.connections.find(c => c.id === 'conn-old')).toEqual(
      expect.objectContaining({
        updatedAt: BASE_CONNECTION_UPDATED_AT,
      })
    );
    expect(activeProject.connections.find(c => c.id === 'conn-old')?.deletedAt).toBeUndefined();
    expect(activeProject.connections.find(c => c.id === 'conn-invalid-deleted')).toEqual(
      expect.objectContaining({
        deletedAt: '2026-04-10T01:00:00.000Z',
        updatedAt: '2026-04-10T01:00:00.000Z',
      })
    );
  });

  it('relinkCrossTreeConnection 不应重连到已删除任务', async () => {
    const { service, getActiveProject, setActiveProject } = getContext();
    const project = createProject([
      {
        id: 'conn-old',
        source: 'task-1',
        target: 'task-2',
        updatedAt: BASE_CONNECTION_UPDATED_AT,
      },
    ]);
    project.tasks = project.tasks.map(task => (
      task.id === 'task-4'
        ? { ...task, deletedAt: '2026-04-10T01:00:00.000Z' }
        : task
    ));
    setActiveProject(project);

    const saved = await service.relinkCrossTreeConnection('task-1', 'task-2', 'task-3', 'task-4');
    const activeProject = getActiveProject();

    expect(saved).toBe(false);
    expect(activeProject.connections).toEqual([
      expect.objectContaining({
        id: 'conn-old',
        source: 'task-1',
        target: 'task-2',
        updatedAt: BASE_CONNECTION_UPDATED_AT,
      }),
    ]);
  });

  it('relinkCrossTreeConnection 不应重连到与 parentId 重复的非法端点对', async () => {
    const { service, getActiveProject, setActiveProject } = getContext();
    const project = createProject([
      {
        id: 'conn-old',
        source: 'task-3',
        target: 'task-4',
        updatedAt: BASE_CONNECTION_UPDATED_AT,
      },
    ]);
    project.tasks = project.tasks.map(task => (
      task.id === 'task-2'
        ? { ...task, parentId: 'task-1' }
        : task
    ));
    setActiveProject(project);

    const saved = await service.relinkCrossTreeConnection('task-3', 'task-4', 'task-1', 'task-2');
    const activeProject = getActiveProject();

    expect(saved).toBe(false);
    expect(activeProject.connections).toEqual([
      expect.objectContaining({
        id: 'conn-old',
        source: 'task-3',
        target: 'task-4',
        updatedAt: BASE_CONNECTION_UPDATED_AT,
      }),
    ]);
  });
}
