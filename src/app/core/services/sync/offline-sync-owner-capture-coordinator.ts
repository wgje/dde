import {
  createOfflineCommandStore,
  type OfflineCommandStore,
  type OfflineCommandStoreOptions,
  type OfflineCommandStoreCommandStatus,
} from '../../../../services/sync/offline-command-store';
import {
  negotiateOfflineSyncCapabilities,
  type OfflineSyncCapability,
  type OfflineSyncCapabilityDecision,
} from '../../../../services/sync/offline-sync-capability-gate';
import { loadOrCreateOfflineSyncDeviceIdentity, type OfflineSyncDeviceIdentity, type OfflineSyncIdentityStorage } from '../../../../services/sync/offline-sync-device-identity';
import type { SyncProtocolInfo } from '../../../../services/sync-rpc-client.service';
import {
  createOfflineSyncCaptureRuntime,
  type OfflineSyncCaptureRuntime,
} from './offline-sync-capture-runtime';

/**
 * Owner-scoped lifecycle seam. Call only after AuthOwnerTransitionController
 * has committed and the new owner's queues have reloaded.
 */
export interface OfflineSyncOwnerCaptureCoordinatorOptions {
  readonly identityStorage: OfflineSyncIdentityStorage;
  readonly storeOptions?: OfflineCommandStoreOptions;
  readonly featureEnabled: boolean;
  /** Capabilities that must be advertised by the remote server; local guarantees are always present. */
  readonly requiredCapabilities?: readonly OfflineSyncCapability[];
  readonly protocolProbe: () => Promise<SyncProtocolInfo | null>;
  readonly pullProjections?: (ownerUserId: string, store: OfflineCommandStore) => Promise<void>;
  /** Drains durable commands only after the capability gate enables command mode. */
  readonly capturePendingLegacyCommands?: (ownerUserId: string, store: OfflineCommandStore) => Promise<void>;
  readonly replayPendingCommands?: (ownerUserId: string, store: OfflineCommandStore) => Promise<void>;
}

const REPLAYABLE_STATUSES: readonly OfflineCommandStoreCommandStatus[] = ['pending', 'sent', 'unknown'];

export class OfflineSyncOwnerCaptureCoordinator {
  private readonly options: OfflineSyncOwnerCaptureCoordinatorOptions;
  private readonly identity: OfflineSyncDeviceIdentity;
  private runtime: OfflineSyncCaptureRuntime | null = null;
  private activeStore: OfflineCommandStore | null = null;
  private ownerUserId: string | null = null;
  private capability: OfflineSyncCapabilityDecision | null = null;
  private retryRequired = false;
  private lifecycleGeneration = 0;
  private refreshPromise: Promise<OfflineSyncCapabilityDecision | null> | null = null;

  constructor(options: OfflineSyncOwnerCaptureCoordinatorOptions) {
    this.options = options;
    this.identity = loadOrCreateOfflineSyncDeviceIdentity(options.identityStorage);
  }

  currentOwnerUserId(): string | null {
    return this.ownerUserId;
  }

  currentCapability(): OfflineSyncCapabilityDecision | null {
    return this.capability;
  }

  currentDeviceIdentity(): OfflineSyncDeviceIdentity {
    return this.identity;
  }

  isActive(): boolean {
    return this.options.featureEnabled && this.runtime !== null && this.activeStore !== null;
  }

  async onOwnerCommitted(ownerUserId: string): Promise<OfflineSyncCapabilityDecision> {
    if (this.ownerUserId === ownerUserId && this.runtime) {
      return await this.refreshCurrentOwner()
        ?? this.capability
        ?? this.unavailableCapability();
    }

    this.dispose();
    this.ownerUserId = ownerUserId;
    if (!this.options.featureEnabled) {
      this.capability = this.unavailableCapability();
      return this.capability;
    }

    // Install local capture before probing the network. A slow or offline probe
    // must never create a gap in the durable local command stream.
    this.activeStore = createOfflineCommandStore(this.options.storeOptions);
    const localCaptureDecision = this.unavailableCapability();
    this.runtime = createOfflineSyncCaptureRuntime({
      store: this.activeStore,
      enabled: true,
      capability: localCaptureDecision,
      ownerUserId,
      installationId: this.identity.installationId,
      deviceId: this.identity.deviceId,
    });
    this.runtime.install();
    this.capability = localCaptureDecision;

    try {
      return await this.refreshCurrentOwner() ?? this.capability;
    } catch {
      // Local capture is already installed; transient probe/pull/replay failures
      // defer remote work and are retried by the owner service.
      this.retryRequired = true;
      return this.capability;
    }
  }

  /** Re-probes after network/lifecycle recovery and drains the same owner store. */
  async refreshCurrentOwner(): Promise<OfflineSyncCapabilityDecision | null> {
    if (!this.ownerUserId || !this.runtime || !this.activeStore || !this.options.featureEnabled) return null;
    if (this.refreshPromise) return this.refreshPromise;

    const ownerUserId = this.ownerUserId;
    const store = this.activeStore;
    const generation = this.lifecycleGeneration;
    const refresh = this.refreshOwner(ownerUserId, store, generation)
      .finally(() => {
        if (this.refreshPromise === refresh) this.refreshPromise = null;
      });
    this.refreshPromise = refresh;
    return refresh;
  }

  requiresConnectivityRetry(ownerUserId: string): boolean {
    return this.ownerUserId === ownerUserId && this.retryRequired;
  }

  async hasReplayWork(ownerUserId: string): Promise<boolean> {
    const store = this.activeStore;
    if (!store || this.ownerUserId !== ownerUserId) return false;
    const batches = await Promise.all(REPLAYABLE_STATUSES.map(status => store.listCommands(ownerUserId, status)));
    return batches.some(batch => batch.length > 0);
  }

  onOwnerInvalidated(): void {
    this.dispose();
  }

  dispose(): void {
    this.lifecycleGeneration += 1;
    this.refreshPromise = null;
    this.runtime?.dispose();
    this.runtime = null;
    this.activeStore = null;
    this.ownerUserId = null;
    this.capability = null;
    this.retryRequired = false;
  }

  private async refreshOwner(
    ownerUserId: string,
    store: OfflineCommandStore,
    generation: number,
  ): Promise<OfflineSyncCapabilityDecision | null> {
    try {
      // Owner-committed legacy queues may have been loaded before capture hooks
      // were installed. Capture those durable entries first; network probing and
      // replay are both fenced behind a complete owner-scoped snapshot.
      if (this.options.capturePendingLegacyCommands) {
        await this.options.capturePendingLegacyCommands(ownerUserId, store);
      }
    } catch (error) {
      this.retryRequired = true;
      throw error;
    }
    if (!this.isCurrentOwner(ownerUserId, store, generation)) return null;

    let protocol: SyncProtocolInfo | null;
    try {
      protocol = await this.options.protocolProbe();
    } catch {
      protocol = null;
    }
    if (!this.isCurrentOwner(ownerUserId, store, generation)) return null;

    const capability = negotiateOfflineSyncCapabilities({
      clientProtocolVersion: 1,
      server: protocol
        ? {
          minProtocolVersion: protocol.minProtocolVersion,
          deploymentEpoch: protocol.deploymentEpoch,
          capabilities: protocol.capabilities,
        }
        : null,
      requiredCapabilities: this.options.requiredCapabilities,
    });
    this.capability = capability;
    this.retryRequired = capability.mode !== 'command';
    if (capability.mode !== 'command') return capability;

    try {
      // Pull before replay so dependency/conflict decisions use the latest server
      // projection. A failed pull keeps local capture alive and defers replay.
      if (this.options.pullProjections) await this.options.pullProjections(ownerUserId, store);
      if (!this.isCurrentOwner(ownerUserId, store, generation)) return null;
      if (this.options.replayPendingCommands) await this.options.replayPendingCommands(ownerUserId, store);
      if (!this.isCurrentOwner(ownerUserId, store, generation)) return null;
      if (this.options.pullProjections) await this.options.pullProjections(ownerUserId, store);
      this.retryRequired = false;
      return this.isCurrentOwner(ownerUserId, store, generation) ? capability : null;
    } catch (error) {
      this.retryRequired = true;
      throw error;
    }
  }

  private isCurrentOwner(ownerUserId: string, store: OfflineCommandStore, generation: number): boolean {
    return this.ownerUserId === ownerUserId
      && this.activeStore === store
      && this.lifecycleGeneration === generation;
  }

  private unavailableCapability(): OfflineSyncCapabilityDecision {
    return negotiateOfflineSyncCapabilities({
      clientProtocolVersion: 1,
      server: null,
      requiredCapabilities: this.options.requiredCapabilities,
    });
  }
}
