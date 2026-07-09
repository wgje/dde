interface SyncObservabilityContextInput {
  attempts: number;
  confirmed: number;
  lastSyncTimestamp: string | null;
  pendingActions: number;
  retryQueuePressureEvents: number;
  actionQueueFrozen: boolean;
  dirtyAgeMs: number | undefined;
  lastProjectSyncTime: string | null;
  nowMs: number;
}

export interface SyncObservabilityContext {
  lastSyncTimestamp: string | null;
  pendingActions: number;
  syncSuccessRate: number | null;
  queuePressureEvents: number;
  dirtyAgeMs: number | undefined;
  cursorLagMs: number;
}

export function buildSyncObservabilityContext(
  input: SyncObservabilityContextInput,
): SyncObservabilityContext {
  return {
    lastSyncTimestamp: input.lastSyncTimestamp,
    pendingActions: input.pendingActions,
    syncSuccessRate: input.attempts === 0
      ? null
      : Number((input.confirmed / input.attempts).toFixed(4)),
    queuePressureEvents: input.retryQueuePressureEvents + (input.actionQueueFrozen ? 1 : 0),
    dirtyAgeMs: input.dirtyAgeMs,
    cursorLagMs: input.lastProjectSyncTime
      ? Math.max(0, input.nowMs - new Date(input.lastProjectSyncTime).getTime())
      : 0,
  };
}
