import { beforeEach, expect, it, describe, vi } from 'vitest';

import type { DockSnapshot, FocusTaskSlot } from '../models/parking-dock';
import { DockDailySlotService } from './dock-daily-slot.service';
import type { DockEngineService } from './dock-engine.service';
import type { DockEngineSpecContext } from './dock-engine.spec-context';

async function flushDockCompletion(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

export function registerDockEngineRoutineLifecycleSpecs(context: DockEngineSpecContext): void {
  let service: DockEngineService;
  const {
    seedTask,
    taskMap,
    taskProjectMap,
    mockActionQueue,
    mockFocusPreferenceService,
    mockTaskOps,
    mockTaskStore,
    mockToast,
    testBed: TestBed,
  } = context;

  beforeEach(() => {
    service = context.service();
  });

  it('restoreSnapshot should hydrate remote C-slot order into project and exported session state', async () => {
    seedTask('A');
    seedTask('B');
    seedTask('C');
    seedTask('D');

    const makeEntry = (taskId: string, dockedOrder: number, overrides: Partial<DockSnapshot['entries'][number]> = {}) => ({
      taskId,
      title: taskId,
      sourceProjectId: 'project-1',
      status: 'stalled' as const,
      load: 'low' as const,
      expectedMinutes: 10,
      waitMinutes: null,
      waitStartedAt: null,
      lane: 'combo-select' as const,
      zoneSource: 'manual' as const,
      isMain: false,
      dockedOrder,
      detail: '',
      sourceKind: 'project-task' as const,
      systemSelected: false,
      recommendedScore: null,
      ...overrides,
    });

    service.restoreSnapshot({
      version: 7,
      entries: [
        makeEntry('A', 0, { isMain: true, status: 'focusing' }),
        makeEntry('B', 1),
        makeEntry('C', 2),
        makeEntry('D', 3),
      ],
      focusMode: true,
      isDockExpanded: true,
      muteWaitTone: false,
      session: {
        firstDragIntervened: true,
        focusBlurOn: true,
        focusScrimOn: true,
        mainTaskId: 'A',
        comboSelectIds: ['D', 'B', 'C'],
        backupIds: [],
      },
      firstDragDone: true,
      dailySlots: [],
      suspendChainRootTaskId: null,
      suspendRecommendationLocked: false,
      pendingDecision: null,
      dailyResetDate: '2026-04-24',
      savedAt: '2026-04-24T08:00:00.000Z',
    });

    expect(service.consoleVisibleEntries().map(entry => entry.taskId)).toEqual(['A', 'D', 'B', 'C']);
    expect(service.entries().map(entry => entry.taskId)).toEqual(['A', 'D', 'B', 'C']);
    expect(service.exportSnapshot().session.comboSelectIds).toEqual(['D', 'B', 'C']);
    expect(service.exportSnapshot().focusSessionState?.comboSelectTasks.map(slot => slot.taskId)).toEqual(['D', 'B', 'C']);
  });

  it('restoreSnapshot should keep widget-promoted secondary C-slot ahead of the master task', async () => {
    seedTask('main');
    seedTask('a');
    seedTask('b');
    seedTask('c');

    const makeFocusSlot = (
      taskId: string,
      zone: FocusTaskSlot['zone'],
      zoneIndex: number,
      isMaster: boolean,
      focusStatus: FocusTaskSlot['focusStatus'],
    ): FocusTaskSlot => ({
      slotId: taskId,
      taskId,
      estimatedMinutes: 10,
      waitMinutes: null,
      cognitiveLoad: 'low',
      focusStatus,
      zone,
      zoneIndex,
      isMaster,
      waitStartedAt: null,
      waitEndAt: null,
      sourceProjectId: 'project-1',
      sourceBlockType: null,
      draggedInAt: 1710000000000,
      isFirstBatch: false,
      inlineTitle: taskId,
      inlineDetail: null,
    });

    const makeEntry = (taskId: string, dockedOrder: number, overrides: Partial<DockSnapshot['entries'][number]> = {}) => ({
      taskId,
      title: taskId,
      sourceProjectId: 'project-1',
      status: 'stalled' as const,
      load: 'low' as const,
      expectedMinutes: 10,
      waitMinutes: null,
      waitStartedAt: null,
      lane: 'combo-select' as const,
      zoneSource: 'manual' as const,
      isMain: false,
      dockedOrder,
      manualOrder: dockedOrder,
      detail: '',
      sourceKind: 'project-task' as const,
      systemSelected: false,
      recommendedScore: null,
      ...overrides,
    });

    service.restoreSnapshot({
      version: 7,
      entries: [
        makeEntry('main', 1, { isMain: true }),
        makeEntry('a', 0, { status: 'focusing' }),
        makeEntry('b', 2),
        makeEntry('c', 3),
      ],
      focusMode: true,
      isDockExpanded: true,
      muteWaitTone: false,
      session: {
        firstDragIntervened: true,
        focusBlurOn: true,
        focusScrimOn: true,
        mainTaskId: 'main',
        comboSelectIds: ['a', 'b', 'c'],
        backupIds: [],
      },
      focusSessionState: {
        schemaVersion: 2,
        sessionId: 'session-1',
        sessionStartedAt: 1710000000000,
        isActive: true,
        isFocusOverlayOn: true,
        commandCenterOrderIds: ['a', 'main', 'b', 'c'],
        commandCenterTasks: [
          makeFocusSlot('main', 'command', 0, true, 'pending'),
        ],
        comboSelectTasks: [
          makeFocusSlot('a', 'combo-select', 0, false, 'focusing'),
          makeFocusSlot('b', 'combo-select', 1, false, 'pending'),
          makeFocusSlot('c', 'combo-select', 2, false, 'pending'),
        ],
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
      dailyResetDate: '2026-04-26',
      savedAt: '2026-04-26T08:00:00.000Z',
    });

    expect(service.entries().map(entry => entry.taskId)).toEqual(['a', 'main', 'b', 'c']);
    expect(service.entries().map(entry => entry.manualOrder)).toEqual([0, 1, 2, 3]);
    expect(service.consoleVisibleEntries().map(entry => entry.taskId)).toEqual(['a', 'main', 'b', 'c']);
    expect(service.exportSnapshot().focusSessionState?.commandCenterOrderIds).toEqual(['a', 'main', 'b', 'c']);
  });

  it('dock capacity should warn at soft limit and reject at hard limit', async () => {
    for (let i = 0; i < 15; i += 1) {
      const id = `soft-${i}`;
      seedTask(id);
      expect(await service.dockTask(id)).toBe(true);
    }

    expect(mockToast.info).toHaveBeenCalledTimes(1);
    expect(service.dockCapacity().softReached).toBe(true);

    for (let i = 15; i < 30; i += 1) {
      const id = `hard-${i}`;
      seedTask(id);
      expect(await service.dockTask(id)).toBe(true);
    }

    seedTask('overflow-task');
    expect(await service.dockTask('overflow-task')).toBe(false);
    expect(service.entries().some(entry => entry.taskId === 'overflow-task')).toBe(false);
    expect(mockToast.warning).toHaveBeenCalled();
    expect(service.dockCapacity().hardReached).toBe(true);
  });

  it('dockedTaskIds should expose active dock membership', async () => {
    seedTask('A');
    seedTask('B');
    await service.dockTask('A');
    await service.dockTask('B');

    const dockedIds = service.dockedTaskIds();
    expect(dockedIds.has('A')).toBe(true);
    expect(dockedIds.has('B')).toBe(true);

    service.completeTask('A');
    await flushDockCompletion();
    expect(service.dockedTaskIds().has('A')).toBe(false);
    expect(service.dockedTaskIds().has('B')).toBe(true);
  });

  it('external task completion should reconcile dock entry out of active pool', async () => {
    seedTask('A');
    await service.dockTask('A');

    mockTaskStore.setTask(
      {
        ...taskMap.get('A')!,
        status: 'completed',
        updatedAt: new Date().toISOString(),
      },
      'project-1',
    );
    TestBed.flushEffects();
    await Promise.resolve();
    await Promise.resolve();
    TestBed.flushEffects();

    expect(service.entries().find(entry => entry.taskId === 'A')?.status).toBe('completed');
    expect(service.dockedTaskIds().has('A')).toBe(false);
  });

  it('completeTask should fall back to the active project when task store mapping is missing', async () => {
    seedTask('project-fallback', { projectId: 'project-1' });
    taskProjectMap.delete('project-fallback');

    await service.dockTask('project-fallback', 'backup', { zoneSource: 'manual' });
    service.completeTask('project-fallback');

    expect(mockTaskOps.updateTaskStatus).toHaveBeenCalledWith('project-fallback', 'completed');
    expect(mockTaskStore.setTask).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: 'project-fallback', status: 'completed' }),
      'project-1',
    );
  });

  it('todayDateKey should honor routine reset hour preference', async () => {
    mockFocusPreferenceService.update({ routineResetHourLocal: 5 });

    const dailySlot = TestBed.inject<DockDailySlotService>(DockDailySlotService);
    expect(dailySlot.todayDateKey(new Date('2026-03-06T04:59:00'))).toBe('2026-03-05');
    expect(dailySlot.todayDateKey(new Date('2026-03-06T05:00:00'))).toBe('2026-03-06');
  });

  it('completeDailySlot should enqueue UUID-based routine completion mutation', async () => {
    const slotId = await service.dailySlotService.addDailySlot('Daily Task', 1);
    mockActionQueue.enqueueDurablyForOwner.mockClear();

    await service.dailySlotService.completeDailySlot(slotId);

    expect(mockActionQueue.enqueueDurablyForOwner).toHaveBeenCalledTimes(1);
    const firstCall = mockActionQueue.enqueueDurablyForOwner.mock.calls.at(0) as [
      string,
      {
        entityType: string;
        payload: {
          completion: {
            userId: string;
            routineId: string;
            completionId: string;
          };
        };
      },
    ] | undefined;
    expect(firstCall).toBeDefined();
    expect(firstCall?.[0]).toBe('user-1');
    const payload = firstCall?.[1];
    if (!payload) {
      throw new Error('Expected action queue payload to be present');
    }
    expect(payload.entityType).toBe('routine-completion');
    expect(payload.payload.completion.userId).toBe('user-1');
    expect(payload.payload.completion.routineId).toBe(slotId);
    expect(payload.payload.completion.completionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it('daily slot mutations should write recoverable local snapshots before returning success', async () => {
    const slotId = await service.dailySlotService.addDailySlot('Daily Task', 2);

    let shadow = JSON.parse(
      localStorage.getItem('nanoflow.dock-snapshot.v3.user-1') ?? '{}',
    ) as DockSnapshot;
    expect(shadow.dailySlots).toHaveLength(1);
    expect(shadow.dailySlots[0]?.id).toBe(slotId);
    expect(shadow.dailySlots[0]?.title).toBe('Daily Task');

    await expect(service.dailySlotService.completeDailySlot(slotId)).resolves.toBe(true);
    shadow = JSON.parse(
      localStorage.getItem('nanoflow.dock-snapshot.v3.user-1') ?? '{}',
    ) as DockSnapshot;
    expect(shadow.dailySlots[0]?.todayCompletedCount).toBe(1);

    await expect(service.dailySlotService.skipDailySlot(slotId)).resolves.toBe(true);
    shadow = JSON.parse(
      localStorage.getItem('nanoflow.dock-snapshot.v3.user-1') ?? '{}',
    ) as DockSnapshot;
    expect(shadow.dailySlots[0]?.todayCompletedCount).toBe(2);

    await expect(service.dailySlotService.removeDailySlot(slotId)).resolves.toBe(true);
    shadow = JSON.parse(
      localStorage.getItem('nanoflow.dock-snapshot.v3.user-1') ?? '{}',
    ) as DockSnapshot;
    expect(shadow.dailySlots).toEqual([]);
  });

  it('clearDockForExit and finalizeClearDockForExit should persist the cleared snapshot before returning success', async () => {
    seedTask('A');
    await service.dockTask('A');
    await service.dailySlotService.addDailySlot('Daily Task', 1);

    await expect(service.clearDockForExit()).resolves.toBe(true);
    let shadow = JSON.parse(
      localStorage.getItem('nanoflow.dock-snapshot.v3.user-1') ?? '{}',
    ) as DockSnapshot;
    expect(shadow.entries).toEqual([]);
    expect(shadow.dailySlots).toHaveLength(1);

    await expect(service.finalizeClearDockForExit()).resolves.toBe(true);
    shadow = JSON.parse(
      localStorage.getItem('nanoflow.dock-snapshot.v3.user-1') ?? '{}',
    ) as DockSnapshot;
    expect(shadow.entries).toEqual([]);
    expect(shadow.dailySlots).toEqual([]);
    expect(shadow.lastRuleDecision).toBeNull();
  });

  it('focus transition helpers should set and clear transition state', async () => {
    service.beginFocusTransition({
      phase: 'entering',
      direction: 'enter',
      fromRect: { left: 1, top: 2, width: 100, height: 60 },
      toRect: { left: 10, top: 20, width: 200, height: 120 },
      durationMs: 550,
      startedAt: new Date().toISOString(),
    });

    expect(service.focusTransition()?.phase).toBe('entering');
    service.endFocusTransition();
    expect(service.focusTransition()).toBeNull();
  });

  it('focus chrome restore should expose restoring phase until timer settles', async () => {
    expect(service.focusChromePhase()).toBe('idle');

    service.beginFocusChromeRestore(200);
    expect(service.focusChromePhase()).toBe('restoring');

    vi.advanceTimersByTime(220);
    expect(service.focusChromePhase()).toBe('idle');
  });

  // =========================================================================
  //  Init-chain integration — all sub-services respond after construction
  // =========================================================================

  describe('sub-service init chain', () => {
    it('should allow completionFlow operations after engine construction', async () => {
      // completionFlow is initialized during DockEngineService constructor via initSubServices.
      // If init() wasn't called, these would throw "must be called before use".
      seedTask('T1');
      await service.dockTask('T1');
      // completionFlow's enforceSingleMainInvariant is called during dockTask flow
      expect(service.entries().length).toBe(1);
    });

    it('should allow entryField operations after engine construction', async () => {
      seedTask('T1');
      await service.dockTask('T1');
      // entryField.toggleLoad would throw if init() wasn't called
      await service.toggleLoad('T1', 'up');
      expect(service.entries().find(e => e.taskId === 'T1')?.load).toBe('high');
    });

    it('should allow inlineCreation after engine construction', async () => {
      const taskId = await service.createInDock('Inline test', 'combo-select', 'low');
      expect(taskId).not.toBeNull();
      expect(service.entries().some(e => e.taskId === taskId)).toBe(true);
    });
  });
}
