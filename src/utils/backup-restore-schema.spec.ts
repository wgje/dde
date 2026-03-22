import { describe, expect, it } from 'vitest';
import { prepareRestoreRows } from './backup-restore-schema';

describe('prepareRestoreRows', () => {
  const backupData = {
    version: '2.0.0',
    type: 'full' as const,
    createdAt: '2026-03-19T00:00:00.000Z',
    payloadVersion: '2.0.0',
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
    userPreferences: [
      {
        id: 'pref-1',
        userId: 'source-user',
        theme: 'forest',
        layoutDirection: 'ltr',
        floatingWindowPref: 'auto',
        colorMode: 'dark',
        autoResolveConflicts: false,
        localBackupEnabled: true,
        localBackupIntervalMs: 600000,
        focusPreferences: { gateEnabled: true },
        createdAt: '2026-03-01T00:00:00.000Z',
        updatedAt: '2026-03-02T00:00:00.000Z',
      },
    ],
    blackBoxEntries: [
      {
        id: 'bb-project',
        projectId: 'project-1',
        userId: 'source-user',
        content: 'Project scoped',
        date: '2026-03-03',
        createdAt: '2026-03-03T00:00:00.000Z',
        updatedAt: '2026-03-03T00:00:00.000Z',
        isRead: false,
        isCompleted: false,
        isArchived: false,
        snoozeUntil: null,
        snoozeCount: 0,
        deletedAt: null,
        focusMeta: { source: 'focus-console-inline' },
      },
      {
        id: 'bb-shared',
        projectId: null,
        userId: 'source-user',
        content: 'Shared',
        date: '2026-03-04',
        createdAt: '2026-03-04T00:00:00.000Z',
        updatedAt: '2026-03-04T00:00:00.000Z',
        isRead: true,
        isCompleted: true,
        isArchived: false,
        snoozeUntil: null,
        snoozeCount: 1,
        deletedAt: null,
      },
    ],
    focusSessions: [
      {
        id: 'focus-1',
        userId: 'source-user',
        startedAt: '2026-03-05T00:00:00.000Z',
        endedAt: null,
        sessionState: { version: 7, mode: 'focus' },
        updatedAt: '2026-03-05T00:10:00.000Z',
      },
    ],
    transcriptionUsage: [
      {
        id: 'usage-1',
        userId: 'source-user',
        date: '2026-03-05',
        audioSeconds: 180,
        createdAt: '2026-03-05T00:00:00.000Z',
      },
    ],
    routineTasks: [
      {
        id: 'routine-1',
        userId: 'source-user',
        title: 'Stretch',
        maxTimesPerDay: 2,
        isEnabled: true,
        createdAt: '2026-03-06T00:00:00.000Z',
        updatedAt: '2026-03-06T00:05:00.000Z',
      },
    ],
    routineCompletions: [
      {
        id: 'routine-completion-1',
        routineId: 'routine-1',
        userId: 'source-user',
        dateKey: '2026-03-06',
        count: 2,
        updatedAt: '2026-03-06T00:06:00.000Z',
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

    expect(rows.userPreferences).toEqual([
      {
        id: 'pref-1',
        user_id: 'target-user',
        theme: 'forest',
        layout_direction: 'ltr',
        floating_window_pref: 'auto',
        color_mode: 'dark',
        auto_resolve_conflicts: false,
        local_backup_enabled: true,
        local_backup_interval_ms: 600000,
        focus_preferences: { gateEnabled: true },
        created_at: '2026-03-01T00:00:00.000Z',
        updated_at: '2026-03-02T00:00:00.000Z',
      },
    ]);

    expect(rows.blackBoxEntries).toHaveLength(2);
    expect(rows.blackBoxEntries[0]).toEqual({
      id: 'bb-project',
      project_id: 'project-1',
      user_id: 'target-user',
      content: 'Project scoped',
      date: '2026-03-03',
      created_at: '2026-03-03T00:00:00.000Z',
      updated_at: '2026-03-03T00:00:00.000Z',
      is_read: false,
      is_completed: false,
      is_archived: false,
      snooze_until: null,
      snooze_count: 0,
      deleted_at: null,
      focus_meta: { source: 'focus-console-inline' },
    });
    expect(rows.focusSessions).toEqual([
      {
        id: 'focus-1',
        user_id: 'target-user',
        started_at: '2026-03-05T00:00:00.000Z',
        ended_at: null,
        session_state: { version: 7, mode: 'focus' },
        updated_at: '2026-03-05T00:10:00.000Z',
      },
    ]);
    expect(rows.transcriptionUsage).toEqual([
      {
        id: 'usage-1',
        user_id: 'target-user',
        date: '2026-03-05',
        audio_seconds: 180,
        created_at: '2026-03-05T00:00:00.000Z',
      },
    ]);
    expect(rows.routineTasks).toEqual([
      {
        id: 'routine-1',
        user_id: 'target-user',
        title: 'Stretch',
        max_times_per_day: 2,
        is_enabled: true,
        created_at: '2026-03-06T00:00:00.000Z',
        updated_at: '2026-03-06T00:05:00.000Z',
      },
    ]);
    expect(rows.routineCompletions).toEqual([
      {
        id: 'routine-completion-1',
        routine_id: 'routine-1',
        user_id: 'target-user',
        date_key: '2026-03-06',
        count: 2,
        updated_at: '2026-03-06T00:06:00.000Z',
      },
    ]);
  });

  it('restricts project restores to project-only preset by default', () => {
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
    expect(rows.blackBoxEntries).toEqual([
      expect.objectContaining({ id: 'bb-project', project_id: 'project-1' }),
    ]);
    expect(rows.userPreferences).toEqual([]);
    expect(rows.focusSessions).toEqual([]);
    expect(rows.transcriptionUsage).toEqual([]);
    expect(rows.routineTasks).toEqual([]);
    expect(rows.routineCompletions).toEqual([]);
  });

  it('can include user-level state when project restore uses the expanded preset', () => {
    const rows = prepareRestoreRows(backupData, 'target-user', {
      scope: 'project',
      projectId: 'project-1',
      preset: 'project_plus_user_state',
    });

    expect(rows.projects).toHaveLength(1);
    expect(rows.blackBoxEntries.map(row => row.id)).toEqual(['bb-project', 'bb-shared']);
    expect(rows.userPreferences).toHaveLength(1);
    expect(rows.focusSessions).toHaveLength(1);
    expect(rows.transcriptionUsage).toHaveLength(1);
    expect(rows.routineTasks).toHaveLength(1);
    expect(rows.routineCompletions).toHaveLength(1);
  });
});
