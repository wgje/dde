import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LaunchSnapshotService, type LaunchSnapshot } from './launch-snapshot.service';
import type { Project } from '../models';

function createProject(id: string, name: string, updatedAt: string, taskCount = 4): Project {
  return {
    id,
    name,
    description: `${name} 描述`,
    createdDate: '2026-03-20T10:00:00.000Z',
    updatedAt,
    tasks: Array.from({ length: taskCount }, (_, index) => ({
      id: `${id}-task-${index + 1}`,
      title: `${name} Task ${index + 1}`,
      content: '不应出现在启动快照中',
      stage: index + 1,
      parentId: null,
      order: index + 1,
      rank: (index + 1) * 1000,
      status: index === taskCount - 1 ? 'completed' : 'active',
      x: 0,
      y: 0,
      createdDate: '2026-03-20T10:00:00.000Z',
      updatedAt,
      displayId: `${index + 1}`,
      attachments: [{ id: 'att-1', type: 'image', name: 'x', url: 'x', createdAt: '2026-03-20T10:00:00.000Z' }],
    })),
    connections: [],
  };
}

describe('LaunchSnapshotService', () => {
  let service: LaunchSnapshotService;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-25T10:00:00.000Z'));
    localStorage.clear();
    service = new LaunchSnapshotService();
  });

  afterEach(() => {
    service.flushPendingPersist();
    service.dispose();
    localStorage.clear();
    vi.useRealTimers();
  });

  it('should capture a trimmed launch snapshot with active project first', () => {
    const snapshot = service.capture(
      [
        createProject('project-1', 'Inbox', '2026-03-25T08:00:00.000Z', 5),
        createProject('project-2', 'Hot Path', '2026-03-25T09:00:00.000Z', 4),
      ],
      {
        userId: 'user-2',
        activeProjectId: 'project-2',
        lastActiveView: 'flow',
        theme: 'ocean',
        colorMode: 'dark',
      },
    );

    expect(snapshot.userId).toBe('user-2');
    expect(snapshot.activeProjectId).toBe('project-2');
    expect(snapshot.lastActiveView).toBe('flow');
    expect(snapshot.projects[0].id).toBe('project-2');
    expect(snapshot.projects[0].recentTasks).toHaveLength(3);
    expect(snapshot.projects[0].openTaskCount).toBe(3);
    expect(snapshot.projects[0].recentTasks[0]).toEqual({
      id: 'project-2-task-1',
      title: 'Hot Path Task 1',
      displayId: '1',
      status: 'active',
    });
  });

  it('should return null for corrupted stored snapshot payloads', () => {
    localStorage.setItem('nanoflow.launch-snapshot.v1', '{broken');

    expect(service.read()).toBeNull();
    expect(localStorage.getItem('nanoflow.launch-snapshot.v1')).toBeNull();
  });

  it('should debounce persisted snapshots until the timer elapses', () => {
    const snapshot = service.capture([createProject('project-1', 'Inbox', '2026-03-25T08:00:00.000Z')], {
      activeProjectId: 'project-1',
      lastActiveView: 'text',
      theme: 'default',
      colorMode: 'light',
    });

    service.schedulePersist(snapshot);

    expect(localStorage.getItem('nanoflow.launch-snapshot.v1')).toBeNull();

    vi.advanceTimersByTime(399);
    expect(localStorage.getItem('nanoflow.launch-snapshot.v1')).toBeNull();

    vi.advanceTimersByTime(1);
    const stored = JSON.parse(localStorage.getItem('nanoflow.launch-snapshot.v1') ?? 'null') as LaunchSnapshot;
    expect(stored.activeProjectId).toBe('project-1');
    expect(stored.projects[0].id).toBe('project-1');
  });

  it('should flush a pending snapshot immediately when requested', () => {
    const snapshot = service.capture([createProject('project-9', 'Launch', '2026-03-25T08:00:00.000Z')], {
      activeProjectId: 'project-9',
      lastActiveView: 'text',
      theme: 'default',
      colorMode: 'light',
    });

    service.schedulePersist(snapshot);
    service.flushPendingPersist();

    const stored = JSON.parse(localStorage.getItem('nanoflow.launch-snapshot.v1') ?? 'null') as LaunchSnapshot;
    expect(stored.activeProjectId).toBe('project-9');
    expect(stored.projects).toHaveLength(1);
  });

  it('should materialize deferred captures before flushing on pagehide/visibility transitions', () => {
    service.schedulePersistDeferred([createProject('project-2', 'Deferred', '2026-03-25T09:00:00.000Z')], {
      activeProjectId: 'project-2',
      lastActiveView: 'text',
      theme: 'default',
      colorMode: 'dark',
    });

    service.flushPendingPersist();

    const stored = JSON.parse(localStorage.getItem('nanoflow.launch-snapshot.v1') ?? 'null') as LaunchSnapshot;
    expect(stored.activeProjectId).toBe('project-2');
    expect(stored.colorMode).toBe('dark');
  });

  it('should prefer v2 payloads over v1 when both snapshots exist', () => {
    localStorage.setItem('nanoflow.launch-snapshot.v1', JSON.stringify({
      version: 1,
      savedAt: '2026-03-25T08:00:00.000Z',
      activeProjectId: 'project-v1',
      lastActiveView: 'text',
      theme: 'default',
      colorMode: 'light',
      projects: [],
    }));
    localStorage.setItem('nanoflow.launch-snapshot.v2', JSON.stringify({
      version: 2,
      savedAt: '2026-03-25T09:00:00.000Z',
      userId: 'user-v2',
      activeProjectId: 'project-v2',
      preferredView: 'flow',
      resolvedLaunchView: 'text',
      routeIntent: { kind: 'task', projectId: 'project-v2', taskId: 'task-9' },
      mobileDegraded: true,
      degradeReason: 'mobile-default-text',
      theme: 'default',
      colorMode: 'dark',
      projects: [],
      currentProject: null,
    }));

    const snapshot = service.read() as LaunchSnapshot & {
      version: 2;
      routeIntent: { kind: string; projectId: string | null; taskId?: string | null };
      resolvedLaunchView: 'text' | 'flow';
      mobileDegraded: boolean;
    };

    expect(snapshot.version).toBe(2);
  expect(snapshot.userId).toBe('user-v2');
    expect(snapshot.activeProjectId).toBe('project-v2');
    expect(snapshot.routeIntent.kind).toBe('task');
    expect(snapshot.resolvedLaunchView).toBe('text');
    expect(snapshot.mobileDegraded).toBe(true);
  });
});
