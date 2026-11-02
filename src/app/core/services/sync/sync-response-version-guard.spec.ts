import { describe, expect, it } from 'vitest';

import {
  captureSyncResponseVersion,
  isSyncResponseVersionCurrent,
} from './sync-response-version-guard';

describe('sync response version guard', () => {
  it('treats unchanged updatedAt/deletedAt as the same request version', () => {
    const requestVersion = captureSyncResponseVersion({
      updatedAt: '2026-07-14T00:00:00.000Z',
      deletedAt: null,
    });

    expect(isSyncResponseVersionCurrent(requestVersion, [{
      updatedAt: '2026-07-14T00:00:00.000Z',
      deletedAt: undefined,
    }])).toBe(true);
  });

  it('rejects a late response when the local updatedAt changed after request start', () => {
    const requestVersion = captureSyncResponseVersion({
      updatedAt: '2026-07-14T00:00:00.000Z',
      deletedAt: null,
    });

    expect(isSyncResponseVersionCurrent(requestVersion, [{
      updatedAt: '2026-07-14T00:05:00.000Z',
      deletedAt: null,
    }])).toBe(false);
  });

  it('rejects a late response when a local tombstone appeared after request start', () => {
    const requestVersion = captureSyncResponseVersion({
      updatedAt: '2026-07-14T00:00:00.000Z',
      deletedAt: null,
    });

    expect(isSyncResponseVersionCurrent(requestVersion, [{
      updatedAt: '2026-07-14T00:00:00.000Z',
      deletedAt: '2026-07-14T00:03:00.000Z',
    }])).toBe(false);
  });
});
