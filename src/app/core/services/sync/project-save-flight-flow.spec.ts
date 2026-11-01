import { describe, expect, it } from 'vitest';
import {
  decideFailedProjectSaveFlightSettlement,
  decideQueuedProjectSaveRequestMerge,
  parseProjectSaveFlightKey,
} from './project-save-flight-flow';

describe('project save flight flow helpers', () => {
  it('parses a single-flight key into owner and project ids', () => {
    expect(parseProjectSaveFlightKey('user-1:project-1')).toEqual({
      userId: 'user-1',
      projectId: 'project-1',
    });

    expect(parseProjectSaveFlightKey('project-legacy')).toEqual({
      userId: undefined,
      projectId: 'project-legacy',
    });
  });

  it('parses session-scoped flight keys without leaking generation into owner identity', () => {
    expect(parseProjectSaveFlightKey('7|user-1:project-1')).toEqual({
      sessionGeneration: 7,
      userId: 'user-1',
      projectId: 'project-1',
    });
  });

  it('clears terminal retry markers and deletes the flight when no request is queued', () => {
    expect(decideFailedProjectSaveFlightSettlement({
      conflict: true,
      terminal: false,
      hasQueuedRequest: false,
      retryPayloadRefreshed: false,
    })).toEqual({
      kind: 'delete-flight',
      clearRetryMarker: true,
    });
  });

  it('settles queued conflict and terminal failures without replaying the queue', () => {
    expect(decideFailedProjectSaveFlightSettlement({
      conflict: false,
      terminal: true,
      hasQueuedRequest: true,
      retryPayloadRefreshed: false,
    })).toEqual({
      kind: 'settle-queued',
      clearRetryMarker: true,
      logKind: 'terminal',
    });

    expect(decideFailedProjectSaveFlightSettlement({
      conflict: true,
      terminal: false,
      hasQueuedRequest: true,
      retryPayloadRefreshed: false,
    })).toEqual({
      kind: 'settle-queued',
      clearRetryMarker: true,
      logKind: 'conflict',
    });
  });

  it('settles queued transient failures when durable retry already owns the latest payload', () => {
    expect(decideFailedProjectSaveFlightSettlement({
      conflict: false,
      terminal: false,
      hasQueuedRequest: true,
      retryPayloadRefreshed: true,
    })).toEqual({
      kind: 'settle-queued',
      clearRetryMarker: false,
      logKind: 'retry-handoff',
    });
  });

  it('advances queued transient failures when durable retry did not refresh the latest payload', () => {
    expect(decideFailedProjectSaveFlightSettlement({
      conflict: false,
      terminal: false,
      hasQueuedRequest: true,
      retryPayloadRefreshed: false,
    })).toEqual({
      kind: 'advance-queued',
      clearRetryMarker: false,
    });
  });

  it('reuses the queued promise when an incoming request has the same queued signature', () => {
    expect(decideQueuedProjectSaveRequestMerge({
      incomingSignature: 'same-signature',
      queuedSignature: 'same-signature',
      queuedRefreshedSignature: 'same-signature',
      incomingIsNewer: true,
    })).toEqual({ kind: 'reuse-queued' });
  });

  it('updates the queued request when the incoming project snapshot is newer or equally fresh', () => {
    expect(decideQueuedProjectSaveRequestMerge({
      incomingSignature: 'incoming-signature',
      queuedSignature: 'queued-signature',
      queuedRefreshedSignature: 'queued-refresh-signature',
      incomingIsNewer: true,
    })).toEqual({ kind: 'replace-queued' });
  });

  it('keeps an older queued snapshot while refreshing changed delete payload', () => {
    expect(decideQueuedProjectSaveRequestMerge({
      incomingSignature: 'incoming-signature',
      queuedSignature: 'queued-signature',
      queuedRefreshedSignature: 'queued-refresh-signature',
      incomingIsNewer: false,
    })).toEqual({
      kind: 'keep-queued',
      refreshQueuedPayload: true,
    });
  });

  it('keeps an older queued snapshot without rewriting equivalent delete payload', () => {
    expect(decideQueuedProjectSaveRequestMerge({
      incomingSignature: 'incoming-signature',
      queuedSignature: 'queued-signature',
      queuedRefreshedSignature: 'queued-signature',
      incomingIsNewer: false,
    })).toEqual({
      kind: 'keep-queued',
      refreshQueuedPayload: false,
    });
  });
});
