import type { QueuedAction } from '../../../../services/action-queue.types';
import type { OfflineCommandStore } from '../../../../services/sync/offline-command-store';
import type {
  OfflineSyncCapabilityDecision,
  OfflineSyncTransportMode,
} from '../../../../services/sync/offline-sync-capability-gate';
import { resolveOfflineSyncRollout, type OfflineSyncRolloutDecision } from '../../../../services/sync/offline-sync-rollout';
import { OfflineSyncCommandCoordinator } from '../../../../services/sync/offline-sync-command-coordinator';
import {
  configureOfflineSyncCaptureHooks,
  type OfflineSyncCaptureHooks,
} from './offline-sync-capture-registry';
import {
  configureOfflineSyncActionCaptureHooks,
  type OfflineSyncActionCaptureHooks,
} from '../../../../services/sync/offline-sync-action-capture-registry';
import {
  queuedActionToOfflineCommand,
  retryQueueItemToOfflineCommand,
  type LegacyOfflineCommandAdapterContext,
} from './legacy-offline-command-adapter';
import type { RetryQueueItem } from './retry-queue.types';

export interface OfflineSyncCaptureRuntimeOptions {
  readonly store: OfflineCommandStore;
  readonly enabled: boolean;
  readonly capability: OfflineSyncCapabilityDecision;
  readonly ownerUserId: string;
  readonly installationId: string;
  readonly deviceId: string;
}

export interface OfflineSyncCaptureRuntime {
  readonly rollout: OfflineSyncRolloutDecision;
  readonly mode: OfflineSyncTransportMode;
  install(): void;
  dispose(): void;
}

export function createOfflineSyncCaptureRuntime(
  options: OfflineSyncCaptureRuntimeOptions,
): OfflineSyncCaptureRuntime {
  const rollout = resolveOfflineSyncRollout({ enabled: options.enabled, capability: options.capability });
  const coordinator = new OfflineSyncCommandCoordinator({ store: options.store });
  const baseContext: LegacyOfflineCommandAdapterContext = {
    ownerUserId: options.ownerUserId,
    installationId: options.installationId,
    deviceId: options.deviceId,
  };
  const installed = { value: false };
  const retryHooks: OfflineSyncCaptureHooks = {
    enabled: rollout.mode !== 'legacy',
    captureRetryQueueItem: async (item: RetryQueueItem) => {
      const adapted = retryQueueItemToOfflineCommand(item, baseContext);
      await coordinator.commitEnvelope(adapted.command, adapted.command.normalizedResultPatch);
    },
  };
  const actionHooks: OfflineSyncActionCaptureHooks = {
    enabled: rollout.mode !== 'legacy',
    captureQueuedAction: async (ownerUserId: string, action: QueuedAction) => {
      const adapted = queuedActionToOfflineCommand(action, { ...baseContext, ownerUserId });
      await coordinator.commitEnvelope(adapted.command, adapted.command.normalizedResultPatch);
    },
  };

  return {
    rollout,
    mode: rollout.mode,
    install(): void {
      if (installed.value) return;
      configureOfflineSyncCaptureHooks(retryHooks);
      configureOfflineSyncActionCaptureHooks(actionHooks);
      installed.value = true;
    },
    dispose(): void {
      if (!installed.value) return;
      configureOfflineSyncCaptureHooks(null);
      configureOfflineSyncActionCaptureHooks(null);
      installed.value = false;
    },
  };
}