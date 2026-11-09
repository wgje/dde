import { Injector, runInInjectionContext } from '@angular/core';
import { describe, expect, it } from 'vitest';
import type { Connection, Project, Task } from '../models';
import { ConnectionStore, ProjectStore, TaskStore } from '../app/core/state/stores';
import { LayoutService } from './layout.service';
import { ProjectStateService } from './project-state.service';
import { UiStateService } from './ui-state.service';

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    content: `${id} content`,
    stage: 1,
    parentId: null,
    order: 0,
    rank: 1000,
    status: 'active',
    x: 0,
    y: 0,
    createdDate: '2026-07-15T00:00:00.000Z',
    updatedAt: '2026-07-15T00:00:00.000Z',
    displayId: id,
    ...overrides,
  };
}

function connection(id: string, overrides: Partial<Connection> = {}): Connection {
  return {
    id,
    source: 'task-1',
    target: 'task-2',
    title: id,
    description: '',
    updatedAt: '2026-07-15T00:00:00.000Z',
    ...overrides,
  };
}

function project(
  tasks: Task[],
  connections: Connection[] = [],
  overrides: Partial<Project> = {},
): Project {
  return {
    id: 'project-1',
    name: 'Project',
    description: '',
    createdDate: '2026-07-15T00:00:00.000Z',
    updatedAt: '2026-07-15T00:00:00.000Z',
    tasks,
    connections,
    version: 1,
    ...overrides,
  };
}

interface ProjectStateDataSafetySpecContext {
  service: ProjectStateService;
  taskStore: TaskStore;
  connectionStore: ConnectionStore;
}

function captureState(context: ProjectStateDataSafetySpecContext): object {
  const taskEntries = Array.from(context.taskStore.tasksMap().entries());
  const connectionEntries = Array.from(context.connectionStore.connectionsMap().entries());
  return {
    projects: context.service.getProjectsWithCurrentData(),
    activeProjectId: context.service.activeProjectId(),
    taskEntries,
    taskOwners: taskEntries.map(([taskId]) => [
      taskId,
      context.taskStore.getTaskProjectId(taskId),
    ]),
    parkedTaskIds: Array.from(context.taskStore.parkedTaskIds()),
    connectionEntries,
    connectionOwners: connectionEntries.map(([connectionId]) => [
      connectionId,
      context.connectionStore.getConnectionProjectId(connectionId),
    ]),
  };
}

function createContext(): ProjectStateDataSafetySpecContext {
  const taskStore = new TaskStore();
  const connectionStore = new ConnectionStore();
  const injector = Injector.create({
    providers: [
      { provide: TaskStore, useValue: taskStore },
      { provide: ProjectStore, useValue: new ProjectStore() },
      { provide: ConnectionStore, useValue: connectionStore },
      { provide: LayoutService, useValue: {} },
      { provide: UiStateService, useValue: { filterMode: () => 'all' } },
    ],
  });

  return {
    service: runInInjectionContext(injector, () => new ProjectStateService()),
    taskStore,
    connectionStore,
  };
}

function createService(): ProjectStateService {
  return createContext().service;
}

describe('ProjectStateService data safety', () => {
  it('activeProject and updateProjects must preserve authoritative ConnectionStore data', () => {
    const service = createService();
    service.setProjects([project([], [connection('connection-1', { title: 'Stale shell' })])]);
    service.setActiveProjectId('project-1');

    expect(service.activeProject()?.connections).toHaveLength(1);

    service.updateConnection(connection('connection-1', {
      title: 'Current connection',
      updatedAt: '2026-07-15T00:01:00.000Z',
    }), 'project-1');
    service.updateConnection(connection('connection-2', {
      source: 'task-2',
      target: 'task-1',
      updatedAt: '2026-07-15T00:02:00.000Z',
    }), 'project-1');

    expect(service.activeProject()?.connections).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'connection-1', title: 'Current connection' }),
      expect.objectContaining({ id: 'connection-2' }),
    ]));

    service.updateProjects(projects => projects.map(item => ({ ...item, name: 'Renamed' })));

    expect(service.getProjectWithCurrentData('project-1')?.connections).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'connection-1', title: 'Current connection' }),
      expect.objectContaining({ id: 'connection-2' }),
    ]));
  });

  it('activeProject must expose authoritative TaskStore tasks instead of stale shell tasks', () => {
    const service = createService();
    const staleShellTask = task('task-1', { stage: null, parentId: null, rank: 0 });
    service.setProjects([project([staleShellTask])]);
    service.setActiveProjectId('project-1');

    expect(service.activeProject()?.tasks).toHaveLength(1);

    service.updateTask(task('task-1', {
      stage: 2,
      parentId: 'parent-1',
      rank: 2000,
      updatedAt: '2026-07-15T00:01:00.000Z',
    }), 'project-1');
    service.updateTask(task('task-2', {
      stage: 3,
      parentId: 'task-1',
      rank: 3000,
      updatedAt: '2026-07-15T00:02:00.000Z',
    }), 'project-1');

    const activeProject = service.activeProject();
    expect(activeProject?.tasks.map(item => item.id).sort()).toEqual(['task-1', 'task-2']);
    expect(activeProject?.tasks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'task-1', stage: 2, parentId: 'parent-1', rank: 2000 }),
      expect.objectContaining({ id: 'task-2', stage: 3, parentId: 'task-1', rank: 3000 }),
    ]));
  });

  it('updateProjects must not replay stale project shell tasks over current TaskStore data', () => {
    const service = createService();
    const staleShellTask = task('task-1', { stage: null, parentId: null, rank: 0 });
    service.setProjects([project([staleShellTask])]);
    service.setActiveProjectId('project-1');

    const currentTask = task('task-1', {
      stage: 2,
      parentId: 'parent-1',
      rank: 2000,
      updatedAt: '2026-07-15T00:01:00.000Z',
    });
    const locallyAdded = task('task-2', {
      stage: 3,
      parentId: 'task-1',
      updatedAt: '2026-07-15T00:02:00.000Z',
    });
    service.updateTask(currentTask, 'project-1');
    service.updateTask(locallyAdded, 'project-1');

    service.updateProjects(projects => projects.map(item => ({ ...item, name: 'Renamed' })));

    expect(service.tasks().map(item => item.id).sort()).toEqual(['task-1', 'task-2']);
    expect(service.getTask('task-1')).toMatchObject({
      stage: 2,
      parentId: 'parent-1',
      rank: 2000,
    });
  });

  it('metadata-only project shells must not clear authoritative tasks or connections', () => {
    const service = createService();
    const currentTask = task('task-1', {
      content: 'authoritative content',
      stage: 2,
      parentId: 'parent-1',
    });
    const currentConnection = connection('connection-1');
    service.setProjects([project([currentTask], [currentConnection])]);
    service.setActiveProjectId('project-1');

    service.setProjectsMetadataOnly([{
      ...project([], []),
      name: 'Launch snapshot shell',
      updatedAt: '2026-07-15T00:03:00.000Z',
    }]);

    expect(service.getProject('project-1')?.name).toBe('Launch snapshot shell');
    expect(service.tasks()).toEqual([currentTask]);
    expect(service.activeProject()?.connections).toEqual([currentConnection]);
  });

  it('metadata-only omission clears an inaccessible active project before implicit writes', () => {
    const { service, taskStore } = createContext();
    const retainedOrphan = task('retained-orphan');
    service.setProjects([
      project([retainedOrphan], [], { id: 'project-a' }),
      project([], [], { id: 'project-b' }),
    ]);
    service.setActiveProjectId('project-a');

    service.setProjectsMetadataOnly([
      project([], [], { id: 'project-b' }),
    ]);
    service.updateTask(task('ghost-task'));

    expect(service.activeProjectId()).toBeNull();
    expect(taskStore.getTask('retained-orphan')).toEqual(retainedOrphan);
    expect(taskStore.getTask('ghost-task')).toBeUndefined();
    expect(service.getProjectsWithCurrentData().map(item => item.id)).toEqual(['project-b']);
  });

  it('authoritative replacement clears entities for omitted projects', () => {
    const { service, taskStore, connectionStore } = createContext();
    const parkedTask = task('task-a', {
      parkingMeta: {
        state: 'parked',
        parkedAt: '2026-07-15T00:01:00.000Z',
        lastVisitedAt: '2026-07-15T00:01:00.000Z',
        contextSnapshot: null,
        reminder: null,
        pinned: false,
      },
    });
    const retainedTask = task('task-b', {
      content: 'retained content',
      stage: 3,
      updatedAt: '2026-07-15T00:02:00.000Z',
    });
    const retainedConnection = connection('connection-b', {
      source: 'task-b',
      target: 'task-b',
      title: 'Retained connection',
    });
    service.setProjects([
      project([parkedTask], [connection('connection-a')], { id: 'project-a' }),
      project([retainedTask], [retainedConnection], { id: 'project-b' }),
    ]);

    service.setProjectsMetadataOnly([
      project([], [], { id: 'project-b', name: 'Metadata shell B' }),
    ]);

    expect(taskStore.getTask('task-a')).toEqual(parkedTask);
    expect(connectionStore.getConnection('connection-a')).toBeDefined();
    expect(taskStore.parkedTaskIds().has('task-a')).toBe(true);

    service.setProjects([
      project([retainedTask], [retainedConnection], { id: 'project-b' }),
    ]);

    expect(taskStore.getTask('task-a')).toBeUndefined();
    expect(taskStore.getTaskProjectId('task-a')).toBeNull();
    expect(taskStore.parkedTaskIds().has('task-a')).toBe(false);
    expect(connectionStore.getConnection('connection-a')).toBeUndefined();
    expect(taskStore.getTask('task-b')).toEqual(retainedTask);
    expect(taskStore.getTaskProjectId('task-b')).toBe('project-b');
    expect(connectionStore.getConnection('connection-b')).toEqual(retainedConnection);
  });

  it('authoritative replacement clears an omitted active project before implicit writes', () => {
    const { service, taskStore } = createContext();
    service.setProjects([
      project([], [], { id: 'project-a' }),
      project([], [], { id: 'project-b' }),
    ]);
    service.setActiveProjectId('project-a');

    service.setProjects([
      project([], [], { id: 'project-b' }),
    ]);
    service.updateTask(task('ghost-task'));

    expect(service.activeProjectId()).toBeNull();
    expect(taskStore.getTask('ghost-task')).toBeUndefined();
    expect(taskStore.getTaskProjectId('ghost-task')).toBeNull();
  });

  it('authoritative replacement rejects duplicate task IDs before mutating stores', () => {
    const { service, taskStore } = createContext();
    const existingTask = task('existing-task', { content: 'must survive rejection' });
    service.setProjects([
      project([existingTask], [], { id: 'project-existing' }),
    ]);

    expect(() => service.setProjects([
      project([task('duplicate-task')], [], { id: 'project-a' }),
      project([task('duplicate-task')], [], { id: 'project-b' }),
    ])).toThrow(/duplicate task id/i);

    expect(service.getProjectsWithCurrentData()).toEqual([
      expect.objectContaining({
        id: 'project-existing',
        tasks: [existingTask],
      }),
    ]);
    expect(taskStore.getTask('duplicate-task')).toBeUndefined();
  });

  it('authoritative replacement rejects duplicate project IDs before mutating stores', () => {
    const { service } = createContext();
    const existingTask = task('existing-project-task');
    service.setProjects([
      project([existingTask], [], { id: 'project-existing' }),
    ]);

    expect(() => service.setProjects([
      project([], [], { id: 'duplicate-project', name: 'First' }),
      project([], [], { id: 'duplicate-project', name: 'Second' }),
    ])).toThrow(/duplicate project id/i);

    expect(service.getProjectsWithCurrentData()).toEqual([
      expect.objectContaining({
        id: 'project-existing',
        tasks: [existingTask],
      }),
    ]);
  });

  it('authoritative replacement rejects duplicate connection IDs before mutating stores', () => {
    const { service, connectionStore } = createContext();
    const existingConnection = connection('existing-connection');
    service.setProjects([
      project([], [existingConnection], { id: 'project-existing' }),
    ]);

    expect(() => service.setProjects([
      project([], [connection('duplicate-connection')], { id: 'project-a' }),
      project([], [connection('duplicate-connection')], { id: 'project-b' }),
    ])).toThrow(/duplicate connection id/i);

    expect(service.getProjectsWithCurrentData()).toEqual([
      expect.objectContaining({
        id: 'project-existing',
        connections: [existingConnection],
      }),
    ]);
    expect(connectionStore.getConnection('duplicate-connection')).toBeUndefined();
  });

  it('authoritative replacement rolls back exactly when connection cleanup throws', () => {
    const context = createContext();
    const parkedTask = task('project-a-parked', {
      parkingMeta: {
        state: 'parked',
        parkedAt: '2026-07-26T00:01:00.000Z',
        lastVisitedAt: '2026-07-26T00:01:00.000Z',
        contextSnapshot: null,
        reminder: null,
        pinned: false,
      },
    });
    context.service.setProjects([
      project([parkedTask], [connection('connection-a')], { id: 'project-a' }),
      project([task('task-b')], [connection('connection-b')], { id: 'project-b' }),
    ]);
    context.service.setActiveProjectId('project-a');
    const before = captureState(context);
    vi.spyOn(context.connectionStore, 'clearProjectsExcept')
      .mockImplementationOnce(() => { throw new Error('injected connection cleanup failure'); });

    expect(() => context.service.setProjects([
      project([task('replacement-b')], [], { id: 'project-b' }),
    ])).toThrow('injected connection cleanup failure');

    expect(captureState(context)).toEqual(before);
  });

  it('authoritative replacement rolls back exactly when connection batch write throws', () => {
    const context = createContext();
    context.service.setProjects([
      project([task('task-a')], [connection('connection-a')], { id: 'project-a' }),
      project([task('task-b')], [connection('connection-b')], { id: 'project-b' }),
    ]);
    context.service.setActiveProjectId('project-a');
    const before = captureState(context);
    vi.spyOn(context.connectionStore, 'setConnectionsForMultipleProjects')
      .mockImplementationOnce(() => { throw new Error('injected connection batch failure'); });

    expect(() => context.service.setProjects([
      project([task('replacement-b')], [connection('replacement-connection')], {
        id: 'project-b',
      }),
    ])).toThrow('injected connection batch failure');

    expect(captureState(context)).toEqual(before);
  });
});
