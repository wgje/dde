import { describe, expect, it, vi } from 'vitest';

import { StoreCacheCleanupController } from './store-cache-cleanup.controller';

describe('StoreCacheCleanupController', () => {
  it('deleteProject should swallow cache cleanup failure when error logger throws', async () => {
    const dbError = new Error('indexeddb unavailable');
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
  });

  it('clearAll should swallow cache cleanup failure when error logger throws', async () => {
    const dbError = new Error('indexeddb unavailable');
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
  });
});
