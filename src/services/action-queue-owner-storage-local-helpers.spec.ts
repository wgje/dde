import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  readOwnerDeadLetterSnapshotFromLocalStorage,
  readOwnerQueueSnapshotFromLocalStorage,
  type ActionQueueOwnerScopedStorageOptions,
} from './action-queue-owner-storage-local-helpers';
import { LOCAL_QUEUE_CONFIG } from './action-queue-storage.helpers';

describe('action queue owner storage local helpers', () => {
  const ownerUserId = 'user-a';
  const getScopedStorageKey = (baseKey: string, owner: string) => `${baseKey}.${owner}`;

  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('returns a corrupted queue snapshot when warn throws while reading invalid JSON', () => {
    const storageKey = getScopedStorageKey(LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY, ownerUserId);
    const warn = vi.fn(() => {
      throw new Error('warn failed');
    });
    localStorage.setItem(storageKey, '{invalid-json');

    let snapshot: ReturnType<typeof readOwnerQueueSnapshotFromLocalStorage> | undefined;
    expect(() => {
      snapshot = readOwnerQueueSnapshotFromLocalStorage(createOptions(warn));
    }).not.toThrow();

    expect(snapshot).toMatchObject({
      found: false,
      queue: [],
      corrupted: true,
      storageKey,
    });
    expect(snapshot?.error).toBeInstanceOf(SyntaxError);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('returns an empty dead-letter queue when warn throws while reading invalid JSON', () => {
    const storageKey = getScopedStorageKey(LOCAL_QUEUE_CONFIG.DEAD_LETTER_STORAGE_KEY, ownerUserId);
    const warn = vi.fn(() => {
      throw new Error('warn failed');
    });
    localStorage.setItem(storageKey, '{invalid-json');

    expect(() => {
      expect(readOwnerDeadLetterSnapshotFromLocalStorage(createOptions(warn))).toEqual([]);
    }).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  function createOptions(
    warn: ActionQueueOwnerScopedStorageOptions['logger']['warn'],
  ): ActionQueueOwnerScopedStorageOptions {
    return {
      ownerUserId,
      getScopedStorageKey,
      logger: { warn },
    };
  }
});
