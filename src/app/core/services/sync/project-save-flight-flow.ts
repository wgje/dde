export interface ProjectSaveFlightKeyParts {
  sessionGeneration?: number;
  userId?: string;
  projectId: string;
}

export type FailedProjectSaveFlightSettlement =
  | {
      kind: 'delete-flight';
      clearRetryMarker: boolean;
    }
  | {
      kind: 'settle-queued';
      clearRetryMarker: boolean;
      logKind: 'conflict' | 'terminal' | 'retry-handoff';
    }
  | {
      kind: 'advance-queued';
      clearRetryMarker: boolean;
    };

export interface FailedProjectSaveFlightSettlementInput {
  conflict: boolean;
  terminal: boolean;
  hasQueuedRequest: boolean;
  retryPayloadRefreshed: boolean;
}

export type QueuedProjectSaveRequestMergeDecision =
  | { kind: 'reuse-queued' }
  | { kind: 'replace-queued' }
  | {
      kind: 'keep-queued';
      refreshQueuedPayload: boolean;
    };

export interface QueuedProjectSaveRequestMergeInput {
  incomingSignature: string;
  queuedSignature: string;
  queuedRefreshedSignature: string;
  incomingIsNewer: boolean;
}

export function parseProjectSaveFlightKey(key: string): ProjectSaveFlightKeyParts {
  const generationSeparatorIndex = key.indexOf('|');
  const generationText = generationSeparatorIndex >= 0 ? key.slice(0, generationSeparatorIndex) : '';
  const sessionGeneration = /^\d+$/.test(generationText) ? Number(generationText) : undefined;
  const scopedKey = generationSeparatorIndex >= 0 ? key.slice(generationSeparatorIndex + 1) : key;
  const separatorIndex = scopedKey.indexOf(':');

  return separatorIndex >= 0
    ? {
        ...(sessionGeneration === undefined ? {} : { sessionGeneration }),
        userId: scopedKey.slice(0, separatorIndex),
        projectId: scopedKey.slice(separatorIndex + 1),
      }
    : {
        ...(sessionGeneration === undefined ? {} : { sessionGeneration }),
        userId: undefined,
        projectId: scopedKey,
      };
}

export function decideFailedProjectSaveFlightSettlement(
  input: FailedProjectSaveFlightSettlementInput,
): FailedProjectSaveFlightSettlement {
  const clearRetryMarker = input.conflict || input.terminal;

  if (!input.hasQueuedRequest) {
    return {
      kind: 'delete-flight',
      clearRetryMarker,
    };
  }

  if (input.conflict || input.terminal) {
    return {
      kind: 'settle-queued',
      clearRetryMarker,
      logKind: input.terminal ? 'terminal' : 'conflict',
    };
  }

  if (input.retryPayloadRefreshed) {
    return {
      kind: 'settle-queued',
      clearRetryMarker,
      logKind: 'retry-handoff',
    };
  }

  return {
    kind: 'advance-queued',
    clearRetryMarker,
  };
}

export function decideQueuedProjectSaveRequestMerge(
  input: QueuedProjectSaveRequestMergeInput,
): QueuedProjectSaveRequestMergeDecision {
  if (input.incomingSignature === input.queuedSignature) {
    return { kind: 'reuse-queued' };
  }

  if (input.incomingIsNewer) {
    return { kind: 'replace-queued' };
  }

  return {
    kind: 'keep-queued',
    refreshQueuedPayload: input.queuedRefreshedSignature !== input.queuedSignature,
  };
}
