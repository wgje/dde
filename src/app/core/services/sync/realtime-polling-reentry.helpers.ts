export interface RealtimePollingReentryDecisionInput {
  projectId: string;
  userId: string | null;
  transportGeneration: number;
  realtimeEnabled: boolean;
  transportContextCurrent: boolean;
  remoteTransportActivatable: boolean;
  hasActiveRealtimeChannel: boolean;
  realtimeTransportSupported: boolean;
  remainingCircuitMs: number;
  remainingBackoffMs: number;
}

export interface RealtimeActivationTransportDecisionInput {
  realtimeTransportSupported: boolean;
  remainingCircuitMs: number;
  remainingBackoffMs: number;
}

export type RealtimeActivationTransportDecision =
  | { mode: 'realtime' }
  | { mode: 'polling'; reason: 'unsupported' }
  | { mode: 'polling'; reason: 'circuit'; remainingMs: number }
  | { mode: 'polling'; reason: 'backoff'; remainingMs: number };

export function shouldAttemptRealtimeReentryFromPolling(
  input: RealtimePollingReentryDecisionInput,
): boolean {
  void input.projectId;
  void input.transportGeneration;

  return Boolean(input.userId)
    && input.realtimeEnabled
    && input.transportContextCurrent
    && input.remoteTransportActivatable
    && !input.hasActiveRealtimeChannel
    && input.realtimeTransportSupported
    && input.remainingCircuitMs <= 0
    && input.remainingBackoffMs <= 0;
}

export function decideRealtimeActivationTransport(
  input: RealtimeActivationTransportDecisionInput,
): RealtimeActivationTransportDecision {
  if (!input.realtimeTransportSupported) {
    return { mode: 'polling', reason: 'unsupported' };
  }

  if (input.remainingCircuitMs > 0) {
    return {
      mode: 'polling',
      reason: 'circuit',
      remainingMs: input.remainingCircuitMs,
    };
  }

  if (input.remainingBackoffMs > 0) {
    return {
      mode: 'polling',
      reason: 'backoff',
      remainingMs: input.remainingBackoffMs,
    };
  }

  return { mode: 'realtime' };
}
