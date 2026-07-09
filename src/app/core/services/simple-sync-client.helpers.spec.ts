import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import {
  resolveSimpleSyncSupabaseClient,
  type ResolveSimpleSyncClientDeps,
} from './simple-sync-client.helpers';

const client = { auth: {} } as unknown as SupabaseClient;

function createDeps(overrides: Partial<ResolveSimpleSyncClientDeps> = {}): ResolveSimpleSyncClientDeps {
  return {
    supabase: {
      isConfigured: true,
      isOfflineMode: vi.fn(() => false),
      clientAsync: vi.fn(async () => client),
    },
    syncStateService: {
      setSyncError: vi.fn(),
      setOfflineMode: vi.fn(),
    },
    sentryLazyLoader: {
      captureMessage: vi.fn(),
    },
    logger: {
      warn: vi.fn(),
      debug: vi.fn(),
    },
    ...overrides,
  };
}

describe('simple-sync-client.helpers', () => {
  it('returns null and records sync error when Supabase is not configured', async () => {
    const deps = createDeps({
      supabase: {
        isConfigured: false,
        isOfflineMode: vi.fn(() => false),
        clientAsync: vi.fn(async () => client),
      },
    });

    await expect(resolveSimpleSyncSupabaseClient(deps)).resolves.toBeNull();

    expect(deps.syncStateService.setSyncError).toHaveBeenCalledWith('Supabase 未配置');
    expect(deps.logger.warn).toHaveBeenCalledWith('无法获取 Supabase 客户端', {
      category: 'not_configured',
      message: 'Supabase 未配置',
      retryable: false,
    });
    expect(deps.supabase.clientAsync).not.toHaveBeenCalled();
  });

  it('marks offline mode and skips cloud client creation while Supabase is offline', async () => {
    const deps = createDeps({
      supabase: {
        isConfigured: true,
        isOfflineMode: vi.fn(() => true),
        clientAsync: vi.fn(async () => client),
      },
    });

    await expect(resolveSimpleSyncSupabaseClient(deps)).resolves.toBeNull();

    expect(deps.syncStateService.setOfflineMode).toHaveBeenCalledWith(true);
    expect(deps.logger.debug).toHaveBeenCalledWith('Supabase 远端暂不可达，已跳过云端客户端获取');
    expect(deps.supabase.clientAsync).not.toHaveBeenCalled();
  });

  it('returns the async client when it is available', async () => {
    const deps = createDeps();

    await expect(resolveSimpleSyncSupabaseClient(deps)).resolves.toBe(client);

    expect(deps.supabase.clientAsync).toHaveBeenCalledOnce();
    expect(deps.syncStateService.setSyncError).not.toHaveBeenCalled();
    expect(deps.sentryLazyLoader.captureMessage).not.toHaveBeenCalled();
  });

  it('reports runtime failures and returns null when async client creation throws', async () => {
    const error = new Error('client failed');
    const deps = createDeps({
      supabase: {
        isConfigured: true,
        isOfflineMode: vi.fn(() => false),
        clientAsync: vi.fn(async () => {
          throw error;
        }),
      },
    });

    await expect(resolveSimpleSyncSupabaseClient(deps)).resolves.toBeNull();

    expect(deps.syncStateService.setSyncError).toHaveBeenCalledWith('client failed');
    expect(deps.logger.warn).toHaveBeenCalledWith('无法获取 Supabase 客户端', {
      category: 'runtime_failure',
      message: 'client failed',
    });
    expect(deps.sentryLazyLoader.captureMessage).toHaveBeenCalledWith('Sync client unavailable', {
      level: 'warning',
      tags: {
        operation: 'SimpleSync.getSupabaseClient',
        category: 'runtime_failure',
      },
    });
  });
});
