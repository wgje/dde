import { describe, expect, it, afterEach, vi } from 'vitest';
import { configureOfflineSyncActionCaptureHooks, getOfflineSyncActionCaptureHooks } from './offline-sync-action-capture-registry';

describe('offline-sync-action-capture-registry', () => {
  afterEach(() => configureOfflineSyncActionCaptureHooks(null));

  it('is disabled by default and accepts an explicit capture hook', () => {
    expect(getOfflineSyncActionCaptureHooks()).toBeNull();
    configureOfflineSyncActionCaptureHooks({ enabled: true, captureQueuedAction: vi.fn().mockResolvedValue(undefined) });
    expect(getOfflineSyncActionCaptureHooks()?.enabled).toBe(true);
  });
});
