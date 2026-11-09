import { beforeEach, expect, it, vi } from 'vitest';

import type { DockSnapshot } from '../models/parking-dock';
import { AuthService } from './auth.service';
import type { DockEngineService } from './dock-engine.service';
import type { DockEngineSpecContext } from './dock-engine.spec-context';
import { DockTaskSyncService } from './dock-task-sync.service';

async function flushDockCompletion(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

export function registerDockEngineConsoleCompletionSpecs(context: DockEngineSpecContext): void {
  let service: DockEngineService;
  let authFence = 'dock-fence-a';
  let auth: {
    currentUserId: { set(value: string | null): void };
    captureAuthIdentityFence: ReturnType<typeof vi.fn>;
  };
  const { seedTask, mockBlackBoxService, mockTaskOps } = context;

  beforeEach(() => {
    service = context.service();
    auth = context.testBed.inject(AuthService) as unknown as typeof auth;
    auth.currentUserId.set('user-1');
    authFence = 'dock-fence-a';
    auth.captureAuthIdentityFence = vi.fn(() => authFence);
  });

  async function createInlineCompletionWithSuccessor(): Promise<string> {
    mockBlackBoxService.createDurably.mockResolvedValueOnce({
      ok: true,
      value: { id: 'bb-inline-sync-failure', content: 'Inline Sync Failure' },
    });
    const inlineTaskId = await service.createInDock('Inline Sync Failure', 'combo-select', 'low');
    if (!inlineTaskId) throw new Error('inline task was not created');
    seedTask('B');
    await service.dockTask('B', 'backup', { zoneSource: 'manual' });
    service.toggleFocusMode();
    return inlineTaskId;
  }

  it('insertToConsoleFromRadar should move a backup task to the front and evict the last non-main visible card', async () => {
    seedTask('A');
    seedTask('B');
    seedTask('C');
    seedTask('D');
    seedTask('E');

    service.restoreSnapshot({
      version: 7,
      entries: [
        {
          taskId: 'A',
          title: 'A',
          sourceProjectId: 'project-1',
          status: 'focusing',
          load: 'low',
          expectedMinutes: 20,
          waitMinutes: null,
          waitStartedAt: null,
          lane: 'combo-select',
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
          status: 'stalled',
          load: 'low',
          expectedMinutes: 15,
          waitMinutes: null,
          waitStartedAt: null,
          lane: 'combo-select',
          zoneSource: 'manual',
          isMain: false,
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
          status: 'stalled',
          load: 'low',
          expectedMinutes: 10,
          waitMinutes: null,
          waitStartedAt: null,
          lane: 'combo-select',
          zoneSource: 'manual',
          isMain: false,
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
          status: 'stalled',
          load: 'low',
          expectedMinutes: 5,
          waitMinutes: null,
          waitStartedAt: null,
          lane: 'combo-select',
          zoneSource: 'manual',
          isMain: false,
          dockedOrder: 3,
          detail: '',
          sourceKind: 'project-task',
          systemSelected: false,
          recommendedScore: null,
        },
        {
          taskId: 'E',
          title: 'E',
          sourceProjectId: 'project-1',
          status: 'pending_start',
          load: 'low',
          expectedMinutes: 8,
          waitMinutes: null,
          waitStartedAt: null,
          lane: 'backup',
          zoneSource: 'manual',
          isMain: false,
          dockedOrder: 4,
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
        focusScrimOn: true,
        mainTaskId: 'A',
        comboSelectIds: ['B', 'C', 'D'],
        backupIds: ['E'],
      },
      firstDragDone: true,
      dailySlots: [],
      suspendChainRootTaskId: null,
      suspendRecommendationLocked: false,
      pendingDecision: null,
      dailyResetDate: '2026-03-12',
      savedAt: new Date().toISOString(),
    });

    expect(service.consoleVisibleEntries().map(entry => entry.taskId)).toEqual(['A', 'B', 'C', 'D']);

    const evictedTaskId = service.insertToConsoleFromRadar('E');

    expect(evictedTaskId).toBe('D');
    expect(service.pendingRadarEviction()).toBe('D');
    expect(service.consoleVisibleEntries().map(entry => entry.taskId)).toEqual(['E', 'A', 'B', 'C']);
    expect(service.statusMachineEntries().map(entry => entry.taskId)).toEqual(['E', 'A', 'B', 'C']);
    expect(service.consoleVisibleEntries()).toHaveLength(4);
    expect(service.statusMachineEntries()).toHaveLength(4);
    expect(service.entries().find(entry => entry.taskId === 'A')?.status).toBe('stalled');
    expect(service.entries().find(entry => entry.taskId === 'E')?.status).toBe('focusing');

    service.flushRadarEviction('D');

    const evicted = service.entries().find(entry => entry.taskId === 'D');
    expect(evicted?.lane).toBe('backup');
    expect(evicted?.status).toBe('pending_start');
    expect(service.pendingRadarEviction()).toBeNull();
  });

  it('insertToConsoleFromRadar should protect a fourth-slot main task and evict the previous non-main card', async () => {
    seedTask('A');
    seedTask('B');
    seedTask('C');
    seedTask('D');
    seedTask('E');

    await service.dockTask('A');
    await service.dockTask('B', 'backup', { zoneSource: 'manual' });
    await service.dockTask('C', 'backup', { zoneSource: 'manual' });
    await service.dockTask('D', 'backup', { zoneSource: 'manual' });
    await service.dockTask('E', 'backup', { zoneSource: 'manual' });
    service.toggleFocusMode();
    service.setMainTask('B');
    service.suspendTask('A', 30);
    service.setMainTask('C');
    service.setMainTask('D');

    expect(service.consoleVisibleEntries().map(entry => entry.taskId)).toEqual(['D', 'C', 'B', 'A']);
    expect(service.entries().find(entry => entry.taskId === 'A')?.isMain).toBe(true);
    expect(service.entries().find(entry => entry.taskId === 'A')?.status).toBe('suspended_waiting');

    const evictedTaskId = service.insertToConsoleFromRadar('E');

    expect(evictedTaskId).toBe('B');
    expect(service.pendingRadarEviction()).toBe('B');
    expect(service.consoleVisibleEntries().map(entry => entry.taskId)).toEqual(['E', 'D', 'C', 'A']);
    expect(service.entries().find(entry => entry.taskId === 'A')?.isMain).toBe(true);
    expect(service.consoleVisibleEntries().at(-1)?.taskId).toBe('A');
  });

  it('main completion should prefer stalled task before fresh recommendation', async () => {
    seedTask('A');
    seedTask('B');
    seedTask('C');
    await service.dockTask('A');
    await service.dockTask('B', 'backup', { zoneSource: 'manual' });
    await service.dockTask('C', 'combo-select', { zoneSource: 'manual' });
    service.toggleFocusMode();
    service.switchToTask('A');
    service.setMainTask('B');
    service.switchToTask('A');

    expect(service.entries().find(entry => entry.taskId === 'B')?.status).toBe('stalled');

    service.completeTask('A');
    await flushDockCompletion();

    expect(service.focusingEntry()?.taskId).toBe('B');
    expect(service.entries().find(entry => entry.taskId === 'B')?.isMain).toBe(true);
  });

  it('completeTask should keep dock state unchanged when local status persistence fails', async () => {
    seedTask('A');
    seedTask('B');
    await service.dockTask('A');
    await service.dockTask('B', 'backup', { zoneSource: 'manual' });
    service.toggleFocusMode();
    service.switchToTask('A');
    mockTaskOps.updateTaskStatus.mockResolvedValueOnce(false);

    service.completeTask('A');
    await Promise.resolve();

    const entry = service.entries().find(item => item.taskId === 'A');
    expect(entry?.status).toBe('focusing');
    expect(entry?.isMain).toBe(true);
    expect(service.focusMode()).toBe(true);
    expect(service.focusingEntry()?.taskId).toBe('A');
    expect(service.entries().find(item => item.taskId === 'B')?.isMain).toBe(false);
  });

  it('completeTask should keep cross-project dock state unchanged when durable outbox enqueue fails', async () => {
    seedTask('A', { projectId: 'project-2' });
    seedTask('B', { projectId: 'project-2' });
    await service.dockTask('A');
    await service.dockTask('B', 'backup', { zoneSource: 'manual' });
    service.toggleFocusMode();
    service.switchToTask('A');
    context.mockActionQueue.enqueueDurablyForOwner.mockClear();
    (context.mockActionQueue.enqueueDurablyForOwner as unknown as {
      mockResolvedValueOnce: (value: string) => unknown;
    }).mockResolvedValueOnce('');

    service.completeTask('A');
    await flushDockCompletion();

    const entry = service.entries().find(item => item.taskId === 'A');
    expect(context.mockActionQueue.enqueueDurablyForOwner).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        type: 'update',
        entityType: 'task',
        entityId: 'A',
      }),
    );
    expect(entry?.status).toBe('focusing');
    expect(entry?.isMain).toBe(true);
    expect(service.focusMode()).toBe(true);
    expect(service.focusingEntry()?.taskId).toBe('A');
    expect(service.entries().find(item => item.taskId === 'B')?.isMain).toBe(false);
  });

  it('main completion should let the current front secondary inherit main ownership before other stalled tasks', async () => {
    seedTask('A');
    seedTask('B');
    seedTask('C');
    await service.dockTask('A');
    await service.dockTask('B', 'backup', { zoneSource: 'manual' });
    await service.dockTask('C', 'combo-select', { zoneSource: 'manual' });
    service.toggleFocusMode();
    service.switchToTask('A');
    service.switchToTask('C');
    service.switchToTask('B');

    expect(service.focusingEntry()?.taskId).toBe('B');
    expect(service.entries().find(entry => entry.taskId === 'C')?.status).toBe('stalled');
    expect(service.entries().find(entry => entry.taskId === 'A')?.isMain).toBe(true);

    service.completeTask('A');
    await flushDockCompletion();

    expect(service.focusingEntry()?.taskId).toBe('B');
    expect(service.entries().find(entry => entry.taskId === 'B')?.isMain).toBe(true);
    expect(service.entries().find(entry => entry.taskId === 'C')?.isMain).toBe(false);
    expect(service.exportSnapshot().session.mainTaskId).toBe('B');
    expect(service.exportSnapshot().focusSessionState?.commandCenterOrderIds?.[0]).toBe('B');
    expect(service.exportSnapshot().focusSessionState?.commandCenterTasks.map(slot => slot.taskId)).toEqual(['B']);
  });

  it('main completion should promote the highest visible C-slot secondary when no task is focused', async () => {
    const makeEntry = (taskId: string, overrides: Partial<DockSnapshot['entries'][number]> = {}) => ({
      taskId,
      title: taskId,
      sourceProjectId: 'project-1',
      status: 'pending_start' as const,
      load: 'low' as const,
      expectedMinutes: 10,
      waitMinutes: null,
      waitStartedAt: null,
      lane: 'combo-select' as const,
      zoneSource: 'manual' as const,
      isMain: false,
      dockedOrder: 0,
      detail: '',
      sourceKind: 'project-task' as const,
      systemSelected: false,
      recommendedScore: null,
      ...overrides,
    });

    service.restoreSnapshot({
      version: 7,
      entries: [
        makeEntry('A', { isMain: true, status: 'focusing', lane: 'combo-select', dockedOrder: 0, manualOrder: 0 }),
        makeEntry('B', { status: 'pending_start', lane: 'combo-select', dockedOrder: 1, manualOrder: 1 }),
        makeEntry('C', { status: 'pending_start', lane: 'combo-select', dockedOrder: 2, manualOrder: 2 }),
        makeEntry('D', { status: 'pending_start', lane: 'backup', dockedOrder: 3, manualOrder: 3 }),
      ],
      focusMode: true,
      isDockExpanded: true,
      muteWaitTone: false,
      session: {
        firstDragIntervened: true,
        focusBlurOn: true,
        focusScrimOn: true,
        mainTaskId: 'A',
        comboSelectIds: ['B', 'C'],
        backupIds: ['D'],
      },
      focusSessionState: {
        schemaVersion: 2,
        sessionId: 'session-1',
        sessionStartedAt: 1710000000000,
        isActive: true,
        isFocusOverlayOn: true,
        commandCenterOrderIds: ['A', 'B', 'C'],
        commandCenterTasks: [],
        comboSelectTasks: [],
        backupTasks: [],
        hasFirstBatchSelected: true,
        routineSlotsShownToday: [],
        highLoadCounter: { count: 0, windowStartAt: 0 },
        burnoutTriggeredAt: null,
      },
      firstDragDone: true,
      dailySlots: [],
      suspendChainRootTaskId: null,
      suspendRecommendationLocked: false,
      pendingDecision: null,
      dailyResetDate: '2026-04-25',
      savedAt: '2026-04-25T08:00:00.000Z',
    });

    service.completeTask('A');
    await flushDockCompletion();

    expect(service.focusingEntry()?.taskId).toBe('B');
    expect(service.entries().find(entry => entry.taskId === 'B')?.isMain).toBe(true);
    expect(service.entries().find(entry => entry.taskId === 'C')?.isMain).toBe(false);
    expect(service.entries().find(entry => entry.taskId === 'D')?.isMain).toBe(false);
    expect(service.exportSnapshot().session.mainTaskId).toBe('B');
  });

  it('main completion should float backup candidates instead of auto-promoting when C slots are empty', async () => {
    seedTask('A');
    seedTask('B');
    seedTask('C');
    seedTask('D');
    await service.dockTask('A');
    await service.dockTask('B', 'backup', { zoneSource: 'manual' });
    await service.dockTask('C', 'backup', { zoneSource: 'manual' });
    await service.dockTask('D', 'backup', { zoneSource: 'manual' });
    service.toggleFocusMode();

    service.completeTask('A');
    await flushDockCompletion();

    expect(service.focusingEntry()).toBeNull();
    expect(service.entries().filter(entry => entry.isMain)).toHaveLength(0);
    expect(service.pendingDecisionEntries().map(entry => entry.taskId)).toEqual(['B', 'C', 'D']);
    expect(service.highlightedIds()).toEqual(new Set(['B', 'C', 'D']));

    service.choosePendingDecisionCandidate('C');

    expect(service.focusingEntry()?.taskId).toBe('C');
    expect(service.entries().find(entry => entry.taskId === 'C')?.isMain).toBe(true);
    expect(service.exportSnapshot().session.mainTaskId).toBe('C');
  });

  it('completeTask should leave focus mode when the final dock task is completed', async () => {
    seedTask('A');
    await service.dockTask('A');
    service.toggleFocusMode();

    service.completeTask('A');
    await flushDockCompletion();

    expect(service.focusMode()).toBe(false);
    expect(service.exportSnapshot().focusMode).toBe(false);
    expect(service.exportSnapshot().focusSessionState).toBeNull();
  });

  it('completeTask should complete the source black-box entry for dock-created tasks before save exit', async () => {
    mockBlackBoxService.createDurably.mockResolvedValueOnce({
      ok: true,
      value: { id: 'bb-inline-completed-before-exit', content: 'Inline Temp' },
    });
    seedTask('A');
    await service.dockTask('A');
    const inlineTaskId = await service.createInDock('Inline Temp', 'backup', 'low');
    expect(inlineTaskId).not.toBeNull();
    service.toggleFocusMode();

    service.completeTask(inlineTaskId!);
    await flushDockCompletion();
    service.markExitAction('save_exit');
    service.toggleFocusMode();

    expect(service.entries().find(entry => entry.taskId === inlineTaskId)?.status).toBe('completed');
    expect(mockBlackBoxService.markAsCompletedDurably).toHaveBeenCalledWith('bb-inline-completed-before-exit');
    expect(mockBlackBoxService.markAsCompleted).not.toHaveBeenCalled();
    expect(mockBlackBoxService.archiveDurably).not.toHaveBeenCalledWith('bb-inline-completed-before-exit');
  });

  it('completeTask should not publish dock completion when inline completion sync returns false', async () => {
    const inlineTaskId = await createInlineCompletionWithSuccessor();
    const taskSync = context.testBed.inject(DockTaskSyncService);
    const syncInlineCompletion = vi.spyOn(taskSync, 'syncInlineCompletion').mockResolvedValueOnce(false);

    service.completeTask(inlineTaskId);
    await flushDockCompletion();

    expect(syncInlineCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: inlineTaskId }),
    );
    expect(service.entries().find(entry => entry.taskId === inlineTaskId)?.status).not.toBe('completed');
    expect(service.focusingEntry()?.taskId).toBe(inlineTaskId);
    expect(service.entries().find(entry => entry.taskId === 'B')?.isMain).toBe(false);
    expect(mockTaskOps.updateTaskStatus).not.toHaveBeenCalled();
  });

  it('completeTask should not publish dock completion when inline completion sync rejects', async () => {
    const inlineTaskId = await createInlineCompletionWithSuccessor();
    const taskSync = context.testBed.inject(DockTaskSyncService);
    const syncInlineCompletion = vi.spyOn(taskSync, 'syncInlineCompletion')
      .mockRejectedValueOnce(new Error('inline completion sync rejected'));

    service.completeTask(inlineTaskId);
    await flushDockCompletion();

    expect(syncInlineCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: inlineTaskId }),
    );
    expect(service.entries().find(entry => entry.taskId === inlineTaskId)?.status).not.toBe('completed');
    expect(service.focusingEntry()?.taskId).toBe(inlineTaskId);
    expect(service.entries().find(entry => entry.taskId === 'B')?.isMain).toBe(false);
    expect(mockTaskOps.updateTaskStatus).not.toHaveBeenCalled();
  });

  it.each([
    { identity: 'A->B', transitions: [['user-b', 'dock-fence-b']] },
    { identity: 'A->B->A', transitions: [['user-b', 'dock-fence-b'], ['user-1', 'dock-fence-a2']] },
    { identity: 'same-owner relogin', transitions: [['user-1', 'dock-fence-a2']] },
  ])('completeTask should not publish stale $identity completion or successor state', async ({ transitions }) => {
    seedTask('A');
    seedTask('B');
    await service.dockTask('A');
    await service.dockTask('B', 'backup', { zoneSource: 'manual' });
    await service.toggleFocusMode();
    await service.switchToTask('A');

    const resolvers: Array<(result: boolean) => void> = [];
    (mockTaskOps.updateTaskStatus as unknown as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(() => new Promise(resolve => resolvers.push(resolve)));

    service.completeTask('A');
    await flushDockCompletion();
    const [resolveStatusUpdate] = resolvers;
    if (!resolveStatusUpdate) throw new Error('task status resolver was not captured');
    for (const [owner, fence] of transitions) {
      auth.currentUserId.set(owner);
      authFence = fence;
    }
    resolveStatusUpdate(true);
    await flushDockCompletion();

    expect(service.entries().find(entry => entry.taskId === 'A')?.status).not.toBe('completed');
    expect(service.focusingEntry()?.taskId).toBe('A');
    expect(service.entries().find(entry => entry.taskId === 'B')?.isMain).toBe(false);
    expect(mockTaskOps.updateTaskStatus).toHaveBeenCalledWith('A', 'completed');
  });

  it('save exit should backfill completed dock-created black-box sources restored from older snapshots', async () => {
    mockBlackBoxService.createDurably.mockResolvedValueOnce({
      ok: true,
      value: { id: 'bb-inline-restored-completed', content: 'Restored Temp' },
    });
    seedTask('A');
    await service.dockTask('A');
    const inlineTaskId = await service.createInDock('Restored Temp', 'backup', 'low');
    expect(inlineTaskId).not.toBeNull();
    service.toggleFocusMode();
    service.entries.update(entries =>
      entries.map(entry =>
        entry.taskId === inlineTaskId
          ? { ...entry, status: 'completed' }
          : entry,
      ),
    );

    service.markExitAction('save_exit');
    service.toggleFocusMode();

    expect(mockBlackBoxService.markAsCompletedDurably).toHaveBeenCalledWith('bb-inline-restored-completed');
    expect(mockBlackBoxService.markAsCompleted).not.toHaveBeenCalled();
  });

  it('clearDockForExit should clear entries but keep exit chrome alive until final cleanup', async () => {
    seedTask('A');
    await service.dockTask('A');
    service.markExitAction('clear_exit');
    service.pendingDecision.set({
      rootTaskId: 'A',
      rootRemainingMinutes: 15,
      candidateGroups: [],
      reason: 'still visible during exit',
      createdAt: new Date().toISOString(),
    });
    service.lastRuleDecision.set({
      type: 'idle_promote',
      reason: 'rule',
      recommendedTaskIds: ['A'],
      createdAt: new Date().toISOString(),
    });
    await service.clearDockForExit();

    expect(service.entries()).toHaveLength(0);
    expect(service.pendingDecision()).toEqual(
      expect.objectContaining({ reason: 'still visible during exit' }),
    );
    await service.finalizeClearDockForExit();
    expect(service.lastRuleDecision()).toBeNull();
  });

  it('reorderDockEntries should persist manualOrder sequence', async () => {
    seedTask('A');
    seedTask('B');
    seedTask('C');
    await service.dockTask('A');
    await service.dockTask('B');
    await service.dockTask('C');

    await expect(service.reorderDockEntries('C', 'B')).resolves.toBe(true);
    const ordered = service.orderedDockEntries().map(entry => entry.taskId);
    expect(ordered).toEqual(['A', 'C', 'B']);
    expect(service.entries().every(entry => entry.manualOrder !== undefined)).toBe(true);
  });

  it('reorderDockEntries should write a recoverable local snapshot before returning success', async () => {
    seedTask('A');
    seedTask('B');
    seedTask('C');
    await service.dockTask('A');
    await service.dockTask('B');
    await service.dockTask('C');

    const result = service.reorderDockEntries('C', 'B');

    const shadow = JSON.parse(
      localStorage.getItem('nanoflow.dock-snapshot.v3.user-1') ?? '{}',
    ) as DockSnapshot;
    expect(
      [...shadow.entries]
        .sort((left, right) => (left.dockedOrder ?? 0) - (right.dockedOrder ?? 0))
        .map(entry => entry.taskId),
    ).toEqual(['A', 'C', 'B']);
    expect([
      shadow.session.mainTaskId,
      ...shadow.session.comboSelectIds,
      ...shadow.session.backupIds,
    ].filter(Boolean)).toEqual(['A', 'C', 'B']);
    expect(service.orderedDockEntries().map(entry => entry.taskId)).toEqual(['A', 'B', 'C']);

    await expect(result).resolves.toBe(true);
    expect(service.orderedDockEntries().map(entry => entry.taskId)).toEqual(['A', 'C', 'B']);
  });
}
