import { beforeEach, expect, it, vi } from 'vitest';

import { PARKING_CONFIG } from '../config/parking.config';
import { SYNC_CONFIG } from '../config/sync.config';
import type { DockEngineService } from './dock-engine.service';
import type { DockEngineSpecContext } from './dock-engine.spec-context';
import type { DockSnapshot } from '../models/parking-dock';

export function registerDockEngineFocusSessionSpecs(context: DockEngineSpecContext): void {
  let service: DockEngineService;
  const { seedTask, mockActionQueue } = context;

  beforeEach(() => {
    service = context.service();
  });

  it('pending decision with candidates should stay manual even after timeout elapses', async () => {
    seedTask('A');
    seedTask('B');
    seedTask('C');
    seedTask('D');

    service.restoreSnapshot({
      version: 4,
      entries: [
        {
          taskId: 'A',
          title: 'A',
          sourceProjectId: 'project-1',
          status: 'suspended_waiting',
          load: 'high',
          expectedMinutes: 90,
          waitMinutes: 30,
          waitStartedAt: new Date().toISOString(),
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
          status: 'focusing',
          load: 'low',
          expectedMinutes: 20,
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
          status: 'pending_start',
          load: 'low',
          expectedMinutes: 18,
          waitMinutes: null,
          waitStartedAt: null,
          lane: 'combo-select',
          zoneSource: 'manual',
          isMain: false,
          dockedOrder: 2,
          detail: '',
          sourceKind: 'project-task',
          systemSelected: true,
          recommendedScore: 100,
        },
        {
          taskId: 'D',
          title: 'D',
          sourceProjectId: 'project-1',
          status: 'pending_start',
          load: 'high',
          expectedMinutes: 8,
          waitMinutes: null,
          waitStartedAt: null,
          lane: 'backup',
          zoneSource: 'manual',
          isMain: false,
          dockedOrder: 3,
          detail: '',
          sourceKind: 'project-task',
          systemSelected: true,
          recommendedScore: 60,
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
        comboSelectIds: ['C'],
        backupIds: ['D'],
      },
      firstDragDone: true,
      dailySlots: [],
      suspendChainRootTaskId: 'A',
      suspendRecommendationLocked: true,
      pendingDecision: {
        rootTaskId: 'A',
        rootRemainingMinutes: 25,
        candidateGroups: [
          {
            type: 'homologous-advancement',
            taskIds: ['C', 'D'],
          },
        ],
        reason: '候选任务时长匹配异常',
        createdAt: new Date(Date.now() - 5_000).toISOString(),
        expiresAt: new Date(Date.now() - 1_000).toISOString(),
      },
      dailyResetDate: '2026-02-25',
      savedAt: new Date().toISOString(),
    });

    vi.advanceTimersByTime(10_500);

    expect(service.pendingDecision()).not.toBeNull();
    expect(service.focusingEntry()?.taskId).toBe('B');
  });

  it('suspend recommendation should only create the first recommendation chain once', async () => {
    seedTask('A');
    seedTask('B');
    seedTask('C');

    await service.dockTask('A', 'combo-select', { expectedMinutes: 60, load: 'high', zoneSource: 'manual' });
    await service.dockTask('B', 'combo-select', { expectedMinutes: 15, load: 'low', zoneSource: 'manual' });
    await service.dockTask('C', 'backup', { expectedMinutes: 20, load: 'low', zoneSource: 'manual' });
    service.toggleFocusMode();
    service.switchToTask('A');

    service.suspendTask('A', 30);
    expect(service.lastRuleDecision()?.type).toBe('first_suspend_recommendation');

    expect(service.focusingEntry()).toBeNull();
    expect(service.pendingDecision()).not.toBeNull();

    service.suspendTask('B', 10);
    expect(service.lastRuleDecision()?.type).not.toBe('first_suspend_recommendation');
    expect(service.pendingDecision()).toBeNull();
  });

  it('suspendTask should write a recoverable local snapshot before returning success', async () => {
    seedTask('A');
    seedTask('B');
    await service.dockTask('A', 'combo-select', { expectedMinutes: 60, load: 'high', zoneSource: 'manual' });
    await service.dockTask('B', 'combo-select', { expectedMinutes: 15, load: 'low', zoneSource: 'manual' });
    service.toggleFocusMode();
    await service.switchToTask('A');

    const result = service.suspendTask('A', 30);

    expect(service.entries().find(entry => entry.taskId === 'A')?.status).toBe('suspended_waiting');
    await expect(result).resolves.toBe(true);
    const shadow = JSON.parse(
      localStorage.getItem('nanoflow.dock-snapshot.v3.user-1') ?? '{}',
    ) as DockSnapshot;
    const suspended = shadow.entries.find(entry => entry.taskId === 'A');
    expect(suspended?.status).toBe('suspended_waiting');
    expect(suspended?.waitMinutes).toBe(30);
    expect(shadow.suspendChainRootTaskId).toBe('A');
    expect(shadow.suspendRecommendationLocked).toBe(true);
  });

  it('switchToTask should coalesce to a single entries.update commit', async () => {
    seedTask('A');
    seedTask('B');
    seedTask('C');

    await service.dockTask('A', 'combo-select', { expectedMinutes: 50, load: 'high', zoneSource: 'manual' });
    await service.dockTask('B', 'combo-select', { expectedMinutes: 20, load: 'low', zoneSource: 'manual' });
    await service.dockTask('C', 'backup', { expectedMinutes: 35, load: 'low', zoneSource: 'manual' });
    service.toggleFocusMode();
    service.switchToTask('A');

    const updateSpy = vi.spyOn(service.entries, 'update');
    updateSpy.mockClear();

    service.switchToTask('B');

    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(service.focusingEntry()?.taskId).toBe('B');
  });

  it('switchToTask should keep critical commit immediate and defer maintenance commit', async () => {
    seedTask('A');
    seedTask('B');
    seedTask('C');

    await service.dockTask('A', 'combo-select', { expectedMinutes: 50, load: 'high', zoneSource: 'manual' });
    await service.dockTask('B', 'combo-select', { expectedMinutes: 20, load: 'low', zoneSource: 'manual' });
    await service.dockTask('C', 'backup', { expectedMinutes: 35, load: 'low', zoneSource: 'manual' });
    service.toggleFocusMode();
    service.switchToTask('A');

    const updateSpy = vi.spyOn(service.entries, 'update');
    updateSpy.mockClear();

    service.switchToTask('B');

    expect(service.focusingEntry()?.taskId).toBe('B');
    expect(updateSpy).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(PARKING_CONFIG.DOCK_ANIMATION_MS);
    expect(updateSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('holdNonCriticalWork should defer switch maintenance commit until hold window ends', async () => {
    seedTask('A');
    seedTask('B');
    seedTask('C');

    await service.dockTask('A', 'combo-select', { expectedMinutes: 50, load: 'high', zoneSource: 'manual' });
    await service.dockTask('B', 'combo-select', { expectedMinutes: 20, load: 'low', zoneSource: 'manual' });
    await service.dockTask('C', 'backup', { expectedMinutes: 35, load: 'low', zoneSource: 'manual' });
    service.toggleFocusMode();
    service.switchToTask('A');

    const updateSpy = vi.spyOn(service.entries, 'update');
    updateSpy.mockClear();

    service.holdNonCriticalWork(320);
    service.switchToTask('B');

    expect(service.focusingEntry()?.taskId).toBe('B');
    expect(updateSpy).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(PARKING_CONFIG.DOCK_ANIMATION_MS);
    expect(updateSpy).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(PARKING_CONFIG.DOCK_ANIMATION_MS);
    expect(updateSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('holdNonCriticalWork should defer cloud push timer', async () => {
    (service as unknown as { restoringSnapshot: { set: (v: boolean) => void } }).restoringSnapshot.set(false);

    // hold 必须覆盖过云推送防抖窗口（SYNC_CONFIG.DEBOUNCE_DELAY），才能验证"动画期间延后推送"
    const holdTailMs = 500;
    service.holdNonCriticalWork(SYNC_CONFIG.DEBOUNCE_DELAY + holdTailMs);
    await service.toggleFocusScrim();
    // 云推送由 persistenceDeps effect 调度，需显式冲刷 effects 才会武装防抖定时器
    context.testBed.flushEffects();
    mockActionQueue.enqueueDurablyForOwner.mockClear();

    await vi.advanceTimersByTimeAsync(SYNC_CONFIG.DEBOUNCE_DELAY);
    expect(mockActionQueue.enqueueDurablyForOwner).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(holdTailMs);
    expect(mockActionQueue.enqueueDurablyForOwner).toHaveBeenCalledTimes(1);
  });

  it('focusSessionState should keep stable sessionId/sessionStartedAt within one session', async () => {
    seedTask('A');
    await service.dockTask('A');
    service.toggleFocusMode();

    const first = service.exportSnapshot().focusSessionState;
    expect(first).toBeTruthy();

    vi.advanceTimersByTime(PARKING_CONFIG.DOCK_SEMICIRCLE_DRAG_EXPAND_DELAY_MS);
    service.toggleFocusScrim();
    const second = service.exportSnapshot().focusSessionState;
    expect(second).toBeTruthy();

    expect(second?.sessionId).toBe(first?.sessionId);
    expect(second?.sessionStartedAt).toBe(first?.sessionStartedAt);
  });

  it('restoreSnapshot should reset burnout signals to safe defaults when session fields are missing', async () => {
    service.highLoadCounter.set({ count: 5, windowStartAt: Date.now() - 1000 });
    service.burnoutTriggeredAt.set(Date.now() - 500);

    service.restoreSnapshot({
      version: 6,
      entries: [],
      focusMode: false,
      isDockExpanded: true,
      muteWaitTone: false,
      session: {
        firstDragIntervened: false,
        focusBlurOn: false,
        focusScrimOn: true,
        mainTaskId: null,
        comboSelectIds: [],
        backupIds: [],
      },
      dailySlots: [],
      suspendChainRootTaskId: null,
      suspendRecommendationLocked: false,
      pendingDecision: null,
      lastRuleDecision: null,
      dailyResetDate: '2026-03-03',
      savedAt: new Date().toISOString(),
    });

    expect(service.highLoadCounter()).toEqual({ count: 0, windowStartAt: 0 });
    expect(service.burnoutTriggeredAt()).toBeNull();
  });

  it('createInDock should default to blackbox ownership (sourceProjectId null)', async () => {
    const taskId = await service.createInDock('Inline Task', 'backup', 'low');
    const entry = service.entries().find(item => item.taskId === taskId);
    expect(entry?.sourceProjectId).toBeNull();
  });

  it('first main override window should start on focus entry and allow override within 15 seconds', async () => {
    seedTask('A');
    seedTask('B');
    await service.dockTask('A');
    await service.dockTask('B');

    expect(service.firstMainSelectionPending()).toBeNull();
    service.toggleFocusMode();
    expect(service.firstMainSelectionPending()).not.toBeNull();
    service.overrideFirstMainTask('B');
    expect(service.entries().find(item => item.taskId === 'B')?.isMain).toBe(true);
    expect(service.focusingEntry()?.taskId).toBe('B');
  });

  it('first main override window should close after 15 seconds', async () => {
    seedTask('A');
    seedTask('B');
    await service.dockTask('A');
    await service.dockTask('B');

    service.toggleFocusMode();
    vi.advanceTimersByTime(PARKING_CONFIG.NOTICE_FALLBACK_TIMEOUT_MS + 100);
    expect(service.firstMainSelectionPending()).toBeNull();
    service.overrideFirstMainTask('B');
    expect(service.entries().find(item => item.taskId === 'A')?.isMain).toBe(true);
    expect(service.entries().find(item => item.taskId === 'B')?.isMain).toBe(false);
    expect(service.focusingEntry()?.taskId).toBe('B');
  });

  it('restoreSnapshot should recover a unique main when session mainTaskId is null', async () => {
    service.restoreSnapshot({
      version: 6,
      entries: [
        {
          taskId: 'A',
          title: 'A',
          sourceProjectId: 'project-1',
          status: 'pending_start',
          load: 'low',
          expectedMinutes: 20,
          waitMinutes: null,
          waitStartedAt: null,
          lane: 'combo-select',
          zoneSource: 'manual',
          isMain: false,
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
          status: 'pending_start',
          load: 'low',
          expectedMinutes: 30,
          waitMinutes: null,
          waitStartedAt: null,
          lane: 'backup',
          zoneSource: 'manual',
          isMain: false,
          dockedOrder: 1,
          detail: '',
          sourceKind: 'project-task',
          systemSelected: false,
          recommendedScore: null,
        },
      ],
      focusMode: false,
      isDockExpanded: true,
      muteWaitTone: false,
      session: {
        firstDragIntervened: true,
        focusBlurOn: false,
        focusScrimOn: true,
        mainTaskId: null,
        comboSelectIds: ['A'],
        backupIds: ['B'],
      },
      firstDragDone: true,
      dailySlots: [],
      suspendChainRootTaskId: null,
      suspendRecommendationLocked: false,
      pendingDecision: null,
      dailyResetDate: '2026-02-25',
      savedAt: new Date().toISOString(),
    });

    const activeEntries = service.entries().filter(entry => entry.status !== 'completed');
    const mains = activeEntries.filter(entry => entry.isMain);
    expect(mains).toHaveLength(1);
    expect(mains[0]?.taskId).toBe('A');
  });

}
