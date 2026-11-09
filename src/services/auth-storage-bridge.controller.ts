import type { PersistedSessionIdentity } from './auth-session-identity';
import type { CanonicalAuthBundle } from './supabase-auth-client-lifecycle.controller';

export interface AuthStorageBridgeContext {
  storageKey: () => string | null;
  authRuntimeReady: () => boolean;
  isLocalModeEnabled: () => boolean;
  currentUserId: () => string | null;
  localModeUserId: string;
  peekPersistedSessionIdentity: () => PersistedSessionIdentity | null;
  sessionExpired: () => boolean;
  pendingStorageBridgeSessionIdentity: () => PersistedSessionIdentity | null;
  setPendingStorageBridgeSessionIdentity: (identity: PersistedSessionIdentity | null) => void;
  setPersistedOwnerHint: (userId: string | null) => void;
  syncPersistedOwnerHintFromStorage: () => void;
  syncPersistedSessionUserIdFromStorage: () => void;
  resolvePersistedSessionIdentityFromAuthData: (authData: unknown) => PersistedSessionIdentity | null;
  captureAcceptedSession: (session: AuthStorageBridgeSession) => void;
  applyConfirmedSessionIdentity: (
    userId: string,
    email: string | null,
    options?: { publishSessionRestored?: boolean; source?: string }
  ) => void;
  publishSessionRestored: (userId: string, source: string) => void;
  teardownInvalidatedSession: (source: string) => void;
  readCanonicalBundle: () => Promise<CanonicalAuthBundle>;
  restartAuthRuntimeForStorageAdoption: () => Promise<void>;
  debug: (message: string, data?: unknown) => void;
}

export interface AuthStorageBridgeSession {
  access_token?: string;
  user?: { id: string; email?: string | null };
}

type PendingCanonicalAdoption = {
  accessToken: string;
  bundleFingerprint: string;
  email: string | null;
  sequence: number;
  userId: string;
};

export class AuthStorageBridgeController {
  private eventQueue = Promise.resolve();
  private eventSequence = 0;
  private sameUserRecoveryState: 'idle' | 'armed' | 'published' = 'idle';
  private lastBundleFingerprint: string | null = null;
  private pendingAdoption: PendingCanonicalAdoption | null = null;
  private adoptionTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly context: AuthStorageBridgeContext) {}

  shouldDeferSignedOutInvalidation(): boolean {
    const currentUserId = this.context.currentUserId();
    const pendingIdentity = this.context.pendingStorageBridgeSessionIdentity();
    if (!currentUserId || !pendingIdentity || pendingIdentity.userId === currentUserId) {
      return false;
    }

    return this.context.peekPersistedSessionIdentity()?.userId === pendingIdentity.userId;
  }

  handleInitialSession(
    session: AuthStorageBridgeSession | null,
  ): void {
    if (!session?.user) {
      return;
    }

    const adoption = this.pendingAdoption;
    if (adoption) {
      if (session.user.id !== adoption.userId || session.access_token !== adoption.accessToken) return;
      void this.settleCanonicalAdoption(adoption, session);
      return;
    }

    this.context.captureAcceptedSession(session);
    this.applyInitialSessionIdentity(session.user.id, session.user.email ?? null);
  }

  reset(): void {
    this.eventSequence += 1;
    this.sameUserRecoveryState = 'idle';
    this.pendingAdoption = null;
    this.lastBundleFingerprint = null;
    if (this.adoptionTimeout !== null) clearTimeout(this.adoptionTimeout);
    this.adoptionTimeout = null;
  }

  private armSameUserRecovery(userId: string): void {
    if (
      this.sameUserRecoveryState === 'idle'
      && this.context.currentUserId() === userId
      && this.context.sessionExpired()
    ) {
      this.sameUserRecoveryState = 'armed';
    }
  }

  private consumeSameUserRecovery(): boolean {
    if (this.sameUserRecoveryState !== 'armed') return false;
    this.sameUserRecoveryState = 'published';
    return true;
  }

  private teardownInvalidatedStorageSession(source: string): void {
    this.sameUserRecoveryState = 'idle';
    this.context.teardownInvalidatedSession(source);
  }

  private applyInitialSessionIdentity(
    userId: string,
    email: string | null,
    publishRecovery = false,
  ): void {
    const currentUserId = this.context.currentUserId();

    if (!currentUserId) {
      this.context.setPendingStorageBridgeSessionIdentity(null);
      this.context.applyConfirmedSessionIdentity(userId, email, publishRecovery
        ? {
            publishSessionRestored: true,
            source: 'AuthService.storageBridge',
          }
        : undefined);
      return;
    }

    if (currentUserId === userId) {
      this.armSameUserRecovery(userId);
      const publishSessionRestored = this.consumeSameUserRecovery();
      if (publishRecovery || publishSessionRestored) {
        this.context.applyConfirmedSessionIdentity(userId, email, {
          publishSessionRestored,
          source: 'AuthService.storageBridge',
        });
      } else {
        this.context.setPendingStorageBridgeSessionIdentity(null);
      }
      return;
    }

    const previousPendingUserId = this.context.pendingStorageBridgeSessionIdentity()?.userId ?? null;
    this.context.setPendingStorageBridgeSessionIdentity({ userId, email });
    this.context.setPersistedOwnerHint(userId);

    if (previousPendingUserId === userId) {
      return;
    }

    this.context.publishSessionRestored(userId, 'AuthService.storageBridge');
  }

  handleStorageEvent(event: StorageEvent): void {
    const storageKey = this.context.storageKey();
    if (!storageKey || !this.isCanonicalBundleKey(event.key, storageKey)) return;
    if (!this.isAuthoritativeStorageArea(event.storageArea)) return;

    if (event.storageArea) {
      const sequence = ++this.eventSequence;
      this.eventQueue = this.eventQueue
        .catch(() => undefined)
        .then(() => this.reconcileCanonicalStorageEvent(event, sequence));
      return;
    }

    if (event.key !== storageKey) return;

    const currentValue = this.resolveCurrentStorageValue(event, storageKey);
    if (currentValue === undefined) return;

    this.applyResolvedStorageValue(currentValue);
  }

  private applyResolvedStorageValue(currentValue: string | null): void {

    if (!currentValue) {
      this.teardownInvalidatedStorageSession('AuthService.storageBridge');
      return;
    }

    if (!this.context.authRuntimeReady()) {
      return;
    }

    if (
      this.context.isLocalModeEnabled()
      || this.context.currentUserId() === this.context.localModeUserId
    ) {
      this.context.debug('Storage bridge 忽略 local-user 模式下的跨标签页登入事件');
      return;
    }

    try {
      const sessionIdentity = this.parseSessionIdentity(currentValue);
      const userId = sessionIdentity?.userId ?? null;
      const email = sessionIdentity?.email ?? null;

      if (!userId) {
        this.syncPersistedHints();
        return;
      }

      if (this.context.currentUserId() === userId) {
        this.context.setPendingStorageBridgeSessionIdentity(null);
        this.armSameUserRecovery(userId);
        const publishSessionRestored = this.consumeSameUserRecovery();
        this.context.applyConfirmedSessionIdentity(userId, email, {
          publishSessionRestored,
          source: 'AuthService.storageBridge',
        });
        return;
      }

      const previousPendingUserId = this.context.pendingStorageBridgeSessionIdentity()?.userId ?? null;
      this.context.setPendingStorageBridgeSessionIdentity({ userId, email });
      this.context.setPersistedOwnerHint(userId);

      if (previousPendingUserId === userId) {
        return;
      }

      this.context.publishSessionRestored(userId, 'AuthService.storageBridge');
    } catch (error) {
      this.syncPersistedHints();
      this.context.debug('Storage bridge 解析 auth token 失败，已忽略', error);
    }
  }

  private async reconcileCanonicalStorageEvent(event: StorageEvent, sequence: number): Promise<void> {
    let bundle: CanonicalAuthBundle;
    try {
      bundle = await this.context.readCanonicalBundle();
    } catch (error) {
      if (sequence !== this.eventSequence) return;
      if (event.newValue === null && event.key === this.context.storageKey()) {
        this.teardownInvalidatedStorageSession('AuthService.storageBridge');
      } else {
        this.context.debug('Storage bridge 读取 canonical auth bundle 失败，已忽略', error);
      }
      return;
    }
    if (sequence !== this.eventSequence) return;

    const fingerprint = this.bundleFingerprint(bundle);
    if (fingerprint === this.lastBundleFingerprint) return;
    this.lastBundleFingerprint = fingerprint;
    if (!bundle.session) {
      if (sequence === this.eventSequence) this.teardownInvalidatedStorageSession('AuthService.storageBridge');
      return;
    }
    if (!this.context.authRuntimeReady() || this.context.isLocalModeEnabled()) return;

    try {
      const parsed = JSON.parse(bundle.session) as Record<string, unknown>;
      const identity = this.context.resolvePersistedSessionIdentityFromAuthData(parsed);
      const accessToken = this.resolveAccessToken(parsed);
      if (!identity?.userId || !accessToken) return;
      this.armSameUserRecovery(identity.userId);
      this.pendingAdoption = {
        accessToken,
        bundleFingerprint: fingerprint,
        email: identity.email,
        sequence,
        userId: identity.userId,
      };
      this.armAdoptionTimeout(sequence);
      await this.context.restartAuthRuntimeForStorageAdoption();
    } catch (error) {
      if (this.pendingAdoption?.sequence === sequence) this.pendingAdoption = null;
      this.context.debug('Storage bridge canonical adoption 启动失败，已忽略', error);
    }
  }

  private async settleCanonicalAdoption(
    adoption: PendingCanonicalAdoption,
    session: AuthStorageBridgeSession,
  ): Promise<void> {
    let bundle: CanonicalAuthBundle;
    try {
      bundle = await this.context.readCanonicalBundle();
    } catch (error) {
      this.context.debug('Storage bridge canonical adoption 复核失败，已忽略', error);
      return;
    }
    if (
      this.pendingAdoption !== adoption
      || adoption.sequence !== this.eventSequence
      || this.bundleFingerprint(bundle) !== adoption.bundleFingerprint
    ) return;
    this.pendingAdoption = null;
    if (this.adoptionTimeout !== null) clearTimeout(this.adoptionTimeout);
    this.adoptionTimeout = null;
    this.context.captureAcceptedSession(session);
    this.applyCanonicalInitialSessionIdentity(adoption.userId, adoption.email);
  }

  private applyCanonicalInitialSessionIdentity(userId: string, email: string | null): void {
    this.armSameUserRecovery(userId);
    this.applyInitialSessionIdentity(userId, email, true);
  }

  private resolveAccessToken(authData: Record<string, unknown>): string | null {
    const record = (authData['currentSession'] ?? authData['session'] ?? authData) as Record<string, unknown>;
    return typeof record?.['access_token'] === 'string' && record['access_token']
      ? record['access_token'] : null;
  }

  private bundleFingerprint(bundle: CanonicalAuthBundle): string {
    return JSON.stringify([bundle.session, bundle.codeVerifier, bundle.user]);
  }

  private isCanonicalBundleKey(eventKey: string | null, storageKey: string): boolean {
    return eventKey === storageKey || eventKey === `${storageKey}-code-verifier` || eventKey === `${storageKey}-user`;
  }

  private armAdoptionTimeout(sequence: number): void {
    if (this.adoptionTimeout !== null) clearTimeout(this.adoptionTimeout);
    this.adoptionTimeout = setTimeout(() => {
      if (this.pendingAdoption?.sequence === sequence) this.pendingAdoption = null;
      this.adoptionTimeout = null;
    }, 10_000);
  }

  private parseSessionIdentity(raw: string): PersistedSessionIdentity | null {
    const parsed = JSON.parse(raw) as unknown;
    return this.context.resolvePersistedSessionIdentityFromAuthData(parsed);
  }

  private isAuthoritativeStorageArea(storageArea: Storage | null): boolean {
    if (!storageArea) return true;

    try {
      return storageArea === globalThis.localStorage;
    } catch {
      return false;
    }
  }

  private resolveCurrentStorageValue(event: StorageEvent, storageKey: string): string | null | undefined {
    if (!event.storageArea) return event.newValue;

    try {
      return event.storageArea.getItem(storageKey);
    } catch (error) {
      if (!event.newValue) return null;
      this.context.debug('Storage bridge 读取当前 auth token 失败，已忽略', error);
      return undefined;
    }
  }

  private syncPersistedHints(): void {
    this.context.syncPersistedOwnerHintFromStorage();
    this.context.syncPersistedSessionUserIdFromStorage();
  }
}
