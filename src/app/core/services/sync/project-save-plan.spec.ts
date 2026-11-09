import { describe, expect, it } from 'vitest';
import {
  buildProjectSavePlan,
  buildProjectSavePreparation,
  classifyProjectSaveFailures,
  createProjectSaveSnapshot,
  decideConnectionPushResult,
  decidePositionOnlyTaskPushFailure,
  decideRemoteExistingTaskIdsQueryFailure,
  decideRefreshedProjectSaveSession,
} from './project-save-plan';
import type { Project } from '../../../../models';

describe('project save planning helpers', () => {
  function createProject(overrides: Partial<Project> = {}): Project {
    return {
      id: 'project-1',
      name: 'Project 1',
      description: '',
      createdDate: '2026-03-31T00:00:00.000Z',
      updatedAt: '2026-03-31T00:00:00.000Z',
      version: 1,
      tasks: [],
      connections: [],
      ...overrides,
    };
  }

  it('creates an isolated project save snapshot for mutable task and connection arrays', () => {
    const project = createProject({
      tasks: [{
        id: 'task-1',
        title: 'Task 1',
        content: '',
        stage: 0,
        parentId: null,
        order: 0,
        rank: 0,
        status: 'active',
        x: 0,
        y: 0,
        displayId: '1',
        createdDate: '2026-03-31T00:00:00.000Z',
      }],
      connections: [{
        id: 'connection-1',
        source: 'task-1',
        target: 'task-1',
      }],
    });

    const snapshot = createProjectSaveSnapshot(project);

    expect(snapshot).not.toBe(project);
    expect(snapshot.tasks).not.toBe(project.tasks);
    expect(snapshot.connections).not.toBe(project.connections);
    expect(snapshot.tasks[0]).toEqual(project.tasks[0]);
    expect(snapshot.tasks[0]).not.toBe(project.tasks[0]);
    expect(snapshot.connections[0]).toEqual(project.connections[0]);
    expect(snapshot.connections[0]).not.toBe(project.connections[0]);
  });

  it('builds snapshot, save plan, lookup maps, and changed ID sets together', () => {
    const project = createProject({
      tasks: [
        {
          id: 'task-update',
          title: 'Task Update',
          content: '',
          stage: 0,
          parentId: null,
          order: 0,
          rank: 0,
          status: 'active',
          x: 0,
          y: 0,
          displayId: '1',
          createdDate: '2026-03-31T00:00:00.000Z',
        },
        {
          id: 'task-delete',
          title: 'Task Delete',
          content: '',
          stage: 0,
          parentId: null,
          order: 1,
          rank: 1,
          status: 'active',
          x: 0,
          y: 0,
          displayId: '2',
          createdDate: '2026-03-31T00:00:00.000Z',
        },
      ],
      connections: [
        {
          id: 'connection-update',
          source: 'task-update',
          target: 'task-update',
        },
        {
          id: 'connection-deleted',
          source: 'task-delete',
          target: 'task-update',
          deletedAt: '2026-03-31T01:00:00.000Z',
        },
      ],
    });

    const preparation = buildProjectSavePreparation({
      project,
      changes: {
        tasksToCreate: [{ ...project.tasks[0], id: 'task-create' }],
        tasksToUpdate: [project.tasks[0]],
        taskIdsToDelete: ['task-delete'],
        connectionsToCreate: [{ ...project.connections[0], id: 'connection-create' }],
        connectionsToUpdate: [project.connections[0]],
        connectionsToDelete: [{
          id: 'connection-deleted',
        }],
      },
      pendingTaskIdsToDelete: ['task-delete'],
    });

    expect(preparation.snapshot).not.toBe(project);
    expect(preparation.savePlan.taskUpsertIds).toEqual(['task-update']);
    expect(preparation.savePlan.taskDeleteIds).toEqual(['task-delete']);
    expect(preparation.savePlan.connectionUpsertIds).toEqual(['connection-update']);
    expect(preparation.savePlan.connectionDeleteIds).toEqual(['connection-deleted']);
    expect(preparation.changedTaskIds).toEqual(new Set(['task-create', 'task-update', 'task-delete']));
    expect(preparation.changedConnectionIds).toEqual(new Set([
      'connection-create',
      'connection-update',
      'connection-deleted',
    ]));
    expect(preparation.taskSnapshotById.get('task-update')).toEqual(project.tasks[0]);
    expect(preparation.connectionSnapshotById.get('connection-update')).toEqual(project.connections[0]);
  });

  it('keeps task and connection deletes separate from upserts', () => {
    const plan = buildProjectSavePlan({
      taskIds: ['task-1', 'task-2', 'task-3'],
      connectionIds: ['connection-1', 'connection-2'],
      taskIdsToDelete: ['task-2', 'task-4'],
      connectionIdsToDelete: ['connection-2', 'connection-3'],
    });

    expect(plan).toEqual({
      taskUpsertIds: ['task-1', 'task-3'],
      taskDeleteIds: ['task-2', 'task-4'],
      connectionUpsertIds: ['connection-1'],
      connectionDeleteIds: ['connection-2', 'connection-3'],
    });
  });

  it('classifies failures as fully resolved when every failed entity was handed to retry queue', () => {
    expect(classifyProjectSaveFailures({
      projectId: 'project-1',
      failedTaskIds: ['task-1', 'task-1'],
      failedConnectionIds: ['connection-1'],
      retryEnqueued: ['task:task-1', 'connection:connection-1'],
      terminalTaskIds: [],
      terminalConnectionIds: [],
      projectPushed: true,
    })).toEqual({
      failedTaskIds: ['task-1'],
      failedConnectionIds: ['connection-1'],
      retryEnqueued: ['task:task-1', 'connection:connection-1'],
      hasTerminalConflicts: false,
      fullyResolved: true,
      partialRetryHandoff: false,
      failureReason: 'project batch sync delegated remaining work to retry queue',
    });
  });

  it('classifies missing retry markers as partial handoff', () => {
    expect(classifyProjectSaveFailures({
      projectId: 'project-1',
      failedTaskIds: ['task-1', 'task-2'],
      failedConnectionIds: [],
      retryEnqueued: ['task:task-1'],
      terminalTaskIds: [],
      terminalConnectionIds: [],
      projectPushed: true,
    })).toEqual({
      failedTaskIds: ['task-1', 'task-2'],
      failedConnectionIds: [],
      retryEnqueued: ['task:task-1'],
      hasTerminalConflicts: false,
      fullyResolved: false,
      partialRetryHandoff: true,
      failureReason: 'project batch sync partially delegated; some failures did not enter retry queue',
    });
  });

  it('treats suppressed terminal ids as resolved but terminal', () => {
    expect(classifyProjectSaveFailures({
      projectId: 'project-1',
      failedTaskIds: ['task-terminal'],
      failedConnectionIds: ['connection-terminal'],
      retryEnqueued: [],
      terminalTaskIds: ['task-terminal'],
      terminalConnectionIds: ['connection-terminal'],
      projectPushed: true,
    })).toEqual({
      failedTaskIds: ['task-terminal'],
      failedConnectionIds: ['connection-terminal'],
      retryEnqueued: [],
      hasTerminalConflicts: true,
      fullyResolved: true,
      partialRetryHandoff: false,
      failureReason: 'project batch sync finished with terminal conflicts',
    });
  });

  it('requires either a project push or a project retry marker before failures are fully resolved', () => {
    expect(classifyProjectSaveFailures({
      projectId: 'project-1',
      failedTaskIds: [],
      failedConnectionIds: [],
      retryEnqueued: [],
      terminalTaskIds: [],
      terminalConnectionIds: [],
      projectPushed: false,
    })).toMatchObject({
      fullyResolved: false,
      partialRetryHandoff: true,
      failureReason: 'project batch sync partially delegated; some failures did not enter retry queue',
    });

    expect(classifyProjectSaveFailures({
      projectId: 'project-1',
      failedTaskIds: [],
      failedConnectionIds: [],
      retryEnqueued: ['project:project-1'],
      terminalTaskIds: [],
      terminalConnectionIds: [],
      projectPushed: false,
    })).toMatchObject({
      fullyResolved: true,
      partialRetryHandoff: false,
      failureReason: 'project batch sync delegated remaining work to retry queue',
    });
  });

  it('defers remote task id lookup when query failure happened during browser suspension', () => {
    expect(decideRemoteExistingTaskIdsQueryFailure({
      browserSuspendedError: true,
      browserSuspendedWindow: false,
    })).toEqual({ kind: 'defer-by-suspension' });

    expect(decideRemoteExistingTaskIdsQueryFailure({
      browserSuspendedError: false,
      browserSuspendedWindow: true,
    })).toEqual({ kind: 'defer-by-suspension' });
  });

  it('falls back to local successful task ids for ordinary remote lookup failures', () => {
    expect(decideRemoteExistingTaskIdsQueryFailure({
      browserSuspendedError: false,
      browserSuspendedWindow: false,
    })).toEqual({ kind: 'fallback-local-success-set' });
  });

  it('continues project save after refresh when session owner matches', () => {
    expect(decideRefreshedProjectSaveSession({
      expectedUserId: 'user-a',
      sessionUserId: 'user-a',
      browserSuspendedWindow: false,
    })).toEqual({ kind: 'continue' });
  });

  it('defers refreshed session handling when the browser is suspended and no session is available', () => {
    expect(decideRefreshedProjectSaveSession({
      expectedUserId: 'user-a',
      sessionUserId: null,
      browserSuspendedWindow: true,
    })).toEqual({ kind: 'defer-by-suspension' });
  });

  it('expires refreshed session handling when no session is available outside suspension', () => {
    expect(decideRefreshedProjectSaveSession({
      expectedUserId: 'user-a',
      sessionUserId: null,
      browserSuspendedWindow: false,
    })).toEqual({ kind: 'session-expired' });
  });

  it('rejects refreshed session handling when owner does not match', () => {
    expect(decideRefreshedProjectSaveSession({
      expectedUserId: 'user-a',
      sessionUserId: 'user-b',
      browserSuspendedWindow: false,
    })).toEqual({ kind: 'owner-mismatch' });
  });

  it('skips full task upsert fallback when position-only push fails during browser suspension', () => {
    expect(decidePositionOnlyTaskPushFailure({
      browserSuspendedWindow: true,
    })).toEqual({ kind: 'defer-by-suspension' });
  });

  it('falls back to full task upsert when position-only push fails outside browser suspension', () => {
    expect(decidePositionOnlyTaskPushFailure({
      browserSuspendedWindow: false,
    })).toEqual({ kind: 'fallback-full-upsert' });
  });

  it('clears connection dirty state after a successful project save connection push', () => {
    expect(decideConnectionPushResult({
      success: true,
      retryEnqueued: false,
    })).toEqual({ kind: 'clear-success' });
  });

  it('records connection failure and retry marker when project save connection push enqueued retry', () => {
    expect(decideConnectionPushResult({
      success: false,
      retryEnqueued: true,
    })).toEqual({ kind: 'record-failure', retryEnqueued: true });
  });

  it('records connection failure without retry marker when project save connection push did not enqueue retry', () => {
    expect(decideConnectionPushResult({
      success: false,
      retryEnqueued: false,
    })).toEqual({ kind: 'record-failure', retryEnqueued: false });
  });
});
