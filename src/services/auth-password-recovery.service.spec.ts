import { Injector } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LoggerService } from './logger.service';
import { AuthPasswordRecoveryService } from './auth-password-recovery.service';
import { resolveSupabaseStorageKey } from './supabase-client-configuration';
import { SupabaseClientOptionsFactoryService } from './supabase-client-options-factory.service';
import { environment } from '../environments/environment';

const createClientMock = vi.hoisted(() => vi.fn());

vi.mock('@supabase/supabase-js', () => ({
  createClient: createClientMock,
}));

type RecoveryStorage = {
  getItem: (key: string) => string | null | Promise<string | null>;
  setItem: (key: string, value: string) => void | Promise<void>;
  removeItem: (key: string) => void | Promise<void>;
};

type RecoveryClientOptions = {
  auth: {
    storage: RecoveryStorage;
    storageKey: string;
  };
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

type RecoveryClientRecord = {
  dispose: ReturnType<typeof vi.fn>;
  signOut: ReturnType<typeof vi.fn>;
  storage: RecoveryStorage;
  storageKey: string;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(promiseResolve => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

describe('AuthPasswordRecoveryService', () => {
  const originalLocks = navigator.locks;
  const primaryStorageKey = resolveSupabaseStorageKey(environment.supabaseUrl) ?? 'primary-auth';
  let resetRedirectTo: string | null;
  let updateDeferred: Deferred<{ data: { user: { id: string } }; error: null }> | null;
  let nextExchangeGate: Deferred<void> | null;
  let signOutError: Error | null;
  let updateTransportError: Error | null;
  let clients: RecoveryClientRecord[];

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    window.history.replaceState(null, '', '/');
    resetRedirectTo = null;
    updateDeferred = null;
    nextExchangeGate = null;
    signOutError = null;
    updateTransportError = null;
    clients = [];
    createClientMock.mockReset();
    installSerializedWebLocks();
    installFakeSupabaseClients();
  });

  afterEach(() => {
    Object.defineProperty(navigator, 'locks', { configurable: true, value: originalLocks });
    vi.restoreAllMocks();
  });

  function createService(): AuthPasswordRecoveryService {
    const optionsFactory = {
      buildPasswordRecoveryStorage: (storageKey: string, storage: RecoveryStorage) => {
        const allowed = new Set([storageKey, `${storageKey}-code-verifier`, `${storageKey}-user`]);
        const requireKey = (key: string) => {
          if (!allowed.has(key)) throw new Error('AUTH_RECOVERY_STORAGE_KEY_REJECTED');
        };
        return {
          getItem: (key: string) => { requireKey(key); return storage.getItem(key); },
          setItem: (key: string, value: string) => { requireKey(key); return storage.setItem(key, value); },
          removeItem: (key: string) => { requireKey(key); return storage.removeItem(key); },
        };
      },
      buildPasswordRecoveryClientOptions: (storageKey: string, storage: RecoveryStorage) => ({
        auth: {
          autoRefreshToken: false,
          detectSessionInUrl: false,
          flowType: 'pkce',
          persistSession: true,
          storage,
          storageKey,
        },
      }),
    };
    return Injector.create({
      providers: [
        AuthPasswordRecoveryService,
        { provide: SupabaseClientOptionsFactoryService, useValue: optionsFactory },
        {
          provide: LoggerService,
          useValue: {
            category: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
          },
        },
      ],
    }).get(AuthPasswordRecoveryService);
  }

  function installSerializedWebLocks(): void {
    let tail = Promise.resolve();
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: {
        request: vi.fn((_name: string, _options: LockOptions, callback: () => unknown) => {
          const result = tail.then(callback);
          tail = result.then(() => undefined, () => undefined);
          return result;
        }),
      },
    });
  }

  function installFakeSupabaseClients(): void {
    createClientMock.mockImplementation((
      _url: string,
      _key: string,
      options: RecoveryClientOptions,
    ) => {
      const { storage, storageKey } = options.auth;
      const dispose = vi.fn().mockResolvedValue(undefined);
      const exchangeGate = nextExchangeGate;
      nextExchangeGate = null;
      const session = {
        access_token: `access-${storageKey}`,
        refresh_token: `refresh-${storageKey}`,
        expires_at: 4_000_000_000,
        user: { id: 'recovery-owner' },
      };
      const signOut = vi.fn(async () => {
        await storage.removeItem(storageKey);
        return { error: signOutError };
      });
      const client = {
        auth: {
          dispose,
          exchangeCodeForSession: vi.fn(async () => {
            if (exchangeGate) await exchangeGate.promise;
            const verifier = await storage.getItem(`${storageKey}-code-verifier`);
            if (!verifier) return { data: { session: null }, error: new Error('missing verifier') };
            await storage.removeItem(`${storageKey}-code-verifier`);
            await storage.setItem(storageKey, JSON.stringify(session));
            return { data: { session }, error: null };
          }),
          getSession: vi.fn(async () => {
            const raw = await storage.getItem(storageKey);
            return { data: { session: raw ? JSON.parse(raw) : null }, error: null };
          }),
          resetPasswordForEmail: vi.fn(async (_email: string, optionsArg: { redirectTo: string }) => {
            resetRedirectTo = optionsArg.redirectTo;
            await storage.setItem(`${storageKey}-code-verifier`, 'verifier/recovery');
            return { data: {}, error: null };
          }),
          setSession: vi.fn(async (tokens: { access_token: string; refresh_token: string }) => {
            const implicitSession = { ...session, ...tokens };
            await storage.setItem(storageKey, JSON.stringify(implicitSession));
            return { data: { session: implicitSession }, error: null };
          }),
          signOut,
          updateUser: vi.fn(async () => {
            if (updateTransportError) throw updateTransportError;
            return await (updateDeferred?.promise ?? Promise.resolve({
              data: { user: { id: 'recovery-owner' } },
              error: null,
            }));
          }),
        },
      };
      clients.push({ dispose, signOut, storage, storageKey });
      return client;
    });
  }

  async function issueRecovery(service: AuthPasswordRecoveryService): Promise<string> {
    await service.requestPasswordReset('user@example.com', window.location.origin);
    const redirect = new URL(resetRedirectTo ?? '');
    const nonce = redirect.searchParams.get('recovery_nonce');
    expect(nonce).toBeTruthy();
    return nonce ?? '';
  }

  function recoveryLedger(nonce: string) {
    const raw = localStorage.getItem(`nanoflow:auth-recovery:v1:ledger:${nonce}`);
    return raw ? JSON.parse(raw) as Record<string, unknown> : null;
  }

  it('uses isolated storage for PKCE recovery without changing the primary session', async () => {
    const service = createService();
    localStorage.setItem(primaryStorageKey, 'primary-session-b');
    const nonce = await issueRecovery(service);
    window.history.replaceState(null, '', `/reset-password?recovery_nonce=${nonce}&code=code-a`);

    await expect(service.prepareFromCurrentUrl()).resolves.toBe(true);
    await expect(service.completePasswordReset('new-password')).resolves.toEqual({
      cleanupPending: false,
    });

    expect(localStorage.getItem(primaryStorageKey)).toBe('primary-session-b');
    expect(clients.every(client => client.storageKey !== primaryStorageKey)).toBe(true);
    expect(clients.every(client => client.dispose.mock.calls.length === 1)).toBe(true);
  });

  it('allows exactly one tab to claim a recovery verifier', async () => {
    const issuer = createService();
    const nonce = await issueRecovery(issuer);
    window.history.replaceState(null, '', `/reset-password?recovery_nonce=${nonce}&code=code-a`);
    const firstTab = createService();
    const secondTab = createService();

    const results = await Promise.all([
      firstTab.prepareFromCurrentUrl(),
      secondTab.prepareFromCurrentUrl(),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('fences an update completion after disposal without clearing primary B', async () => {
    const service = createService();
    localStorage.setItem(primaryStorageKey, 'primary-session-b');
    const nonce = await issueRecovery(service);
    window.history.replaceState(null, '', `/reset-password?recovery_nonce=${nonce}&code=code-a`);
    await service.prepareFromCurrentUrl();
    updateDeferred = deferred();

    const completion = service.completePasswordReset('new-password');
    await Promise.resolve();
    await service.dispose();
    updateDeferred.resolve({ data: { user: { id: 'recovery-owner' } }, error: null });

    await expect(completion).rejects.toThrow('AUTH_RECOVERY_ATTEMPT_STALE');
    expect(localStorage.getItem(primaryStorageKey)).toBe('primary-session-b');
  });

  it('migrates the exact claimant verifier to a fresh attempt on reload before exchange', async () => {
    const issuer = createService();
    const nonce = await issueRecovery(issuer);
    window.history.replaceState(null, '', `/reset-password?recovery_nonce=${nonce}&code=code-a`);
    const exchangeGate = deferred<void>();
    nextExchangeGate = exchangeGate;
    const interrupted = createService();

    const stalePreparation = interrupted.prepareFromCurrentUrl();
    await vi.waitFor(() => expect(recoveryLedger(nonce)?.['state']).toBe('claimed'));
    const reloaded = createService();
    const reloadedPreparation = reloaded.prepareFromCurrentUrl();

    await expect(reloadedPreparation).resolves.toBe(true);
    exchangeGate.resolve(undefined);
    await expect(stalePreparation).resolves.toBe(false);
    expect(recoveryLedger(nonce)?.['state']).toBe('session-ready');
  });

  it('rehydrates only the exact persisted isolated session after exchange and URL scrub', async () => {
    const firstPage = createService();
    localStorage.setItem(primaryStorageKey, 'primary-session-b');
    const nonce = await issueRecovery(firstPage);
    window.history.replaceState(null, '', `/reset-password?recovery_nonce=${nonce}&code=code-a`);
    await expect(firstPage.prepareFromCurrentUrl()).resolves.toBe(true);
    expect(window.location.search).toBe('');

    const reloaded = createService();
    await expect(reloaded.prepareFromCurrentUrl()).resolves.toBe(true);
    await expect(reloaded.completePasswordReset('new-password')).resolves.toEqual({
      cleanupPending: false,
    });

    expect(localStorage.getItem(primaryStorageKey)).toBe('primary-session-b');
    expect(recoveryLedger(nonce)?.['state']).toBe('terminal');
  });

  it('recovers only the matching claimant after the ledger commit precedes verifier removal', async () => {
    const issuer = createService();
    const nonce = await issueRecovery(issuer);
    window.history.replaceState(null, '', `/reset-password?recovery_nonce=${nonce}&code=code-a`);
    const requestKey = String(recoveryLedger(nonce)?.['requestStorageKey']);
    const removeItem = localStorage.removeItem.bind(localStorage);
    const removal = vi.spyOn(localStorage, 'removeItem').mockImplementation((key: string) => {
      if (key === `${requestKey}-code-verifier`) {
        throw new Error('simulated crash after claim');
      }
      return removeItem(key);
    });

    await expect(createService().prepareFromCurrentUrl())
      .rejects.toThrow('simulated crash after claim');
    expect(recoveryLedger(nonce)?.['state']).toBe('claimed');
    removal.mockRestore();

    await expect(createService().prepareFromCurrentUrl()).resolves.toBe(true);
    expect(localStorage.getItem(`${requestKey}-code-verifier`)).toBeNull();
  });

  it('orphaned envelope-only storage cannot authorize and does not block a valid fresh claim', async () => {
    const issuer = createService();
    const nonce = await issueRecovery(issuer);
    window.history.replaceState(null, '', `/reset-password?recovery_nonce=${nonce}&code=code-a`);
    const setItem = localStorage.setItem.bind(localStorage);
    const ledgerWrite = vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
      if (key.endsWith(`ledger:${nonce}`) && JSON.parse(value)['state'] === 'claimed') {
        throw new Error('simulated crash after envelope');
      }
      setItem(key, value);
    });

    await expect(createService().prepareFromCurrentUrl())
      .rejects.toThrow('simulated crash after envelope');
    expect(recoveryLedger(nonce)?.['state']).toBe('issued');
    ledgerWrite.mockRestore();

    await expect(createService().prepareFromCurrentUrl()).resolves.toBe(true);
    expect(recoveryLedger(nonce)?.['state']).toBe('session-ready');
  });

  it('keeps password success truthful when isolated local sign-out needs cleanup', async () => {
    const service = createService();
    localStorage.setItem(primaryStorageKey, 'primary-session-b');
    const nonce = await issueRecovery(service);
    window.history.replaceState(null, '', `/reset-password?recovery_nonce=${nonce}&code=code-a`);
    await service.prepareFromCurrentUrl();
    signOutError = new Error('isolated cleanup failed');

    await expect(service.completePasswordReset('new-password')).resolves.toEqual({
      cleanupPending: true,
    });

    expect(localStorage.getItem(primaryStorageKey)).toBe('primary-session-b');
    expect(recoveryLedger(nonce)).toMatchObject({ state: 'terminal', cleanupPending: true });
  });

  it('rejects canonical or unknown keys through every isolated storage adapter', async () => {
    const service = createService();
    await issueRecovery(service);
    const requestClient = clients[0];

    expect(() => requestClient.storage.setItem(primaryStorageKey, 'forbidden'))
      .toThrow('AUTH_RECOVERY_STORAGE_KEY_REJECTED');
    expect(() => requestClient.storage.removeItem('unknown-key'))
      .toThrow('AUTH_RECOVERY_STORAGE_KEY_REJECTED');
  });

  it('accepts implicit recovery only in the isolated attempt namespace', async () => {
    const service = createService();
    localStorage.setItem(primaryStorageKey, 'same-owner-newer-primary-token');
    const nonce = await issueRecovery(service);
    window.history.replaceState(
      null,
      '',
      `/reset-password?recovery_nonce=${nonce}#access_token=implicit-a&refresh_token=refresh-a&type=recovery`,
    );

    await expect(service.prepareFromCurrentUrl()).resolves.toBe(true);
    expect(localStorage.getItem(primaryStorageKey)).toBe('same-owner-newer-primary-token');
    expect(clients.at(-1)?.storageKey).toContain(`attempt:${nonce}:`);
  });

  it('does not reopen a claimed nonce when the claimant storage is missing', async () => {
    const issuer = createService();
    const nonce = await issueRecovery(issuer);
    const ledger = recoveryLedger(nonce) ?? {};
    localStorage.setItem(`nanoflow:auth-recovery:v1:ledger:${nonce}`, JSON.stringify({
      ...ledger,
      state: 'claimed',
      attemptId: 'missing-attempt',
      tabId: 'missing-tab',
      capabilityDigest: 'missing-capability',
    }));
    sessionStorage.clear();
    window.history.replaceState(null, '', `/reset-password?recovery_nonce=${nonce}&code=code-a`);

    await expect(createService().prepareFromCurrentUrl()).resolves.toBe(false);
    expect(recoveryLedger(nonce)?.['attemptId']).toBe('missing-attempt');
  });

  it('fences delayed exchange completion after disposal to obsolete attempt storage', async () => {
    const service = createService();
    localStorage.setItem(primaryStorageKey, 'primary-b');
    const nonce = await issueRecovery(service);
    window.history.replaceState(null, '', `/reset-password?recovery_nonce=${nonce}&code=code-a`);
    const exchangeGate = deferred<void>();
    nextExchangeGate = exchangeGate;

    const preparation = service.prepareFromCurrentUrl();
    await vi.waitFor(() => expect(recoveryLedger(nonce)?.['state']).toBe('claimed'));
    await service.dispose();
    localStorage.setItem(primaryStorageKey, 'same-owner-newer-b');
    exchangeGate.resolve(undefined);

    await expect(preparation).resolves.toBe(false);
    expect(localStorage.getItem(primaryStorageKey)).toBe('same-owner-newer-b');
  });

  it('treats post-update session drift as cleanup pending without signing out the replacement', async () => {
    const service = createService();
    const nonce = await issueRecovery(service);
    window.history.replaceState(null, '', `/reset-password?recovery_nonce=${nonce}&code=code-a`);
    await service.prepareFromCurrentUrl();
    updateDeferred = deferred();
    const completion = service.completePasswordReset('new-password');
    await Promise.resolve();
    const attempt = clients.at(-1);
    await attempt?.storage.setItem(attempt.storageKey, JSON.stringify({
      access_token: 'replacement-token',
      refresh_token: 'replacement-refresh',
      expires_at: 4_000_000_001,
      user: { id: 'recovery-owner' },
    }));
    updateDeferred.resolve({ data: { user: { id: 'recovery-owner' } }, error: null });

    await expect(completion).resolves.toEqual({ cleanupPending: true });
    expect(attempt?.signOut).not.toHaveBeenCalled();
    expect(recoveryLedger(nonce)).toMatchObject({ state: 'terminal', cleanupPending: true });
  });

  it('reports a rejected update transport as indeterminate and retires the attempt', async () => {
    const service = createService();
    const nonce = await issueRecovery(service);
    window.history.replaceState(null, '', `/reset-password?recovery_nonce=${nonce}&code=code-a`);
    await service.prepareFromCurrentUrl();
    updateTransportError = new Error('network outcome unknown');
    const completion = service.completePasswordReset('new-password');
    const rejection = expect(completion).rejects.toThrow('AUTH_RECOVERY_UPDATE_OUTCOME_UNKNOWN');

    await rejection;
    expect(recoveryLedger(nonce)).toMatchObject({ state: 'terminal', cleanupPending: true });
  });

  it('rejects expired and replayed nonces without creating another callback client', async () => {
    const expiredNonce = await issueRecovery(createService());
    const expired = recoveryLedger(expiredNonce) ?? {};
    localStorage.setItem(`nanoflow:auth-recovery:v1:ledger:${expiredNonce}`, JSON.stringify({
      ...expired,
      expiresAt: 0,
    }));
    window.history.replaceState(null, '', `/reset-password?recovery_nonce=${expiredNonce}&code=expired`);
    const clientCount = clients.length;
    await expect(createService().prepareFromCurrentUrl()).resolves.toBe(false);
    expect(clients).toHaveLength(clientCount);

    const nonce = await issueRecovery(createService());
    const callback = `/reset-password?recovery_nonce=${nonce}&code=code-a`;
    window.history.replaceState(null, '', callback);
    const claimant = createService();
    await expect(claimant.prepareFromCurrentUrl()).resolves.toBe(true);
    await claimant.completePasswordReset('new-password');
    window.history.replaceState(null, '', callback);
    await expect(createService().prepareFromCurrentUrl()).resolves.toBe(false);
  });

  it('keeps concurrent request verifiers bound to distinct nonce namespaces', async () => {
    const firstNonce = await issueRecovery(createService());
    const firstRequestKey = String(recoveryLedger(firstNonce)?.['requestStorageKey']);
    const secondNonce = await issueRecovery(createService());
    const secondRequestKey = String(recoveryLedger(secondNonce)?.['requestStorageKey']);

    expect(firstNonce).not.toBe(secondNonce);
    expect(firstRequestKey).not.toBe(secondRequestKey);
    expect(localStorage.getItem(`${firstRequestKey}-code-verifier`)).toBe('verifier/recovery');
    expect(localStorage.getItem(`${secondRequestKey}-code-verifier`)).toBe('verifier/recovery');
  });

  it('fails closed before client creation when Web Crypto or storage is unavailable', async () => {
    const originalCrypto = globalThis.crypto;
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: undefined });
    await expect(createService().requestPasswordReset('user@example.com', window.location.origin))
      .rejects.toThrow('AUTH_RECOVERY_CRYPTO_UNAVAILABLE');
    expect(createClientMock).not.toHaveBeenCalled();
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: originalCrypto });

    vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('storage unavailable');
    });
    await expect(createService().requestPasswordReset('user@example.com', window.location.origin))
      .rejects.toThrow('storage unavailable');
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it('fails closed before creating a client when Web Locks are unavailable', async () => {
    Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
    const service = createService();

    await expect(service.requestPasswordReset('user@example.com', window.location.origin))
      .rejects.toThrow('AUTH_RECOVERY_LOCK_UNAVAILABLE');
    expect(createClientMock).not.toHaveBeenCalled();
  });
});
