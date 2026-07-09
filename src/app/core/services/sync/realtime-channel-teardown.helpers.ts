import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';

export interface RealtimeChannelTeardownLogger {
  debug: (message: string, data?: unknown) => void;
  warn: (message: string, data?: unknown) => void;
}

export async function unsubscribeRealtimeChannel(
  channel: RealtimeChannel,
  logger: RealtimeChannelTeardownLogger,
  message: string,
): Promise<void> {
  try {
    await channel.unsubscribe();
  } catch (error) {
    logRealtimeTeardownFailure(logger, 'debug', message, error);
  }
}

export interface RealtimeChannelTeardownOptions {
  channel: RealtimeChannel;
  client: Pick<SupabaseClient, 'removeChannel'> | null;
  logger: RealtimeChannelTeardownLogger;
  removeFailureMessage: string;
  fallbackUnsubscribeMessage: string;
  removeFailureLevel?: 'debug' | 'warn';
}

export async function teardownRealtimeChannel({
  channel,
  client,
  logger,
  removeFailureMessage,
  fallbackUnsubscribeMessage,
  removeFailureLevel = 'debug',
}: RealtimeChannelTeardownOptions): Promise<void> {
  if (!client) {
    await unsubscribeRealtimeChannel(channel, logger, fallbackUnsubscribeMessage);
    return;
  }

  try {
    await client.removeChannel(channel);
  } catch (error) {
    logRealtimeTeardownFailure(logger, removeFailureLevel, removeFailureMessage, error);
    await unsubscribeRealtimeChannel(channel, logger, fallbackUnsubscribeMessage);
  }
}

function logRealtimeTeardownFailure(
  logger: RealtimeChannelTeardownLogger,
  level: 'debug' | 'warn',
  message: string,
  error: unknown,
): void {
  try {
    logger[level](message, { error });
  } catch {
    // Realtime teardown fallback must not depend on logging sink health.
  }
}
