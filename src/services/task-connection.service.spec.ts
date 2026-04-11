import { Injector } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskConnectionService } from './task-connection.service';
import { LoggerService } from './logger.service';
import { ProjectStateService } from './project-state.service';
import { TaskRecordTrackingService } from './task-record-tracking.service';
import type { Connection, Project } from '../models';

function createProject(connections: Connection[] = []): Project {
  return {
    id: 'proj-1',
    name: 'Project 1',
    description: '',
    createdDate: '2026-04-11T00:00:00.000Z',
    updatedAt: '2026-04-11T00:00:00.000Z',
    tasks: [
      { id: 'task-1' },
      { id: 'task-2' },
      { id: 'task-3' },
      { id: 'task-4' },
    ] as Project['tasks'],
    connections,
  } as Project;
}

describe('TaskConnectionService', () => {
  let service: TaskConnectionService;
  let activeProject: Project;
  let projectState: {
    activeProject: ReturnType<typeof vi.fn>;
    getTask: ReturnType<typeof vi.fn>;
  };
  let recorder: {
    recordAndUpdate: ReturnType<typeof vi.fn>;
    recordAndUpdateDebounced: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    activeProject = createProject();

    projectState = {
      activeProject: vi.fn(() => activeProject),
      getTask: vi.fn((taskId: string) => activeProject.tasks.find(task => task.id === taskId) ?? null),
    };

    recorder = {
      recordAndUpdate: vi.fn((mutator: (project: Project) => Project) => {
        activeProject = mutator(activeProject);
      }),
      recordAndUpdateDebounced: vi.fn((mutator: (project: Project) => Project) => {
        activeProject = mutator(activeProject);
      }),
    };

    const injector = Injector.create({
      providers: [
        { provide: TaskConnectionService, useClass: TaskConnectionService },
        {
          provide: LoggerService,
          useValue: {
            category: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
          },
        },
        { provide: ProjectStateService, useValue: projectState },
        { provide: TaskRecordTrackingService, useValue: recorder },
      ],
    });

    service = injector.get(TaskConnectionService);
  });

  it('addCrossTreeConnection 创建新连接时应写入 updatedAt', () => {
    service.addCrossTreeConnection('task-1', 'task-2');

    expect(activeProject.connections).toHaveLength(1);
    expect(activeProject.connections[0]).toEqual(
      expect.objectContaining({
        source: 'task-1',
        target: 'task-2',
        updatedAt: expect.any(String),
      })
    );
  });

  it('addCrossTreeConnection 遇到软删历史时应保留历史并创建新的活跃连接', () => {
    activeProject = createProject([
      {
        id: 'conn-1',
        source: 'task-1',
        target: 'task-2',
        deletedAt: '2026-04-10T01:00:00.000Z',
        updatedAt: '2026-04-10T00:00:00.000Z',
      },
    ]);

    service.addCrossTreeConnection('task-1', 'task-2');

    expect(activeProject.connections).toHaveLength(2);
    expect(activeProject.connections.find(c => c.id === 'conn-1')).toEqual(
      expect.objectContaining({
        deletedAt: '2026-04-10T01:00:00.000Z',
        updatedAt: '2026-04-10T00:00:00.000Z',
      })
    );
    expect(activeProject.connections.find(c => c.id !== 'conn-1')).toEqual(
      expect.objectContaining({
        source: 'task-1',
        target: 'task-2',
        updatedAt: expect.any(String),
      })
    );
    expect(activeProject.connections.find(c => c.id !== 'conn-1')?.deletedAt).toBeUndefined();
  });

  it('addCrossTreeConnection 恢复前应先校验端点，避免恢复 self-link', () => {
    activeProject = createProject([
      {
        id: 'conn-self-deleted',
        source: 'task-1',
        target: 'task-1',
        deletedAt: '2026-04-10T01:00:00.000Z',
        updatedAt: '2026-04-10T00:00:00.000Z',
      },
    ]);

    service.addCrossTreeConnection('task-1', 'task-1');

    expect(activeProject.connections).toEqual([
      expect.objectContaining({
        id: 'conn-self-deleted',
        deletedAt: '2026-04-10T01:00:00.000Z',
      }),
    ]);
  });

  it('addCrossTreeConnection 不应连接已删除任务', () => {
    activeProject = createProject();
    activeProject.tasks = activeProject.tasks.map(task => (
      task.id === 'task-2'
        ? { ...task, deletedAt: '2026-04-10T01:00:00.000Z' }
        : task
    ));

    service.addCrossTreeConnection('task-1', 'task-2');

    expect(activeProject.connections).toHaveLength(0);
  });

  it('addCrossTreeConnection 遇到同端点 active+deleted 混排时不应误恢复 deleted 记录', () => {
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

    service.addCrossTreeConnection('task-1', 'task-2');

    expect(activeProject.connections).toHaveLength(2);
    expect(activeProject.connections.find(c => c.id === 'conn-deleted')?.deletedAt).toBe('2026-04-10T01:00:00.000Z');
    expect(activeProject.connections.find(c => c.id === 'conn-active')?.deletedAt).toBeUndefined();
  });

  it('addCrossTreeConnection 遇到多条 deleted history 时应创建新的活跃连接且不复活旧记录', () => {
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

    service.addCrossTreeConnection('task-1', 'task-2');

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

  it('removeConnection 软删时应同时刷新 updatedAt', () => {
    activeProject = createProject([
      {
        id: 'conn-1',
        source: 'task-1',
        target: 'task-2',
        updatedAt: '2026-04-10T00:00:00.000Z',
      },
    ]);

    service.removeConnection('task-1', 'task-2');

    expect(activeProject.connections[0].deletedAt).toBeTruthy();
    expect(activeProject.connections[0].updatedAt).toBeTruthy();
    expect(activeProject.connections[0].updatedAt).not.toBe('2026-04-10T00:00:00.000Z');
  });

  it('removeConnection 遇到同端点 active+deleted 混排时只应软删 active 记录', () => {
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

    service.removeConnection('task-1', 'task-2');

    expect(activeProject.connections.find(c => c.id === 'conn-deleted')).toEqual(
      expect.objectContaining({
        deletedAt: '2026-04-10T01:00:00.000Z',
        updatedAt: '2026-04-10T01:00:00.000Z',
      })
    );
    expect(activeProject.connections.find(c => c.id === 'conn-active')?.deletedAt).toBeTruthy();
  });

  it('updateConnectionContent 更新内容时应刷新 updatedAt', () => {
    activeProject = createProject([
      {
        id: 'conn-1',
        source: 'task-1',
        target: 'task-2',
        title: 'Old',
        description: 'Old description',
        updatedAt: '2026-04-10T00:00:00.000Z',
      },
    ]);

    service.updateConnectionContent('task-1', 'task-2', 'New', 'New description');

    expect(activeProject.connections[0]).toEqual(
      expect.objectContaining({
        title: 'New',
        description: 'New description',
        updatedAt: expect.any(String),
      })
    );
    expect(activeProject.connections[0].updatedAt).not.toBe('2026-04-10T00:00:00.000Z');
  });

  it('updateConnectionContent 遇到同端点 active+deleted 混排时只应改 active 记录', () => {
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

    service.updateConnectionContent('task-1', 'task-2', 'New title', 'New description');

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

  it('relinkCrossTreeConnection 应为旧连接删除和新连接创建都写入 updatedAt', () => {
    activeProject = createProject([
      {
        id: 'conn-1',
        source: 'task-1',
        target: 'task-2',
        updatedAt: '2026-04-10T00:00:00.000Z',
      },
    ]);

    service.relinkCrossTreeConnection('task-1', 'task-2', 'task-3', 'task-4');

    const oldConnection = activeProject.connections.find(c => c.source === 'task-1' && c.target === 'task-2');
    const newConnection = activeProject.connections.find(c => c.source === 'task-3' && c.target === 'task-4');

    expect(oldConnection).toEqual(
      expect.objectContaining({
        deletedAt: expect.any(String),
        updatedAt: expect.any(String),
      })
    );
    expect(oldConnection?.updatedAt).not.toBe('2026-04-10T00:00:00.000Z');
    expect(newConnection).toEqual(
      expect.objectContaining({
        updatedAt: expect.any(String),
      })
    );
  });

  it('relinkCrossTreeConnection 指向软删同端点连接时应保留 deleted history 并创建新连接', () => {
    activeProject = createProject([
      {
        id: 'conn-1',
        source: 'task-1',
        target: 'task-2',
        updatedAt: '2026-04-10T00:00:00.000Z',
      },
      {
        id: 'conn-2',
        source: 'task-3',
        target: 'task-4',
        deletedAt: '2026-04-10T01:00:00.000Z',
        updatedAt: '2026-04-10T01:00:00.000Z',
      },
    ]);

    service.relinkCrossTreeConnection('task-1', 'task-2', 'task-3', 'task-4');

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

  it('relinkCrossTreeConnection 在新端点非法时不应删除旧连接或恢复无效目标', () => {
    activeProject = createProject([
      {
        id: 'conn-old',
        source: 'task-1',
        target: 'task-2',
        updatedAt: '2026-04-10T00:00:00.000Z',
      },
      {
        id: 'conn-invalid-deleted',
        source: 'task-3',
        target: 'task-3',
        deletedAt: '2026-04-10T01:00:00.000Z',
        updatedAt: '2026-04-10T01:00:00.000Z',
      },
    ]);

    service.relinkCrossTreeConnection('task-1', 'task-2', 'task-3', 'task-3');

    expect(activeProject.connections.find(c => c.id === 'conn-old')).toEqual(
      expect.objectContaining({
        updatedAt: '2026-04-10T00:00:00.000Z',
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

  it('relinkCrossTreeConnection 不应重连到已删除任务', () => {
    activeProject = createProject([
      {
        id: 'conn-old',
        source: 'task-1',
        target: 'task-2',
        updatedAt: '2026-04-10T00:00:00.000Z',
      },
    ]);
    activeProject.tasks = activeProject.tasks.map(task => (
      task.id === 'task-4'
        ? { ...task, deletedAt: '2026-04-10T01:00:00.000Z' }
        : task
    ));

    service.relinkCrossTreeConnection('task-1', 'task-2', 'task-3', 'task-4');

    expect(activeProject.connections).toEqual([
      expect.objectContaining({
        id: 'conn-old',
        source: 'task-1',
        target: 'task-2',
        updatedAt: '2026-04-10T00:00:00.000Z',
      }),
    ]);
  });
});
