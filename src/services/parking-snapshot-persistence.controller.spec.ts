import { describe, expect, it, vi } from 'vitest';

import type { ParkingSnapshot, Task, TaskParkingMeta } from '../models';
import { ParkingSnapshotPersistenceController } from './parking-snapshot-persistence.controller';

describe('ParkingSnapshotPersistenceController', () => {
  const draftKey = 'parking-draft-test';

  it('writes a focused task snapshot draft to localStorage', () => {
    localStorage.removeItem(draftKey);
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
    expect(saveParkedTasksCache).toHaveBeenCalledWith({
      entries: [{ task: focused, projectId: 'project-1' }],
      cursor: 'cursor-1',
    });
  });

  it('restores a newer localStorage draft and removes it afterwards', () => {
    const focused = taskWithSnapshot(snapshot({ savedAt: '2026-02-23T10:00:00.000Z' }));
    localStorage.setItem(draftKey, JSON.stringify({
      taskId: 'task-1',
      contentHash: 'new-hash',
      cursorPosition: { line: 9, column: 3 },
      structuralAnchor: { taskId: 'anchor-task', offset: 2 },
      savedAt: '2026-02-23T10:01:00.000Z',
    }));
    const updateParkingMeta = vi.fn();
    const controller = createController({
      taskById: () => focused,
      updateParkingMeta,
    });

    controller.restoreSnapshotDraftFromLocalStorage();

    expect(updateParkingMeta).toHaveBeenCalledWith('task-1', expect.objectContaining({
      contextSnapshot: expect.objectContaining({
        savedAt: '2026-02-23T10:01:00.000Z',
        contentHash: 'new-hash',
        cursorPosition: { line: 9, column: 3 },
      }),
    }));
    expect(localStorage.getItem(draftKey)).toBeNull();
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
