interface AuthSessionRestoreSubscription { unsubscribe(): void; }

interface AuthSessionRestoreEventStream { subscribe(listener: () => void): AuthSessionRestoreSubscription; }

interface PersistedSessionIdentity { userId: string; email: string | null; }

interface PendingSyncSessionRecoveryAuthority { ownerUserId: string; authIdentityFence: string; }

export interface ApplyConfirmedSessionIdentityOptions { publishSessionRestored?: boolean; source?: string; }

export interface AuthSessionRestoreControllerOptions {
  advanceAuthIdentityGeneration: () => void;
  applyAuthenticatedIdentity: (userId: string, email: string | null) => void;
  captureAuthIdentityFence: () => string;
  clearPendingStorageBridgeSessionIdentity: () => void;
  currentUserId: () => string | null;
  localModeUserId: string;
  pendingSessionRestoredNotification: () => boolean;
  peekPersistedSessionIdentity: () => PersistedSessionIdentity | null;
  publishSessionRestored: (userId: string, source: string) => void;
  sessionExpired: () => boolean;
  sessionRecoveryRequired$: AuthSessionRestoreEventStream;
  setPendingSessionRestoredNotification: (value: boolean) => void;
  setSessionExpired: (value: boolean) => void;
}

export class AuthSessionRestoreController {
  private pendingSyncSessionRecovery: PendingSyncSessionRecoveryAuthority | null = null;
  private activeArmToken: object | null = null;
  private activeSettlementToken: object | null = null;
  private destroyed = false;
  private readonly recoveryRequiredSubscription: AuthSessionRestoreSubscription;

  constructor(private readonly options: AuthSessionRestoreControllerOptions) {
    this.recoveryRequiredSubscription = options.sessionRecoveryRequired$
      .subscribe(() => this.armSyncSessionRecoveryRequirement());
  }

  completeCrossTabSessionRestore(userId: string): void {
    this.runSettlement(settlementToken => {
      if (this.options.currentUserId() !== userId
        || !this.isActiveSettlement(settlementToken)) return;
      const sessionIdentity = this.options.peekPersistedSessionIdentity();
      if (!this.isActiveSettlement(settlementToken)
        || !sessionIdentity || sessionIdentity.userId !== userId) return;
      this.options.clearPendingStorageBridgeSessionIdentity();
      if (!this.isActiveSettlement(settlementToken)) return;
      this.applyConfirmedSessionIdentityWithinSettlement(
        settlementToken, userId, sessionIdentity.email ?? null,
      );
    });
  }

  applyConfirmedSessionIdentity(
    userId: string,
    email: string | null,
    options?: ApplyConfirmedSessionIdentityOptions,
  ): void {
    this.runSettlement(settlementToken => this.applyConfirmedSessionIdentityWithinSettlement(
      settlementToken, userId, email, options,
    ));
  }

  private runSettlement(callback: (settlementToken: object) => void): void {
    if (this.destroyed) return;
    const settlementToken = {};
    this.activeSettlementToken = settlementToken;
    try {
      callback(settlementToken);
    } finally {
      if (this.isActiveSettlement(settlementToken)) this.activeSettlementToken = null;
    }
  }

  private applyConfirmedSessionIdentityWithinSettlement(
    settlementToken: object,
    userId: string,
    email: string | null,
    options?: ApplyConfirmedSessionIdentityOptions,
  ): void {
    const shouldPublishPendingSyncRecovery = options?.publishSessionRestored
      ? this.consumePendingSyncSessionRecovery(userId)
      : false;
    if (!this.isActiveSettlement(settlementToken)) return;
    this.options.applyAuthenticatedIdentity(userId, email);
    if (!this.isActiveSettlement(settlementToken)) return;
    this.options.advanceAuthIdentityGeneration();
    if (!this.isActiveSettlement(settlementToken)) return;
    this.publishSessionRestoredIfCurrent(
      settlementToken, userId, shouldPublishPendingSyncRecovery, options,
    );
  }

  clearPendingSyncSessionRecovery(): void {
    this.pendingSyncSessionRecovery = null;
    this.activeArmToken = null;
    this.activeSettlementToken = null;
  }

  destroy(): void {
    this.clearPendingSyncSessionRecovery();
    if (this.destroyed) return;
    this.destroyed = true;
    this.recoveryRequiredSubscription.unsubscribe();
  }

  private armSyncSessionRecoveryRequirement(): void {
    if (this.destroyed) return;
    const armToken = {};
    this.activeArmToken = armToken;
    const currentUserId = this.options.currentUserId();
    if (!this.isActiveArm(armToken)) return;
    if (!currentUserId || currentUserId === this.options.localModeUserId) {
      this.clearPendingSyncSessionRecovery();
      return;
    }

    const authIdentityFence = this.options.captureAuthIdentityFence();
    if (!this.isActiveArm(armToken)) return;
    this.pendingSyncSessionRecovery = {
      ownerUserId: currentUserId,
      authIdentityFence,
    };
  }

  private consumePendingSyncSessionRecovery(userId: string): boolean {
    const pendingSyncSessionRecovery = this.pendingSyncSessionRecovery;
    this.pendingSyncSessionRecovery = null;
    this.activeArmToken = null;
    if (!pendingSyncSessionRecovery) return false;

    return pendingSyncSessionRecovery.ownerUserId === userId
      && this.options.currentUserId() === userId
      && pendingSyncSessionRecovery.authIdentityFence === this.options.captureAuthIdentityFence();
  }

  private isActiveSettlement(settlementToken: object): boolean {
    return this.activeSettlementToken === settlementToken;
  }

  private isActiveArm(armToken: object): boolean {
    return !this.destroyed && this.activeArmToken === armToken;
  }

  private publishSessionRestoredIfCurrent(
    settlementToken: object,
    userId: string,
    shouldPublishPendingSyncRecovery: boolean,
    options?: ApplyConfirmedSessionIdentityOptions,
  ): void {
    if (!options?.publishSessionRestored) return;
    const sessionExpired = this.options.sessionExpired();
    if (!this.isActiveSettlement(settlementToken)) return;
    let pendingSessionRestoredNotification = false;
    if (!sessionExpired) {
      pendingSessionRestoredNotification = this.options.pendingSessionRestoredNotification();
      if (!this.isActiveSettlement(settlementToken)) return;
    }
    const shouldPublish = sessionExpired
      || pendingSessionRestoredNotification
      || shouldPublishPendingSyncRecovery;
    if (sessionExpired) {
      this.options.setSessionExpired(false);
      if (!this.isActiveSettlement(settlementToken)) return;
    }
    if (!shouldPublish) return;
    this.options.setPendingSessionRestoredNotification(false);
    if (!this.isActiveSettlement(settlementToken)) return;
    this.options.publishSessionRestored(userId, options.source ?? 'AuthService');
  }
}
