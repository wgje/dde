import { describe, expect, it } from 'vitest';

import type { RecoveryMetricsSnapshot } from './app-lifecycle-orchestrator.types';
import {
  buildRecoveryCompensationReport,
  mergeRecoveryMetrics,
} from './app-lifecycle-recovery-metrics.helpers';

describe('app lifecycle recovery metrics helpers', () => {
  it('merges metrics for the same recovery ticket and replaces different tickets', () => {
    const current: RecoveryMetricsSnapshot = {
      ticketId: 'ticket-1',
      reason: 'visibility-threshold',
      interactionReadyMs: 12,
    };

    expect(mergeRecoveryMetrics(current, {
      ticketId: 'ticket-1',
      reason: 'visibility-threshold',
      interactionReadyMs: 12,
      backgroundRefreshMs: 30,
      fastPathHit: false,
    })).toEqual({
      ticketId: 'ticket-1',
      reason: 'visibility-threshold',
      interactionReadyMs: 12,
      backgroundRefreshMs: 30,
      fastPathHit: false,
    });

    expect(mergeRecoveryMetrics(current, {
      ticketId: 'ticket-2',
      reason: 'online',
      interactionReadyMs: 5,
    })).toEqual({
      ticketId: 'ticket-2',
      reason: 'online',
      interactionReadyMs: 5,
    });
  });

  it('builds compensation metrics only for the active recovery ticket', () => {
    const ticket = { id: 'ticket-1', startedAt: 100, mode: 'heavy' as const };

    expect(buildRecoveryCompensationReport({
      currentMetrics: { ticketId: 'ticket-2', reason: 'online', interactionReadyMs: 5 },
      reason: 'visibility-threshold',
      recoveryTicket: ticket,
      interactionReadyMs: 12,
      backgroundRefreshMs: 30,
      fastPathHit: true,
    })).toBeNull();

    expect(buildRecoveryCompensationReport({
      currentMetrics: { ticketId: 'ticket-1', reason: 'visibility-threshold', interactionReadyMs: 12 },
      reason: 'visibility-threshold',
      recoveryTicket: ticket,
      interactionReadyMs: 12,
      backgroundRefreshMs: 30,
      fastPathHit: true,
    })).toEqual({
      ticketId: 'ticket-1',
      reason: 'visibility-threshold',
      interactionReadyMs: 12,
      backgroundRefreshMs: 30,
      fastPathHit: true,
    });
  });
});
