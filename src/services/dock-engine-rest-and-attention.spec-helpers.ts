import { beforeEach, expect, it, vi } from 'vitest';

import { PARKING_CONFIG } from '../config/parking.config';
import { DEFAULT_FOCUS_PREFERENCES } from '../models/focus';
import { DockFragmentRestService } from './dock-fragment-rest.service';
import type { DockEngineService } from './dock-engine.service';
import type { DockEngineSpecContext } from './dock-engine.spec-context';

async function flushDockCompletion(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

export function registerDockEngineRestAndAttentionSpecs(context: DockEngineSpecContext): void {
  let service: DockEngineService;
  const { seedTask, mockFocusAttention, mockFocusHudWindow, mockFocusPreferenceService } = context;

  beforeEach(() => {
    service = context.service();
  });

  it('should start fragment countdown when subtask completes and root wait remains without suitable next candidate', async () => {
    seedTask('A');
    seedTask('B');

    const waitStartedAt = new Date(Date.now() - 30 * 1000).toISOString();
    service.restoreSnapshot({
      version: 7,
      entries: [
        {
          taskId: 'A',
          title: 'A',
          sourceProjectId: 'project-1',
          status: 'suspended_waiting',
          load: 'high',
          expectedMinutes: 30,
          waitMinutes: 4,
          waitStartedAt,
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
          expectedMinutes: 2,
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
      focusMode: true,
      isDockExpanded: true,
      muteWaitTone: false,
      session: {
        firstDragIntervened: true,
        focusBlurOn: true,
        focusScrimOn: true,
        mainTaskId: 'B',
        comboSelectIds: [],
        backupIds: [],
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
    await flushDockCompletion();

    expect(service.fragmentEntryCountdown()).toBe(PARKING_CONFIG.FRAGMENT_ENTRY_COUNTDOWN_S);
    expect(service.pendingDecision()).toBeNull();
    service.fragmentRest.skipFragmentEntry();
    expect(service.fragmentEntryCountdown()).toBeNull();
    expect(service.activeFragmentEvent()).toBeNull();
  });

  it('accepting fragment countdown should enter fragment phase without mutating the waiting root task', async () => {
    seedTask('A');
    seedTask('B');

    const waitStartedAt = new Date(Date.now() - 30 * 1000).toISOString();
    service.restoreSnapshot({
      version: 7,
      entries: [
        {
          taskId: 'A',
          title: 'A',
          sourceProjectId: 'project-1',
          status: 'suspended_waiting',
          load: 'high',
          expectedMinutes: 30,
          waitMinutes: 4,
          waitStartedAt,
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
          expectedMinutes: 2,
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
      focusMode: true,
      isDockExpanded: true,
      muteWaitTone: false,
      session: {
        firstDragIntervened: true,
        focusBlurOn: true,
        focusScrimOn: true,
        mainTaskId: 'B',
        comboSelectIds: [],
        backupIds: [],
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
    await flushDockCompletion();
    service.fragmentRest.acceptFragmentEntry();

    expect(service.fragmentEntryCountdown()).toBeNull();
    expect(service.fragmentDefenseLevel()).toBe(2);
    expect(service.activeFragmentEvent()).not.toBeNull();
    expect(service.entries().find(entry => entry.taskId === 'A')?.status).toBe('suspended_waiting');
  });

  it('should trigger and reset the high-load rest reminder after sustained focus time', async () => {
    seedTask('A');

    await service.dockTask('A', 'combo-select', { expectedMinutes: 45, load: 'high', zoneSource: 'manual' });
    service.toggleFocusMode();
    service.switchToTask('A');

    expect(service.focusingEntry()?.taskId).toBe('A');

    const fragmentRest = context.testBed.inject(DockFragmentRestService);
    for (let elapsed = 0; elapsed < PARKING_CONFIG.REST_REMINDER_HIGH_LOAD_THRESHOLD_MS; elapsed += 10_000) {
      fragmentRest.tickRestReminderAccumulator(true, 'high');
    }

    expect(service.restReminderActive()).toBe(true);
    expect(service.cumulativeHighLoadMs()).toBeGreaterThanOrEqual(PARKING_CONFIG.REST_REMINDER_HIGH_LOAD_THRESHOLD_MS);

    service.fragmentRest.dismissRestReminder();

    expect(service.restReminderActive()).toBe(false);
    expect(service.cumulativeHighLoadMs()).toBe(0);
  });

  it('should honor configurable high-load rest reminder threshold', async () => {
    mockFocusPreferenceService.update({ restReminderHighLoadMinutes: 20 });
    seedTask('A');

    await service.dockTask('A', 'combo-select', { expectedMinutes: 45, load: 'high', zoneSource: 'manual' });
    service.toggleFocusMode();
    service.switchToTask('A');

    const fragmentRest = context.testBed.inject(DockFragmentRestService);
    for (let elapsed = 0; elapsed < 19 * 60 * 1000; elapsed += 10_000) {
      fragmentRest.tickRestReminderAccumulator(true, 'high');
    }
    expect(service.restReminderActive()).toBe(false);

    for (let elapsed = 19 * 60 * 1000; elapsed < 20 * 60 * 1000; elapsed += 10_000) {
      fragmentRest.tickRestReminderAccumulator(true, 'high');
    }
    expect(service.restReminderActive()).toBe(true);
  });

  it('restoreSnapshot should backfill legacy external-drag manual combo entries to backup', async () => {
    service.restoreSnapshot({
      version: 6,
      entries: [
        {
          taskId: 'legacy-flow',
          title: 'Legacy Flow',
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
          sourceSection: 'flow',
          systemSelected: false,
          recommendedScore: null,
          relationScore: 100,
          relationReason: 'manual:combo-select',
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
        comboSelectIds: ['legacy-flow'],
        backupIds: [],
      },
      firstDragDone: true,
      dailySlots: [],
      suspendChainRootTaskId: null,
      suspendRecommendationLocked: false,
      pendingDecision: null,
      dailyResetDate: '2026-02-25',
      savedAt: new Date().toISOString(),
    });

    const entry = service.entries().find(item => item.taskId === 'legacy-flow');
    expect(entry?.lane).toBe('backup');
    expect(entry?.relationScore).toBe(20);
    expect(entry?.relationReason).toBe('manual:default-backup');
  });

  it('restoreSnapshot backfill should not mutate non-target entries', async () => {
    service.restoreSnapshot({
      version: 6,
      entries: [
        {
          taskId: 'dock-created',
          title: 'Inline',
          sourceProjectId: null,
          status: 'pending_start',
          load: 'low',
          expectedMinutes: 10,
          waitMinutes: null,
          waitStartedAt: null,
          lane: 'combo-select',
          zoneSource: 'manual',
          isMain: false,
          dockedOrder: 0,
          detail: '',
          sourceKind: 'dock-created',
          sourceSection: 'dock-create',
          systemSelected: false,
          recommendedScore: null,
          relationScore: 100,
          relationReason: 'manual:create-combo-select',
        },
        {
          taskId: 'manual-text-nonlegacy',
          title: 'Manual text',
          sourceProjectId: 'project-1',
          status: 'pending_start',
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
          sourceSection: 'text',
          systemSelected: false,
          recommendedScore: null,
          relationScore: 99,
          relationReason: 'manual:custom-pinned',
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
        comboSelectIds: ['dock-created', 'manual-text-nonlegacy'],
        backupIds: [],
      },
      firstDragDone: true,
      dailySlots: [],
      suspendChainRootTaskId: null,
      suspendRecommendationLocked: false,
      pendingDecision: null,
      dailyResetDate: '2026-02-25',
      savedAt: new Date().toISOString(),
    });

    const inlineEntry = service.entries().find(item => item.taskId === 'dock-created');
    expect(inlineEntry?.lane).toBe('combo-select');
    expect(inlineEntry?.relationReason).toBe('manual:create-combo-select');

    const customTextEntry = service.entries().find(item => item.taskId === 'manual-text-nonlegacy');
    expect(customTextEntry?.lane).toBe('combo-select');
    expect(customTextEntry?.relationReason).toBe('manual:custom-pinned');
  });

  it('wait-finished should only notify state and must not steal current focus', async () => {
    seedTask('A');
    seedTask('B');
    const waitStartedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    service.restoreSnapshot({
      version: 4,
      entries: [
        {
          taskId: 'A',
          title: 'A',
          sourceProjectId: 'project-1',
          status: 'suspended_waiting',
          load: 'low',
          expectedMinutes: 30,
          waitMinutes: 5,
          waitStartedAt,
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
          load: 'high',
          expectedMinutes: 25,
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
      ],
      focusMode: true,
      isDockExpanded: true,
      muteWaitTone: false,
      session: {
        firstDragIntervened: true,
        focusBlurOn: true,
        focusScrimOn: true,
        mainTaskId: 'A',
        comboSelectIds: [],
        backupIds: [],
      },
      firstDragDone: true,
      dailySlots: [],
      suspendChainRootTaskId: 'A',
      suspendRecommendationLocked: true,
      pendingDecision: null,
      dailyResetDate: '2026-02-25',
      savedAt: new Date().toISOString(),
    });

    vi.advanceTimersByTime(10_500);

    expect(service.focusingEntry()?.taskId).toBe('B');
    expect(service.entries().find(entry => entry.taskId === 'A')?.status).toBe('wait_finished');
  });

  it('expired suspended_waiting entries should count toward the attention badge immediately', async () => {
    seedTask('A');
    seedTask('B');
    mockFocusAttention.updateBadge.mockClear();
    const waitStartedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();

    service.restoreSnapshot({
      version: 4,
      entries: [
        {
          taskId: 'A',
          title: 'A',
          sourceProjectId: 'project-1',
          status: 'suspended_waiting',
          load: 'low',
          expectedMinutes: 30,
          waitMinutes: 5,
          waitStartedAt,
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
          load: 'high',
          expectedMinutes: 25,
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
      ],
      focusMode: true,
      isDockExpanded: true,
      muteWaitTone: false,
      session: {
        firstDragIntervened: true,
        focusBlurOn: true,
        focusScrimOn: true,
        mainTaskId: 'A',
        comboSelectIds: [],
        backupIds: [],
      },
      firstDragDone: true,
      dailySlots: [],
      suspendChainRootTaskId: 'A',
      suspendRecommendationLocked: true,
      pendingDecision: null,
      dailyResetDate: '2026-02-25',
      savedAt: new Date().toISOString(),
    });
    context.testBed.flushEffects();

    expect(mockFocusAttention.updateBadge).toHaveBeenLastCalledWith(1);
  });

  it('active PiP HUD should suppress wait-finished notifications while the main document is hidden', async () => {
    const originalVisibilityDescriptor = Object.getOwnPropertyDescriptor(document, 'visibilityState');
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    });
    mockFocusHudWindow.isActive.set(true);
    seedTask('A');
    seedTask('B');
    const waitStartedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();

    try {
      service.restoreSnapshot({
        version: 4,
        entries: [
          {
            taskId: 'A',
            title: 'A',
            sourceProjectId: 'project-1',
            status: 'suspended_waiting',
            load: 'low',
            expectedMinutes: 30,
            waitMinutes: 5,
            waitStartedAt,
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
            load: 'high',
            expectedMinutes: 25,
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
        ],
        focusMode: true,
        isDockExpanded: true,
        muteWaitTone: false,
        session: {
          firstDragIntervened: true,
          focusBlurOn: true,
          focusScrimOn: true,
          mainTaskId: 'A',
          comboSelectIds: [],
          backupIds: [],
        },
        firstDragDone: true,
        dailySlots: [],
        suspendChainRootTaskId: 'A',
        suspendRecommendationLocked: true,
        pendingDecision: null,
        dailyResetDate: '2026-02-25',
        savedAt: new Date().toISOString(),
      });
      mockFocusAttention.notify.mockClear();

      vi.advanceTimersByTime(10_500);

      expect(service.entries().find(entry => entry.taskId === 'A')?.status).toBe('wait_finished');
      expect(mockFocusAttention.notify).not.toHaveBeenCalled();
    } finally {
      if (originalVisibilityDescriptor) {
        Object.defineProperty(document, 'visibilityState', originalVisibilityDescriptor);
      } else {
        Reflect.deleteProperty(document as unknown as Record<string, unknown>, 'visibilityState');
      }
    }
  });
}
