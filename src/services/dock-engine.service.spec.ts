import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DockEngineService } from './dock-engine.service';
import { TaskStore, SimpleSyncService } from '../core-bridge';
import { AuthService } from './auth.service';
import { PreferenceService } from './preference.service';
import { ProjectStateService } from './project-state.service';
import { TaskOperationAdapterService } from './task-operation-adapter.service';
import { LoggerService } from './logger.service';
import { Task } from '../models';

describe('DockEngineService', () => {
  let service: DockEngineService;
  let currentUserId: ReturnType<typeof signal<string | null>>;
  let activeProjectId: ReturnType<typeof signal<string | null>>;

  const taskMap = new Map<string, Task>();
  const taskProjectMap = new Map<string, string>();

  const mockPreferenceService = {
    saveUserPreferences: vi.fn().mockResolvedValue(true),
  };

  const mockSyncService = {
    loadUserPreferences: vi.fn().mockResolvedValue(null),
  };

  const mockTaskOps = {
    updateTaskContent: vi.fn(),
  };

  const mockProjectState = {
    activeProjectId: () => activeProjectId(),
    updateProjects: vi.fn(),
  };

  const mockLogger = {
    category: vi.fn(() => ({
      warn: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    })),
  };

  const mockTaskStore = {
    getTask: vi.fn((id: string) => taskMap.get(id)),
    getTaskProjectId: vi.fn((id: string) => taskProjectMap.get(id) ?? null),
    setTask: vi.fn((task: Task, projectId: string) => {
      taskMap.set(task.id, task);
      taskProjectMap.set(task.id, projectId);
    }),
  };

  const seedTask = (id: string, options?: Partial<Task> & { projectId?: string }): void => {
    const projectId = options?.projectId ?? 'project-1';
    const task: Task = {
      id,
      title: options?.title ?? id,
      content: options?.content ?? '',
      stage: options?.stage ?? null,
      parentId: options?.parentId ?? null,
      order: options?.order ?? 0,
      rank: options?.rank ?? 1,
      status: options?.status ?? 'active',
      x: options?.x ?? 0,
      y: options?.y ?? 0,
      createdDate: options?.createdDate ?? new Date().toISOString(),
      updatedAt: options?.updatedAt,
      displayId: options?.displayId ?? id,
      shortId: options?.shortId,
      hasIncompleteTask: options?.hasIncompleteTask,
      deletedAt: options?.deletedAt ?? null,
      attachments: options?.attachments,
      tags: options?.tags,
      priority: options?.priority,
      dueDate: options?.dueDate,
      parkingMeta: options?.parkingMeta,
    };
    taskMap.set(id, task);
    taskProjectMap.set(id, projectId);
  };

  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    taskMap.clear();
    taskProjectMap.clear();
    currentUserId = signal('user-1');
    activeProjectId = signal('project-1');
    mockPreferenceService.saveUserPreferences.mockClear();
    mockSyncService.loadUserPreferences.mockClear();
    mockTaskOps.updateTaskContent.mockClear();
    mockProjectState.updateProjects.mockClear();

    TestBed.configureTestingModule({
      providers: [
        DockEngineService,
        { provide: TaskStore, useValue: mockTaskStore },
        { provide: PreferenceService, useValue: mockPreferenceService },
        { provide: SimpleSyncService, useValue: mockSyncService },
        { provide: ProjectStateService, useValue: mockProjectState },
        { provide: TaskOperationAdapterService, useValue: mockTaskOps },
        { provide: AuthService, useValue: { currentUserId } },
        { provide: LoggerService, useValue: mockLogger },
      ],
    });

    service = TestBed.inject(DockEngineService);
  });

  afterEach(() => {
    service.ngOnDestroy();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('only first drag auto-sets main task in a focus session', () => {
    seedTask('A');
    seedTask('B');

    service.dockTask('A');
    service.dockTask('B');

    const a = service.entries().find(entry => entry.taskId === 'A');
    const b = service.entries().find(entry => entry.taskId === 'B');
    expect(a?.isMain).toBe(true);
    expect(b?.isMain).toBe(false);
  });

  it('dockTask should reject non-active tasks', () => {
    seedTask('archived-task', { status: 'completed' });
    service.dockTask('archived-task');
    expect(service.entries().length).toBe(0);
  });

  it('first suspend recommends and promotes B to focus slot', () => {
    seedTask('A');
    seedTask('B');
    seedTask('C');

    service.dockTask('A', 'strong', { expectedMinutes: 60, load: 'high', zoneSource: 'manual' });
    service.dockTask('B', 'strong', { expectedMinutes: 20, waitMinutes: 5, load: 'low', zoneSource: 'manual' });
    service.dockTask('C', 'weak', { expectedMinutes: 40, load: 'high', zoneSource: 'manual' });
    service.toggleFocusMode();
    service.switchToTask('A');
    service.suspendTask('A', 30);

    expect(service.focusingEntry()?.taskId).toBe('B');
    const b = service.entries().find(entry => entry.taskId === 'B');
    const c = service.entries().find(entry => entry.taskId === 'C');
    expect(b?.systemSelected).toBe(true);
    expect((b?.recommendedScore ?? 0) > (c?.recommendedScore ?? 0)).toBe(true);
  });

  it('after B completes in mismatch scenario, enters C/D pending decision', () => {
    seedTask('A');
    seedTask('B');
    seedTask('C');
    seedTask('D');

    const waitStartedAt = new Date(Date.now() - 60 * 1000).toISOString();
    service.restoreSnapshot({
      version: 3,
      entries: [
        {
          taskId: 'A',
          title: 'A',
          sourceProjectId: 'project-1',
          status: 'suspended_waiting',
          load: 'high',
          expectedMinutes: 120,
          waitMinutes: 30,
          waitStartedAt,
          zone: 'strong',
          zoneSource: 'manual',
          isMain: true,
          dockedOrder: 0,
          detail: '',
          sourceKind: 'project-task',
          systemSelected: false,
          recommendedScore: null,
        },
        {
          taskId: 'B',
          title: 'B',
          sourceProjectId: 'project-1',
          status: 'focusing',
          load: 'low',
          expectedMinutes: 10,
          waitMinutes: null,
          waitStartedAt: null,
          zone: 'strong',
          zoneSource: 'manual',
          isMain: true,
          dockedOrder: 1,
          detail: '',
          sourceKind: 'project-task',
          systemSelected: false,
          recommendedScore: null,
        },
        {
          taskId: 'C',
          title: 'C',
          sourceProjectId: 'project-1',
          status: 'pending_start',
          load: 'low',
          expectedMinutes: 80,
          waitMinutes: null,
          waitStartedAt: null,
          zone: 'strong',
          zoneSource: 'manual',
          isMain: true,
          dockedOrder: 2,
          detail: '',
          sourceKind: 'project-task',
          systemSelected: false,
          recommendedScore: null,
        },
        {
          taskId: 'D',
          title: 'D',
          sourceProjectId: 'project-1',
          status: 'pending_start',
          load: 'high',
          expectedMinutes: 5,
          waitMinutes: null,
          waitStartedAt: null,
          zone: 'weak',
          zoneSource: 'manual',
          isMain: false,
          dockedOrder: 3,
          detail: '',
          sourceKind: 'project-task',
          systemSelected: false,
          recommendedScore: null,
        },
      ],
      focusMode: true,
      isDockExpanded: true,
      muteWaitTone: false,
      session: {
        firstDragIntervened: true,
        focusBlurOn: true,
        mainTaskId: 'B',
        strongZoneIds: ['D'],
        weakZoneIds: [],
      },
      firstDragDone: true,
      dailySlots: [],
      suspendChainRootTaskId: 'A',
      suspendRecommendationLocked: true,
      pendingDecision: null,
      dailyResetDate: '2026-02-25',
      savedAt: new Date().toISOString(),
    });

    service.completeTask('B');

    const pending = service.pendingDecision();
    expect(pending).not.toBeNull();
    expect(pending?.candidateTaskIds).toContain('C');
    expect(pending?.candidateTaskIds).toContain('D');
    expect(service.highlightedIds().has('C')).toBe(true);
    expect(service.highlightedIds().has('D')).toBe(true);
  });

  it('export snapshot should include v3 fields', () => {
    seedTask('A');
    service.dockTask('A');
    service.setDockExpanded(false);
    service.toggleMuteWaitTone();
    const snapshot = service.exportSnapshot();

    expect(snapshot.version).toBe(3);
    expect(snapshot.focusMode).toBe(false);
    expect(snapshot.isDockExpanded).toBe(false);
    expect(snapshot.muteWaitTone).toBe(true);
    expect(snapshot.session.firstDragIntervened).toBe(true);
    expect(snapshot.session.focusBlurOn).toBe(false);
    expect(snapshot.suspendChainRootTaskId).toBeNull();
    expect(snapshot.suspendRecommendationLocked).toBe(false);
    expect(snapshot.dailyResetDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(snapshot.entries[0]?.zoneSource).toBe('auto');
  });

  it('restoreSnapshot should restore dock expanded and mute preference', () => {
    service.restoreSnapshot({
      version: 3,
      entries: [],
      focusMode: true,
      isDockExpanded: false,
      muteWaitTone: true,
      session: {
        firstDragIntervened: true,
        focusBlurOn: true,
        mainTaskId: null,
        strongZoneIds: [],
        weakZoneIds: [],
      },
      firstDragDone: true,
      dailySlots: [],
      suspendChainRootTaskId: null,
      suspendRecommendationLocked: false,
      pendingDecision: null,
      dailyResetDate: '2026-02-25',
      savedAt: new Date().toISOString(),
    });

    expect(service.focusMode()).toBe(true);
    expect(service.dockExpanded()).toBe(false);
    expect(service.muteWaitTone()).toBe(true);
  });
});
