import type { DestroyRef } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FEATURE_FLAGS } from '../../../config/feature-flags.config';
import { SYNC_CONFIG } from '../../../config/sync.config';
import type { BlackBoxEntry } from '../../../models/focus';
import type { Project, Task, Connection } from '../../../models';
import { nowISO } from '../../../utils/date';
import type { ActionQueueService } from '../../../services/action-queue.service';
import type { BlackBoxSyncService } from '../../../services/black-box-sync.service';
import type { EventBusService } from '../../../services/event-bus.service';
import type { CategoryLogger } from '../../../services/logger.service';
import type { SupabaseClientService, SupabaseConnectivityChange } from '../../../services/supabase-client.service';
import type { TaskWriteIntent } from '../../../services/sync-rpc-client.service';
import type {
  ConnectivityRecoveryService,
  RealtimePollingService,
  RetryOperationHandler,
  RetryQueueService,
  SyncStateService,
  TaskDeleteBaseUpdatedAtMap,
} from './sync';
import type { RetryableEntityType, RetryableOperation } from './sync/retry-queue.types';

export interface SimpleSyncRuntimeControllerDeps {
  logger: CategoryLogger;
  eventBus: EventBusService;
  destroyRef: DestroyRef;
  supabase: SupabaseClientService;
  realtimePollingService: RealtimePollingService;
  retryQueueService: RetryQueueService;
  syncStateService: SyncStateService;
  connectivityRecovery: ConnectivityRecoveryService;
  blackBoxSync: BlackBoxSyncService;
  getActionQueue: () => ActionQueueService | null;
  syncState: SyncStateService['syncState'];
  state: SyncStateService['syncState'];
  pushTask: (
    task: Task,
    projectId: string,
    skipTombstoneCheck?: boolean,
    fromRetryQueue?: boolean,
    sourceUserId?: string,
    treatTombstoneAsPermanent?: boolean,
    writeIntent?: TaskWriteIntent,
    operationId?: string,
  ) => Promise<boolean>;
  deleteTask: (
    taskId: string,
    projectId: string,
    sourceUserId?: string,
    fromRetryQueue?: boolean,
    baseUpdatedAt?: string | null,
    operationId?: string,
  ) => Promise<boolean>;
  pushConnection: (
    connection: Connection,
    projectId: string,
    skipTombstoneCheck?: boolean,
    skipTaskExistenceCheck?: boolean,
    fromRetryQueue?: boolean,
    sourceUserId?: string,
    operationId?: string,
    requireSyncRpc?: boolean,
  ) => Promise<boolean>;
  addToRetryQueueDurably: (
    type: RetryableEntityType,
    operation: RetryableOperation,
    data: Task | Project | Connection | { id: string },
    projectId?: string,
    sourceUserId?: string,
    taskIdsToDelete?: string[],
    writeIntent?: TaskWriteIntent,
    taskDeleteBaseUpdatedAtMap?: TaskDeleteBaseUpdatedAtMap,
    operationId?: string,
  ) => Promise<boolean>;
  markSyncRecoveredIfIdle: (timestamp?: string) => boolean;
  resetSessionExpired: () => void;
}

export class SimpleSyncRuntimeController {
  private runtimeStarted = false;
  private syncStateListenersSetup = false;
  private readonly handleOnline = () => {
    if (!this.runtimeStarted) return;
    this.deps.logger.info('网络恢复');
    this.deps.syncStateService.setOnline(true);
    if (!this.deps.supabase.isOfflineMode()) {
      this.deps.syncStateService.setOfflineMode(false);
    }
    if (FEATURE_FLAGS.LIFECYCLE_RECOVERY_V1) {
      return;
    }
    void this.deps.connectivityRecovery.restoreRemoteConnectivity('online-event')
      .catch((error: unknown) => {
        this.deps.logger.warn('网络恢复后的远端连接恢复失败', {
          reason: 'online-event',
          error,
        });
      });
  };
  private readonly handleOffline = () => {
    if (!this.runtimeStarted) return;
    this.deps.logger.info('网络断开');
    this.deps.syncStateService.setOnline(false);
    this.deps.syncStateService.setOfflineMode(true);
    this.deps.connectivityRecovery.cancelScheduledRecovery();
    void this.deps.realtimePollingService.suspendTransport()
      .catch((error: unknown) => {
        this.deps.logger.warn('网络断开后的 Realtime 传输挂起失败', {
          reason: 'offline-event',
          error,
        });
      });
  };

  constructor(private readonly deps: SimpleSyncRuntimeControllerDeps) {}

  setupSyncStateListeners(): void {
    if (this.syncStateListenersSetup) {
      return;
    }
    this.syncStateListenersSetup = true;

    this.deps.eventBus.onSessionRestored$.pipe(
      takeUntilDestroyed(this.deps.destroyRef)
    ).subscribe(() => {
      if (!this.runtimeStarted) {
        return;
      }
      this.deps.resetSessionExpired();
      void this.deps.realtimePollingService.resetRealtimeCircuit('session-restored');
    });

    this.deps.syncStateService.registerIdleChecker(() => {
      if (this.deps.retryQueueService.length > 0) {
        return false;
      }
      const actionQueue = this.deps.getActionQueue();
      if (actionQueue && actionQueue.queueSize() > 0) {
        return false;
      }
      return true;
    });

    this.deps.syncStateService.registerSyncErrorListener((syncError) => {
      if (syncError) {
        this.deps.retryQueueService.clearSuccessfulDrainFlag?.();
      }
    });
  }

  setupRetryQueueHandler(): void {
    const retryHandler: RetryOperationHandler = {
      pushTask: (task, pid, sourceUserId, writeIntent, operationId) =>
        this.deps.pushTask(task, pid, false, true, sourceUserId, false, writeIntent, operationId),
      deleteTask: (tid, pid, sourceUserId, fromRetryQueue, baseUpdatedAt, operationId) =>
        this.deps.deleteTask(tid, pid, sourceUserId, fromRetryQueue ?? true, baseUpdatedAt, operationId),
      pushProject: (project, sourceUserId, taskIdsToDelete, taskDeleteBaseUpdatedAtMap, operationId) =>
        this.handleProjectRetry(project, sourceUserId, taskIdsToDelete, taskDeleteBaseUpdatedAtMap, operationId),
      pushConnection: (conn, pid, sourceUserId, operationId) =>
        this.deps.pushConnection(conn, pid, false, false, true, sourceUserId, operationId, true),
      pushBlackBoxEntry: (entry: BlackBoxEntry, sourceUserId?: string, operationId?: string) =>
        this.handleBlackBoxRetry(entry, sourceUserId, operationId),
      isSessionExpired: () => this.deps.syncState().sessionExpired,
      isOnline: () => this.deps.state().isOnline && !this.deps.supabase.isOfflineMode(),
      onProcessingStateChange: (processing, pendingCount) => {
        this.deps.syncStateService.update({ isSyncing: processing, pendingCount });
        if (!processing && pendingCount === 0 && this.deps.retryQueueService.hasSuccessfulDrainFlag()) {
          this.deps.markSyncRecoveredIfIdle(nowISO());
        }
      }
    };

    this.deps.retryQueueService.setOperationHandler(retryHandler);
  }

  setupBlackBoxRetryHandler(): void {
    this.deps.blackBoxSync.setRetryQueueHandler(async (entry: BlackBoxEntry) => {
      const ownerUserId = entry.userId?.trim();
      if (!ownerUserId) {
        this.deps.logger.warn('BlackBox retry enqueue skipped: missing owner userId', {
          entryId: entry.id,
        });
        return false;
      }

      return await this.deps.addToRetryQueueDurably(
        'blackbox',
        'upsert',
        entry,
        entry.projectId ?? undefined,
        ownerUserId,
      );
    });
  }

  setupLifecycleListeners(cleanup: () => void): void {
    const detachConnectivityListener = this.deps.supabase.onConnectivityChange((change) => {
      this.handleSupabaseConnectivityChange(change);
    });

    this.deps.destroyRef.onDestroy(() => {
      detachConnectivityListener();
      cleanup();
    });
  }

  startRuntime(): void {
    if (this.runtimeStarted) {
      return;
    }

    let connectivityRecoveryStarted = false;
    let realtimeRuntimeInitialized = false;
    let networkListenersAttached = false;
    let retryLoopStarted = false;

    try {
      this.deps.connectivityRecovery.startRuntime();
      connectivityRecoveryStarted = true;
      this.deps.realtimePollingService.initializeRuntime();
      realtimeRuntimeInitialized = true;
      this.setupNetworkListeners();
      networkListenersAttached = true;
      this.deps.retryQueueService.startLoop(5000);
      retryLoopStarted = true;

      if (this.deps.supabase.isConfigured) {
        if (this.deps.supabase.isOfflineMode()) {
          this.deps.syncStateService.setOfflineMode(true);
          this.deps.connectivityRecovery.scheduleConnectivityRecovery('runtime-start', SYNC_CONFIG.CONNECTIVITY_PROBE_INTERVAL);
        } else {
          this.deps.connectivityRecovery.scheduleConnectivityRecovery('runtime-start-online', 0);
        }
      }

      this.runtimeStarted = true;
    } catch (error) {
      if (retryLoopStarted) {
        this.deps.retryQueueService.stopLoop();
      }
      if (networkListenersAttached) {
        this.teardownNetworkListeners();
      }
      if (realtimeRuntimeInitialized) {
        this.deps.realtimePollingService.teardownRuntime();
      }
      if (connectivityRecoveryStarted) {
        this.deps.connectivityRecovery.stopRuntime();
      }
      this.runtimeStarted = false;
      throw error;
    }
  }

  stopRuntime(): void {
    if (!this.runtimeStarted) {
      return;
    }

    this.runtimeStarted = false;
    this.deps.connectivityRecovery.stopRuntime();
    this.teardownNetworkListeners();
    this.deps.retryQueueService.stopLoop();
    this.deps.realtimePollingService.teardownRuntime();
  }

  private async handleProjectRetry(
    project: Project,
    sourceUserId?: string,
    taskIdsToDelete?: string[],
    taskDeleteBaseUpdatedAtMap?: TaskDeleteBaseUpdatedAtMap,
    operationId?: string,
  ): Promise<boolean> {
    const actionQueue = this.deps.getActionQueue();
    if (!actionQueue) {
      this.deps.logger.warn('ActionQueueService 不可用，项目重试保持在 RetryQueue 中等待后续回放', {
        projectId: project.id,
        sourceUserId,
        pendingTaskDeleteCount: taskIdsToDelete?.length ?? 0,
      });
      return false;
    }

    if (!sourceUserId) {
      this.deps.logger.warn('项目重试缺少 sourceUserId，拒绝转交 ActionQueue 以避免 owner bucket 错位', {
        projectId: project.id,
        pendingTaskDeleteCount: taskIdsToDelete?.length ?? 0,
      });
      return false;
    }

    const actionId = await actionQueue.enqueueDurablyForOwner(sourceUserId, {
      ...(operationId === undefined ? {} : { operationId }),
      type: 'update',
      entityType: 'project',
      entityId: project.id,
      payload: {
        project,
        sourceUserId,
        taskIdsToDelete,
        taskDeleteBaseUpdatedAtMap,
      },
    });

    if (!actionId) {
      this.deps.logger.warn('项目重试转交 ActionQueue 失败，保留在 RetryQueue 中等待后续回放', {
        projectId: project.id,
        sourceUserId,
        pendingTaskDeleteCount: taskIdsToDelete?.length ?? 0,
      });
      return false;
    }

    return true;
  }

  private async handleBlackBoxRetry(entry: BlackBoxEntry, sourceUserId?: string, operationId?: string): Promise<boolean> {
    if (!sourceUserId) {
      this.deps.logger.warn('BlackBox retry deferred: missing queued owner', {
        entryId: entry.id,
      });
      return Promise.resolve(false);
    }

    if (entry.userId !== sourceUserId) {
      this.deps.logger.warn('BlackBox retry rejected: entry owner mismatch', {
        entryId: entry.id,
        hasSourceUserId: !!sourceUserId,
        hasEntryUserId: !!entry.userId,
      });
      try {
        await this.deps.blackBoxSync.markEntrySyncConflict(entry);
        return true;
      } catch (error) {
        this.deps.logger.warn('BlackBox retry owner mismatch repair failed', {
          entryId: entry.id,
          error: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
    }
    return this.deps.blackBoxSync.pushToServer(entry, sourceUserId, operationId);
  }

  private setupNetworkListeners(): void {
    if (typeof window === 'undefined') return;

    try {
      window.addEventListener('online', this.handleOnline);
      window.addEventListener('offline', this.handleOffline);
    } catch (error) {
      this.teardownNetworkListeners();
      throw error;
    }
  }

  private teardownNetworkListeners(): void {
    if (typeof window === 'undefined') return;

    const cleanupListener = (type: 'online' | 'offline', listener: () => void): void => {
      try {
        window.removeEventListener(type, listener);
      } catch (error) {
        this.deps.logger.warn('同步运行时网络监听清理失败，已继续停止其他运行时资源', error);
      }
    };

    cleanupListener('online', this.handleOnline);
    cleanupListener('offline', this.handleOffline);
  }

  private handleSupabaseConnectivityChange(change: SupabaseConnectivityChange): void {
    if (!this.runtimeStarted) {
      return;
    }

    this.deps.connectivityRecovery.handleSupabaseConnectivityChange(change, this.deps.syncState().isOnline);
  }
}
