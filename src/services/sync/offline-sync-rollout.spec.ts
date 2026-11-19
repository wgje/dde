import { describe, expect, it } from 'vitest';
import { resolveOfflineSyncRollout } from './offline-sync-rollout';
import type { OfflineSyncCapabilityDecision } from './offline-sync-capability-gate';

const commandReady: OfflineSyncCapabilityDecision = {
  mode: 'command', compatible: true, commandPathEnabled: true, missingCapabilities: [], reason: 'command-path-ready',
};
const shadowReady: OfflineSyncCapabilityDecision = {
  mode: 'shadow', compatible: true, commandPathEnabled: false, missingCapabilities: ['field-lww-v1'], reason: 'server-capabilities-missing',
};

describe('offline-sync-rollout', () => {
  it('keeps legacy behavior when the feature is disabled', () => {
    expect(resolveOfflineSyncRollout({ enabled: false, capability: commandReady })).toEqual({ mode: 'legacy', shadowCompareEnabled: false, reason: 'feature-disabled' });
  });

  it('uses shadow mode when capability negotiation is incomplete', () => {
    expect(resolveOfflineSyncRollout({ enabled: true, capability: shadowReady })).toEqual({ mode: 'shadow', shadowCompareEnabled: true, reason: 'capability-gate' });
  });

  it('enables command mode only after the capability gate passes', () => {
    expect(resolveOfflineSyncRollout({ enabled: true, capability: commandReady })).toEqual({ mode: 'command', shadowCompareEnabled: true, reason: 'command-enabled' });
  });
});
