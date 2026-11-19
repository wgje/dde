import type {
  OfflineSyncCapabilityDecision,
  OfflineSyncTransportMode,
} from './offline-sync-capability-gate';

export interface OfflineSyncRolloutInput {
  readonly enabled: boolean;
  readonly capability: OfflineSyncCapabilityDecision;
}

export interface OfflineSyncRolloutDecision {
  readonly mode: OfflineSyncTransportMode;
  readonly shadowCompareEnabled: boolean;
  readonly reason: 'feature-disabled' | 'capability-gate' | 'command-enabled';
}

export function resolveOfflineSyncRollout(
  input: OfflineSyncRolloutInput,
): OfflineSyncRolloutDecision {
  if (!input.enabled) {
    return { mode: 'legacy', shadowCompareEnabled: false, reason: 'feature-disabled' };
  }
  if (!input.capability.commandPathEnabled) {
    return {
      mode: input.capability.mode === 'legacy' ? 'legacy' : 'shadow',
      shadowCompareEnabled: input.capability.mode === 'shadow',
      reason: 'capability-gate',
    };
  }
  return { mode: 'command', shadowCompareEnabled: true, reason: 'command-enabled' };
}