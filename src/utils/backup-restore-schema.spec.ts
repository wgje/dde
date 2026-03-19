import { describe, expect, it } from 'vitest';
import { prepareRestoreRows } from './backup-restore-schema';

describe('prepareRestoreRows', () => {
  const backupData = {
    version: '1.1.0',
    type: 'full' as const,
    createdAt: '2026-03-19T00:00:00.000Z',
    projects: [
      {
        id: 'project-1',
        userId: 'source-user',
        name: 'Inbox',
        description: 'Primary project',
        createdAt: '2026-03-01T00:00:00.000Z',
        updatedAt: '2026-03-02T00:00:00.000Z',
        version: 7,
      },
      {
        id: 'project-2',
        userId: 'other-user',
        name: 'Ignored',
      },
    ],
    tasks: [
      {
        id: 'task-1',
        projectId: 'project-1',
        title: 'Task A',
        content: 'body',
        parentId: null,
        stage: 1,
        order: 2,
        rank: 3,
        status: 'active',
        x: 10,
        y: 20,
        shortId: 'A1',
        attachments: [],
        tags: ['focus'],
        priority: 'high',
        dueDate: null,
        createdAt: '2026-03-01T00:00:00.000Z',
        updatedAt: '2026-03-02T00:00:00.000Z',
        deletedAt: null,
      },
      {
        id: 'task-2',
        projectId: 'project-2',
        title: 'Ignored task',
      },
    ],
    connections: [
      {
        id: 'conn-1',
        projectId: 'project-1',
        source: 'task-1',
        target: 'task-1',
        title: 'Loop',
        description: 'self',
        createdAt: '2026-03-01T00:00:00.000Z',
        updatedAt: '2026-03-02T00:00:00.000Z',
        deletedAt: null,
      },
      {
        id: 'conn-2',
        projectId: 'project-2',
        source: 'task-2',
        target: 'task-2',
      },
    ],
  };

  it('maps backup data to the live restore schema for full user restores', () => {
    const rows = prepareRestoreRows(backupData, 'target-user', {
      scope: 'all',
    });

    expect(rows.projects).toEqual([
      {
        id: 'project-1',
        owner_id: 'target-user',
        title: 'Inbox',
        description: 'Primary project',
        created_date: '2026-03-01T00:00:00.000Z',
        updated_at: '2026-03-02T00:00:00.000Z',
        version: 7,
      },
      {
        id: 'project-2',
        owner_id: 'target-user',
        title: 'Ignored',
        description: undefined,
        created_date: undefined,
        updated_at: undefined,
        version: undefined,
      },
    ]);

    expect(rows.tasks).toEqual([
      expect.objectContaining({
        id: 'task-1',
        project_id: 'project-1',
        title: 'Task A',
        short_id: 'A1',
        status: 'active',
      }),
      expect.objectContaining({
        id: 'task-2',
        project_id: 'project-2',
        title: 'Ignored task',
      }),
    ]);
    expect(rows.tasks[0]).not.toHaveProperty('display_id');

    expect(rows.connections).toEqual([
      {
        id: 'conn-1',
        project_id: 'project-1',
        source_id: 'task-1',
        target_id: 'task-1',
        title: 'Loop',
        description: 'self',
        created_at: '2026-03-01T00:00:00.000Z',
        updated_at: '2026-03-02T00:00:00.000Z',
        deleted_at: null,
      },
      {
        id: 'conn-2',
        project_id: 'project-2',
        source_id: 'task-2',
        target_id: 'task-2',
        title: undefined,
        description: undefined,
        created_at: undefined,
        updated_at: undefined,
        deleted_at: undefined,
      },
    ]);
  });

  it('restricts restore rows to the requested project scope', () => {
    const rows = prepareRestoreRows(backupData, 'target-user', {
      scope: 'project',
      projectId: 'project-1',
    });

    expect(rows.projects).toHaveLength(1);
    expect(rows.tasks).toHaveLength(1);
    expect(rows.connections).toHaveLength(1);
    expect(rows.projects[0].id).toBe('project-1');
    expect(rows.tasks[0].project_id).toBe('project-1');
    expect(rows.connections[0].project_id).toBe('project-1');
  });
});
