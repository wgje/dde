import type {
  CanonicalAuthBundle,
  CanonicalAuthStorageAuthority,
  SupabaseAuthClientCandidate,
} from './supabase-auth-client-lifecycle.controller';

export interface SupabaseAuthScopedRequestCacheContext {
  anonymousBearerToken: () => string;
  authority: () => CanonicalAuthStorageAuthority | null;
  isCandidateCurrent: (candidate: SupabaseAuthClientCandidate) => boolean;
  onCacheHit?: (signature: string) => void;
  now?: () => number;
}

export interface SupabaseAuthScopedRequestCacheInput {
  candidate?: SupabaseAuthClientCandidate;
  signature: string;
  options: RequestInit;
  request?: RequestInfo | URL;
  fetch: () => Promise<Response>;
}

interface AuthRequestFence {
  candidate: SupabaseAuthClientCandidate;
  fingerprint: string;
}

interface AuthScopedRequestCacheEntryBase {
  createdAt: number;
  fence: AuthRequestFence;
}

interface AuthScopedRequestCachePendingEntry extends AuthScopedRequestCacheEntryBase {
  kind: 'pending';
  promise: Promise<Response>;
}

interface AuthScopedRequestCacheSettledEntry extends AuthScopedRequestCacheEntryBase {
  kind: 'settled';
  response: Response;
}

type AuthScopedRequestCacheEntry =
  | AuthScopedRequestCachePendingEntry
  | AuthScopedRequestCacheSettledEntry;

export class SupabaseAuthScopedRequestCacheController {
  private readonly entries = new Map<string, AuthScopedRequestCacheEntry[]>();
  private readonly ttlMs = 5_000;

  constructor(private readonly context: SupabaseAuthScopedRequestCacheContext) {}

  async execute(input: SupabaseAuthScopedRequestCacheInput): Promise<Response> {
    const fence = await this.captureFence(input);
    if (!fence) return (await input.fetch()).clone();

    const cached = await this.findCurrentEntry(input.signature, fence);
    if (cached) {
      this.context.onCacheHit?.(input.signature);
      return cached.kind === 'settled' ? cached.response.clone() : (await cached.promise).clone();
    }

    const signature = input.signature;
    const entry = {} as AuthScopedRequestCachePendingEntry;
    const request = input.fetch();
    const promise = request.then(async response => {
      if (await this.isFenceCurrent(fence)) this.settleEntry(signature, entry, response);
      else this.removeEntry(signature, entry);
      return response;
    }).catch(error => {
      this.removeEntry(signature, entry);
      throw error;
    });
    Object.assign(entry, {
      createdAt: this.now(),
      fence,
      kind: 'pending',
      promise,
    });
    const entries = this.entries.get(signature) ?? [];
    this.entries.set(signature, [...entries, entry]);
    return (await promise).clone();
  }

  reset(): void {
    this.entries.clear();
  }

  private async captureFence(input: SupabaseAuthScopedRequestCacheInput): Promise<AuthRequestFence | null> {
    const candidate = input.candidate;
    if (!candidate || !this.context.isCandidateCurrent(candidate)) return null;
    const authorization = this.readAuthorization(input);
    const bundle = this.peekBundle(candidate);
    if (!bundle || !this.authorizationMatchesBundle(authorization, bundle)) return null;
    const fingerprint = await this.fingerprintBundle(bundle);
    if (!fingerprint) return null;
    const fence = { candidate, fingerprint };
    return await this.isFenceCurrent(fence) ? fence : null;
  }
  private async findCurrentEntry(
    signature: string,
    fence: AuthRequestFence,
  ): Promise<AuthScopedRequestCacheEntry | null> {
    const entries = this.entries.get(signature);
    if (!entries) return null;
    const fenceCurrent = await this.isFenceCurrent(fence);
    if (this.entries.get(signature) !== entries) {
      const latest = this.entries.get(signature);
      return fenceCurrent ? latest?.find(entry =>
        this.now() - entry.createdAt <= this.ttlMs && this.fencesEqual(entry.fence, fence)) ?? null : null;
    }
    if (!fenceCurrent) {
      this.entries.delete(signature);
      return null;
    }
    const current = entries.filter(entry =>
      this.now() - entry.createdAt <= this.ttlMs && this.fencesEqual(entry.fence, fence));
    if (current.length === 0) {
      this.entries.delete(signature);
      return null;
    }
    this.entries.set(signature, current);
    return current.find(entry => this.fencesEqual(entry.fence, fence)) ?? null;
  }

  private async isFenceCurrent(fence: AuthRequestFence): Promise<boolean> {
    if (!this.context.isCandidateCurrent(fence.candidate)) return false;
    const bundle = this.peekBundle(fence.candidate);
    if (!bundle) return false;
    return await this.fingerprintBundle(bundle) === fence.fingerprint;
  }

  private peekBundle(candidate: SupabaseAuthClientCandidate): CanonicalAuthBundle | null {
    try {
      const authority = this.context.authority();
      if (!authority) return null;
      return authority.peekBundle(candidate.storageKey);
    } catch {
      return null; // eslint-disable-line no-restricted-syntax -- unreadable authority state must bypass request caching
    }
  }

  private authorizationMatchesBundle(
    authorization: string | null,
    bundle: CanonicalAuthBundle,
  ): boolean {
    if (bundle.session === null) {
      return bundle.user === null && (
        authorization === null || authorization === `Bearer ${this.context.anonymousBearerToken()}`
      );
    }
    try {
      const authData = JSON.parse(bundle.session) as Record<string, unknown>;
      const session = (authData['currentSession'] ?? authData['session'] ?? authData) as Record<string, unknown>;
      const accessToken = session?.['access_token'];
      return typeof accessToken === 'string'
        && accessToken.length > 0
        && authorization === `Bearer ${accessToken}`;
    } catch {
      return false;
    }
  }

  private async fingerprintBundle(bundle: CanonicalAuthBundle): Promise<string | null> {
    try {
      const subtle = globalThis.crypto?.subtle;
      if (!subtle) return null;
      const encoded = new TextEncoder().encode(JSON.stringify([
        bundle.session,
        bundle.codeVerifier,
        bundle.user,
      ]));
      const digest = await subtle.digest('SHA-256', encoded);
      return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    } catch {
      return null; // eslint-disable-line no-restricted-syntax -- unavailable hashing must bypass request caching
    }
  }

  private readAuthorization(input: SupabaseAuthScopedRequestCacheInput): string | null {
    const requestHeaders = typeof Request !== 'undefined' && input.request instanceof Request
      ? input.request.headers
      : undefined;
    return new Headers(input.options.headers ?? requestHeaders).get('authorization');
  }

  private fencesEqual(left: AuthRequestFence, right: AuthRequestFence): boolean {
    return left.candidate === right.candidate
      && left.fingerprint === right.fingerprint;
  }

  private settleEntry(
    signature: string,
    pending: AuthScopedRequestCachePendingEntry,
    response: Response,
  ): void {
    const entries = this.entries.get(signature);
    const index = entries?.indexOf(pending) ?? -1;
    if (!entries || index < 0) return;
    const settled: AuthScopedRequestCacheSettledEntry = {
      createdAt: pending.createdAt,
      fence: pending.fence,
      kind: 'settled',
      response: response.clone(),
    };
    this.entries.set(signature, entries.map(entry => entry === pending ? settled : entry));
  }

  private removeEntry(signature: string, entry: AuthScopedRequestCacheEntry): void {
    const entries = this.entries.get(signature);
    if (!entries) return;
    const remaining = entries.filter(value => value !== entry);
    if (remaining.length > 0) this.entries.set(signature, remaining);
    else this.entries.delete(signature);
  }

  private now(): number {
    return this.context.now?.() ?? Date.now();
  }
}
