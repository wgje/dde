import { Injectable, inject } from '@angular/core';
import { LoggerService } from './logger.service';
import { SentryLazyLoaderService } from './sentry-lazy-loader.service';
import { resolveSupabaseStorageKey } from './supabase-client-configuration';
import type { CanonicalAuthStorageAdapter } from './supabase-auth-client-lifecycle.controller';

type RealtimeHeartbeatPayload = string | {
  status?: string;
  event?: string;
  reason?: string;
};

export interface PasswordRecoveryStorage {
  getItem: (key: string) => string | null | Promise<string | null>;
  setItem: (key: string, value: string) => void | Promise<void>;
  removeItem: (key: string) => void | Promise<void>;
}

class PasswordRecoveryStorageAdapter implements PasswordRecoveryStorage {
  private readonly allowedKeys: Set<string>;

  constructor(
    private readonly storage: PasswordRecoveryStorage,
    storageKey: string,
  ) {
    this.allowedKeys = new Set([storageKey, `${storageKey}-code-verifier`, `${storageKey}-user`]);
  }

  getItem(key: string) {
    this.requireAllowed(key);
    return this.storage.getItem(key);
  }

  setItem(key: string, value: string) {
    this.requireAllowed(key);
    return this.storage.setItem(key, value);
  }

  removeItem(key: string) {
    this.requireAllowed(key);
    return this.storage.removeItem(key);
  }

  private requireAllowed(key: string): void {
    if (!this.allowedKeys.has(key)) throw new Error('AUTH_RECOVERY_STORAGE_KEY_REJECTED');
  }
}

@Injectable({
  providedIn: 'root',
})
export class SupabaseClientOptionsFactoryService {
  private readonly logger = inject(LoggerService).category('SupabaseClient');
  private readonly sentryLazyLoader = inject(SentryLazyLoaderService);

  buildClientOptions(
    supabaseUrl: string,
    fetchHandler: (url: RequestInfo | URL, options?: RequestInit) => Promise<Response>,
    authGeneration?: { storageKey: string; storage: CanonicalAuthStorageAdapter | Storage },
  ) {
    return {
      auth: this.buildAuthClientOptions(supabaseUrl, authGeneration),
      global: {
        fetch: fetchHandler,
      },
      db: {
        schema: 'public' as const,
      },
      realtime: this.buildRealtimeClientOptions(),
    };
  }

  buildPasswordRecoveryClientOptions(
    storageKey: string,
    storage: PasswordRecoveryStorage,
  ) {
    return {
      auth: {
        storage,
        storageKey,
        lock: this.buildNavigatorLockHandler(),
        autoRefreshToken: false,
        persistSession: true,
        detectSessionInUrl: false,
        flowType: 'pkce' as const,
      },
    };
  }

  buildAuthCallbackClientOptions(storageKey: string) {
    return {
      auth: {
        storageKey,
        lock: this.buildNavigatorLockHandler(),
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
        flowType: 'pkce' as const,
        skipAutoInitialize: true,
      },
    };
  }

  buildSignupClientOptions(
    storageKey: string,
    storage: PasswordRecoveryStorage,
    fetchHandler: (url: RequestInfo | URL, options?: RequestInit) => Promise<Response>,
  ) {
    return {
      auth: {
        storage,
        storageKey,
        lock: this.buildNavigatorLockHandler(),
        autoRefreshToken: false,
        persistSession: true,
        detectSessionInUrl: false,
        flowType: 'pkce' as const,
        skipAutoInitialize: true,
      },
      global: { fetch: fetchHandler },
    };
  }

  buildSignupAdoptionClientOptions(storageKey: string, storage: CanonicalAuthStorageAdapter) {
    return {
      auth: {
        storage,
        storageKey,
        lock: this.buildNavigatorLockHandler(),
        autoRefreshToken: false,
        persistSession: true,
        detectSessionInUrl: false,
        flowType: 'pkce' as const,
        skipAutoInitialize: true,
      },
    };
  }

  buildPasswordRecoveryStorage(
    storageKey: string,
    storage: PasswordRecoveryStorage,
  ): PasswordRecoveryStorage {
    return new PasswordRecoveryStorageAdapter(storage, storageKey);
  }

  private buildAuthClientOptions(
    supabaseUrl: string,
    authGeneration?: { storageKey: string; storage: CanonicalAuthStorageAdapter | Storage },
  ) {
    return {
      storage: authGeneration?.storage
        ?? (typeof window !== 'undefined' ? window.localStorage : undefined),
      storageKey: authGeneration?.storageKey ?? resolveSupabaseStorageKey(supabaseUrl) ?? undefined,
      lock: this.buildNavigatorLockHandler(),
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: !this.isAuthUrlIsolationRoute(),
      flowType: 'pkce' as const,
    };
  }

  private isAuthUrlIsolationRoute(): boolean {
    if (typeof window === 'undefined') {
      return false;
    }
    const path = window.location.pathname.replace(/\/+$/, '');
    const hashPath = window.location.hash.slice(1).split('?')[0]?.replace(/\/+$/, '');
    return path === '/reset-password'
      || path === '/auth/callback'
      || hashPath === '/reset-password'
      || hashPath === '/auth/callback';
  }

  private buildNavigatorLockHandler() {
    if (typeof navigator === 'undefined' || !navigator.locks) {
      return async <T>(): Promise<T> => {
        throw new Error('AUTH_GENERATION_LOCK_UNAVAILABLE');
      };
    }

    return async <T>(name: string, acquireTimeout: number, fn: () => Promise<T>): Promise<T> => {
      const abortController = new AbortController();
      const timeoutId = acquireTimeout > 0
        ? setTimeout(() => abortController.abort(), acquireTimeout)
        : undefined;
      try {
        return await navigator.locks.request(
          name,
          { mode: 'exclusive', signal: abortController.signal },
          async () => fn(),
        );
      } catch (err: unknown) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          throw new Error(`Lock acquisition timed out after ${acquireTimeout}ms`);
        }
        throw err;
      } finally {
        if (timeoutId !== undefined) clearTimeout(timeoutId);
      }
    };
  }

  private buildRealtimeClientOptions() {
    return {
      params: {
        eventsPerSecond: 10,
      },
      heartbeatIntervalMs: 30000,
      timeout: 10000,
      worker: true,
      workerUrl: '/worker-basic.min.js',
      heartbeatCallback: (payload: RealtimeHeartbeatPayload) => this.handleRealtimeHeartbeat(payload),
    };
  }

  private handleRealtimeHeartbeat(payload: RealtimeHeartbeatPayload): void {
    const status = typeof payload === 'string'
      ? payload
      : payload.status ?? payload.event ?? payload.reason ?? 'unknown';
    if (/timeout|disconnect|closed|error/i.test(status)) {
      this.logger.warn('Supabase Realtime heartbeat unhealthy', { status });
      this.sentryLazyLoader.addBreadcrumb({
        category: 'realtime',
        level: 'warning',
        message: 'supabase_realtime_heartbeat_unhealthy',
        data: { status },
      });
      return;
    }
    this.logger.debug('Supabase Realtime heartbeat', { status });
  }
}
