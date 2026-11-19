export const OFFLINE_SYNC_COMMAND_PROTOCOL_VERSION = 1 as const;

export const OFFLINE_SYNC_CAPABILITIES = [
  'command-envelope-v1',
  'field-lww-v1',
  'domain-apply-v1',
  'device-identity-v1',
  'dependency-replay-v1',
  'data-safety-command-store-v1',
] as const;

/** Capabilities that are negotiated with the remote ingest/projection server. */
export const OFFLINE_SYNC_REMOTE_CAPABILITIES = ['command-envelope-v1', 'field-lww-v1', 'domain-apply-v1'] as const;
export type OfflineSyncCapability = typeof OFFLINE_SYNC_CAPABILITIES[number];
export type OfflineSyncTransportMode = 'legacy' | 'shadow' | 'command';

export interface OfflineSyncServerCapabilitySnapshot {
  readonly minProtocolVersion: number;
  readonly deploymentEpoch: number;
  readonly capabilities?: readonly string[];
}

export interface OfflineSyncCapabilityGateInput {
  readonly clientProtocolVersion: number;
  readonly server: OfflineSyncServerCapabilitySnapshot | null;
  readonly requiredCapabilities?: readonly OfflineSyncCapability[];
}

export interface OfflineSyncCapabilityDecision {
  readonly mode: OfflineSyncTransportMode;
  readonly compatible: boolean;
  readonly commandPathEnabled: boolean;
  readonly missingCapabilities: readonly OfflineSyncCapability[];
  readonly reason:
    | 'server-probe-unavailable'
    | 'client-protocol-too-old'
    | 'server-capabilities-missing'
    | 'command-path-ready';
}

/**
 * Conservative capability gate. Missing server capabilities never break the
 * legacy path; they only prevent enabling the new command transport.
 */
export function negotiateOfflineSyncCapabilities(
  input: OfflineSyncCapabilityGateInput,
): OfflineSyncCapabilityDecision {
  if (!input.server) {
    return {
      mode: 'shadow',
      compatible: false,
      commandPathEnabled: false,
      missingCapabilities: [...(input.requiredCapabilities ?? OFFLINE_SYNC_CAPABILITIES)],
      reason: 'server-probe-unavailable',
    };
  }

  if (input.server.minProtocolVersion > input.clientProtocolVersion) {
    return {
      mode: 'legacy',
      compatible: false,
      commandPathEnabled: false,
      missingCapabilities: [],
      reason: 'client-protocol-too-old',
    };
  }

  const requiredCapabilities = input.requiredCapabilities ?? OFFLINE_SYNC_CAPABILITIES;
  const serverCapabilities = new Set(input.server.capabilities ?? []);
  const missingCapabilities = requiredCapabilities.filter(capability => !serverCapabilities.has(capability));
  if (missingCapabilities.length > 0) {
    return {
      mode: 'shadow',
      compatible: true,
      commandPathEnabled: false,
      missingCapabilities,
      reason: 'server-capabilities-missing',
    };
  }

  return {
    mode: 'command',
    compatible: true,
    commandPathEnabled: true,
    missingCapabilities: [],
    reason: 'command-path-ready',
  };
}