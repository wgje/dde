export interface RealtimePollingPauseResumeState {
  realtimePaused: boolean;
  restartPollingOnRealtimeResume: boolean;
}

export interface RealtimePollingResumeState extends RealtimePollingPauseResumeState {
  shouldRestartPolling: boolean;
}

export function pauseRealtimePollingUpdates(input: {
  realtimeChannel: unknown | null;
  pollingFallbackActive: boolean;
  restartPollingOnRealtimeResume: boolean;
}): RealtimePollingPauseResumeState {
  return {
    realtimePaused: true,
    restartPollingOnRealtimeResume: input.restartPollingOnRealtimeResume
      || (input.realtimeChannel === null && input.pollingFallbackActive),
  };
}

export function resumeRealtimePollingUpdates(
  restartPollingOnRealtimeResume: boolean,
): RealtimePollingResumeState {
  return {
    realtimePaused: false,
    restartPollingOnRealtimeResume: false,
    shouldRestartPolling: restartPollingOnRealtimeResume,
  };
}

export function shouldStartPollingFallbackAfterRealtimeResume(input: {
  projectId: string | null;
  canActivateRemoteTransport: boolean;
  realtimeChannel: unknown | null;
  hasActivePolling: boolean;
  isTransportContextCurrent: boolean;
}): boolean {
  // hasActivePolling 为 true 时跳过重启是安全的：暂停期间调度链只会在 tick 回调里
  // 静默终止（终止后 pollingTimer 置 null、activePollingKeys 清空，hasActivePolling
  // 必然变 false 并走重启分支）；仍然 pending 的 timer 在 resume 后触发时会因
  // realtimePaused=false 继续自我调度，重复启动反而会多打一次立即 poll
  return input.projectId !== null
    && input.canActivateRemoteTransport
    && input.realtimeChannel === null
    && !input.hasActivePolling
    && input.isTransportContextCurrent;
}
