import { describe, expect, it, vi } from 'vitest';

import { WorkspaceShellOwnerTransitionController } from './workspace-shell-owner-transition.controller';

function createController() {
  const calls: string[] = [];
  const resetFocusEntrySyncPulseState = vi.fn(() => calls.push('resetFocusEntrySyncPulseState'));
  const setLaunchSnapshotWriteBlocked = vi.fn(() => calls.push('setLaunchSnapshotWriteBlocked'));
  const cancelPendingLaunchSnapshotPersist = vi.fn(() => calls.push('cancelPendingLaunchSnapshotPersist'));
  const stopSyncRuntime = vi.fn(() => calls.push('stopSyncRuntime'));
  const clearProjectSubscription = vi.fn(() => calls.push('clearProjectSubscription'));
  const destroySyncPulse = vi.fn(() => calls.push('destroySyncPulse'));
  const warn = vi.fn();
  const controller = new WorkspaceShellOwnerTransitionController({
    resetFocusEntrySyncPulseState,
    setLaunchSnapshotWriteBlocked,
    cancelPendingLaunchSnapshotPersist,
    stopSyncRuntime,
    clearProjectSubscription,
    destroySyncPulse,
    warn,
  });

  return {
    calls,
    cancelPendingLaunchSnapshotPersist,
    clearProjectSubscription,
    controller,
    destroySyncPulse,
    resetFocusEntrySyncPulseState,
    setLaunchSnapshotWriteBlocked,
    stopSyncRuntime,
    warn,
  };
}

describe('WorkspaceShellOwnerTransitionController', () => {
  it('runs the owner transition cleanup steps in order', () => {
    const {
      calls,
      controller,
      resetFocusEntrySyncPulseState,
      setLaunchSnapshotWriteBlocked,
    } = createController();

    controller.prepare();

    expect(calls).toEqual([
      'resetFocusEntrySyncPulseState',
      'setLaunchSnapshotWriteBlocked',
      'cancelPendingLaunchSnapshotPersist',
      'stopSyncRuntime',
      'clearProjectSubscription',
      'destroySyncPulse',
    ]);
    expect(resetFocusEntrySyncPulseState).toHaveBeenCalledWith(false);
    expect(setLaunchSnapshotWriteBlocked).toHaveBeenCalledWith(true);
  });

  it('warns and continues remaining cleanup when one step fails', () => {
    const {
      clearProjectSubscription,
      controller,
      destroySyncPulse,
      stopSyncRuntime,
      warn,
    } = createController();
    const error = new Error('stop runtime failed');
    stopSyncRuntime.mockImplementationOnce(() => {
      throw error;
    });

    expect(() => controller.prepare()).not.toThrow();

    expect(clearProjectSubscription).toHaveBeenCalledTimes(1);
    expect(destroySyncPulse).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('会话 owner 过渡步骤失败，已继续后续清理', {
      step: 'stopSyncRuntime',
      error,
    });
  });

  it('continues cleanup when the warning sink also fails', () => {
    const {
      cancelPendingLaunchSnapshotPersist,
      controller,
      destroySyncPulse,
      resetFocusEntrySyncPulseState,
      warn,
    } = createController();
    resetFocusEntrySyncPulseState.mockImplementationOnce(() => {
      throw new Error('reset failed');
    });
    warn.mockImplementation(() => {
      throw new Error('warning sink failed');
    });

    expect(() => controller.prepare()).not.toThrow();

    expect(cancelPendingLaunchSnapshotPersist).toHaveBeenCalledTimes(1);
    expect(destroySyncPulse).toHaveBeenCalledTimes(1);
  });
});
