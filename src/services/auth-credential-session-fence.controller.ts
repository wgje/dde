import { AUTH_CONFIG } from '../config/auth.config';
import { ErrorCodes, failure, type OperationError, type Result } from '../utils/result';
import type { AuthCredentialStateCommitPredicate } from './auth-credential-flow.controller';
import { resolvePersistedSessionRecord } from './auth-session-identity';
import type { AuthResult } from './auth-types';
import type { CredentialRequestSessionBinding } from './supabase-client.service';
import type { ExplicitSignOutRevocation } from './auth-explicit-sign-out.controller';
import {
  getCanonicalAuthStorageAuthority,
  type CanonicalAuthBundle,
  type CanonicalAuthStorageAuthority,
} from './supabase-auth-client-lifecycle.controller';

export type AuthCredentialSessionUser = {
  id: string;
  email?: string | null;
};

export type AuthCredentialSession = {
  access_token?: string;
  user?: AuthCredentialSessionUser;
};

type AcceptedPersistedSessionSnapshot = {
  accessToken: string;
  raw: string;
  userId: string;
};

type PersistedCredentialSnapshot = {
  accessToken: string;
  authority: CanonicalAuthStorageAuthority;
  bundle: CanonicalAuthBundle;
  email: string | null;
  storageKey: string;
  userId: string;
};

type SignupInitialSessionAdoption = {
  accessToken: string;
  email: string | null;
  generation: number;
  outcome: boolean | null;
  userId: string;
};

interface AuthCredentialSessionFenceControllerOptions {
  isConfigured: () => boolean;
  runSignInRequest: (
    email: string,
    password: string,
    requestId: string | undefined,
    canCommitCredentialState: AuthCredentialStateCommitPredicate | undefined,
  ) => Promise<Result<AuthResult, OperationError>>;
  runSignUpRequest: (
    email: string,
    password: string,
    canCommitCredentialState: AuthCredentialStateCommitPredicate,
    afterSessionCommit: (
      session: Required<Pick<AuthCredentialSession, 'access_token' | 'user'>>,
      isAttemptActive?: () => boolean,
    ) => Promise<boolean>,
  ) => Promise<Result<AuthResult, OperationError>>;
  captureAuthIdentityFence: () => string;
  authorizeSignupAdoption: (
    session: Required<Pick<AuthCredentialSession, 'access_token' | 'user'>>,
    authorize: () => boolean,
  ) => Promise<boolean>;
  restartAuthRuntime: () => Promise<void>;
  storageKey: () => string | null;
  currentUserId: () => string | null;
  consumeCredentialRequestBinding: (accessToken: string) => CredentialRequestSessionBinding | null;
  pendingStorageBridgeUserId: () => string | null;
  deferStorageBridgeIdentity: (userId: string, email: string | null) => void;
  clearPendingStorageBridgeIdentity: () => void;
  applyConfirmedSessionIdentity: (userId: string, email: string | null) => void;
  clearCachedSessionArtifacts: () => void;
  sessionExpired: () => boolean;
  syncPersistedOwnerHintFromStorage: () => void;
  syncPersistedSessionUserIdFromStorage: () => void;
  debug: (message: string) => void;
  info: (message: string, data: unknown) => void;
  warn: (message: string, data: unknown) => void;
}

export class AuthCredentialSessionFenceController {
  private readonly activeCommitPredicates = new Map<string, AuthCredentialStateCommitPredicate>();
  private readonly revokedSessionKeys = new Set<string>();
  private readonly acceptedCredentialSessionKeys = new Set<string>();
  private requestSequence = 0;
  private signupAdoptionGeneration = 0;
  private latestAcceptedPersistedSession: AcceptedPersistedSessionSnapshot | null = null;
  private expiredRecoveryUserId: string | null = null;
  private pendingSignupInitialSessionAdoption: SignupInitialSessionAdoption | null = null;

  constructor(private readonly options: AuthCredentialSessionFenceControllerOptions) {}

  // eslint-disable-next-line max-lines-per-function -- adoption and restart phases are fenced around each await
  async signUp(
    email: string,
    password: string,
    canCommitCredentialState?: AuthCredentialStateCommitPredicate,
  ): Promise<Result<AuthResult, OperationError>> {
    if (!this.options.isConfigured()) {
      return failure(
        ErrorCodes.SYNC_AUTH_EXPIRED,
        'Supabase 未配置。请设置 NG_APP_SUPABASE_URL 和 NG_APP_SUPABASE_ANON_KEY。',
      );
    }

    const identityFence = this.options.captureAuthIdentityFence();
    const canCommit: AuthCredentialStateCommitPredicate = identity => {
      if (this.options.captureAuthIdentityFence() !== identityFence) return false;
      try {
        return canCommitCredentialState?.(identity) !== false;
      } catch {
        return false;
      }
    };
    let signupPhase = 0;
    return await this.options.runSignUpRequest(email, password, canCommit, async (session, isAttemptActive) => {
      const identity = { userId: session.user.id, email: session.user.email ?? null };
      const isActive = () => (isAttemptActive?.() ?? true) && canCommit(identity);
      const phaseActive = (phase: number) => phase === signupPhase && isActive();
      if (!isActive()) return false;
      const adoption = this.beginSignupInitialSessionAdoption(session);
      try {
        const adoptionPhase = ++signupPhase;
        const accepted = await this.options.authorizeSignupAdoption(session, () =>
          phaseActive(adoptionPhase) && this.settleSignupInitialSessionAdoption(adoption,
            this.pendingSignupInitialSessionAdoption === adoption
              && canCommit(identity) && this.isCurrentPersistedSessionIdentity(session)));
        if (!accepted || !phaseActive(adoptionPhase)) {
          this.rejectSignupInitialSessionAdoption(adoption);
          return false;
        }
        const restartPhase = ++signupPhase;
        if (!phaseActive(restartPhase)) {
          this.rejectSignupInitialSessionAdoption(adoption);
          return false;
        }
        await this.options.restartAuthRuntime();
        if (!phaseActive(restartPhase)) {
          this.rejectSignupInitialSessionAdoption(adoption);
          return false;
        }
        return true;
      } catch (error) {
        this.rejectSignupInitialSessionAdoption(adoption);
        throw error;
      }
    });
  }

  async signIn(
    email: string,
    password: string,
    canCommitCredentialState?: AuthCredentialStateCommitPredicate,
  ): Promise<Result<AuthResult, OperationError>> {
    if (!this.options.isConfigured()) {
      return failure(
        ErrorCodes.SYNC_AUTH_EXPIRED,
        'Supabase 未配置。请设置 NG_APP_SUPABASE_URL 和 NG_APP_SUPABASE_ANON_KEY。',
      );
    }

    const requestId = canCommitCredentialState ? this.beginRequest(canCommitCredentialState) : undefined;
    try {
      return await this.options.runSignInRequest(
        email,
        password,
        requestId,
        canCommitCredentialState,
      );
    } finally {
      if (requestId) this.activeCommitPredicates.delete(requestId);
    }
  }

  canCommit(requestId: string, user: AuthCredentialSessionUser): boolean {
    const predicate = this.activeCommitPredicates.get(requestId);
    if (!predicate) return false;

    try {
      return predicate({ userId: user.id, email: user.email ?? null }) === true;
    } catch {
      return false;
    }
  }

  shouldApplyInitialSession(session: AuthCredentialSession | null): boolean {
    const adoption = this.pendingSignupInitialSessionAdoption;
    if (!session?.access_token || !session.user) {
      if (adoption) this.settleSignupInitialSessionAdoption(adoption, false);
      return adoption === null;
    }

    const sessionKey = this.getSessionKey(session.user.id, session.access_token);
    if (this.revokedSessionKeys.has(sessionKey)) {
      this.removePersistedRevokedSession(session.user.id, session.access_token);
      this.options.debug('忽略已撤销 signup adoption 的迟到 INITIAL_SESSION');
      return false;
    }
    if (!adoption) return true;

    const exactAdoption = adoption.userId === session.user.id
      && adoption.email === (session.user.email ?? null)
      && adoption.accessToken === session.access_token;
    if (!exactAdoption) {
      if (!this.isCurrentPersistedSessionIdentity(session)) return false;
      this.settleSignupInitialSessionAdoption(adoption, false);
      return true;
    }
    return false;
  }

  cancelPendingSignupInitialSessionAdoption(): void {
    const adoption = this.pendingSignupInitialSessionAdoption;
    if (adoption) this.settleSignupInitialSessionAdoption(adoption, false);
  }

  handleTokenRefreshed(session: AuthCredentialSession | null): void {
    this.options.debug('Token 刷新成功');
    if (!session?.user) return;
    if (this.rejectRevokedSession(session)) return;

    const currentUserId = this.options.currentUserId();
    const pendingStorageBridgeUserId = this.options.pendingStorageBridgeUserId();
    if (
      pendingStorageBridgeUserId === session.user.id
      && currentUserId !== session.user.id
    ) {
      this.captureAcceptedPersistedSession(session);
      this.options.deferStorageBridgeIdentity(session.user.id, session.user.email ?? null);
      return;
    }

    if (!this.canCommitTokenRefresh(session, currentUserId)) {
      this.options.debug('忽略无 owner 证据的迟到 Token 刷新');
      return;
    }

    this.captureAcceptedPersistedSession(session);
    this.options.clearPendingStorageBridgeIdentity();
    this.options.applyConfirmedSessionIdentity(session.user.id, session.user.email ?? null);
  }

  handleSignedIn(session: AuthCredentialSession | null): void {
    if (!session?.user) return;
    if (this.rejectRevokedSession(session)) return;

    const sessionKey = session.access_token
      ? this.getSessionKey(session.user.id, session.access_token)
      : null;
    if (sessionKey && this.acceptedCredentialSessionKeys.has(sessionKey)) {
      this.options.debug('忽略已消费的重复 SIGNED_IN 事件');
      return;
    }

    const binding = session.access_token
      ? this.options.consumeCredentialRequestBinding(session.access_token)
      : null;
    if (binding && !this.canCommit(binding.requestId, session.user)) {
      this.discardPersistedSession(session, binding);
      return;
    }

    if (sessionKey) this.acceptedCredentialSessionKeys.add(sessionKey);
    this.captureAcceptedPersistedSession(session);
    this.options.info('用户已登录', { userId: session.user.id });
    if (
      this.options.pendingStorageBridgeUserId() === session.user.id
      && this.options.currentUserId() !== session.user.id
    ) {
      this.options.deferStorageBridgeIdentity(session.user.id, session.user.email ?? null);
      return;
    }

    this.options.clearPendingStorageBridgeIdentity();
    this.options.applyConfirmedSessionIdentity(session.user.id, session.user.email ?? null);
  }

  discardPersistedSession(
    session: AuthCredentialSession,
    binding: CredentialRequestSessionBinding,
  ): void {
    const storageKey = this.options.storageKey();
    if (!storageKey || !session.access_token || typeof localStorage === 'undefined') return;

    try {
      const persisted = this.readPersistedCredential();
      if (!persisted || persisted.accessToken !== session.access_token) return;
      const restoreRaw = this.resolvePreviousPersistedSession(binding, session.access_token);
      void this.replacePersistedSession(persisted, restoreRaw, !restoreRaw);
    } catch (error) {
      this.options.warn('拒绝迟到登录时无法校验持久化会话，已保留现有 storage', { error });
    }
  }

  captureAcceptedPersistedSession(session: AuthCredentialSession): void {
    const storageKey = this.options.storageKey();
    if (!storageKey || !session.access_token || !session.user || typeof localStorage === 'undefined') {
      return;
    }

    try {
      const persisted = this.readPersistedCredential();
      const raw = persisted?.bundle.session;
      if (!raw || persisted.accessToken !== session.access_token) return;
      this.latestAcceptedPersistedSession = {
        accessToken: session.access_token,
        raw,
        userId: session.user.id,
      };
      this.expiredRecoveryUserId = null;
    } catch {
      // Storage 不可读时保留最后一次已验证快照；stale cleanup 仍受 exact-token 检查保护。
    }
  }

  clearAcceptedPersistedSession(): void {
    this.cancelPendingSignupInitialSessionAdoption();
    this.expiredRecoveryUserId = this.latestAcceptedPersistedSession?.userId ?? null;
    this.latestAcceptedPersistedSession = null;
  }

  isCurrentPersistedSession(userId: string, accessToken: string): boolean {
    const persisted = this.readPersistedCredential();
    return persisted?.userId === userId && persisted.accessToken === accessToken;
  }

  captureExplicitSignOutRevocation(): ExplicitSignOutRevocation {
    const revocationKey = this.captureCurrentSessionKey();
    const cleanupSnapshot = this.readPersistedCredential();
    const commit = (async () => {
      if (revocationKey) this.revokedSessionKeys.add(revocationKey);
      this.expiredRecoveryUserId = null;
      this.latestAcceptedPersistedSession = null;
      if (cleanupSnapshot) await this.replacePersistedSession(cleanupSnapshot, null);
    }) as ExplicitSignOutRevocation;
    commit.isCurrent = () => this.captureCurrentSessionKey() === revocationKey;
    return commit;
  }

  reset(): void {
    this.cancelPendingSignupInitialSessionAdoption();
    this.activeCommitPredicates.clear();
    this.revokedSessionKeys.clear();
    this.acceptedCredentialSessionKeys.clear();
    this.expiredRecoveryUserId = null;
    this.latestAcceptedPersistedSession = null;
  }

  private beginSignupInitialSessionAdoption(
    session: Required<Pick<AuthCredentialSession, 'access_token' | 'user'>>,
  ): SignupInitialSessionAdoption {
    this.cancelPendingSignupInitialSessionAdoption();
    const adoption: SignupInitialSessionAdoption = {
      accessToken: session.access_token,
      email: session.user.email ?? null,
      generation: ++this.signupAdoptionGeneration,
      outcome: null,
      userId: session.user.id,
    };
    this.revokedSessionKeys.delete(this.getSessionKey(adoption.userId, adoption.accessToken));
    this.pendingSignupInitialSessionAdoption = adoption;
    return adoption;
  }

  private settleSignupInitialSessionAdoption(
    adoption: SignupInitialSessionAdoption,
    accepted: boolean,
  ): boolean {
    if (adoption.outcome !== null) return adoption.outcome;
    const isCurrent = this.pendingSignupInitialSessionAdoption === adoption
      && adoption.generation === this.signupAdoptionGeneration;
    adoption.outcome = accepted;
    if (isCurrent) {
      this.pendingSignupInitialSessionAdoption = null;
    }
    if (!accepted && isCurrent) {
      this.revokedSessionKeys.add(this.getSessionKey(adoption.userId, adoption.accessToken));
    }
    return accepted;
  }

  private rejectSignupInitialSessionAdoption(adoption: SignupInitialSessionAdoption): void {
    if (adoption.outcome === null) this.settleSignupInitialSessionAdoption(adoption, false);
    if (this.pendingSignupInitialSessionAdoption === adoption
      && adoption.generation === this.signupAdoptionGeneration) {
      this.revokedSessionKeys.add(this.getSessionKey(adoption.userId, adoption.accessToken));
    }
  }

  private canCommitTokenRefresh(
    session: AuthCredentialSession,
    currentUserId: string | null,
  ): boolean {
    if (currentUserId === session.user?.id) {
      return true;
    }

    if (this.options.sessionExpired()) {
      return currentUserId === null
        && this.expiredRecoveryUserId === session.user?.id
        && !!session.access_token;
    }

    if (currentUserId !== null || !session.access_token) {
      return false;
    }

    const latestAcceptedPersistedSession = this.latestAcceptedPersistedSession;
    return latestAcceptedPersistedSession?.userId === session.user?.id
      && latestAcceptedPersistedSession?.accessToken === session.access_token;
  }

  private beginRequest(predicate: AuthCredentialStateCommitPredicate): string {
    this.requestSequence += 1;
    const requestId = `auth-sign-in-${this.requestSequence}`;
    this.activeCommitPredicates.set(requestId, predicate);
    return requestId;
  }

  private captureCurrentSessionKey(): string | null {
    const currentUserId = this.options.currentUserId();
    if (!currentUserId) return null;

    const persisted = this.readPersistedCredential();
    if (persisted?.userId === currentUserId) {
      return this.getSessionKey(persisted.userId, persisted.accessToken);
    }

    const accepted = this.latestAcceptedPersistedSession;
    return accepted?.userId === currentUserId
      ? this.getSessionKey(accepted.userId, accepted.accessToken)
      : null;
  }

  private rejectRevokedSession(session: AuthCredentialSession): boolean {
    const accessToken = session.access_token;
    const userId = session.user?.id;
    if (!accessToken || !userId || !this.revokedSessionKeys.has(this.getSessionKey(userId, accessToken))) {
      return false;
    }

    this.removePersistedRevokedSession(userId, accessToken);
    this.options.debug('忽略显式登出后迟到的认证事件');
    return true;
  }

  private removePersistedRevokedSession(userId: string, accessToken: string): void {
    const storageKey = this.options.storageKey();
    if (!storageKey || typeof localStorage === 'undefined') return;

    try {
      const persisted = this.readPersistedCredential();
      if (persisted?.userId !== userId || persisted.accessToken !== accessToken) return;
      void this.replacePersistedSession(persisted, null);
    } catch (error) {
      this.options.warn('拒绝迟到认证事件时无法校验持久化会话，已保留现有 storage', { error });
    }
  }

  private readPersistedCredential(): PersistedCredentialSnapshot | null {
    const storageKey = this.options.storageKey();
    const authority = getCanonicalAuthStorageAuthority();
    if (!storageKey || !authority) return null;

    try {
      const bundle = authority.peekBundle(storageKey);
      const raw = bundle.session;
      if (!raw) return null;
      const persisted = resolvePersistedSessionRecord(JSON.parse(raw) as unknown);
      const accessToken = persisted?.['access_token'];
      const user = persisted?.['user'];
      const userId = user && typeof user === 'object'
        ? (user as Record<string, unknown>)['id']
        : null;
      const userEmail = user && typeof user === 'object'
        ? (user as Record<string, unknown>)['email']
        : null;
      return typeof accessToken === 'string' && accessToken && typeof userId === 'string' && userId
        ? {
            userId,
            email: typeof userEmail === 'string' ? userEmail : null,
            accessToken,
            authority,
            bundle,
            storageKey,
          }
        : null;
    } catch {
      // Storage 不可读时无法形成 exact owner/token 证据。
    }
    return null;
  }

  private isCurrentPersistedSessionIdentity(session: AuthCredentialSession): boolean {
    if (!session.access_token || !session.user) return false;
    const persisted = this.readPersistedCredential();
    return persisted?.userId === session.user.id
      && persisted.email === (session.user.email ?? null)
      && persisted.accessToken === session.access_token;
  }

  private getSessionKey(userId: string, accessToken: string): string {
    return JSON.stringify([userId, accessToken]);
  }

  private resolvePreviousPersistedSession(
    binding: CredentialRequestSessionBinding,
    staleAccessToken: string,
  ): string | null {
    const storageKey = this.options.storageKey();
    if (!storageKey || !binding.previousPersistedSession) return null;

    const currentUserId = this.options.currentUserId();
    if (!currentUserId || currentUserId === AUTH_CONFIG.LOCAL_MODE_USER_ID) return null;

    const latestAccepted = this.latestAcceptedPersistedSession;
    const pendingStorageBridgeUserId = this.options.pendingStorageBridgeUserId();
    const canRestoreLatestAccepted = latestAccepted
      && latestAccepted.userId !== AUTH_CONFIG.LOCAL_MODE_USER_ID
      && (
        latestAccepted.userId === currentUserId
        || latestAccepted.userId === pendingStorageBridgeUserId
      )
      && latestAccepted.accessToken !== staleAccessToken;
    const safeOwnerUserId = canRestoreLatestAccepted ? latestAccepted.userId : currentUserId;
    const restoreRaw = canRestoreLatestAccepted
      ? latestAccepted.raw : binding.previousPersistedSession;
    const previous = resolvePersistedSessionRecord(JSON.parse(restoreRaw) as unknown);
    const previousAccessToken = previous?.['access_token'];
    const previousUser = previous?.['user'];
    const previousUserId = previousUser && typeof previousUser === 'object'
      ? (previousUser as Record<string, unknown>)['id']
      : null;
    if (
      typeof previousAccessToken !== 'string'
      || !previousAccessToken
      || previousAccessToken === staleAccessToken
      || previousUserId !== safeOwnerUserId
    ) {
      return null;
    }
    return restoreRaw;
  }

  private async replacePersistedSession(
    snapshot: PersistedCredentialSnapshot,
    session: string | null,
    clearArtifacts = false,
  ): Promise<void> {
    const next = session === null
      ? { session: null, codeVerifier: null, user: null }
      : { ...snapshot.bundle, session };
    try {
      await snapshot.authority.compareAndSwap({
        storageKey: snapshot.storageKey,
        expected: snapshot.bundle,
        next,
      });
      if (clearArtifacts) this.options.clearCachedSessionArtifacts();
      this.options.syncPersistedOwnerHintFromStorage();
      this.options.syncPersistedSessionUserIdFromStorage();
    } catch (error) {
      this.options.warn('认证凭证 CAS 已被较新会话取代，已保留当前 storage', { error });
    }
  }
}
