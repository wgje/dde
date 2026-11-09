import {
  resetWorkspaceShellFocusModeIntentActivated,
} from './workspace-shell-focus-sync-mount-state.factory';
import type {
  WorkspaceShellFocusEntrySyncPulseDelegate,
  WorkspaceShellFocusSyncControllerHosts,
  WorkspaceShellSyncPulseLifecycleDelegate,
} from './workspace-shell-focus-sync-controllers.factory';
import type { WorkspaceShellMountStateController } from './workspace-shell-mount-state.controller';

const FOCUS_SYNC_OPERATION_FAILURE_MESSAGE =
  'Focus sync controller lazy host 加载失败，已跳过本次操作';
const FOCUS_SYNC_PULSE_FAILURE_MESSAGE =
  'Focus sync controller lazy host 加载失败，已跳过本次同步脉冲';
const FOCUS_SYNC_CLEANUP_FAILURE_MESSAGE =
  'Focus sync controller lazy host 清理失败，已跳过';

export interface WorkspaceShellFocusSyncLazyHost {
  loadedDelegate: WorkspaceShellFocusSyncControllerHosts | null;
  run(
    action: (delegate: WorkspaceShellFocusSyncControllerHosts) => void,
    failureMessage?: string,
    loadFailureMessage?: string,
  ): void;
  runIfLoaded(
    action: (delegate: WorkspaceShellFocusSyncControllerHosts) => void,
    failureMessage?: string,
  ): void;
  call<TResult>(
    action: (delegate: WorkspaceShellFocusSyncControllerHosts) => TResult | Promise<TResult>,
    fallback: TResult,
    failureMessage?: string,
    loadFailureMessage?: string,
  ): Promise<TResult>;
}

export interface WorkspaceShellFocusSyncPulseDelegatesOptions {
  lazyHosts: WorkspaceShellFocusSyncLazyHost;
  mountState: WorkspaceShellMountStateController;
}

export function createWorkspaceShellFocusSyncPulseDelegates({
  lazyHosts,
  mountState,
}: WorkspaceShellFocusSyncPulseDelegatesOptions): Pick<
  WorkspaceShellFocusSyncControllerHosts,
  'focusEntrySyncPulse' | 'syncPulseLifecycle'
> {
  return {
    focusEntrySyncPulse: createFocusEntrySyncPulseDelegate(lazyHosts, mountState),
    syncPulseLifecycle: createSyncPulseLifecycleDelegate(lazyHosts, mountState),
  };
}

function createFocusEntrySyncPulseDelegate(
  lazyHosts: WorkspaceShellFocusSyncLazyHost,
  mountState: WorkspaceShellMountStateController,
): WorkspaceShellFocusEntrySyncPulseDelegate {
  return {
    clearRetry: () => lazyHosts.runIfLoaded(
      host => host.focusEntrySyncPulse.clearRetry(),
      FOCUS_SYNC_CLEANUP_FAILURE_MESSAGE,
    ),
    dispatchIfReady: () => lazyHosts.run(
      host => host.focusEntrySyncPulse.dispatchIfReady(),
      FOCUS_SYNC_OPERATION_FAILURE_MESSAGE,
    ),
    handleOwnerChange: ownerId => lazyHosts.run(
      host => host.focusEntrySyncPulse.handleOwnerChange(ownerId),
      FOCUS_SYNC_OPERATION_FAILURE_MESSAGE,
    ),
    reset: rearmIntentListener =>
      resetFocusEntrySyncPulse(lazyHosts, mountState, rearmIntentListener),
  };
}

function createSyncPulseLifecycleDelegate(
  lazyHosts: WorkspaceShellFocusSyncLazyHost,
  mountState: WorkspaceShellMountStateController,
): WorkspaceShellSyncPulseLifecycleDelegate {
  return {
    clearFocusEntrySyncPulseRetry: () => lazyHosts.runIfLoaded(
      host => host.syncPulseLifecycle.clearFocusEntrySyncPulseRetry(),
      FOCUS_SYNC_CLEANUP_FAILURE_MESSAGE,
    ),
    destroy: () => lazyHosts.runIfLoaded(
      host => host.syncPulseLifecycle.destroy(),
      FOCUS_SYNC_CLEANUP_FAILURE_MESSAGE,
    ),
    dispatchFocusEntrySyncPulseIfReady: () => lazyHosts.run(
      host => host.syncPulseLifecycle.dispatchFocusEntrySyncPulseIfReady(),
      FOCUS_SYNC_OPERATION_FAILURE_MESSAGE,
    ),
    initialize: () => lazyHosts.run(
      host => host.syncPulseLifecycle.initialize(),
      FOCUS_SYNC_OPERATION_FAILURE_MESSAGE,
    ),
    isReady: () => lazyHosts.loadedDelegate?.syncPulseLifecycle.isReady() ?? false,
    resetFocusEntrySyncPulse: rearmIntentListener =>
      resetFocusEntrySyncPulse(lazyHosts, mountState, rearmIntentListener),
    sync: () => lazyHosts.run(
      host => host.syncPulseLifecycle.sync(),
      FOCUS_SYNC_OPERATION_FAILURE_MESSAGE,
    ),
    syncEffect: () => lazyHosts.run(
      host => host.syncPulseLifecycle.syncEffect(),
      FOCUS_SYNC_OPERATION_FAILURE_MESSAGE,
    ),
    trigger: reason => lazyHosts.call(
      host => host.syncPulseLifecycle.trigger(reason),
      null,
      FOCUS_SYNC_PULSE_FAILURE_MESSAGE,
    ),
  };
}

function resetFocusEntrySyncPulse(
  lazyHosts: WorkspaceShellFocusSyncLazyHost,
  mountState: WorkspaceShellMountStateController,
  rearmIntentListener?: boolean,
): void {
  resetWorkspaceShellFocusModeIntentActivated(mountState);
  lazyHosts.run(
    host => host.focusEntrySyncPulse.reset(rearmIntentListener),
    FOCUS_SYNC_OPERATION_FAILURE_MESSAGE,
  );
}
