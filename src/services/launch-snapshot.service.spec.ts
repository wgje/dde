import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { LaunchSnapshotService, type LaunchSnapshot } from './launch-snapshot.service';
import type { Project } from '../models';
import { SessionRuntimeResetRegistry } from './session-runtime-reset.service';
import {
  LocalBackupUiRestoreWriterPausedError,
  LocalBackupUiRestoreWriterQuiescenceService,
} from './local-backup-ui-restore-writer-quiescence.service';

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
  let sessionResetCallback: (() => void) | null;
  let mockSessionRuntimeReset: Pick<SessionRuntimeResetRegistry, 'register' | 'resetAll'>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-25T10:00:00.000Z'));
    localStorage.clear();
    sessionResetCallback = null;
    mockSessionRuntimeReset = {
      register: vi.fn((_owner: string, reset: () => void) => {
        sessionResetCallback = reset;
        return vi.fn();
      }),
      resetAll: vi.fn((reason) => {
        sessionResetCallback?.();
        return { ok: true, reason, attemptedOwners: [], failures: [] };
      }),
    };
    TestBed.configureTestingModule({
      providers: [
        LaunchSnapshotService,
        { provide: SessionRuntimeResetRegistry, useValue: mockSessionRuntimeReset },
      ],
    });
    service = TestBed.inject(LaunchSnapshotService);
  });

  afterEach(() => {
    service.flushPendingPersist();
    service.dispose();
    TestBed.resetTestingModule();
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

  it('should register pending owner launch snapshots with restore quiescence and block new owner writes after freeze', async () => {
    vi.useRealTimers();
    const snapshot = service.capture([createProject('project-restore', 'Restore', '2026-03-25T09:00:00.000Z')], {
      userId: 'restore-owner',
      activeProjectId: 'project-restore',
      lastActiveView: 'text',
      theme: 'default',
      colorMode: 'dark',
    });
    const quiescence = new LocalBackupUiRestoreWriterQuiescenceService({ pollIntervalMs: 1 });

    service.schedulePersist(snapshot);
    let prepared = false;
    const preparing = quiescence.prepare('restore-owner').then(handle => {
      prepared = true;
      return handle;
    });

    await new Promise(resolve => setTimeout(resolve, 10));
    expect(prepared).toBe(false);

    const handle = await preparing;
    expect(JSON.parse(localStorage.getItem('nanoflow.launch-snapshot.v2') ?? 'null')).toMatchObject({
      userId: 'restore-owner',
      activeProjectId: 'project-restore',
    });

    expect(() => service.schedulePersist(snapshot)).toThrow(LocalBackupUiRestoreWriterPausedError);
    expect(() => service.schedulePersistDeferred(
      [createProject('project-blocked', 'Blocked', '2026-03-25T09:10:00.000Z')],
      {
        userId: 'restore-owner',
        activeProjectId: 'project-blocked',
        lastActiveView: 'flow',
        theme: 'default',
        colorMode: 'light',
      },
    )).toThrow(LocalBackupUiRestoreWriterPausedError);

    await handle.abortBeforeMutation();
  });

  it('should cancel pending deferred persist without writing snapshot', () => {
    service.schedulePersistDeferred([createProject('project-3', 'Canceled', '2026-03-25T09:30:00.000Z')], {
      activeProjectId: 'project-3',
      lastActiveView: 'text',
      theme: 'default',
      colorMode: 'dark',
    });

    service.cancelPendingPersist();
    service.flushPendingPersist();

    expect(localStorage.getItem('nanoflow.launch-snapshot.v1')).toBeNull();
    expect(localStorage.getItem('nanoflow.launch-snapshot.v2')).toBeNull();
  });

  it('should cancel pending owner snapshot when the session runtime resets', () => {
    service.schedulePersistDeferred([createProject('project-old', 'Old Owner', '2026-03-25T09:30:00.000Z')], {
      userId: 'old-user',
      activeProjectId: 'project-old',
      lastActiveView: 'text',
      theme: 'default',
      colorMode: 'dark',
    });

    mockSessionRuntimeReset.resetAll('owner-change');
    vi.advanceTimersByTime(400);

    expect(localStorage.getItem('nanoflow.launch-snapshot.v1')).toBeNull();
    expect(localStorage.getItem('nanoflow.launch-snapshot.v2')).toBeNull();
  });

  it('should ignore a replaced debounce callback instead of flushing the latest snapshot early', () => {
    vi.useRealTimers();
    const scheduledCallbacks: Array<() => void> = [];
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((handler: TimerHandler) => {
      scheduledCallbacks.push(handler as () => void);
      return scheduledCallbacks.length as unknown as ReturnType<typeof setTimeout>;
    });
    const firstSnapshot = service.capture([createProject('project-first', 'First', '2026-03-25T09:00:00.000Z')], {
      activeProjectId: 'project-first',
      lastActiveView: 'text',
      theme: 'default',
      colorMode: 'light',
    });
    const latestSnapshot = service.capture([createProject('project-latest', 'Latest', '2026-03-25T10:00:00.000Z')], {
      activeProjectId: 'project-latest',
      lastActiveView: 'flow',
      theme: 'default',
      colorMode: 'dark',
    });

    try {
      service.schedulePersist(firstSnapshot);
      service.schedulePersist(latestSnapshot);
      scheduledCallbacks[0]?.();

      expect(localStorage.getItem('nanoflow.launch-snapshot.v2')).toBeNull();

      scheduledCallbacks[1]?.();
      const stored = JSON.parse(localStorage.getItem('nanoflow.launch-snapshot.v2') ?? 'null') as LaunchSnapshot;
      expect(stored.activeProjectId).toBe('project-latest');
    } finally {
      setTimeoutSpy.mockRestore();
    }
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
