import type { SupabaseClient } from '@supabase/supabase-js';

import type { SupabaseClientService } from '../../../../services/supabase-client.service';
import { classifySupabaseClientFailure } from '../../../../utils/supabase-error';
import type { SyncStateService } from './sync-state.service';

interface RealtimeSupabaseClientLogger {
  warn(message: string, context?: unknown): void;
}

interface RealtimeSupabaseClientOptions {
  supabase: Pick<SupabaseClientService, 'client' | 'isConfigured'>;
  logger: RealtimeSupabaseClientLogger;
  syncState: Pick<SyncStateService, 'setSyncError'>;
}

export function getRealtimeSupabaseClient({
  supabase,
  logger,
  syncState,
}: RealtimeSupabaseClientOptions): SupabaseClient | null {
  if (!supabase.isConfigured) {
    const failure = classifySupabaseClientFailure(false);
    logger.warn('无法获取 Supabase 客户端', failure);
    syncState.setSyncError(failure.message);
    return null;
  }

  let client: SupabaseClient | null = null;
  try {
    client = supabase.client();
  } catch (error) {
    const failure = classifySupabaseClientFailure(true, error);
    logger.warn('无法获取 Supabase 客户端', {
      category: failure.category,
      message: failure.message,
    });
    syncState.setSyncError(failure.message);
  }

  return client;
}
