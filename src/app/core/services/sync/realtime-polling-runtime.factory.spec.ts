import { describe, expect, it, vi } from 'vitest';

import {
  createRealtimePollingRuntime,
  type RealtimePollingRuntimeOptions,
} from './realtime-polling-runtime.factory';

const mockRealtimeChannel = {} as import('@supabase/supabase-js').RealtimeChannel;

function createOptions(
  overrides: Partial<RealtimePollingRuntimeOptions> = {},
): RealtimePollingRuntimeOptions {
  return {
    canActivateRemoteTransport: vi.fn(() => true),
    getCurrentProjectId: vi.fn(() => 'project-1'),
    getCurrentUserId: vi.fn(() => 'user-1'),
    getOnRemoteChangeCallback: vi.fn(() =>
      vi.fn().mockResolvedValue(undefined),
    ),
    getRealtimeChannel: vi.fn(() => null),
    getRealtimePaused: vi.fn(() => false),
    getSyncState: vi.fn(() => ({ isOnline: true, offlineMode: false })),
    getTransportGeneration: vi.fn(() => 3),
    isTransportContextCurrent: vi.fn(() => true),
    maybeReenterRealtimeFromPolling: vi.fn().mockResolvedValue(false),
    ...overrides,
  };
}

describe('createRealtimePollingRuntime', () => {
  it('exposes live polling state and callbacks to the scheduler', async () => {
    const onRemoteChange = vi.fn().mockResolvedValue(undefined);
    const maybeReenterRealtimeFromPolling = vi.fn().mockResolvedValue(true);
    const options = createOptions({
      getOnRemoteChangeCallback: () => onRemoteChange,
      getRealtimeChannel: () => mockRealtimeChannel,
      getRealtimePaused: () => true,
      getSyncState: () => ({ isOnline: false, offlineMode: true }),
      maybeReenterRealtimeFromPolling,
    });

    const runtime = createRealtimePollingRuntime(options);
    await runtime.onRemoteChange({ eventType: 'polling', projectId: 'project-1' });
    const reentered = await runtime.maybeReenterRealtimeFromPolling('project-1', 'user-1', 3);

    expect(runtime.canActivateRemoteTransport()).toBe(true);
    expect(runtime.isOnline()).toBe(false);
    expect(runtime.isRealtimePaused()).toBe(true);
    expect(runtime.hasRealtimeChannel()).toBe(true);
    expect(runtime.isTransportContextCurrent(3, 'project-1', 'user-1')).toBe(true);
    expect(onRemoteChange).toHaveBeenCalledWith({
      eventType: 'polling',
      projectId: 'project-1',
    });
    expect(maybeReenterRealtimeFromPolling).toHaveBeenCalledWith('project-1', 'user-1', 3);
    expect(reentered).toBe(true);
  });

  it('no-ops remote change when no callback is registered', async () => {
    const runtime = createRealtimePollingRuntime(createOptions({
      getOnRemoteChangeCallback: () => null,
    }));

    await expect(runtime.onRemoteChange(undefined)).resolves.toBeUndefined();
  });
});
