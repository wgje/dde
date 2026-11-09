import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';

import type {
  RealtimePayload,
  RealtimePayloadDispatchRuntime,
} from './realtime-payload-dispatch.controller';
import type {
  RealtimeStatusError,
  RealtimeSubscribeState,
} from './realtime-status.controller';

export interface RealtimeChannelSubscriptionOptions {
  client: Pick<SupabaseClient, 'channel'>;
  projectId: string;
  userId: string;
  transportGeneration: number;
  dispatchRuntime: RealtimePayloadDispatchRuntime;
  logger: {
    info: (message: string, data?: unknown) => void;
  };
  handleTaskPayload: (
    payload: RealtimePayload,
    state: RealtimeSubscribeState,
    runtime: RealtimePayloadDispatchRuntime,
  ) => void;
  handleConnectionPayload: (
    payload: RealtimePayload,
    state: RealtimeSubscribeState,
    runtime: RealtimePayloadDispatchRuntime,
  ) => void;
  handleUserPreferencesPayload: (
    payload: RealtimePayload,
    state: RealtimeSubscribeState,
    runtime: RealtimePayloadDispatchRuntime,
  ) => void;
  handleStatus: (
    status: string,
    err: RealtimeStatusError | undefined,
    state: RealtimeSubscribeState,
  ) => void;
}

export function createRealtimeChannelSubscription(
  options: RealtimeChannelSubscriptionOptions,
): RealtimeSubscribeState {
  const channelName = `project:${options.projectId}:${options.userId.substring(0, 8)}`;
  options.logger.info('启用 Realtime 订阅', {
    projectId: options.projectId,
    channel: channelName,
  });

  const state: RealtimeSubscribeState = {
    projectId: options.projectId,
    userId: options.userId,
    transportGeneration: options.transportGeneration,
    channelName,
    channel: options.client.channel(channelName) as RealtimeChannel,
    previousStatus: null,
    consecutiveErrors: 0,
  };

  registerRealtimeChannelHandlers(state, options);
  return state;
}

function registerRealtimeChannelHandlers(
  state: RealtimeSubscribeState,
  options: RealtimeChannelSubscriptionOptions,
): void {
  state.channel.on(
    'postgres_changes',
    {
      event: '*',
      schema: 'public',
      table: 'tasks',
      filter: `project_id=eq.${state.projectId}`,
    },
    (payload) => options.handleTaskPayload(
      payload as RealtimePayload,
      state,
      options.dispatchRuntime,
    ),
  ).on(
    'postgres_changes',
    {
      event: '*',
      schema: 'public',
      table: 'connections',
      filter: `project_id=eq.${state.projectId}`,
    },
    (payload) => options.handleConnectionPayload(
      payload as RealtimePayload,
      state,
      options.dispatchRuntime,
    ),
  ).on(
    'postgres_changes',
    {
      event: '*',
      schema: 'public',
      table: 'user_preferences',
      filter: `user_id=eq.${state.userId}`,
    },
    (payload) => options.handleUserPreferencesPayload(
      payload as RealtimePayload,
      state,
      options.dispatchRuntime,
    ),
  ).subscribe((status, err) => options.handleStatus(status, err, state));
}
