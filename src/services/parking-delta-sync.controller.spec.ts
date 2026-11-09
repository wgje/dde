import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Task } from '../models';
import { ParkingDeltaSyncController } from './parking-delta-sync.controller';

describe('ParkingDeltaSyncController', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('retires legacy cache after a successful full rebuild that started from since=null', async () => {
    const saveParkedTasksCache = vi.fn(async () => {});
    const { controller, pullParkedTasksDelta } = createController({
      cursor: null,
      saveParkedTasksCache,
      pullResult: {
        entries: [],
        removedTaskIds: [],
        nextCursor: 'full-rebuild-cursor',
        isComplete: true,
      },
    });

    await controller.syncParkedDelta();

    expect(pullParkedTasksDelta).toHaveBeenCalledWith(null, [], ['project-1']);
    expect(saveParkedTasksCache).toHaveBeenCalledWith('owner-a', {
      entries: [],
      cursor: 'full-rebuild-cursor',
    }, {
      retireLegacyOwnerlessCache: true,
    });
  });

  it('does not request legacy retirement for an incremental save', async () => {
    const remoteTask = createParkedTask('remote-task');
    const saveParkedTasksCache = vi.fn(async () => {});
    const { controller } = createController({
      cursor: 'existing-cursor',
      parkedTasks: () => [remoteTask],
      findProjectId: () => 'project-1',
      saveParkedTasksCache,
      pullResult: {
        entries: [{ task: remoteTask, projectId: 'project-1' }],
        removedTaskIds: [],
        nextCursor: 'next-cursor',
        isComplete: true,
      },
    });

    await controller.syncParkedDelta();

    expect(saveParkedTasksCache).toHaveBeenCalledWith('owner-a', {
      entries: [{ task: remoteTask, projectId: 'project-1' }],
      cursor: 'next-cursor',
    });
    expect(saveParkedTasksCache.mock.calls[0]).toHaveLength(2);
  });

  it('does not request legacy retirement when a full rebuild is incomplete', async () => {
    const remoteTask = createParkedTask('partial-task');
    const saveParkedTasksCache = vi.fn(async () => {});
    const { controller } = createController({
      cursor: null,
      parkedTasks: () => [remoteTask],
      findProjectId: () => 'project-1',
      saveParkedTasksCache,
      pullResult: {
        entries: [{ task: remoteTask, projectId: 'project-1' }],
        removedTaskIds: [],
        nextCursor: null,
        isComplete: false,
      },
    });

    await controller.syncParkedDelta();

    expect(saveParkedTasksCache).toHaveBeenCalledWith('owner-a', {
      entries: [{ task: remoteTask, projectId: 'project-1' }],
      cursor: null,
    });
    expect(saveParkedTasksCache.mock.calls[0]).toHaveLength(2);
  });

  it('does not request legacy retirement when the full rebuild fails', async () => {
    const saveParkedTasksCache = vi.fn(async () => {});
    const { controller, pullParkedTasksDelta } = createController({
      cursor: null,
      saveParkedTasksCache,
    });
    pullParkedTasksDelta.mockRejectedValueOnce(new Error('remote rebuild failed'));

    await expect(controller.syncParkedDelta()).rejects.toThrow('remote rebuild failed');

    expect(saveParkedTasksCache).not.toHaveBeenCalled();
  });

  it('does not request legacy retirement when the owner changes during the full rebuild', async () => {
    let currentOwnerUserId = 'owner-a';
    let resolvePull!: (value: {
      entries: [];
      removedTasks: [];
      removedTaskIds: [];
      nextCursor: string;
      isComplete: boolean;
    }) => void;
    const pendingPull = new Promise<{
      entries: [];
      removedTasks: [];
      removedTaskIds: [];
      nextCursor: string;
      isComplete: boolean;
    }>((resolve) => {
      resolvePull = resolve;
    });
    const saveParkedTasksCache = vi.fn(async () => {});
    const { controller, pullParkedTasksDelta } = createController({
      cursor: null,
      currentUserId: () => currentOwnerUserId,
      saveParkedTasksCache,
    });
    pullParkedTasksDelta.mockReturnValueOnce(pendingPull);

    const sync = controller.syncParkedDelta();
    currentOwnerUserId = 'owner-b';
    resolvePull({
      entries: [],
      removedTasks: [],
      removedTaskIds: [],
      nextCursor: 'stale-cursor',
      isComplete: true,
    });
    await sync;

    expect(saveParkedTasksCache).not.toHaveBeenCalled();
  });
});

interface CreateControllerOptions {
  cursor?: string | null;
  currentUserId?: () => string | null;
  parkedTasks?: () => Task[];
  findProjectId?: (taskId: string) => string | null;
  saveParkedTasksCache?: ConstructorParameters<
    typeof ParkingDeltaSyncController
  >[0]['saveParkedTasksCache'];
  pullResult?: {
    entries: Array<{ task: Task; projectId: string }>;
    removedTasks?: Array<{ taskId: string; updatedAt: string | null }>;
    removedTaskIds: string[];
    nextCursor: string | null;
    isComplete: boolean;
  };
}

function createController(options: CreateControllerOptions = {}) {
  let cursor = options.cursor ?? null;
  const pullParkedTasksDelta = vi.fn(async () => options.pullResult
    ? { removedTasks: [], ...options.pullResult }
    : {
        entries: [],
        removedTasks: [],
        removedTaskIds: [],
        nextCursor: cursor,
        isComplete: true,
      });
  const saveParkedTasksCache = options.saveParkedTasksCache ?? vi.fn(async () => {});
  const controller = new ParkingDeltaSyncController({
    logger: {
      debug: vi.fn(),
      warn: vi.fn(),
    },
    isDestroyed: () => false,
    currentUserId: options.currentUserId ?? (() => 'owner-a'),
    knownParkedTaskIds: () => [],
    activeProjectIds: () => ['project-1'],
    pullParkedTasksDelta,
    getTask: () => undefined,
    setTask: vi.fn(),
    parkedTasks: options.parkedTasks ?? (() => []),
    findProjectId: options.findProjectId ?? (() => null),
    saveParkedTasksCache,
    getParkedCursor: () => cursor,
    setParkedCursor: (nextCursor) => { cursor = nextCursor; },
    getRecoveryTimer: () => null,
    setRecoveryTimer: vi.fn(),
  });

  return { controller, pullParkedTasksDelta, saveParkedTasksCache };
}

function createParkedTask(id: string): Task {
  return {
    id,
    title: id,
    content: '',
    stage: null,
    parentId: null,
    order: 0,
    rank: 0,
    status: 'active',
    x: 0,
    y: 0,
    createdDate: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    displayId: id,
    parkingMeta: {
      state: 'parked',
      parkedAt: '2026-07-01T00:00:00.000Z',
      lastVisitedAt: '2026-07-01T00:00:00.000Z',
      contextSnapshot: null,
      reminder: null,
      pinned: false,
    },
  };
}
