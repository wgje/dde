import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import {
  teardownRealtimeChannel,
  unsubscribeRealtimeChannel,
  type RealtimeChannelTeardownLogger,
} from './realtime-channel-teardown.helpers';

const mockChannel = (): RealtimeChannel => ({
  unsubscribe: vi.fn().mockResolvedValue(undefined),
} as unknown as RealtimeChannel);

const mockClient = (removeChannel = vi.fn().mockResolvedValue(undefined)): Pick<SupabaseClient, 'removeChannel'> => ({
  removeChannel,
});

const mockLogger = (): RealtimeChannelTeardownLogger => ({
  debug: vi.fn(),
  warn: vi.fn(),
});

describe('teardownRealtimeChannel', () => {
  it('uses Supabase removeChannel when a client is available', async () => {
    const channel = mockChannel();
    const client = mockClient();
    const logger = mockLogger();

    await teardownRealtimeChannel({
      channel,
      client,
      logger,
      removeFailureMessage: 'remove failed',
      fallbackUnsubscribeMessage: 'unsubscribe fallback failed',
    });

    expect(client.removeChannel).toHaveBeenCalledWith(channel);
    expect(channel.unsubscribe).not.toHaveBeenCalled();
  });

  it('falls back to unsubscribe when removeChannel fails', async () => {
    const channel = mockChannel();
    const removeError = new Error('remove failed');
    const client = mockClient(vi.fn().mockRejectedValue(removeError));
    const logger = mockLogger();

    await expect(teardownRealtimeChannel({
      channel,
      client,
      logger,
      removeFailureMessage: 'remove failed',
      fallbackUnsubscribeMessage: 'unsubscribe fallback failed',
      removeFailureLevel: 'warn',
    })).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledWith('remove failed', { error: removeError });
    expect(channel.unsubscribe).toHaveBeenCalledOnce();
  });

  it('still falls back to unsubscribe when removeChannel failure logging throws', async () => {
    const channel = mockChannel();
    const removeError = new Error('remove failed');
    const client = mockClient(vi.fn().mockRejectedValue(removeError));
    const logger = mockLogger();
    vi.mocked(logger.warn).mockImplementation(() => {
      throw new Error('logger failed');
    });

    await expect(teardownRealtimeChannel({
      channel,
      client,
      logger,
      removeFailureMessage: 'remove failed',
      fallbackUnsubscribeMessage: 'unsubscribe fallback failed',
      removeFailureLevel: 'warn',
    })).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledWith('remove failed', { error: removeError });
    expect(channel.unsubscribe).toHaveBeenCalledOnce();
  });

  it('falls back to channel.unsubscribe when no Supabase client is available', async () => {
    const channel = mockChannel();
    const logger = mockLogger();

    await teardownRealtimeChannel({
      channel,
      client: null,
      logger,
      removeFailureMessage: 'remove failed',
      fallbackUnsubscribeMessage: 'unsubscribe fallback failed',
    });

    expect(channel.unsubscribe).toHaveBeenCalledOnce();
  });
});

describe('unsubscribeRealtimeChannel', () => {
  it('logs unsubscribe failures without throwing', async () => {
    const unsubscribeError = new Error('unsubscribe failed');
    const channel = {
      unsubscribe: vi.fn().mockRejectedValue(unsubscribeError),
    } as unknown as RealtimeChannel;
    const logger = mockLogger();

    await expect(unsubscribeRealtimeChannel(
      channel,
      logger,
      'unsubscribe fallback failed',
    )).resolves.toBeUndefined();

    expect(logger.debug).toHaveBeenCalledWith(
      'unsubscribe fallback failed',
      { error: unsubscribeError },
    );
  });

  it('swallows unsubscribe failure logging errors', async () => {
    const unsubscribeError = new Error('unsubscribe failed');
    const channel = {
      unsubscribe: vi.fn().mockRejectedValue(unsubscribeError),
    } as unknown as RealtimeChannel;
    const logger = mockLogger();
    vi.mocked(logger.debug).mockImplementation(() => {
      throw new Error('logger failed');
    });

    await expect(unsubscribeRealtimeChannel(
      channel,
      logger,
      'unsubscribe fallback failed',
    )).resolves.toBeUndefined();

    expect(logger.debug).toHaveBeenCalledWith(
      'unsubscribe fallback failed',
      { error: unsubscribeError },
    );
  });
});
