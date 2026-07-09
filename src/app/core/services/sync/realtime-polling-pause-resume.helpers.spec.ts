import { describe, expect, it } from 'vitest';

import {
  pauseRealtimePollingUpdates,
  resumeRealtimePollingUpdates,
  shouldStartPollingFallbackAfterRealtimeResume,
} from './realtime-polling-pause-resume.helpers';

describe('realtime polling pause/resume helpers', () => {
  it('records polling fallback restart when pausing without an active channel', () => {
    expect(pauseRealtimePollingUpdates({
      realtimeChannel: null,
      pollingFallbackActive: true,
      restartPollingOnRealtimeResume: false,
    })).toEqual({
      realtimePaused: true,
      restartPollingOnRealtimeResume: true,
    });
  });

  it('consumes the pending restart flag when realtime updates resume', () => {
    expect(resumeRealtimePollingUpdates(true)).toEqual({
      realtimePaused: false,
      restartPollingOnRealtimeResume: false,
      shouldRestartPolling: true,
    });
  });

  it('starts polling fallback only when the current transport context is still eligible', () => {
    expect(shouldStartPollingFallbackAfterRealtimeResume({
      projectId: 'project-1',
      canActivateRemoteTransport: true,
      realtimeChannel: null,
      hasActivePolling: false,
      isTransportContextCurrent: true,
    })).toBe(true);

    expect(shouldStartPollingFallbackAfterRealtimeResume({
      projectId: 'project-1',
      canActivateRemoteTransport: true,
      realtimeChannel: {},
      hasActivePolling: false,
      isTransportContextCurrent: true,
    })).toBe(false);
  });

  it('does not start polling fallback when the transport context is stale', () => {
    expect(shouldStartPollingFallbackAfterRealtimeResume({
      projectId: 'project-1',
      canActivateRemoteTransport: true,
      realtimeChannel: null,
      hasActivePolling: false,
      isTransportContextCurrent: false,
    })).toBe(false);
  });

  it('skips the restart when a pending polling timer survived the pause (it self-continues after resume)', () => {
    // 契约与 realtime-polling.service.spec「已有活跃轮询不应重复启动兜底」一致：
    // 暂停期间未触发的 pending timer 在 resume 后会因 realtimePaused=false 继续自我调度；
    // 而在暂停期间被触发的链会静默终止并清空 timer/keys，使 hasActivePolling 变 false 走重启分支。
    // 因此 hasActivePolling=true 时跳过重启不会让轮询搁浅，重复启动反而会多打一次立即 poll
    expect(shouldStartPollingFallbackAfterRealtimeResume({
      projectId: 'project-1',
      canActivateRemoteTransport: true,
      realtimeChannel: null,
      hasActivePolling: true,
      isTransportContextCurrent: true,
    })).toBe(false);
  });
});
