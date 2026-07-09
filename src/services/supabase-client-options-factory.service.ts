import { Injectable, inject } from '@angular/core';
import { LoggerService } from './logger.service';
import { SentryLazyLoaderService } from './sentry-lazy-loader.service';
import { resolveSupabaseStorageKey } from './supabase-client-configuration';

type RealtimeHeartbeatPayload = string | {
  status?: string;
  event?: string;
  reason?: string;
};

@Injectable({
  providedIn: 'root',
})
export class SupabaseClientOptionsFactoryService {
  private readonly logger = inject(LoggerService).category('SupabaseClient');
  private readonly sentryLazyLoader = inject(SentryLazyLoaderService);

  buildClientOptions(
    supabaseUrl: string,
    fetchHandler: (url: RequestInfo | URL, options?: RequestInit) => Promise<Response>,
  ) {
    return {
      auth: this.buildAuthClientOptions(supabaseUrl),
      global: {
        fetch: fetchHandler,
      },
      db: {
        schema: 'public' as const,
      },
      realtime: this.buildRealtimeClientOptions(),
    };
  }

  private buildAuthClientOptions(supabaseUrl: string) {
    return {
      storage: typeof window !== 'undefined' ? window.localStorage : undefined,
      storageKey: resolveSupabaseStorageKey(supabaseUrl) ?? undefined,
      lock: this.buildNavigatorLockHandler(),
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: true,
      flowType: 'pkce' as const,
    };
  }

  private buildNavigatorLockHandler() {
    if (typeof navigator === 'undefined' || !navigator.locks) {
      return async <T>(_name: string, _acquireTimeout: number, fn: () => Promise<T>): Promise<T> => await fn();
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
