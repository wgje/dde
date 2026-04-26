import { describe, expect, it } from 'vitest';

import {
  promoteSecondaryTaskToC2,
  type DockEntryLike,
  type DockSnapshotLike,
} from '../../../supabase/functions/widget-focus-action/focus-reorder.ts';

const SAVED_AT = '2026-04-24T08:30:00.000Z';

function entry(
  taskId: string,
  overrides: Partial<DockEntryLike> = {},
): DockEntryLike {
  return {
    taskId,
    title: taskId,
    sourceProjectId: 'project-1',
    expectedMinutes: 25,
    waitMinutes: null,
    load: 'low',
    status: 'pending_start',
    lane: 'combo-select',
    isMain: false,
    dockedOrder: 1,
    manualOrder: 1,
    ...overrides,
  };
}

function baseSnapshot(): DockSnapshotLike {
  return {
    version: 7,
    focusMode: true,
    entries: [
      entry('main', { isMain: true, status: 'focusing', lane: 'combo-select', dockedOrder: 0, manualOrder: 0 }),
      entry('a', { dockedOrder: 1, manualOrder: 1 }),
      entry('b', { dockedOrder: 2, manualOrder: 2 }),
      entry('c', { dockedOrder: 3, manualOrder: 3 }),
      entry('d', { lane: 'backup', dockedOrder: 4, manualOrder: 4 }),
      entry('done', { status: 'completed', lane: 'backup', dockedOrder: 99, manualOrder: 99 }),
    ],
    session: {
      mainTaskId: 'main',
      comboSelectIds: ['a', 'b', 'c'],
      backupIds: ['d'],
      focusSessionId: 'session-1',
      focusSessionStartedAt: 1710000000000,
    },
    focusSessionState: {
      schemaVersion: 2,
      sessionId: 'session-1',
      sessionStartedAt: 1710000000000,
      isActive: true,
      isFocusOverlayOn: false,
      commandCenterOrderIds: ['main', 'a', 'b', 'c'],
      commandCenterTasks: [{ taskId: 'main', zone: 'command', zoneIndex: 0, isMaster: true }],
      comboSelectTasks: [
        { taskId: 'a', zone: 'combo-select', zoneIndex: 0, isMaster: false },
        { taskId: 'b', zone: 'combo-select', zoneIndex: 1, isMaster: false },
        { taskId: 'c', zone: 'combo-select', zoneIndex: 2, isMaster: false },
      ],
      backupTasks: [{ taskId: 'd', zone: 'backup', zoneIndex: 0, isMaster: false }],
    },
    savedAt: '2026-04-24T08:00:00.000Z',
  };
}

function expectOk(result: ReturnType<typeof promoteSecondaryTaskToC2>) {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(result.error);
  }
  return result;
}

describe('widget focus reorder helper', () => {
  it('moves a selected backup task to slot #1 while keeping master ownership unchanged', () => {
    const result = expectOk(promoteSecondaryTaskToC2(baseSnapshot(), 'd', SAVED_AT));

    expect(result.mainTaskId).toBe('main');
    expect(result.comboSelectIds).toEqual(['d', 'a', 'b']);
    expect(result.backupIds).toEqual(['c']);
    expect(result.snapshot.session?.mainTaskId).toBe('main');
    expect(result.snapshot.session?.comboSelectIds).toEqual(['d', 'a', 'b']);
    expect(result.snapshot.session?.backupIds).toEqual(['c']);
    expect(result.snapshot.focusSessionState?.commandCenterOrderIds).toEqual(['d', 'main', 'a', 'b']);
    expect(result.snapshot.savedAt).toBe(SAVED_AT);

    const entries = result.snapshot.entries ?? [];
    expect(entries.map(item => item.taskId)).toEqual(['d', 'main', 'a', 'b', 'c', 'done']);
    expect(entries.find(item => item.taskId === 'main')).toMatchObject({
      isMain: true,
      status: 'stalled',
      dockedOrder: 1,
      manualOrder: 1,
    });
    expect(entries.find(item => item.taskId === 'd')).toMatchObject({
      lane: 'combo-select',
      isMain: false,
      status: 'focusing',
      dockedOrder: 0,
      manualOrder: 0,
    });
    expect(entries.find(item => item.taskId === 'c')).toMatchObject({
      lane: 'backup',
      dockedOrder: 4,
      manualOrder: 4,
    });
    expect(entries.find(item => item.taskId === 'done')).toMatchObject({
      status: 'completed',
      dockedOrder: 99,
      manualOrder: 99,
    });
  });

  it('keeps remaining secondaries stable when promoting an existing C slot', () => {
    const result = expectOk(promoteSecondaryTaskToC2(baseSnapshot(), 'c', SAVED_AT));

    expect(result.comboSelectIds).toEqual(['c', 'a', 'b']);
    expect(result.backupIds).toEqual(['d']);
    expect(result.snapshot.focusSessionState?.commandCenterOrderIds).toEqual(['c', 'main', 'a', 'b']);
    expect(result.snapshot.focusSessionState?.comboSelectTasks?.map(slot => slot.taskId)).toEqual(['c', 'a', 'b']);
    expect(result.snapshot.focusSessionState?.backupTasks?.map(slot => slot.taskId)).toEqual(['d']);
  });

  it('falls back to combo-select order when legacy snapshots have no commandCenterOrderIds', () => {
    const snapshot = baseSnapshot();
    snapshot.focusSessionState = {
      ...snapshot.focusSessionState,
      commandCenterOrderIds: undefined,
    };

    const result = expectOk(promoteSecondaryTaskToC2(snapshot, 'd', SAVED_AT));

    expect(result.snapshot.focusSessionState?.commandCenterOrderIds).toEqual(['d', 'main', 'a', 'b']);
    expect(result.comboSelectIds).toEqual(['d', 'a', 'b']);
    expect(result.backupIds).toEqual(['c']);
  });

  it('allows the master task to move back to slot #1 without changing ownership', () => {
    const snapshot = baseSnapshot();
    snapshot.entries = snapshot.entries?.map(item => {
      if (item.taskId === 'main') {
        return { ...item, status: 'stalled', dockedOrder: 2, manualOrder: 2 };
      }
      if (item.taskId === 'a') {
        return { ...item, status: 'focusing', dockedOrder: 0, manualOrder: 0 };
      }
      if (item.taskId === 'b') {
        return { ...item, dockedOrder: 1, manualOrder: 1 };
      }
      if (item.taskId === 'c') {
        return { ...item, dockedOrder: 3, manualOrder: 3 };
      }
      return item;
    });
    snapshot.focusSessionState = {
      ...snapshot.focusSessionState,
      commandCenterOrderIds: ['a', 'b', 'main', 'c'],
      comboSelectTasks: [
        { taskId: 'a', zone: 'combo-select', zoneIndex: 0, isMaster: false, focusStatus: 'focusing' },
        { taskId: 'b', zone: 'combo-select', zoneIndex: 1, isMaster: false },
        { taskId: 'c', zone: 'combo-select', zoneIndex: 2, isMaster: false },
      ],
    };

    const result = expectOk(promoteSecondaryTaskToC2(snapshot, 'main', SAVED_AT));

    expect(result.mainTaskId).toBe('main');
    expect(result.comboSelectIds).toEqual(['a', 'b', 'c']);
    expect(result.snapshot.focusSessionState?.commandCenterOrderIds).toEqual(['main', 'a', 'b', 'c']);
    expect(result.snapshot.entries?.find(item => item.taskId === 'main')).toMatchObject({
      isMain: true,
      status: 'focusing',
      dockedOrder: 0,
      manualOrder: 0,
    });
    expect(result.snapshot.entries?.find(item => item.taskId === 'a')).toMatchObject({
      isMain: false,
      status: 'stalled',
      dockedOrder: 1,
      manualOrder: 1,
    });
  });

  it('keeps the explicit main fixed when session.mainTaskId points at a focused secondary', () => {
    const snapshot = baseSnapshot();
    snapshot.session = {
      ...snapshot.session,
      mainTaskId: 'b',
    };
    snapshot.entries = snapshot.entries?.map(item =>
      item.taskId === 'b'
        ? { ...item, status: 'focusing' }
        : item,
    );

    const result = expectOk(promoteSecondaryTaskToC2(snapshot, 'c', SAVED_AT));

    expect(result.mainTaskId).toBe('main');
    expect(result.comboSelectIds).toEqual(['c', 'a', 'b']);
    expect(result.snapshot.session?.mainTaskId).toBe('main');
    expect(result.snapshot.entries?.filter(item => item.isMain === true).map(item => item.taskId)).toEqual(['main']);
    expect(result.snapshot.focusSessionState?.commandCenterTasks?.map(slot => slot.taskId)).toEqual(['main']);
    expect(result.snapshot.focusSessionState?.comboSelectTasks?.map(slot => slot.taskId)).toEqual(['c', 'a', 'b']);
  });

  it('keeps a fourth-slot main visible when promoting a backup task to slot #1', () => {
    const snapshot = baseSnapshot();
    snapshot.entries = [
      entry('main', { isMain: true, status: 'suspended_waiting', lane: 'combo-select', dockedOrder: 3, manualOrder: 3 }),
      entry('a', { status: 'stalled', dockedOrder: 2, manualOrder: 2 }),
      entry('b', { status: 'stalled', dockedOrder: 1, manualOrder: 1 }),
      entry('c', { status: 'focusing', dockedOrder: 0, manualOrder: 0 }),
      entry('d', { lane: 'backup', status: 'pending_start', dockedOrder: 4, manualOrder: 4 }),
    ];
    snapshot.session = {
      ...snapshot.session,
      mainTaskId: 'main',
      comboSelectIds: ['c', 'b', 'a'],
      backupIds: ['d'],
    };
    snapshot.focusSessionState = {
      ...snapshot.focusSessionState,
      commandCenterOrderIds: ['c', 'b', 'a', 'main'],
      commandCenterTasks: [{ taskId: 'main', zone: 'command', zoneIndex: 0, isMaster: true, focusStatus: 'suspend-waiting' }],
      comboSelectTasks: [
        { taskId: 'c', zone: 'combo-select', zoneIndex: 0, isMaster: false, focusStatus: 'focusing' },
        { taskId: 'b', zone: 'combo-select', zoneIndex: 1, isMaster: false, focusStatus: 'stalled' },
        { taskId: 'a', zone: 'combo-select', zoneIndex: 2, isMaster: false, focusStatus: 'stalled' },
      ],
      backupTasks: [{ taskId: 'd', zone: 'backup', zoneIndex: 0, isMaster: false, focusStatus: 'pending' }],
    };

    const result = expectOk(promoteSecondaryTaskToC2(snapshot, 'd', SAVED_AT));

    expect(result.mainTaskId).toBe('main');
    expect(result.snapshot.focusSessionState?.commandCenterOrderIds).toEqual(['d', 'c', 'b', 'main']);
    expect(result.comboSelectIds).toEqual(['d', 'c', 'b']);
    expect(result.backupIds).toEqual(['a']);
    expect(result.snapshot.entries?.find(item => item.taskId === 'main')).toMatchObject({
      isMain: true,
      dockedOrder: 3,
      manualOrder: 3,
    });
  });

  it('rejects completed, missing, and main tasks without changing the snapshot', () => {
    const snapshot = baseSnapshot();

    expect(promoteSecondaryTaskToC2(snapshot, 'done', SAVED_AT)).toMatchObject({
      ok: false,
      code: 'SECONDARY_TASK_NOT_FOUND',
    });
    expect(promoteSecondaryTaskToC2(snapshot, 'missing', SAVED_AT)).toMatchObject({
      ok: false,
      code: 'SECONDARY_TASK_NOT_FOUND',
    });
    expect(snapshot.session?.comboSelectIds).toEqual(['a', 'b', 'c']);
    expect(snapshot.session?.backupIds).toEqual(['d']);
  });

  it('rejects inactive focus snapshots', () => {
    const snapshot = baseSnapshot();
    snapshot.focusMode = false;
    snapshot.focusSessionState = { ...snapshot.focusSessionState, isActive: false };

    expect(promoteSecondaryTaskToC2(snapshot, 'a', SAVED_AT)).toMatchObject({
      ok: false,
      code: 'FOCUS_INACTIVE',
    });
  });
});
