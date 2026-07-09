import { beforeEach, expect, it } from 'vitest';
import { set as idbSet } from 'idb-keyval';

import type { DockSnapshot } from '../models/parking-dock';
import type { DockEngineService } from './dock-engine.service';
import type { DockEngineSpecContext } from './dock-engine.spec-context';

const mockIdbSet = idbSet as unknown as {
  mockResolvedValueOnce(value: unknown): unknown;
  mockRejectedValueOnce(value: unknown): unknown;
  mockImplementationOnce(implementation: (...args: unknown[]) => unknown): unknown;
};

export function registerDockEngineSnapshotPreferenceSpecs(context: DockEngineSpecContext): void {
  let service: DockEngineService;
  const { seedTask } = context;

  beforeEach(() => {
    service = context.service();
  });

  it('export snapshot should include v3 fields', async () => {
    seedTask('A');
    await service.dockTask('A');
    await service.setDockExpanded(false);
    await service.toggleMuteWaitTone();
    const snapshot = service.exportSnapshot();

    expect(snapshot.version).toBe(7);
    expect(snapshot.focusMode).toBe(false);
    expect(snapshot.isDockExpanded).toBe(false);
    expect(snapshot.muteWaitTone).toBe(true);
    expect(snapshot.session.firstDragIntervened).toBe(true);
    expect(snapshot.session.focusBlurOn).toBe(false);
    expect(snapshot.session.focusScrimOn).toBe(true);
    expect(snapshot.suspendChainRootTaskId).toBeNull();
    expect(snapshot.suspendRecommendationLocked).toBe(false);
    expect(snapshot.dailyResetDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(snapshot.entries[0]?.zoneSource).toBe('auto');
  });

  it('dock preference changes should write a recoverable local snapshot before returning success', async () => {
    seedTask('A');
    await service.dockTask('A');

    await expect(service.setDockExpanded(true)).resolves.toBe(true);
    let shadow = JSON.parse(
      localStorage.getItem('nanoflow.dock-snapshot.v3.user-1') ?? '{}',
    ) as DockSnapshot;
    expect(shadow.isDockExpanded).toBe(true);

    await expect(service.toggleMuteWaitTone()).resolves.toBe(true);
    shadow = JSON.parse(
      localStorage.getItem('nanoflow.dock-snapshot.v3.user-1') ?? '{}',
    ) as DockSnapshot;
    expect(shadow.muteWaitTone).toBe(true);
    expect(shadow.entries.every(entry => entry.snoozeRingMuted === true)).toBe(true);
  });

  it('dock preference signal changes should wait for durable local persistence', async () => {
    let resolvePersist!: () => void;
    mockIdbSet.mockResolvedValueOnce(undefined);
    mockIdbSet.mockImplementationOnce(() => new Promise<void>(resolve => {
      resolvePersist = resolve;
    }));

    seedTask('A');
    await service.dockTask('A');

    const result = service.setDockExpanded(true);
    let shadow = JSON.parse(
      localStorage.getItem('nanoflow.dock-snapshot.v3.user-1') ?? '{}',
    ) as DockSnapshot;
    expect(shadow.isDockExpanded).toBe(true);
    expect(service.dockExpanded()).toBe(false);
    expect(service.exportSnapshot().isDockExpanded).toBe(false);

    await flushMicrotasks();
    resolvePersist();

    await expect(result).resolves.toBe(true);
    expect(service.dockExpanded()).toBe(true);
    expect(service.exportSnapshot().isDockExpanded).toBe(true);
  });

  it('dock preference signal changes should stay unchanged when local persistence fails', async () => {
    seedTask('A');
    await service.dockTask('A');
    mockIdbSet.mockRejectedValueOnce(new Error('idb unavailable'));
    mockIdbSet.mockRejectedValueOnce(new Error('idb unavailable'));

    await expect(service.setDockExpanded(true)).resolves.toBe(false);

    expect(service.dockExpanded()).toBe(false);
    expect(service.exportSnapshot().isDockExpanded).toBe(false);
  });

  it('toggleFocusScrim should flip scrim visibility without changing focus mode', async () => {
    expect(service.focusMode()).toBe(false);
    expect(service.focusScrimOn()).toBe(true);

    await expect(service.toggleFocusScrim()).resolves.toBe(true);
    expect(service.focusScrimOn()).toBe(false);
    expect(service.focusMode()).toBe(false);
    let shadow = JSON.parse(
      localStorage.getItem('nanoflow.dock-snapshot.v3.user-1') ?? '{}',
    ) as DockSnapshot;
    expect(shadow.session.focusScrimOn).toBe(false);

    await expect(service.setFocusScrim(true)).resolves.toBe(true);
    expect(service.focusScrimOn()).toBe(true);
    expect(service.focusMode()).toBe(false);
    shadow = JSON.parse(
      localStorage.getItem('nanoflow.dock-snapshot.v3.user-1') ?? '{}',
    ) as DockSnapshot;
    expect(shadow.session.focusScrimOn).toBe(true);
  });

  it('focus scrim changes should wait for durable local persistence', async () => {
    let resolvePersist!: () => void;
    mockIdbSet.mockImplementationOnce(() => new Promise<void>(resolve => {
      resolvePersist = resolve;
    }));

    const result = service.toggleFocusScrim();
    const shadow = JSON.parse(
      localStorage.getItem('nanoflow.dock-snapshot.v3.user-1') ?? '{}',
    ) as DockSnapshot;
    expect(shadow.session.focusScrimOn).toBe(false);
    expect(service.focusScrimOn()).toBe(true);

    await flushMicrotasks();
    resolvePersist();

    await expect(result).resolves.toBe(true);
    expect(service.focusScrimOn()).toBe(false);
  });

  it('focus scrim changes should stay unchanged when local persistence fails', async () => {
    mockIdbSet.mockRejectedValueOnce(new Error('idb unavailable'));
    mockIdbSet.mockRejectedValueOnce(new Error('idb unavailable'));

    await expect(service.toggleFocusScrim()).resolves.toBe(false);

    expect(service.focusScrimOn()).toBe(true);
  });

  it('toggleFocusMode should reset scrim to true on enter', async () => {
    await service.setFocusScrim(false);
    expect(service.focusMode()).toBe(false);
    expect(service.focusScrimOn()).toBe(false);

    await expect(service.toggleFocusMode()).resolves.toBe(true);
    expect(service.focusMode()).toBe(true);
    expect(service.focusScrimOn()).toBe(true);
    let shadow = JSON.parse(
      localStorage.getItem('nanoflow.dock-snapshot.v3.user-1') ?? '{}',
    ) as DockSnapshot;
    expect(shadow.focusMode).toBe(true);
    expect(shadow.session.focusScrimOn).toBe(true);
    expect(shadow.focusSessionState?.isActive).toBe(true);

    await expect(service.toggleFocusMode()).resolves.toBe(true);
    expect(service.focusMode()).toBe(false);
    shadow = JSON.parse(
      localStorage.getItem('nanoflow.dock-snapshot.v3.user-1') ?? '{}',
    ) as DockSnapshot;
    expect(shadow.focusMode).toBe(false);
    expect(shadow.focusSessionState).toBeNull();
  });

  it('toggleFocusMode should preserve an exiting transition until the coordinator settles it', async () => {
    service.toggleFocusMode();
    expect(service.focusMode()).toBe(true);

    service.beginFocusTransition({
      phase: 'exiting',
      direction: 'exit',
      fromRect: { left: 12, top: 24, width: 180, height: 96 },
      toRect: { left: 18, top: 640, width: 220, height: 108 },
      durationMs: 280,
      startedAt: new Date().toISOString(),
    });

    service.toggleFocusMode();

    expect(service.focusMode()).toBe(false);
    expect(service.focusTransition()?.phase).toBe('exiting');
  });

  it('toggleFocusMode should clear a settled focused transition on direct exit', async () => {
    service.toggleFocusMode();
    expect(service.focusMode()).toBe(true);

    service.beginFocusTransition({
      phase: 'focused',
      direction: 'enter',
      fromRect: { left: 12, top: 640, width: 180, height: 96 },
      toRect: { left: 18, top: 24, width: 220, height: 108 },
      durationMs: 340,
      startedAt: new Date().toISOString(),
    });

    service.toggleFocusMode();

    expect(service.focusMode()).toBe(false);
    expect(service.focusTransition()).toBeNull();
  });

  it('restoreSnapshot should restore dock expanded and mute preference', async () => {
    service.restoreSnapshot({
      version: 4,
      entries: [],
      focusMode: true,
      isDockExpanded: false,
      muteWaitTone: true,
      session: {
        firstDragIntervened: true,
        focusBlurOn: true,
        focusScrimOn: false,
        mainTaskId: null,
        comboSelectIds: [],
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

    expect(service.focusMode()).toBe(true);
    expect(service.dockExpanded()).toBe(false);
    expect(service.muteWaitTone()).toBe(true);
    expect(service.focusScrimOn()).toBe(false);
  });

  it('restoreSnapshot should default focusScrimOn=true for legacy snapshots', async () => {
    const legacySnapshot = {
      version: 4,
      entries: [],
      focusMode: true,
      isDockExpanded: true,
      muteWaitTone: false,
      session: {
        firstDragIntervened: true,
        focusBlurOn: true,
        mainTaskId: null,
        comboSelectIds: [],
        backupIds: [],
      },
      firstDragDone: true,
      dailySlots: [],
      suspendChainRootTaskId: null,
      suspendRecommendationLocked: false,
      pendingDecision: null,
      dailyResetDate: '2026-02-25',
      savedAt: new Date().toISOString(),
    } as unknown as Parameters<DockEngineService['restoreSnapshot']>[0];
    service.restoreSnapshot(legacySnapshot);

    expect(service.focusScrimOn()).toBe(true);
  });

  it('restoreSnapshot should migrate legacy v3 zone fields into v4 lane fields', async () => {
    service.restoreSnapshot({
      version: 3 as unknown as 4,
      entries: [
        {
          taskId: 'legacy-1',
          title: 'Legacy 1',
          sourceProjectId: 'project-1',
          status: 'pending_start',
          load: 'low',
          expectedMinutes: 20,
          waitMinutes: null,
          waitStartedAt: null,
          zone: 'strong',
          zoneSource: 'manual',
          isMain: true,
          dockedOrder: 0,
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
        mainTaskId: 'legacy-1',
        strongZoneIds: ['legacy-1'],
        weakZoneIds: [],
      },
      firstDragDone: true,
      dailySlots: [],
      suspendChainRootTaskId: null,
      suspendRecommendationLocked: false,
      pendingDecision: null,
      dailyResetDate: '2026-02-25',
      savedAt: new Date().toISOString(),
    } as unknown as DockSnapshot);

    const entry = service.entries().find(item => item.taskId === 'legacy-1');
    expect(entry?.lane).toBe('combo-select');
    expect(service.exportSnapshot().version).toBe(7);
  });
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
