import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';

import {
  teardownRealtimeChannel,
  type RealtimeChannelTeardownLogger,
} from './realtime-channel-teardown.helpers';

export interface RealtimePollingCleanupOptions {
  channel: RealtimeChannel | null;
  client: Pick<SupabaseClient, 'removeChannel'> | null;
  logger: RealtimeChannelTeardownLogger;
}

export function cleanupRealtimePollingTransport({
  channel,
  client,
  logger,
}: RealtimePollingCleanupOptions): void {
  if (!channel) {
    return;
  }

  void teardownRealtimeChannel({
    channel,
    client,
    logger,
    removeFailureMessage: '清理时移除 Realtime 通道失败',
    fallbackUnsubscribeMessage: '清理时取消 Realtime 通道失败',
  });
}
