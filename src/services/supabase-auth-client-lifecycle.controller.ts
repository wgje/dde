export interface CanonicalAuthBundle {
  session: string | null;
  codeVerifier: string | null;
  user: string | null;
}

export interface CanonicalAuthStorageAdapter {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export interface CanonicalAuthGeneration {
  storageKey: string;
  storage: CanonicalAuthStorageAdapter;
  promote(): Promise<'committed' | 'noop'>;
  retire(): void;
}

export interface CanonicalAuthStorageAuthority {
  createGeneration(storageKey: string): Promise<CanonicalAuthGeneration>;
  peekBundle(storageKey: string): CanonicalAuthBundle;
  readBundle(storageKey: string): Promise<CanonicalAuthBundle>;
  compareAndSwap(input: {
    storageKey: string;
    expected: CanonicalAuthBundle;
    next: CanonicalAuthBundle;
  }, authorize?: () => void): Promise<'committed' | 'noop'>;
  startSessionPrewarm(input: {
    supabaseUrl: string;
    supabaseAnonKey: string;
    bootFlags: Record<string, boolean>;
  }): Promise<void>;
}

export interface CanonicalAuthCallbackClaimInput {
  storageKey: string;
  expected: CanonicalAuthBundle;
  marker: string;
  claimantKey: string;
  envelope: Record<string, unknown>;
}

export interface CanonicalAuthCallbackStorageAuthority extends CanonicalAuthStorageAuthority {
  captureAndScrubAuthCallback(): AuthCallbackCaptureCapability;
  claimCallbackVerifier(input: CanonicalAuthCallbackClaimInput): Promise<'claimed'>;
}

export interface AuthCallbackCaptureCapability {
  readonly version: 1;
  readonly blocked: boolean;
  readonly capturedAt: number;
  readonly hasAuthError: boolean;
  claimCode(): string | null;
}

export interface SupabaseAuthClientCandidate {
  readonly epoch: number;
  readonly generation: CanonicalAuthGeneration;
  readonly storage: CanonicalAuthStorageAdapter;
  readonly storageKey: string;
}

export interface SupabaseAuthClientResource {
  auth: { dispose(): Promise<void> };
  removeAllChannels(): Promise<unknown>;
}

const AUTHORITY_KEY = '__NANOFLOW_AUTH_CANONICAL_STORAGE__';

export function getCanonicalAuthStorageAuthority(): CanonicalAuthStorageAuthority | null {
  const value: unknown = Object.getOwnPropertyDescriptor(globalThis, AUTHORITY_KEY)?.value;
  if (!value || typeof value !== 'object') return null;
  if (!('createGeneration' in value) || typeof value.createGeneration !== 'function') return null;
  if (!('peekBundle' in value) || typeof value.peekBundle !== 'function') return null;
  if (!('readBundle' in value) || typeof value.readBundle !== 'function') return null;
  if (!('compareAndSwap' in value) || typeof value.compareAndSwap !== 'function') return null;
  if (!('startSessionPrewarm' in value) || typeof value.startSessionPrewarm !== 'function') return null;
  return value as CanonicalAuthStorageAuthority;
}

export function getCanonicalAuthCallbackStorageAuthority(): CanonicalAuthCallbackStorageAuthority | null {
  const authority = getCanonicalAuthStorageAuthority();
  if (!authority || !('claimCallbackVerifier' in authority)) return null;
  if (typeof authority.claimCallbackVerifier !== 'function') return null;
  if (!('captureAndScrubAuthCallback' in authority)) return null;
  if (typeof authority.captureAndScrubAuthCallback !== 'function') return null;
  return authority as CanonicalAuthCallbackStorageAuthority;
}

export class SupabaseAuthClientLifecycleController {
  private epoch = 0;
  private pending: SupabaseAuthClientCandidate | null = null;
  private current: SupabaseAuthClientCandidate | null = null;
  private publicationBarrier: Promise<void> | null = null;

  constructor(
    private readonly authority: () => CanonicalAuthStorageAuthority | null =
      getCanonicalAuthStorageAuthority,
  ) {}

  async beginCandidate(canonicalStorageKey: string): Promise<SupabaseAuthClientCandidate> {
    const epoch = this.epoch;
    const authority = this.authority();
    if (!authority) throw new Error('AUTH_CANONICAL_AUTHORITY_UNAVAILABLE');
    const generation = await authority.createGeneration(canonicalStorageKey);
    if (epoch !== this.epoch) {
      generation.retire();
      throw new Error('AUTH_CLIENT_GENERATION_STALE');
    }
    this.pending?.generation.retire();
    const candidate = Object.freeze({
      epoch,
      generation,
      storage: generation.storage,
      storageKey: generation.storageKey,
    });
    this.pending = candidate;
    return candidate;
  }

  async promote(candidate: SupabaseAuthClientCandidate): Promise<boolean> {
    const barrier = this.publicationBarrier;
    if (barrier) await barrier;
    if (!this.isPending(candidate)) return false;
    await candidate.generation.promote();
    if (!this.isPending(candidate)) {
      candidate.generation.retire();
      return false;
    }
    this.current?.generation.retire();
    this.current = candidate;
    this.pending = null;
    return true;
  }

  isCurrent(candidate: SupabaseAuthClientCandidate): boolean {
    return this.current === candidate && candidate.epoch === this.epoch;
  }

  holdPublicationUntil(operation: Promise<unknown>, timeoutMs: number): void {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>(resolve => {
      timeoutId = setTimeout(resolve, timeoutMs);
    });
    const barrier = Promise.race([
      operation.then(() => undefined, () => undefined),
      timeout,
    ]).finally(() => {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      if (this.publicationBarrier === barrier) this.publicationBarrier = null;
    });
    this.publicationBarrier = barrier;
  }

  disposeClient(client: SupabaseAuthClientResource): null {
    const cleanups: Array<Promise<unknown>> = [];
    try {
      cleanups.push(Promise.resolve(client.auth.dispose()));
    } catch {
      cleanups.push(Promise.resolve());
    }
    try {
      cleanups.push(Promise.resolve(client.removeAllChannels()));
    } catch {
      cleanups.push(Promise.resolve());
    }
    void Promise.allSettled(cleanups);
    return null;
  }

  reset(): void {
    this.epoch += 1;
    this.pending?.generation.retire();
    this.current?.generation.retire();
    this.pending = null;
    this.current = null;
  }

  private isPending(candidate: SupabaseAuthClientCandidate): boolean {
    return this.pending === candidate && candidate.epoch === this.epoch;
  }
}
