import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ParkingSnapshot, Task, TaskParkingMeta } from '../models';
import { ParkingSnapshotPersistenceController } from './parking-snapshot-persistence.controller';

describe('ParkingSnapshotPersistenceController', () => {
  const draftKey = 'parking-draft-test';
  const writeDraft = (overrides: Record<string, unknown> = {}) => localStorage.setItem(draftKey, JSON.stringify({
    taskId: 'task-1',
    contentHash: 'new-hash',
    cursorPosition: { line: 9, column: 3 },
    structuralAnchor: { taskId: 'anchor-task', offset: 2 },
    savedAt: '2026-02-23T10:01:00.000Z', ...overrides,
  }));
  beforeEach(() => localStorage.removeItem(draftKey));
  const restore = (
    updateParkingMeta: ConstructorParameters<typeof ParkingSnapshotPersistenceController>[0]['updateParkingMeta'],
  ) => createController({ taskById: () => taskWithSnapshot(snapshot()), updateParkingMeta })
    .restoreSnapshotDraftFromLocalStorage();
  it('writes a focused task snapshot draft to localStorage', () => {
    const focused = taskWithSnapshot(snapshot({ savedAt: '2026-02-23T10:00:00.000Z' }));
    const controller = createController({ focusedTask: () => focused });
    controller.saveSnapshotToLocalStorage();
    expect(JSON.parse(localStorage.getItem(draftKey) ?? '{}')).toMatchObject({
      taskId: 'task-1',
      contentHash: 'hash',
      savedAt: expect.any(String),
    });
  });

  it('saves the focused full snapshot and parked task cache to IndexedDB', async () => {
    const focused = taskWithSnapshot(snapshot());
    const saveFullSnapshot = vi.fn();
    const saveParkedTasksCache = vi.fn(async () => {});
    const controller = createController({
      focusedTask: () => focused,
      parkedTasks: () => [focused],
      findProjectId: () => 'project-1',
      saveFullSnapshot,
      saveParkedTasksCache,
      parkedCursor: () => 'cursor-1',
    });
    await controller.saveSnapshotToIndexedDB();
    expect(saveFullSnapshot).toHaveBeenCalledWith('task-1');
    expect(saveParkedTasksCache).toHaveBeenCalledWith('user-1', {
      entries: [{ task: focused, projectId: 'project-1' }],
      cursor: 'cursor-1',
    });
    expect(saveParkedTasksCache.mock.calls[0]).toHaveLength(2);
  });

  it('restores a newer localStorage draft and removes it afterwards', () => {
    const focused = taskWithSnapshot(snapshot({ savedAt: '2026-02-23T10:00:00.000Z' }));
    writeDraft();
    const updateParkingMeta = vi.fn(() => true);
    const controller = createController({
      taskById: () => focused,
      updateParkingMeta,
    });

    expect(controller.restoreSnapshotDraftFromLocalStorage()).toBeUndefined();

    expect(updateParkingMeta).toHaveBeenCalledWith('task-1', expect.objectContaining({
      contextSnapshot: expect.objectContaining({
        savedAt: '2026-02-23T10:01:00.000Z',
        contentHash: 'new-hash',
        cursorPosition: { line: 9, column: 3 },
      }),
    }));
    expect(localStorage.getItem(draftKey)).toBeNull();
  });

  it('retains the draft when synchronous persistence is unacknowledged or throws', () => {
    writeDraft();
    restore(() => false);
    expect(localStorage.getItem(draftKey)).not.toBeNull();
    const error = new Error('write failed');
    expect(() => restore(() => { throw error; })).toThrow(error);
    expect(localStorage.getItem(draftKey)).not.toBeNull();
  });

  it('retains pending/false/rejected async writes and removes only after true acknowledgement', async () => {
    let resolve!: (value: boolean) => void;
    const pending = new Promise<boolean>((settle) => { resolve = settle; });
    writeDraft();
    restore(() => pending);
    expect(localStorage.getItem(draftKey)).not.toBeNull();
    resolve(true);
    writeDraft({ contentHash: 'replacement' });
    await pending;
    expect(JSON.parse(localStorage.getItem(draftKey) ?? '{}').contentHash).toBe('replacement');
    restore(async () => true);
    await Promise.resolve();
    expect(localStorage.getItem(draftKey)).toBeNull();
    writeDraft();
    restore(async () => false);
    await Promise.resolve();
    expect(localStorage.getItem(draftKey)).not.toBeNull();
    restore(async () => { throw new Error('rejected'); });
    await Promise.resolve();
    expect(localStorage.getItem(draftKey)).not.toBeNull();
  });

  it('cleans drafts that are stale, equal, or reference a missing task', () => {
    for (const task of [
      taskWithSnapshot(snapshot({ savedAt: '2026-02-23T10:02:00.000Z' })),
      taskWithSnapshot(snapshot({ savedAt: '2026-02-23T10:01:00.000Z' })),
      undefined,
    ]) {
      writeDraft();
      createController({ taskById: () => task }).restoreSnapshotDraftFromLocalStorage();
      expect(localStorage.getItem(draftKey)).toBeNull();
    }
  });

  it('preserves malformed and missing-draft behavior', () => {
    const updateParkingMeta = vi.fn(() => true);
    localStorage.setItem(draftKey, 'malformed');
    const controller = createController({ updateParkingMeta });
    controller.restoreSnapshotDraftFromLocalStorage();
    expect(localStorage.getItem(draftKey)).toBe('malformed');
    localStorage.removeItem(draftKey);
    controller.restoreSnapshotDraftFromLocalStorage();
    expect(updateParkingMeta).not.toHaveBeenCalled();
  });

  function createController(
    overrides: Partial<ConstructorParameters<typeof ParkingSnapshotPersistenceController>[0]> = {}
  ): ParkingSnapshotPersistenceController {
    return new ParkingSnapshotPersistenceController({
      draftKey,
      focusedTask: () => null,
      parkedTasks: () => [],
      taskById: () => undefined,
      findProjectId: () => null,
      updateParkingMeta: vi.fn(),
      saveFullSnapshot: vi.fn(),
      currentOwnerUserId: () => 'user-1',
      saveParkedTasksCache: vi.fn(async () => {}),
      parkedCursor: () => null,
      ...overrides,
    });
  }
});

function snapshot(overrides: Partial<ParkingSnapshot> = {}): ParkingSnapshot {
  return {
    savedAt: '2026-02-23T10:00:00.000Z',
    contentHash: 'hash',
    viewMode: 'text',
    cursorPosition: { line: 1, column: 2 },
    scrollAnchor: null,
    structuralAnchor: { taskId: 'anchor', offset: 3 } as unknown as ParkingSnapshot['structuralAnchor'],
    flowViewport: null,
    ...overrides,
  };
}

function taskWithSnapshot(contextSnapshot: ParkingSnapshot): Task {
  return {
    id: 'task-1',
    title: 'Task',
    content: '',
    stage: 0,
    order: 0,
    parkingMeta: {
      state: 'focused',
      parkedAt: '2026-02-23T09:00:00.000Z',
      lastVisitedAt: '2026-02-23T09:30:00.000Z',
      contextSnapshot,
      reminder: null,
      pinned: false,
    } satisfies TaskParkingMeta,
  } as Task;
}
