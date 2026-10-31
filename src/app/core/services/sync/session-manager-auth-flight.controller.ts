import type { CanonicalAuthBundle } from '../../../../services/supabase-auth-client-lifecycle.controller';
import { resolvePersistedSessionRecord } from '../../../../services/auth-session-identity';
import type { SessionValidationSnapshot } from './session-manager.types';
export interface SessionManagerAuthFence<TClient extends object = object> {
  readonly bundle: CanonicalAuthBundle;
  readonly client: TClient | null;
  readonly eventEpoch: number;
  readonly key: string;
  readonly ownerUserId: string | null;
  readonly storageKey: string;
}
export interface SessionManagerSessionIdentity {
  readonly access_token?: string;
  readonly refresh_token?: string;
  readonly user?: { readonly id?: string };
}
interface SessionManagerAuthFlightOptions<TClient extends object> {
  readonly getStorageKey: () => string | null;
  readonly peekBundle: (storageKey: string) => CanonicalAuthBundle | null;
  readonly getCurrentClient: () => TClient | null;
  readonly now?: () => number;
}
interface CurrentAuthState {
  readonly bundle: CanonicalAuthBundle;
  readonly ownerUserId: string | null;
  readonly storageKey: string;
}
interface StoredSnapshot<TClient extends object> {
  readonly fence: SessionManagerAuthFence<TClient>;
  readonly value: SessionValidationSnapshot;
}
export class SessionManagerAuthFlightController<TClient extends object = object> {
  private eventEpoch = 0;
  private snapshot: StoredSnapshot<TClient> | null = null;
  private readonly clientIds = new WeakMap<object, number>();
  private readonly acceptedSessions = new WeakMap<object, SessionManagerAuthFence<TClient>>();
  private nextClientId = 1;
  private readonly flights = new Map<string, { key: string; promise: Promise<unknown> }>();
  constructor(private readonly options: SessionManagerAuthFlightOptions<TClient>) {}
  capture(): SessionManagerAuthFence<TClient> | null {
    const current = this.readCurrent();
    return current ? this.createFence(current, this.safeCurrentClient()) : null;
  }
  bindClient(
    fence: SessionManagerAuthFence<TClient>,
    client: TClient,
  ): SessionManagerAuthFence<TClient> | null {
    if (fence.client && fence.client !== client) return null;
    if (!this.isCanonicalCurrent(fence) || this.safeCurrentClient() !== client) return null;
    return this.createFence({
      bundle: fence.bundle,
      ownerUserId: fence.ownerUserId,
      storageKey: fence.storageKey,
    }, client);
  }
  isCurrent(fence: SessionManagerAuthFence<TClient>, expectedUserId?: string): boolean {
    if (!this.isCanonicalCurrent(fence)) return false;
    if (fence.client && this.safeCurrentClient() !== fence.client) return false;
    return expectedUserId === undefined || fence.ownerUserId === expectedUserId;
  }
  acceptSession(
    fence: SessionManagerAuthFence<TClient>,
    client: TClient,
    session: SessionManagerSessionIdentity,
  ): SessionManagerAuthFence<TClient> | null {
    if (fence.client && fence.client !== client) return null;
    if (this.safeCurrentClient() !== client) return null;
    const current = this.readCurrent();
    if (!current || current.storageKey !== fence.storageKey) return null;
    const persisted = this.readPersistedSession(current.bundle.session);
    if (!persisted || persisted.accessToken !== session.access_token
      || persisted.refreshToken !== session.refresh_token
      || persisted.userId !== session.user?.id) return null;
    const accepted = this.createFence(current, client);
    this.acceptedSessions.set(session, accepted);
    return accepted;
  }
  isAcceptedSessionCurrent(session: SessionManagerSessionIdentity | undefined): boolean {
    if (!session) return false;
    const fence = this.acceptedSessions.get(session);
    return !!fence && this.isCurrent(fence, session.user?.id);
  }
  acceptNoSession(
    fence: SessionManagerAuthFence<TClient>,
    client: TClient,
  ): SessionManagerAuthFence<TClient> | null {
    if (fence.client && fence.client !== client) return null;
    if (this.safeCurrentClient() !== client) return null;
    return this.isCurrent(fence) ? fence : null;
  }
  advanceEventEpoch(): void {
    this.eventEpoch += 1;
    this.snapshot = null;
  }
  clearSnapshot(): void {
    this.snapshot = null;
  }
  writeSnapshot(
    fence: SessionManagerAuthFence<TClient>,
    valid: boolean,
    userId?: string,
  ): boolean {
    if (!this.isCurrent(fence) || (valid && (!userId || fence.ownerUserId !== userId))) return false;
    this.snapshot = { fence, value: { valid, userId, at: this.now() } };
    return true;
  }
  readSnapshot(maxAgeMs: number): SessionValidationSnapshot | null {
    const stored = this.snapshot;
    if (!stored || this.now() - stored.value.at > maxAgeMs) return null;
    if (!this.isCurrent(stored.fence, stored.value.userId)) return null;
    return { ...stored.value };
  }
  runSingleFlight<T>(
    kind: 'refresh' | 'resume',
    fence: SessionManagerAuthFence<TClient>,
    work: () => Promise<T>,
  ): Promise<T> {
    const slot = `${kind}:${fence.key}`;
    const existing = this.flights.get(slot);
    if (existing?.key === fence.key) return existing.promise as Promise<T>;
    const promise = work();
    this.flights.set(slot, { key: fence.key, promise });
    void promise.finally(() => {
      if (this.flights.get(slot)?.promise === promise) this.flights.delete(slot);
    }).catch(() => undefined);
    return promise;
  }
  private isCanonicalCurrent(fence: SessionManagerAuthFence<TClient>): boolean {
    if (fence.eventEpoch !== this.eventEpoch) return false;
    const current = this.readCurrent();
    return !!current && current.storageKey === fence.storageKey
      && this.bundlesEqual(current.bundle, fence.bundle);
  }
  private createFence(
    current: CurrentAuthState,
    client: TClient | null,
  ): SessionManagerAuthFence<TClient> {
    return {
      ...current,
      client,
      eventEpoch: this.eventEpoch,
      key: JSON.stringify([
        this.eventEpoch,
        current.storageKey,
        current.bundle.session,
        current.bundle.codeVerifier,
        current.bundle.user,
        client ? this.clientId(client) : 0,
      ]),
    };
  }
  private readCurrent(): CurrentAuthState | null {
    const storageKey = this.options.getStorageKey();
    if (!storageKey) return null;
    try {
      const bundle = this.options.peekBundle(storageKey);
      if (!bundle) return null;
      return {
        bundle: { ...bundle },
        ownerUserId: this.readPersistedSession(bundle.session)?.userId ?? null,
        storageKey,
      };
    } catch { /* canonical reads fail closed */ }
    return null;
  }
  private readPersistedSession(raw: string | null): {
    accessToken: string | undefined;
    refreshToken: string | undefined;
    userId: string | undefined;
  } | null {
    if (!raw) return null;
    try {
      const record = resolvePersistedSessionRecord(JSON.parse(raw) as unknown);
      const user = record?.['user'];
      return record ? {
        accessToken: typeof record['access_token'] === 'string' ? record['access_token'] : undefined,
        refreshToken: typeof record['refresh_token'] === 'string' ? record['refresh_token'] : undefined,
        userId: user && typeof user === 'object' && typeof (user as { id?: unknown }).id === 'string'
          ? (user as { id: string }).id : undefined,
      } : null;
    } catch { /* malformed sessions fail closed */ }
    return null;
  }
  private bundlesEqual(left: CanonicalAuthBundle, right: CanonicalAuthBundle): boolean {
    return left.session === right.session
      && left.codeVerifier === right.codeVerifier
      && left.user === right.user;
  }
  private clientId(client: object): number {
    const existing = this.clientIds.get(client);
    if (existing) return existing;
    const id = this.nextClientId++;
    this.clientIds.set(client, id);
    return id;
  }
  private safeCurrentClient(): TClient | null {
    let client: TClient | null = null;
    try {
      client = this.options.getCurrentClient();
    } catch { /* client reads fail closed */ }
    return client;
  }
  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}
