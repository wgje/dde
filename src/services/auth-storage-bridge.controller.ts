import type { PersistedSessionIdentity } from './auth-session-identity';

export interface AuthStorageBridgeContext {
  storageKey: () => string | null;
  authRuntimeReady: () => boolean;
  isLocalModeEnabled: () => boolean;
  currentUserId: () => string | null;
  localModeUserId: string;
  sessionExpired: () => boolean;
  pendingStorageBridgeSessionIdentity: () => PersistedSessionIdentity | null;
  setPendingStorageBridgeSessionIdentity: (identity: PersistedSessionIdentity | null) => void;
  setPersistedOwnerHint: (userId: string | null) => void;
  syncPersistedOwnerHintFromStorage: () => void;
  syncPersistedSessionUserIdFromStorage: () => void;
  resolvePersistedSessionIdentityFromAuthData: (authData: unknown) => PersistedSessionIdentity | null;
  applyConfirmedSessionIdentity: (
    userId: string,
    email: string | null,
    options: { publishSessionRestored: boolean; source: string }
  ) => void;
  publishSessionRestored: (userId: string, source: string) => void;
  teardownInvalidatedSession: (source: string) => void;
  debug: (message: string, data?: unknown) => void;
}

export class AuthStorageBridgeController {
  constructor(private readonly context: AuthStorageBridgeContext) {}

  handleStorageEvent(event: StorageEvent): void {
    const storageKey = this.context.storageKey();
    if (!storageKey || event.key !== storageKey) {
      return;
    }

    if (!event.newValue) {
      this.context.teardownInvalidatedSession('AuthService.storageBridge');
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
      const sessionIdentity = this.parseSessionIdentity(event.newValue);
      const userId = sessionIdentity?.userId ?? null;
      const email = sessionIdentity?.email ?? null;

      if (!userId) {
        this.syncPersistedHints();
        return;
      }

      if (this.context.currentUserId() === userId) {
        this.context.setPendingStorageBridgeSessionIdentity(null);
        this.context.applyConfirmedSessionIdentity(userId, email, {
          publishSessionRestored: this.context.sessionExpired(),
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

  private parseSessionIdentity(raw: string): PersistedSessionIdentity | null {
    const parsed = JSON.parse(raw) as unknown;
    return this.context.resolvePersistedSessionIdentityFromAuthData(parsed);
  }

  private syncPersistedHints(): void {
    this.context.syncPersistedOwnerHintFromStorage();
    this.context.syncPersistedSessionUserIdFromStorage();
  }
}
