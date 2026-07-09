import { describe, expect, it } from 'vitest';

import {
  decideRealtimeActivationTransport,
  shouldAttemptRealtimeReentryFromPolling,
  type RealtimeActivationTransportDecisionInput,
  type RealtimePollingReentryDecisionInput,
} from './realtime-polling-reentry.helpers';

function createReentryInput(
  overrides: Partial<RealtimePollingReentryDecisionInput> = {},
): RealtimePollingReentryDecisionInput {
  return {
    projectId: 'project-1',
    userId: 'user-1',
    transportGeneration: 1,
    realtimeEnabled: true,
    transportContextCurrent: true,
    remoteTransportActivatable: true,
    hasActiveRealtimeChannel: false,
    realtimeTransportSupported: true,
    remainingCircuitMs: 0,
    remainingBackoffMs: 0,
    ...overrides,
  };
}

function createActivationInput(
  overrides: Partial<RealtimeActivationTransportDecisionInput> = {},
): RealtimeActivationTransportDecisionInput {
  return {
    realtimeTransportSupported: true,
    remainingCircuitMs: 0,
    remainingBackoffMs: 0,
    ...overrides,
  };
}

describe('shouldAttemptRealtimeReentryFromPolling', () => {
  it('allows reentry when polling context is current and realtime is available', () => {
    expect(shouldAttemptRealtimeReentryFromPolling(createReentryInput())).toBe(true);
  });

  it.each([
    ['missing user id', { userId: null }],
    ['realtime disabled', { realtimeEnabled: false }],
    ['stale transport context', { transportContextCurrent: false }],
    ['remote transport blocked', { remoteTransportActivatable: false }],
    ['active realtime channel exists', { hasActiveRealtimeChannel: true }],
    ['websocket unsupported', { realtimeTransportSupported: false }],
    ['circuit still open', { remainingCircuitMs: 1 }],
    ['project backoff still active', { remainingBackoffMs: 1 }],
  ] satisfies Array<[string, Partial<RealtimePollingReentryDecisionInput>]>)(
    'blocks reentry for %s',
    (_reason, overrides) => {
      expect(shouldAttemptRealtimeReentryFromPolling(createReentryInput(overrides))).toBe(false);
    },
  );
});

describe('decideRealtimeActivationTransport', () => {
  it.each([
    [
      'websocket is unsupported',
      { realtimeTransportSupported: false },
      { mode: 'polling', reason: 'unsupported' },
    ],
    [
      'circuit window is still active',
      { remainingCircuitMs: 10_000, remainingBackoffMs: 5_000 },
      { mode: 'polling', reason: 'circuit', remainingMs: 10_000 },
    ],
    [
      'project backoff is still active',
      { remainingBackoffMs: 5_000 },
      { mode: 'polling', reason: 'backoff', remainingMs: 5_000 },
    ],
  ] satisfies Array<[
    string,
    Partial<RealtimeActivationTransportDecisionInput>,
    ReturnType<typeof decideRealtimeActivationTransport>,
  ]>)(
    'uses polling when %s',
    (_reason, overrides, expectedDecision) => {
      expect(decideRealtimeActivationTransport(createActivationInput(overrides)))
        .toEqual(expectedDecision);
    },
  );

  it('uses realtime when transport is supported and no circuit or backoff window is active', () => {
    expect(decideRealtimeActivationTransport(createActivationInput()))
      .toEqual({ mode: 'realtime' });
  });
});
