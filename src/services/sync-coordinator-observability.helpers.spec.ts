import { describe, expect, it } from 'vitest';

import { buildSyncObservabilityContext } from './sync-coordinator-observability.helpers';

describe('sync coordinator observability helpers', () => {
  it('builds sentry sync context metrics from persisted counters and queue state', () => {
    expect(buildSyncObservabilityContext({
      attempts: 3,
      confirmed: 2,
      lastSyncTimestamp: '2026-01-01T00:00:00.000Z',
      pendingActions: 4,
      retryQueuePressureEvents: 2,
      actionQueueFrozen: true,
      dirtyAgeMs: 1500,
      lastProjectSyncTime: '2026-01-01T00:00:10.000Z',
      nowMs: Date.parse('2026-01-01T00:00:15.000Z'),
    })).toEqual({
      lastSyncTimestamp: '2026-01-01T00:00:00.000Z',
      pendingActions: 4,
      syncSuccessRate: 0.6667,
      queuePressureEvents: 3,
      dirtyAgeMs: 1500,
      cursorLagMs: 5000,
    });
  });

  it('uses null success rate before any attempts and clamps future cursor lag to zero', () => {
    expect(buildSyncObservabilityContext({
      attempts: 0,
      confirmed: 0,
      lastSyncTimestamp: null,
      pendingActions: 0,
      retryQueuePressureEvents: 0,
      actionQueueFrozen: false,
      dirtyAgeMs: undefined,
      lastProjectSyncTime: '2026-01-01T00:01:00.000Z',
      nowMs: Date.parse('2026-01-01T00:00:00.000Z'),
    })).toEqual({
      lastSyncTimestamp: null,
      pendingActions: 0,
      syncSuccessRate: null,
      queuePressureEvents: 0,
      dirtyAgeMs: undefined,
      cursorLagMs: 0,
    });
  });
});
