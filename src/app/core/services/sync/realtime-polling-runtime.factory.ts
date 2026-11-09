import type { RealtimeChannel } from '@supabase/supabase-js';

import type {
  RealtimePollingSchedulerRuntime,
} from './realtime-polling-scheduler.controller';
import type {
  RemoteChangeCallback,
} from './realtime-payload-dispatch.controller';

export interface RealtimePollingRuntimeOptions {
  isTransportContextCurrent: (
    transportGeneration: number,
    projectId: string,
    userId: string | null,
  ) => boolean;
  canActivateRemoteTransport: () => boolean;
  getSyncState: () => { isOnline: boolean; offlineMode: boolean };
  getRealtimePaused: () => boolean;
  getRealtimeChannel: () => RealtimeChannel | null;
  getCurrentProjectId: () => string | null;
  getCurrentUserId: () => string | null;
  getTransportGeneration: () => number;
  maybeReenterRealtimeFromPolling: (
    projectId: string,
    userId: string | null,
    transportGeneration: number,
  ) => Promise<boolean>;
  getOnRemoteChangeCallback: () => RemoteChangeCallback | null;
}

export function createRealtimePollingRuntime(
  options: RealtimePollingRuntimeOptions,
): RealtimePollingSchedulerRuntime {
  return {
    isTransportContextCurrent: (
      transportGeneration: number,
      projectId: string,
      userId: string | null,
    ) => options.isTransportContextCurrent(transportGeneration, projectId, userId),
    canActivateRemoteTransport: () => options.canActivateRemoteTransport(),
    isOnline: () => options.getSyncState().isOnline,
    isRealtimePaused: () => options.getRealtimePaused(),
    hasRealtimeChannel: () => options.getRealtimeChannel() !== null,
    maybeReenterRealtimeFromPolling: (
      projectId: string,
      userId: string | null,
      transportGeneration: number,
    ) => options.maybeReenterRealtimeFromPolling(
      projectId,
      userId,
      transportGeneration,
    ),
    onRemoteChange: (payload: { eventType?: string; projectId?: string } | undefined) =>
      options.getOnRemoteChangeCallback()?.(payload) ?? Promise.resolve(),
  };
}
