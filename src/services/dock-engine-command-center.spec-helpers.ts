import { beforeEach, expect, it } from 'vitest';

import type { DockEngineService } from './dock-engine.service';
import type { DockEngineSpecContext } from './dock-engine.spec-context';
import type { DockSnapshot } from '../models/parking-dock';

async function flushDockCompletion(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

export function registerDockEngineCommandCenterSpecs(context: DockEngineSpecContext): void {
  let service: DockEngineService;
  const { seedTask } = context;

  beforeEach(() => {
    service = context.service();
  });

  it('cancelPendingDecisionAutoPromote should repair stale system-selected main to a single main', async () => {
    service.restoreSnapshot({
      version: 6,
      entries: [
        {
          taskId: 'A',
          title: 'A',
          sourceProjectId: 'project-1',
          status: 'suspended_waiting',
          load: 'low',
          expectedMinutes: 20,
          waitMinutes: 15,
          waitStartedAt: new Date().toISOString(),
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
          isMain: true,
          dockedOrder: 1,
          detail: '',
          sourceKind: 'project-task',
          systemSelected: true,
          recommendationLocked: true,
          recommendedScore: 99,
        },
      ],
      focusMode: true,
      isDockExpanded: true,
      muteWaitTone: false,
      session: {
        firstDragIntervened: true,
        focusBlurOn: true,
        focusScrimOn: true,
        mainTaskId: null,
        comboSelectIds: ['A'],
        backupIds: ['B'],
      },
      firstDragDone: true,
      dailySlots: [],
      suspendChainRootTaskId: null,
      suspendRecommendationLocked: false,
      pendingDecision: {
        rootTaskId: 'A',
        rootRemainingMinutes: 15,
        candidateGroups: [
          { type: 'homologous-advancement', taskIds: ['B'] },
        ],
        reason: 'stale-main-cleanup',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3000).toISOString(),
      },
      dailyResetDate: '2026-02-25',
      savedAt: new Date().toISOString(),
    });

    await expect(service.cancelPendingDecisionAutoPromote()).resolves.toBe(true);

    const activeEntries = service.entries().filter(entry => entry.status !== 'completed');
    const mains = activeEntries.filter(entry => entry.isMain);
    expect(mains).toHaveLength(1);
    expect(mains[0]?.taskId).toBe('A');
    expect(service.entries().find(entry => entry.taskId === 'B')?.isMain).toBe(false);
    const shadow = JSON.parse(
      localStorage.getItem('nanoflow.dock-snapshot.v3.user-1') ?? '{}',
    ) as DockSnapshot;
    expect(shadow.pendingDecision).toBeNull();
    expect(shadow.lastRuleDecision?.type).toBe('completion_followup');
    expect(shadow.session.mainTaskId).toBe('A');
  });

  it('completeTask should keep exactly one successor main when current main completes', async () => {
    seedTask('A');
    seedTask('B');
    await service.dockTask('A');
    await service.dockTask('B');
    service.toggleFocusMode();
    service.switchToTask('A');
    service.setMainTask('B');
    service.switchToTask('A');

    service.completeTask('A');
    await flushDockCompletion();

    const activeEntries = service.entries().filter(entry => entry.status !== 'completed');
    const mains = activeEntries.filter(entry => entry.isMain);
    expect(mains).toHaveLength(1);
    expect(mains[0]?.taskId).toBe('B');
  });

  it('removeFromDock should keep exactly one successor main after removing current main', async () => {
    seedTask('A');
    seedTask('B');
    seedTask('C');
    await service.dockTask('A');
    await service.dockTask('B');
    await service.dockTask('C');

    service.removeFromDock('A');

    const activeEntries = service.entries().filter(entry => entry.status !== 'completed');
    const mains = activeEntries.filter(entry => entry.isMain);
    expect(mains).toHaveLength(1);
    expect(mains[0]?.taskId).toBe('B');
  });

  it('removeFromDock should write a recoverable local snapshot before returning success', async () => {
    seedTask('A');
    seedTask('B');
    await service.dockTask('A');
    await service.dockTask('B');

    const result = service.removeFromDock('A');

    expect(service.entries().some(entry => entry.taskId === 'A')).toBe(false);
    await expect(result).resolves.toBe(true);
    const shadow = JSON.parse(
      localStorage.getItem('nanoflow.dock-snapshot.v3.user-1') ?? '{}',
    ) as DockSnapshot;
    expect(shadow.entries.some(entry => entry.taskId === 'A')).toBe(false);
    expect(shadow.entries.map(entry => entry.taskId)).toEqual(['B']);
  });

  it('choosePendingDecisionCandidate should persist manual candidate resolution before returning success', async () => {
    seedTask('A');
    seedTask('B');
    seedTask('C');

    service.restoreSnapshot({
      version: 7,
      entries: [
        {
          taskId: 'A',
          title: 'A',
          sourceProjectId: 'project-1',
          status: 'suspended_waiting',
          load: 'high',
          expectedMinutes: 60,
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
          status: 'pending_start',
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
          systemSelected: true,
          recommendationLocked: true,
          recommendedScore: 100,
        },
        {
          taskId: 'C',
          title: 'C',
          sourceProjectId: 'project-1',
          status: 'pending_start',
          load: 'low',
          expectedMinutes: 25,
          waitMinutes: null,
          waitStartedAt: null,
          lane: 'backup',
          zoneSource: 'manual',
          isMain: false,
          dockedOrder: 2,
          detail: '',
          sourceKind: 'project-task',
          systemSelected: true,
          recommendationLocked: true,
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
        comboSelectIds: ['B'],
        backupIds: ['C'],
      },
      firstDragDone: true,
      dailySlots: [],
      suspendChainRootTaskId: 'A',
      suspendRecommendationLocked: true,
      pendingDecision: {
        rootTaskId: 'A',
        rootRemainingMinutes: 30,
        candidateGroups: [
          { type: 'homologous-advancement', taskIds: ['B', 'C'] },
        ],
        reason: 'manual-resolution',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3000).toISOString(),
      },
      dailyResetDate: '2026-04-25',
      savedAt: '2026-04-25T08:00:00.000Z',
    });

    await expect(service.choosePendingDecisionCandidate('B')).resolves.toBe(true);

    const shadow = JSON.parse(
      localStorage.getItem('nanoflow.dock-snapshot.v3.user-1') ?? '{}',
    ) as DockSnapshot;
    expect(shadow.pendingDecision).toBeNull();
    expect(shadow.lastRuleDecision?.recommendedTaskIds).toEqual(['B']);
    expect(shadow.entries.find(entry => entry.taskId === 'B')?.status).toBe('focusing');
    expect(shadow.entries.find(entry => entry.taskId === 'B')?.systemSelected).toBe(false);
    expect(shadow.entries.find(entry => entry.taskId === 'C')?.systemSelected).toBe(false);
  });

  it('switchToTask should only switch C position and keep main ownership unchanged', async () => {
    seedTask('A');
    seedTask('B');
    await service.dockTask('A');
    await service.dockTask('B');
    service.toggleFocusMode();
    service.switchToTask('A');

    expect(service.entries().find(entry => entry.taskId === 'A')?.isMain).toBe(true);

    service.switchToTask('B');

    expect(service.focusingEntry()?.taskId).toBe('B');
    expect(service.entries().find(entry => entry.taskId === 'A')?.isMain).toBe(true);
    expect(service.entries().find(entry => entry.taskId === 'B')?.isMain).toBe(false);
    expect(service.exportSnapshot().session.mainTaskId).toBe('A');
    expect(service.exportSnapshot().focusSessionState?.commandCenterTasks.map(slot => slot.taskId)).toEqual(['A']);
  });

  it('focusSessionState should keep backup-only tasks out of the widget C slots while showing combo-select pending secondaries', async () => {
    const makeEntry = (
      taskId: string,
      dockedOrder: number,
      overrides: Partial<ReturnType<typeof service.entries>[number]> = {},
    ) => ({
      taskId,
      title: taskId,
      sourceProjectId: 'project-1',
      status: 'pending_start' as const,
      load: 'low' as const,
      expectedMinutes: 20,
      waitMinutes: null,
      waitStartedAt: null,
      lane: 'backup' as const,
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
        makeEntry('A', 0, { isMain: true, status: 'focusing', lane: 'combo-select' }),
        makeEntry('B', 1),
        makeEntry('C', 2, { lane: 'combo-select' }),
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
        comboSelectIds: ['C'],
        backupIds: ['B', 'D'],
      },
      firstDragDone: true,
      dailySlots: [],
      suspendChainRootTaskId: null,
      suspendRecommendationLocked: false,
      pendingDecision: null,
      dailyResetDate: '2026-04-25',
      savedAt: '2026-04-25T08:00:00.000Z',
    });

    const focusState = service.exportSnapshot().focusSessionState;

    expect(service.consoleVisibleEntries().map(entry => entry.taskId)).toEqual(['A', 'C']);
    expect(focusState?.commandCenterOrderIds).toEqual(['A', 'C']);
    expect(focusState?.comboSelectTasks.map(slot => slot.taskId)).toEqual(['C']);
    expect(focusState?.backupTasks.map(slot => slot.taskId)).toEqual(['B', 'D']);
  });

  it('switchToTask should move the selected visible card to the front and preserve the remaining order', async () => {
    seedTask('A');
    seedTask('B');
    seedTask('C');
    seedTask('D');

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
        backupIds: [],
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

    service.switchToTask('B');

    expect(service.consoleVisibleEntries().map(entry => entry.taskId)).toEqual(['B', 'A', 'C', 'D']);
    expect(service.entries().find(entry => entry.taskId === 'A')?.isMain).toBe(true);
    expect(service.entries().find(entry => entry.taskId === 'A')?.status).toBe('stalled');
    expect(service.exportSnapshot().session.mainTaskId).toBe('A');
    expect(service.exportSnapshot().focusSessionState?.commandCenterOrderIds).toEqual(['B', 'A', 'C', 'D']);
    expect(service.exportSnapshot().focusSessionState?.commandCenterTasks.map(slot => slot.taskId)).toEqual(['A']);
    expect(service.exportSnapshot().focusSessionState?.comboSelectTasks.map(slot => slot.taskId)).toEqual(['B', 'C', 'D']);
  });

  it('switching back to the main task should mark interrupted secondary task as stalled', async () => {
    seedTask('A');
    seedTask('B');
    await service.dockTask('A');
    await service.dockTask('B');
    service.toggleFocusMode();
    service.switchToTask('A');
    service.switchToTask('B');

    service.switchToTask('A');

    expect(service.entries().find(entry => entry.taskId === 'B')?.status).toBe('stalled');
    expect(service.focusingEntry()?.taskId).toBe('A');
  });

  it('switchToTask should write a recoverable local snapshot before returning success', async () => {
    seedTask('A');
    seedTask('B');
    await service.dockTask('A');
    await service.dockTask('B');
    service.toggleFocusMode();
    await service.switchToTask('A');

    const result = service.switchToTask('B');

    expect(service.focusingEntry()?.taskId).toBe('B');
    await expect(result).resolves.toBe(true);
    const shadow = JSON.parse(
      localStorage.getItem('nanoflow.dock-snapshot.v3.user-1') ?? '{}',
    ) as DockSnapshot;
    expect(shadow.entries.find(entry => entry.taskId === 'B')?.status).toBe('focusing');
    expect(shadow.focusSessionState?.commandCenterOrderIds[0]).toBe('B');
  });

  it('should export command center order from the front four active dock tasks even when secondary slots are still pending', async () => {
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
          systemSelected: false,
          recommendedScore: null,
        },
        {
          taskId: 'C',
          title: 'C',
          sourceProjectId: 'project-1',
          status: 'pending_start',
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
          status: 'pending_start',
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

    const focusState = service.exportSnapshot().focusSessionState;

    expect(focusState?.commandCenterOrderIds).toEqual(['A', 'B', 'C', 'D']);
    expect(focusState?.comboSelectTasks.map(slot => slot.taskId)).toEqual(['B', 'C', 'D']);
    expect(focusState?.backupTasks.map(slot => slot.taskId)).toEqual(['E']);
  });
}
