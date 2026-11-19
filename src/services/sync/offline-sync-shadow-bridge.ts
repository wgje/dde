import type { SyncRpcResult } from '../sync-rpc-client.service';
import type { OfflineSyncCommandEnvelope } from './offline-sync-command-envelope';
import {
  type ShadowCommandIdentity,
  type ShadowComparisonInput,
  type ShadowComparisonRecord,
  type ShadowOutcome,
  type ShadowSyncAdapter,
} from './shadow-sync-adapter';

/** Map the legacy RPC status into the shadow model without changing legacy behavior. */
export function toShadowOutcome(result: SyncRpcResult): ShadowOutcome {
  return {
    status: result.status,
    decision: result.decision,
    changedFields: result.changedFields,
    entityId: result.entityId,
    payloadDigest: result.payloadDigest,
    remoteUpdatedAt: result.remoteUpdatedAt ?? result.serverUpdatedAt,
    reason: result.reason,
  };
}

export function toShadowCommandIdentity(
  command: OfflineSyncCommandEnvelope,
): ShadowCommandIdentity {
  return {
    operationId: command.operationId,
    ownerUserId: command.ownerUserId,
    installationId: command.installationId,
    deviceId: command.deviceId,
    schemaVersion: command.schemaVersion,
    entityType: command.entityType,
    entityId: command.entityId,
  };
}

export interface CompareOfflineCommandWithLegacyRpcInput {
  command: OfflineSyncCommandEnvelope;
  newOutcome: ShadowOutcome;
  legacyResult: SyncRpcResult;
  comparedAt: string;
}

/**
 * Compare a new command-path outcome with the existing RPC outcome.
 * A disabled adapter returns null and never affects the caller.
 */
export function compareOfflineCommandWithLegacyRpc(
  adapter: ShadowSyncAdapter,
  input: CompareOfflineCommandWithLegacyRpcInput,
): ShadowComparisonRecord | null {
  const comparison: ShadowComparisonInput = {
    command: toShadowCommandIdentity(input.command),
    newOutcome: input.newOutcome,
    legacyOutcome: toShadowOutcome(input.legacyResult),
    comparedAt: input.comparedAt,
  };
  return adapter.compare(comparison);
}