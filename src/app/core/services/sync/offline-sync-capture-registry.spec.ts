import { describe, expect, it, afterEach, vi } from 'vitest';
import {
  configureOfflineSyncCaptureHooks,
  getOfflineSyncCaptureHooks,
} from './offline-sync-capture-registry';

describe('offline-sync-capture-registry', () => {
  afterEach(() => configureOfflineSyncCaptureHooks(null));

  it('is disabled by default and can be configured explicitly', () => {
    expect(getOfflineSyncCaptureHooks()).toBeNull();
    const captureRetryQueueItem = vi.fn().mockResolvedValue(undefined);
    configureOfflineSyncCaptureHooks({ enabled: true, captureRetryQueueItem });
    expect(getOfflineSyncCaptureHooks()).toMatchObject({ enabled: true });
  });
});