import { describe, expect, it } from 'vitest';
import type { Project, UndoAction } from '../models';
import {
  collectTaskFieldChanges,
  createProjectUndoSnapshot,
  deserializeUndoAction,
  filterRestorableUndoActions,
  filterUndoActionsExcludingTask,
  hasRedoVersionConflict,
  hasProjectTaskSnapshotChanges,
  isUndoActionInvolvingTask,
  limitStackForMax,
  selectUndoActionsForPersistence,
  resolveUndoVersionConflict,
  serializeUndoAction,
} from './undo-history.helpers';

function action(overrides: Partial<UndoAction> = {}): UndoAction {
  return {
    type: 'task-update',
    timestamp: 1,
    projectId: 'project-1',
    projectVersion: 1,
    data: { before: {}, after: {} },
    ...overrides,
  };
}

describe('undo history helpers', () => {
  it('creates project undo snapshots with cloned nested task and connection arrays', () => {
    const project = {
      id: 'project-1',
      name: 'Project',
      description: '',
      createdDate: '2026-01-01T00:00:00.000Z',
      tasks: [{
        id: 'task-1',
        title: 'Task',
        content: 'Content',
        stage: null,
        parentId: null,
        order: 1,
        rank: 1000,
        status: 'active',
        x: 10,
        y: 20,
        createdDate: '2026-01-01T00:00:00.000Z',
        displayId: '1',
        attachments: [{
          id: 'attachment-1',
          type: 'image',
          name: 'image.png',
          url: 'https://example.test/image.png',
          createdAt: '2026-01-01T00:00:00.000Z',
        }],
        deletedConnections: [{
          id: 'connection-1',
          source: 'task-1',
          target: 'task-2',
        }],
        tags: ['focus', 'next'],
      }],
      connections: [{
        id: 'connection-2',
        source: 'task-1',
        target: 'task-3',
      }],
    } as Project;

    const snapshot = createProjectUndoSnapshot(project);

    expect(snapshot).toEqual({
      id: 'project-1',
      tasks: project.tasks,
      connections: project.connections,
    });
    expect(snapshot.tasks).not.toBe(project.tasks);
    expect(snapshot.tasks?.[0]).not.toBe(project.tasks[0]);
    expect(snapshot.tasks?.[0]?.attachments).not.toBe(project.tasks[0].attachments);
    expect(snapshot.tasks?.[0]?.attachments?.[0]).not.toBe(project.tasks[0].attachments?.[0]);
    expect(snapshot.tasks?.[0]?.deletedConnections).not.toBe(project.tasks[0].deletedConnections);
    expect(snapshot.tasks?.[0]?.deletedConnections?.[0]).not.toBe(project.tasks[0].deletedConnections?.[0]);
    expect(snapshot.tasks?.[0]?.tags).not.toBe(project.tasks[0].tags);
    expect(snapshot.connections).not.toBe(project.connections);
    expect(snapshot.connections?.[0]).not.toBe(project.connections[0]);
  });

  it('limits stack to newest actions and reports truncated count', () => {
    const stack = [action({ timestamp: 1 }), action({ timestamp: 2 }), action({ timestamp: 3 })];

    expect(limitStackForMax(stack, 2)).toEqual({
      stack: [stack[1], stack[2]],
      truncatedCount: 1,
    });
  });

  it('returns forceable and hard undo version conflicts using configured tolerance', () => {
    const base = action({ projectVersion: 1 });

    expect(resolveUndoVersionConflict(base, 7)).toEqual({
      type: 'version-mismatch-forceable',
      action: base,
      versionDiff: 6,
    });
    expect(resolveUndoVersionConflict(base, 12)).toBe('version-mismatch');
    expect(hasRedoVersionConflict(base, 7)).toBe(true);
  });

  it('collects task title and content field changes', () => {
    const before: Partial<Project> = {
      tasks: [{ id: 'task-1', title: 'Before', content: 'A' } as Project['tasks'][number]],
    };
    const after: Partial<Project> = {
      tasks: [{ id: 'task-1', title: 'After', content: 'B' } as Project['tasks'][number]],
    };

    expect(collectTaskFieldChanges(after, before)).toEqual({
      'task-1': ['title', 'content'],
    });
  });

  it('detects meaningful batch snapshot task changes', () => {
    const before: Partial<Project> = {
      tasks: [{
        id: 'task-1',
        title: 'Before',
        content: 'A',
        x: 10,
        y: 20,
        stage: 1,
        parentId: null,
        status: 'active',
      } as Project['tasks'][number]],
    };
    const after: Partial<Project> = {
      tasks: [{
        id: 'task-1',
        title: 'After',
        content: 'A',
        x: 10,
        y: 20,
        stage: 1,
        parentId: null,
        status: 'active',
      } as Project['tasks'][number]],
    };

    expect(hasProjectTaskSnapshotChanges(before, after)).toBe(true);
  });

  it('ignores insignificant batch snapshot movement jitter', () => {
    const before: Partial<Project> = {
      tasks: [{ id: 'task-1', x: 10, y: 20 } as Project['tasks'][number]],
    };
    const after: Partial<Project> = {
      tasks: [{ id: 'task-1', x: 10.5, y: 20.5 } as Project['tasks'][number]],
    };

    expect(hasProjectTaskSnapshotChanges(before, after)).toBe(false);
  });

  it('detects batch snapshot task count changes', () => {
    const before: Partial<Project> = {
      tasks: [{ id: 'task-1' } as Project['tasks'][number]],
    };
    const after: Partial<Project> = {
      tasks: [
        { id: 'task-1' } as Project['tasks'][number],
        { id: 'task-2' } as Project['tasks'][number],
      ],
    };

    expect(hasProjectTaskSnapshotChanges(before, after)).toBe(true);
  });

  it('round-trips serializable undo actions and rejects invalid data', () => {
    const original = action();

    expect(deserializeUndoAction(serializeUndoAction(original))).toEqual(original);
    expect(deserializeUndoAction({ type: 'task-update', projectId: 'project-1' })).toBeNull();
  });

  it('selects the newest undo actions within history and persistence limits', () => {
    const stack = [
      action({ timestamp: 1 }),
      action({ timestamp: 2 }),
      action({ timestamp: 3 }),
      action({ timestamp: 4 }),
    ];

    expect(selectUndoActionsForPersistence(stack, {
      historyLimit: 3,
      persistedLimit: 2,
    })).toEqual([stack[2], stack[3]]);
  });

  it('filters persisted undo actions through deserialization before restoring', () => {
    const valid = action({ timestamp: 10 });

    expect(filterRestorableUndoActions([
      serializeUndoAction(valid),
      { type: 'task-update', projectId: 'project-1' },
      null,
    ])).toEqual([valid]);
  });

  it('detects undo actions involving a task in before or after snapshots', () => {
    expect(isUndoActionInvolvingTask(action({
      projectId: 'project-1',
      data: {
        before: { tasks: [{ id: 'task-1' } as Project['tasks'][number]] },
        after: {},
      },
    }), 'project-1', 'task-1')).toBe(true);

    expect(isUndoActionInvolvingTask(action({
      projectId: 'project-1',
      data: {
        before: {},
        after: { tasks: [{ id: 'task-2' } as Project['tasks'][number]] },
      },
    }), 'project-1', 'task-2')).toBe(true);

    expect(isUndoActionInvolvingTask(action({
      projectId: 'other-project',
      data: {
        before: { tasks: [{ id: 'task-1' } as Project['tasks'][number]] },
        after: {},
      },
    }), 'project-1', 'task-1')).toBe(false);
  });

  it('filters only undo actions for the deleted task in the matching project', () => {
    const involving = action({
      timestamp: 1,
      projectId: 'project-1',
      data: {
        before: { tasks: [{ id: 'task-deleted' } as Project['tasks'][number]] },
        after: {},
      },
    });
    const sameProjectOtherTask = action({
      timestamp: 2,
      projectId: 'project-1',
      data: {
        before: { tasks: [{ id: 'task-kept' } as Project['tasks'][number]] },
        after: {},
      },
    });
    const otherProjectInvolving = action({
      timestamp: 3,
      projectId: 'project-2',
      data: {
        before: { tasks: [{ id: 'task-deleted' } as Project['tasks'][number]] },
        after: {},
      },
    });

    expect(filterUndoActionsExcludingTask(
      [involving, sameProjectOtherTask, otherProjectInvolving],
      'task-deleted',
      'project-1',
    )).toEqual([sameProjectOtherTask, otherProjectInvolving]);
  });
});
