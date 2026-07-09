import { afterEach, beforeEach, vi } from 'vitest';
import { Injector, runInInjectionContext } from '@angular/core';

import { environment } from '../environments/environment';
import { LoggerService } from './logger.service';
import { SupabaseClientService } from './supabase-client.service';
import { SyncRpcClientService } from './sync-rpc-client.service';

export const mockLoggerCategory = {
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

const mockLogger = {
  category: () => mockLoggerCategory,
} as unknown as LoggerService;

export interface MutableSyncRpcEnv {
  syncRpcEnabled?: boolean;
  syncProtocolVersion?: number;
  deploymentEpoch?: number;
  deploymentTarget?: string;
  sentryRelease?: string;
  canonicalOrigin?: string;
}

export function syncRpcEnv(): MutableSyncRpcEnv {
  return environment as unknown as MutableSyncRpcEnv;
}

export function buildService(
  rpcImpl: (
    name: string,
    payload: unknown,
  ) => Promise<{ data: unknown; error: { message: string } | null }>,
): SyncRpcClientService {
  const mockSupabase = {
    clientAsync: vi.fn(async () => ({
      // 直接透传 rpcImpl 返回值：既支持 Promise，也支持带 abortSignal() 的 builder mock
      rpc: vi.fn((name: string, args: { payload: unknown }) =>
        rpcImpl(name, args?.payload)),
    })),
  } as unknown as SupabaseClientService;

  const injector = Injector.create({
    providers: [
      { provide: SupabaseClientService, useValue: mockSupabase },
      { provide: LoggerService, useValue: mockLogger },
    ],
  });
  return runInInjectionContext(injector, () => new SyncRpcClientService());
}

export function installSyncRpcClientSpecEnv(): void {
  let originalEnv: MutableSyncRpcEnv;

  beforeEach(() => {
    mockLoggerCategory.info.mockReset();
    mockLoggerCategory.warn.mockReset();
    const env = syncRpcEnv();
    originalEnv = {
      syncRpcEnabled: env.syncRpcEnabled,
      syncProtocolVersion: env.syncProtocolVersion,
      deploymentEpoch: env.deploymentEpoch,
      deploymentTarget: env.deploymentTarget,
      sentryRelease: env.sentryRelease,
      canonicalOrigin: env.canonicalOrigin,
    };
  });

  afterEach(() => {
    const env = syncRpcEnv();
    env.syncRpcEnabled = originalEnv.syncRpcEnabled;
    env.syncProtocolVersion = originalEnv.syncProtocolVersion;
    env.deploymentEpoch = originalEnv.deploymentEpoch;
    env.deploymentTarget = originalEnv.deploymentTarget;
    env.sentryRelease = originalEnv.sentryRelease;
    env.canonicalOrigin = originalEnv.canonicalOrigin;
  });
}
