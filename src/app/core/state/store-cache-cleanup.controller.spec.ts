import { beforeEach, describe, expect, it, vi } from 'vitest';

import { StoreCacheCleanupController } from './store-cache-cleanup.controller';
import { getStorePersistenceFallbackKey } from './store-persistence-fallback';

function createSuccessfulController() {
  const objectStore = {
    clear: vi.fn(),
    delete: vi.fn(),
  };
  const transaction = {
    objectStore: vi.fn(() => objectStore),
  } as unknown as IDBTransaction;
  const logger = {
    info: vi.fn(),
    error: vi.fn(),
  };
  const controller = new StoreCacheCleanupController({
    initDatabase: vi.fn().mockResolvedValue({
      transaction: vi.fn(() => transaction),
    } as unknown as IDBDatabase),
    logger,
  });
  vi.spyOn(
    controller as unknown as {
      deleteRecordsByProjectId(store: IDBObjectStore, projectId: string): Promise<void>;
    },
    'deleteRecordsByProjectId',
  ).mockResolvedValue(undefined);
  vi.spyOn(
    controller as unknown as {
      waitForTransaction(value: IDBTransaction): Promise<void>;
    },
    'waitForTransaction',
  ).mockResolvedValue(undefined);
  return { controller, logger };
}

describe('StoreCacheCleanupController', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('deleteProject should remove only the committed project fallback snapshot', async () => {
    const { controller } = createSuccessfulController();
    const deletedKey = getStorePersistenceFallbackKey('project-1');
    const preservedKey = getStorePersistenceFallbackKey('project-2');
    localStorage.setItem(deletedKey, '{"project":"deleted"}');
    localStorage.setItem(preservedKey, '{"project":"preserved"}');
    localStorage.setItem('unrelated-key', 'preserved');

    await controller.deleteProject('project-1');

    expect(localStorage.getItem(deletedKey)).toBeNull();
    expect(localStorage.getItem(preservedKey)).toBe('{"project":"preserved"}');
    expect(localStorage.getItem('unrelated-key')).toBe('preserved');
  });

  it('clearAll should remove every committed store fallback snapshot', async () => {
    const { controller } = createSuccessfulController();
    localStorage.setItem(getStorePersistenceFallbackKey('project-1'), '{}');
    localStorage.setItem(getStorePersistenceFallbackKey('project-2'), '{}');
    localStorage.setItem('unrelated-key', 'preserved');

    await controller.clearAll();

    expect(localStorage.getItem(getStorePersistenceFallbackKey('project-1'))).toBeNull();
    expect(localStorage.getItem(getStorePersistenceFallbackKey('project-2'))).toBeNull();
    expect(localStorage.getItem('unrelated-key')).toBe('preserved');
  });

  it('waitForTransaction should reject when IndexedDB aborts the cleanup transaction', async () => {
    const controller = new StoreCacheCleanupController({
      initDatabase: vi.fn(),
      logger: { info: vi.fn(), error: vi.fn() },
    });
    const abortError = new DOMException('quota exceeded', 'AbortError');
    const transaction = {
      error: abortError,
      oncomplete: null,
      onerror: null,
      onabort: null,
    } as unknown as IDBTransaction;
    const completion = (
      controller as unknown as {
        waitForTransaction(value: IDBTransaction): Promise<void>;
      }
    ).waitForTransaction(transaction);

    expect(transaction.onabort).toEqual(expect.any(Function));
    transaction.onabort?.(new Event('abort'));

    await expect(completion).rejects.toBe(abortError);
  });

  it('deleteProject should swallow cache cleanup failure when error logger throws', async () => {
    const dbError = new Error('indexeddb unavailable');
    const fallbackKey = getStorePersistenceFallbackKey('project-1');
    localStorage.setItem(fallbackKey, '{"project":"recoverable"}');
    const logger = {
      info: vi.fn(),
      error: vi.fn(() => {
        throw new Error('logger unavailable');
      }),
    };
    const controller = new StoreCacheCleanupController({
      initDatabase: vi.fn().mockRejectedValue(dbError),
      logger,
    });

    await expect(controller.deleteProject('project-1')).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith(
      '删除项目缓存失败',
      expect.objectContaining({
        projectId: 'project-1',
        error: dbError,
      }),
    );
    expect(localStorage.getItem(fallbackKey)).toBe('{"project":"recoverable"}');
  });

  it('clearAll should swallow cache cleanup failure when error logger throws', async () => {
    const dbError = new Error('indexeddb unavailable');
    const fallbackKey = getStorePersistenceFallbackKey('project-1');
    localStorage.setItem(fallbackKey, '{"project":"recoverable"}');
    const logger = {
      info: vi.fn(),
      error: vi.fn(() => {
        throw new Error('logger unavailable');
      }),
    };
    const controller = new StoreCacheCleanupController({
      initDatabase: vi.fn().mockRejectedValue(dbError),
      logger,
    });

    await expect(controller.clearAll()).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith('清除缓存失败', dbError);
    expect(localStorage.getItem(fallbackKey)).toBe('{"project":"recoverable"}');
  });
});
