import { describe, expect, it, vi } from 'vitest';

import {
  createRealtimeChannelSubscription,
  type RealtimeChannelSubscriptionOptions,
} from './realtime-channel-subscription.factory';
import type { RealtimePayloadDispatchRuntime } from './realtime-payload-dispatch.controller';
import type { RealtimeChannel } from '@supabase/supabase-js';

type MockRealtimeChannel = ReturnType<typeof createChannel>;

function createChannel() {
  const channel = {
    on: vi.fn().mockReturnThis(),
    subscribe: vi.fn().mockReturnThis(),
  };
  channel.on.mockReturnValue(channel);
  channel.subscribe.mockReturnValue(channel);
  return channel;
}

function createClient(channel = createChannel()): RealtimeChannelSubscriptionOptions['client'] {
  return {
    channel: vi.fn(() => channel as unknown as RealtimeChannel) as RealtimeChannelSubscriptionOptions['client']['channel'],
  };
}

function createOptions(
  overrides: Partial<RealtimeChannelSubscriptionOptions> = {},
): RealtimeChannelSubscriptionOptions {
  const channel = createChannel();
  return {
    client: createClient(channel),
    dispatchRuntime: {} as RealtimePayloadDispatchRuntime,
    handleConnectionPayload: vi.fn(),
    handleStatus: vi.fn(),
    handleTaskPayload: vi.fn(),
    handleUserPreferencesPayload: vi.fn(),
    logger: {
      info: vi.fn(),
    },
    projectId: 'project-1',
    transportGeneration: 7,
    userId: 'user-1',
    ...overrides,
  };
}

describe('createRealtimeChannelSubscription', () => {
  it('registers project and user realtime handlers on the channel', () => {
    const channel = createChannel();
    const options = createOptions({
      client: createClient(channel),
    });

    const state = createRealtimeChannelSubscription(options);

    expect(options.client.channel).toHaveBeenCalledWith('project:project-1:user-1');
    expect(state).toEqual(expect.objectContaining({
      channel,
      channelName: 'project:project-1:user-1',
      consecutiveErrors: 0,
      previousStatus: null,
      projectId: 'project-1',
      transportGeneration: 7,
      userId: 'user-1',
    }));
    expect(channel.on).toHaveBeenCalledWith(
      'postgres_changes',
      expect.objectContaining({ table: 'tasks', filter: 'project_id=eq.project-1' }),
      expect.any(Function),
    );
    expect(channel.on).toHaveBeenCalledWith(
      'postgres_changes',
      expect.objectContaining({ table: 'connections', filter: 'project_id=eq.project-1' }),
      expect.any(Function),
    );
    expect(channel.on).toHaveBeenCalledWith(
      'postgres_changes',
      expect.objectContaining({ table: 'user_preferences', filter: 'user_id=eq.user-1' }),
      expect.any(Function),
    );
    expect(channel.subscribe).toHaveBeenCalledWith(expect.any(Function));
  });

  it('forwards payload and status callbacks through the supplied controllers', () => {
    const channel = createChannel();
    const options = createOptions({
      client: createClient(channel),
    });

    const state = createRealtimeChannelSubscription(options);
    const taskHandler = channel.on.mock.calls[0][2] as Parameters<MockRealtimeChannel['on']>[2];
    const connectionHandler = channel.on.mock.calls[1][2] as Parameters<MockRealtimeChannel['on']>[2];
    const userPreferencesHandler = channel.on.mock.calls[2][2] as Parameters<MockRealtimeChannel['on']>[2];
    const statusHandler = channel.subscribe.mock.calls[0][0] as (
      status: string,
      error: undefined,
    ) => void;

    taskHandler({ eventType: 'INSERT' });
    connectionHandler({ eventType: 'UPDATE' });
    userPreferencesHandler({ eventType: 'DELETE' });
    statusHandler('SUBSCRIBED', undefined);

    expect(options.handleTaskPayload).toHaveBeenCalledWith(
      { eventType: 'INSERT' },
      state,
      options.dispatchRuntime,
    );
    expect(options.handleConnectionPayload).toHaveBeenCalledWith(
      { eventType: 'UPDATE' },
      state,
      options.dispatchRuntime,
    );
    expect(options.handleUserPreferencesPayload).toHaveBeenCalledWith(
      { eventType: 'DELETE' },
      state,
      options.dispatchRuntime,
    );
    expect(options.handleStatus).toHaveBeenCalledWith('SUBSCRIBED', undefined, state);
  });
});
