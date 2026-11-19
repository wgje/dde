import { Injectable, inject } from '@angular/core';
import { AuthService } from '../../../../services/auth.service';
import { SyncRpcClientService } from '../../../../services/sync-rpc-client.service';
import { FEATURE_FLAGS } from '../../../../config/feature-flags.config';
import { OFFLINE_SYNC_REMOTE_CAPABILITIES } from '../../../../services/sync/offline-sync-capability-gate';
import { AUTH_CONFIG } from '../../../../config/auth.config';
import type { QueuedAction } from '../../../../services/action-queue.types';
import type { OfflineCommandStore, OfflineCommandRecord } from '../../../../services/sync/offline-command-store';
import type { OfflineSyncCommandEnvelope } from '../../../../services/sync/offline-sync-command-envelope';
import { getAuthOwnerTransition } from '../../../../services/auth-owner-transition.controller';
import { createOfflineSyncProjectionRpcTransport, pullAndApplyOfflineSyncProjections } from '../../../../services/sync/offline-sync-projection-rpc-adapter';
import { LoggerService } from '../../../../services/logger.service';
import { RetryQueueService, type RetryQueueItem } from './retry-queue.service';
import { ActionQueueService } from '../../../../services/action-queue.service';
import { getOfflineSyncCaptureHooks } from './offline-sync-capture-registry';
import { getOfflineSyncActionCaptureHooks } from '../../../../services/sync/offline-sync-action-capture-registry';
import {
  queuedActionToOfflineCommand,
  retryQueueItemToOfflineCommand,
  type LegacyOfflineCommandAdapterContext,
} from './legacy-offline-command-adapter';
import { createOfflineSyncCommandEnvelopeDispatchers } from './offline-sync-command-replay-adapter';
import { OfflineSyncCommandReplayProcessor } from './offline-sync-command-replay-processor';
import type { AppResumeReason } from '../../../../services/app-lifecycle-orchestrator.types';
import {
  OfflineSyncOwnerCaptureCoordinator,
  type OfflineSyncOwnerCaptureCoordinatorOptions,
} from './offline-sync-owner-capture-coordinator';

function createMemoryStorage(): OfflineSyncOwnerCaptureCoordinatorOptions['identityStorage'] {
  const values = new Map<string, string>();
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

const CONNECTIVITY_RETRY_INITIAL_MS = 15_000;
const CONNECTIVITY_RETRY_MAX_MS = 5 * 60_000;

@Injectable({ providedIn: 'root' })
export class OfflineSyncOwnerCaptureCoordinatorService {
  private readonly auth = inject(AuthService);
  private readonly syncRpc = inject(SyncRpcClientService);
  private readonly retryQueue = inject(RetryQueueService);
  private readonly actionQueue = inject(ActionQueueService);
  private readonly logger = inject(LoggerService).category('OfflineSyncOwnerCapture');
  private readonly coordinator: OfflineSyncOwnerCaptureCoordinator;
  private unsubscribeOwnerCommit: (() => void) | null = null;
  private browserEventsWindow: Window | null = null;
  private connectivityRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private connectivityRetryAttempt = 0;
  private readonly onlineHandler = () => { void this.refreshCurrentOwner('online'); };
  private readonly offlineHandler = () => this.clearConnectivityRetryTimer();
  private readonly lifecycleResumedHandler = (event: Event) => {
    const reason = (event as CustomEvent<{ reason?: unknown }>).detail?.reason;
    void this.refreshCurrentOwner(typeof reason === 'string' ? reason : 'resume');
  };

  constructor() {
    const identityStorage = typeof localStorage === 'undefined' ? createMemoryStorage() : localStorage;
    this.coordinator = new OfflineSyncOwnerCaptureCoordinator({
      identityStorage,
      featureEnabled: FEATURE_FLAGS.OFFLINE_COMMAND_CAPTURE_V1,
      requiredCapabilities: OFFLINE_SYNC_REMOTE_CAPABILITIES,
      protocolProbe: () => this.syncRpc.checkProtocol(),
      capturePendingLegacyCommands: (ownerUserId, store) => this.capturePendingLegacyCommands(ownerUserId, store),
      pullProjections: (ownerUserId, store) => pullAndApplyOfflineSyncProjections({
        ownerUserId,
        store,
        transport: createOfflineSyncProjectionRpcTransport(this.syncRpc),
      }).then(() => undefined),
      replayPendingCommands: async (ownerUserId, store) => {
        const handler = this.retryQueue.getOperationHandler();
        if (!handler) return;
        const processor = new OfflineSyncCommandReplayProcessor({
          store,
          ownerUserId,
          handler,
          replayOptions: {
            commands: createOfflineSyncCommandEnvelopeDispatchers(this.syncRpc),
            // sync_apply_offline_command is keyed by operationId; resubmitting the
            // same envelope settles an unknown outcome through the server's unique-key fence.
            reconcileUnknownOutcome: async command => {
              const status = await this.syncRpc.getOfflineCommandStatus({ operationId: command.operationId });
              if (status.appliedToDomainTables === true
                && (status.domainApplyStatus === 'applied' || status.domainApplyStatus === 'idempotent-replay')) {
                return 'settled';
              }
              if (status.reason === 'offline-command-not-found') return 'replay';
              // A known terminal non-success is only re-submitted with the same
              // operationId so the server idempotency fence returns its result;
              // pending/missing audit or network errors remain unknown.
              if (status.domainApplyStatus && status.domainApplyStatus !== 'missing') return 'replay';
              return 'unknown';
            },
          },
        });
        await processor.drain();
      },
    });
  }

  bind(): void {
    if (this.unsubscribeOwnerCommit) return;
    if (typeof window !== 'undefined') {
      this.browserEventsWindow = window;
      this.browserEventsWindow.addEventListener('online', this.onlineHandler);
      this.browserEventsWindow.addEventListener('offline', this.offlineHandler);
      this.browserEventsWindow.addEventListener('nanoflow:lifecycle-resumed', this.lifecycleResumedHandler);
    }
    const transition = getAuthOwnerTransition(this.auth);
    this.unsubscribeOwnerCommit = transition.onCommitted(ownerUserId => {
      if (!ownerUserId) {
        this.clearConnectivityRetryTimer();
        this.connectivityRetryAttempt = 0;
        this.coordinator.onOwnerInvalidated();
        return;
      }
      this.connectivityRetryAttempt = 0;
      this.clearConnectivityRetryTimer();
      void this.coordinator.onOwnerCommitted(ownerUserId)
        .then(() => this.scheduleConnectivityRetryIfNeeded(ownerUserId))
        .catch(error => {
          this.logger.warn('离线 command owner runtime 安装失败，保持旧同步链', { ownerUserId, error });
          this.scheduleConnectivityRetry(ownerUserId);
        });
    });
  }

  dispose(): void {
    this.unsubscribeOwnerCommit?.();
    this.unsubscribeOwnerCommit = null;
    if (this.browserEventsWindow) {
      this.browserEventsWindow.removeEventListener('online', this.onlineHandler);
      this.browserEventsWindow.removeEventListener('offline', this.offlineHandler);
      this.browserEventsWindow.removeEventListener('nanoflow:lifecycle-resumed', this.lifecycleResumedHandler);
      this.browserEventsWindow = null;
    }
    this.clearConnectivityRetryTimer();
    this.coordinator.dispose();
  }

  private async capturePendingLegacyCommands(ownerUserId: string, store: OfflineCommandStore): Promise<void> {
    const currentOwnerUserId = this.auth.currentUserId() ?? AUTH_CONFIG.LOCAL_MODE_USER_ID;
    if (currentOwnerUserId !== ownerUserId) throw new Error('offline command queue owner changed before snapshot');
    const retrySnapshot = this.retryQueue.getOwnerItemsSnapshot(ownerUserId);
    if (retrySnapshot.status !== 'ready') throw new Error('RetryQueue owner snapshot is not authoritative');
    if (this.actionQueue.getCurrentOwnerStorageLoadState() !== 'loaded') {
      throw new Error('ActionQueue owner snapshot is not authoritative');
    }
    const retryHooks = getOfflineSyncCaptureHooks();
    const actionHooks = getOfflineSyncActionCaptureHooks();
    if (!retryHooks?.enabled || !actionHooks?.enabled) {
      throw new Error('offline command capture hooks are not installed');
    }

    const identity = this.coordinator.currentDeviceIdentity();
    const context: LegacyOfflineCommandAdapterContext = {
      ownerUserId,
      installationId: identity.installationId,
      deviceId: identity.deviceId,
    };
    const existing = await store.listCommands<OfflineSyncCommandEnvelope>(ownerUserId);
    const byOperationId = new Map(existing.map(record => [record.operationId, record]));

    for (const item of retrySnapshot.items) {
      const adapted = retryQueueItemToOfflineCommand(item, context).command;
      await this.captureLegacyCandidate(ownerUserId, store, byOperationId, adapted, retryHooks.captureRetryQueueItem, item);
    }
    const actionOwnerUserId = this.auth.currentUserId() ?? AUTH_CONFIG.LOCAL_MODE_USER_ID;
    if (actionOwnerUserId !== ownerUserId || this.actionQueue.getCurrentOwnerStorageLoadState() !== 'loaded') {
      throw new Error('ActionQueue owner changed while capturing legacy commands');
    }
    for (const action of this.actionQueue.pendingActions()) {
      const adapted = queuedActionToOfflineCommand(action, context).command;
      await this.captureLegacyCandidate(ownerUserId, store, byOperationId, adapted,
        async () => actionHooks.captureQueuedAction(ownerUserId, action), action);
    }
  }

  private async captureLegacyCandidate<TSource>(
    ownerUserId: string,
    store: OfflineCommandStore,
    existing: Map<string, OfflineCommandRecord<OfflineSyncCommandEnvelope>>,
    candidate: OfflineSyncCommandEnvelope,
    capture: (source: TSource) => Promise<void>,
    source: TSource,
  ): Promise<boolean> {
    const prior = existing.get(candidate.operationId);
    if (prior) {
      if (sameOfflineCommandIntent(prior.command, candidate)) return true;
      const evidence = { existing: prior.command, candidate };
      if (prior.status === 'pending' || prior.status === 'sent' || prior.status === 'unknown') {
        await store.updateReplayResult({
          ownerUserId,
          operationId: candidate.operationId,
          status: 'rejected',
          decision: 'operation-id-payload-collision',
          rawResponse: evidence,
        });
      }
      await store.quarantine({
        ownerUserId,
        reason: 'operation-id-payload-collision',
        raw: evidence,
        quarantinedAt: new Date().toISOString(),
        key: `${ownerUserId}:quarantine:operation-id-collision:${candidate.operationId}`,
      });
      return true;
    }

    await capture(source);
    const committed: OfflineCommandRecord<OfflineSyncCommandEnvelope> = {
      key: `${ownerUserId}:command:${candidate.operationId}`,
      ownerUserId,
      operationId: candidate.operationId,
      entityType: candidate.entityType,
      entityId: candidate.entityId,
      command: candidate,
      status: candidate.status,
      createdAt: candidate.createdAtIso,
      updatedAt: candidate.createdAtIso,
      schemaVersion: 1,
    };
    existing.set(candidate.operationId, committed);
    return false;
  }

  private async refreshCurrentOwner(reason: AppResumeReason | string): Promise<void> {
    const ownerUserId = this.coordinator.currentOwnerUserId();
    if (!ownerUserId) return;
    try {
      const capability = await this.coordinator.refreshCurrentOwner();
      if (this.coordinator.currentOwnerUserId() !== ownerUserId) return;
      this.logger.debug('offline command connectivity refresh completed', {
        ownerUserId, reason, mode: capability?.mode ?? 'unavailable',
      });
      await this.scheduleConnectivityRetryIfNeeded(ownerUserId);
    } catch (error) {
      if (this.coordinator.currentOwnerUserId() !== ownerUserId) return;
      this.logger.warn('离线 command 联网恢复暂未完成，稍后继续重试', { ownerUserId, reason, error });
      this.scheduleConnectivityRetry(ownerUserId);
    }
  }

  private async scheduleConnectivityRetryIfNeeded(ownerUserId: string): Promise<void> {
    if (this.coordinator.currentOwnerUserId() !== ownerUserId) return;
    if (!this.coordinator.isActive()) {
      this.connectivityRetryAttempt = 0;
      this.clearConnectivityRetryTimer();
      return;
    }
    const capability = this.coordinator.currentCapability();
    const hasReplayWork = await this.coordinator.hasReplayWork(ownerUserId);
    if (this.coordinator.currentOwnerUserId() !== ownerUserId) return;
    if (capability?.mode !== 'command'
      || this.coordinator.requiresConnectivityRetry(ownerUserId)
      || hasReplayWork) {
      this.scheduleConnectivityRetry(ownerUserId);
      return;
    }
    this.connectivityRetryAttempt = 0;
    this.clearConnectivityRetryTimer();
  }

  private scheduleConnectivityRetry(ownerUserId: string): void {
    this.clearConnectivityRetryTimer();
    if (this.coordinator.currentOwnerUserId() !== ownerUserId) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    const delay = Math.min(CONNECTIVITY_RETRY_INITIAL_MS * (2 ** this.connectivityRetryAttempt), CONNECTIVITY_RETRY_MAX_MS);
    this.connectivityRetryAttempt = Math.min(this.connectivityRetryAttempt + 1, 8);
    this.connectivityRetryTimer = setTimeout(() => {
      this.connectivityRetryTimer = null;
      void this.refreshCurrentOwner('online');
    }, delay);
  }

  private clearConnectivityRetryTimer(): void {
    if (this.connectivityRetryTimer === null) return;
    clearTimeout(this.connectivityRetryTimer);
    this.connectivityRetryTimer = null;
  }
}
function sameOfflineCommandIntent(
  existing: unknown,
  candidate: OfflineSyncCommandEnvelope,
): boolean {
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)) return false;
  const existingCommand = existing as OfflineSyncCommandEnvelope;
  const identity = (command: OfflineSyncCommandEnvelope): string => {
    const patch = command.normalizedResultPatch;
    const nestedKeys: Partial<Record<OfflineSyncCommandEnvelope['entityType'], readonly string[]>> = {
      task: ['task'], project: ['project'], connection: ['connection'],
      black_box_entry: ['entry'], preference: ['preferences', 'userPreferences', 'user_preferences'],
      focus_session: ['focusSession', 'focus_session', 'record'],
      routine_task: ['routineTask', 'routine_task', 'task'],
      routine_completion: ['routineCompletion', 'routine_completion', 'mutation'],
    };
    const entityPayload = nestedKeys[command.entityType]
      ?.map(key => patch[key])
      .find(value => value && typeof value === 'object' && !Array.isArray(value))
      ?? Object.fromEntries(Object.entries(patch).filter(([key]) => !['projectId', 'project_id', 'sourceUserId', 'source_user_id'].includes(key)));
    const intent = Object.fromEntries(Object.entries(command.intent)
      .filter(([key]) => !['source', 'operation', 'operationType', 'syncState', 'priority'].includes(key)));
    const patchProjectId = typeof patch['projectId'] === 'string' ? patch['projectId']
      : typeof patch['project_id'] === 'string' ? patch['project_id'] : undefined;
    return JSON.stringify({
      ownerUserId: command.ownerUserId,
      operationId: command.operationId,
      entityType: command.entityType,
      entityId: command.entityId,
      projectId: command.projectId ?? patchProjectId,
      command: command.command,
      intent,
      baseVersion: command.baseVersion,
      baseUpdatedAt: command.baseUpdatedAt,
      entityPayload,
      dependencyOperationIds: command.dependencyOperationIds,
    });
  };
  return identity(existingCommand) === identity(candidate);
}
