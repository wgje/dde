import type { SupabaseClient } from '@supabase/supabase-js';

import { classifySupabaseClientFailure } from '../../../utils/supabase-error';

export interface SimpleSyncClientLogger {
  warn(message: string, context?: unknown): void;
  debug(message: string, context?: unknown): void;
}

export interface ResolveSimpleSyncClientDeps {
  supabase: {
    readonly isConfigured: boolean;
    isOfflineMode(): boolean;
    clientAsync(): Promise<SupabaseClient | null>;
  };
  syncStateService: {
    setSyncError(message: string): void;
    setOfflineMode(isOffline: boolean): void;
  };
  sentryLazyLoader: {
    captureMessage(message: string, context: {
      level: 'warning';
      tags: {
        operation: string;
        category: string;
      };
    }): void;
  };
  logger: SimpleSyncClientLogger;
}

export async function resolveSimpleSyncSupabaseClient(
  deps: ResolveSimpleSyncClientDeps,
): Promise<SupabaseClient | null> {
  if (!deps.supabase.isConfigured) {
    const failure = classifySupabaseClientFailure(false);
    deps.syncStateService.setSyncError(failure.message);
    deps.logger.warn('无法获取 Supabase 客户端', failure);
    return null;
  }

  if (deps.supabase.isOfflineMode()) {
    deps.syncStateService.setOfflineMode(true);
    deps.logger.debug('Supabase 远端暂不可达，已跳过云端客户端获取');
    return null;
  }

  try {
    return await deps.supabase.clientAsync();
  } catch (error) {
    const failure = classifySupabaseClientFailure(true, error);
    deps.syncStateService.setSyncError(failure.message);
    deps.logger.warn('无法获取 Supabase 客户端', {
      category: failure.category,
      message: failure.message,
    });
    deps.sentryLazyLoader.captureMessage('Sync client unavailable', {
      level: 'warning',
      tags: {
        operation: 'SimpleSync.getSupabaseClient',
        category: failure.category,
      },
    });
    // eslint-disable-next-line no-restricted-syntax -- 需保持历史接口语义，客户端不可用时返回 null 触发离线降级分支
    return null;
  }
}
