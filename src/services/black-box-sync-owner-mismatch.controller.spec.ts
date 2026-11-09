import { describe, expect, it, vi } from 'vitest';

import { AUTH_CONFIG } from '../config/auth.config';
import { type BlackBoxEntry } from '../models/focus';
import { BlackBoxSyncOwnerMismatchController } from './black-box-sync-owner-mismatch.controller';

function createEntry(overrides: Partial<BlackBoxEntry> = {}): BlackBoxEntry {
  return {
    id: 'entry-1',
    projectId: null,
    userId: 'user-1',
    content: 'content',
    date: '2026-03-04',
    createdAt: '2026-03-04T00:00:00.000Z',
    updatedAt: '2026-03-04T00:00:00.000Z',
    isRead: false,
    isCompleted: false,
    isArchived: false,
    deletedAt: null,
    ...overrides,
  };
}

function createController(overrides: Partial<ConstructorParameters<typeof BlackBoxSyncOwnerMismatchController>[0]> = {}) {
  let visibleEntries = new Map<string, BlackBoxEntry>();
  const runtime = {
    deleteFromLocal: vi.fn(async () => undefined),
    getVisibleEntries: vi.fn(() => visibleEntries),
    logger: {
      debug: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
    },
    markEntrySyncConflict: vi.fn(async () => undefined),
    pushToServer: vi.fn(async () => undefined),
    retryQueueHandler: vi.fn(async () => true),
    saveToLocal: vi.fn(async () => undefined),
    setVisibleEntries: vi.fn((entries: BlackBoxEntry[]) => {
      visibleEntries = new Map(entries.map(entry => [entry.id, entry]));
    }),
    updateVisibleEntry: vi.fn((entry: BlackBoxEntry) => {
      visibleEntries = new Map(visibleEntries);
      visibleEntries.set(entry.id, entry);
    }),
    ...overrides,
  };
  const controller = new BlackBoxSyncOwnerMismatchController(runtime);

  return {
    controller,
    runtime,
    setVisibleEntries: (entries: BlackBoxEntry[]) => {
      visibleEntries = new Map(entries.map(entry => [entry.id, entry]));
    },
  };
}

describe('BlackBoxSyncOwnerMismatchController', () => {
  it('rebrands local-mode entries to the cloud session owner and enqueues retry', async () => {
    const { controller, runtime, setVisibleEntries } = createController();
    const localEntry = createEntry({
      userId: AUTH_CONFIG.LOCAL_MODE_USER_ID,
      syncStatus: 'pending',
    });
    setVisibleEntries([localEntry]);

    await controller.selfHealOwnerMismatchedEntry(localEntry, 'cloud-user-1', undefined);

    expect(runtime.saveToLocal).toHaveBeenCalledWith({
      ...localEntry,
      userId: 'cloud-user-1',
      syncStatus: 'pending',
    });
    expect(runtime.updateVisibleEntry).toHaveBeenCalledWith({
      ...localEntry,
      userId: 'cloud-user-1',
      syncStatus: 'pending',
    });
    expect(runtime.retryQueueHandler).toHaveBeenCalledWith({
      ...localEntry,
      userId: 'cloud-user-1',
      syncStatus: 'pending',
    });
    expect(runtime.pushToServer).not.toHaveBeenCalled();
  });

  it('deletes invalid-owner entries locally and removes them from visible entries', async () => {
    const otherEntry = createEntry({ id: 'entry-2', userId: 'user-2' });
    const invalidOwnerEntry = createEntry({ userId: 'dev-preview', syncStatus: 'pending' });
    const { controller, runtime, setVisibleEntries } = createController();
    setVisibleEntries([invalidOwnerEntry, otherEntry]);

    await controller.selfHealOwnerMismatchedEntry(
      invalidOwnerEntry,
      'cloud-user-1',
      undefined,
    );

    expect(runtime.deleteFromLocal).toHaveBeenCalledWith('entry-1');
    expect(runtime.setVisibleEntries).toHaveBeenCalledWith([otherEntry]);
    expect(runtime.markEntrySyncConflict).not.toHaveBeenCalled();
  });
});
