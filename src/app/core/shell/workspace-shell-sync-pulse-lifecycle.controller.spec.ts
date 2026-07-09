import { describe, expect, it, vi } from 'vitest';

import type { SyncPulseReason } from '../../../services/sync-pulse-engine.service';
import {
  WorkspaceShellSyncPulseLifecycleController,
  type WorkspaceShellSyncPulseLifecycleControllerOptions,
} from './workspace-shell-sync-pulse-lifecycle.controller';

function createController(
  overrides: Partial<WorkspaceShellSyncPulseLifecycleControllerOptions> = {},
) {
  let destroyed = false;
  let eventDrivenSyncPulseEnabled = true;
  let currentUserId: string | null = 'user-1';
  let coreDataLoaded = true;
  let online = true;
  let resuming = false;
  let recoveryCompensationInFlight = false;
  let recoveryTicket: string | null = null;
  let recoveryTicketDedupEnabled = true;
  let tieredStartupHydrationEnabled = false;
  let p2Ready = true;

  const dispatchFocusEntrySyncPulseIfReady = vi.fn();
  const initialize = vi.fn();
  const destroy = vi.fn();
  const trigger = vi.fn<(
    reason: SyncPulseReason,
  ) => ReturnType<WorkspaceShellSyncPulseLifecycleControllerOptions['trigger']>>()
    .mockResolvedValue({ status: 'success' });
  const warn = vi.fn();
  const resetFocusEntrySyncPulse = vi.fn();
  const clearFocusEntrySyncPulseRetry = vi.fn();

  const controller = new WorkspaceShellSyncPulseLifecycleController({
    isDestroyed: () => destroyed,
    isEventDrivenSyncPulseEnabled: () => eventDrivenSyncPulseEnabled,
    currentUserId: () => currentUserId,
    coreDataLoaded: () => coreDataLoaded,
    isOnline: () => online,
    isResuming: () => resuming,
    isRecoveryCompensationInFlight: () => recoveryCompensationInFlight,
    isRecoveryTicketDedupEnabled: () => recoveryTicketDedupEnabled,
    currentRecoveryTicket: () => recoveryTicket,
    isTieredStartupHydrationEnabled: () => tieredStartupHydrationEnabled,
    isP2Ready: () => p2Ready,
    focusModeIntentActivated: () => true,
    dispatchFocusEntrySyncPulseIfReady,
    resetFocusEntrySyncPulse,
    clearFocusEntrySyncPulseRetry,
    initialize,
    destroy,
    trigger,
    warn,
    ...overrides,
  });

  return {
    clearFocusEntrySyncPulseRetry,
    controller,
    destroy,
    dispatchFocusEntrySyncPulseIfReady,
    initialize,
    resetFocusEntrySyncPulse,
    trigger,
    warn,
    setCoreDataLoaded: (value: boolean) => {
      coreDataLoaded = value;
    },
    setCurrentUserId: (value: string | null) => {
      currentUserId = value;
    },
    setDestroyed: (value: boolean) => {
      destroyed = value;
    },
    setEventDrivenSyncPulseEnabled: (value: boolean) => {
      eventDrivenSyncPulseEnabled = value;
    },
    setOnline: (value: boolean) => {
      online = value;
    },
    setP2Ready: (value: boolean) => {
      p2Ready = value;
    },
    setRecoveryCompensationInFlight: (value: boolean) => {
      recoveryCompensationInFlight = value;
    },
    setRecoveryTicket: (value: string | null) => {
      recoveryTicket = value;
    },
    setRecoveryTicketDedupEnabled: (value: boolean) => {
      recoveryTicketDedupEnabled = value;
    },
    setResuming: (value: boolean) => {
      resuming = value;
    },
    setTieredStartupHydrationEnabled: (value: boolean) => {
      tieredStartupHydrationEnabled = value;
    },
  };
}

describe('WorkspaceShellSyncPulseLifecycleController', () => {
  it('blocks sync pulse until the sync runtime is fully ready', async () => {
    const { controller, setCurrentUserId, trigger } = createController();
    setCurrentUserId(null);

    expect(controller.isReady()).toBe(false);
    await expect(controller.trigger('focus-entry')).resolves.toBeNull();

    expect(trigger).not.toHaveBeenCalled();
  });

  it('initializes and dispatches focus-entry pulse when effect state is ready', () => {
    const { controller, dispatchFocusEntrySyncPulseIfReady, destroy, initialize } = createController();

    controller.syncEffect();

    expect(initialize).toHaveBeenCalledTimes(1);
    expect(dispatchFocusEntrySyncPulseIfReady).toHaveBeenCalledTimes(1);
    expect(destroy).not.toHaveBeenCalled();
  });

  it('contains focus-entry dispatch failures during sync effect startup', () => {
    const error = new Error('focus-entry dispatch failed');
    const {
      controller,
      dispatchFocusEntrySyncPulseIfReady,
      initialize,
      warn,
    } = createController();
    dispatchFocusEntrySyncPulseIfReady.mockImplementationOnce(() => {
      throw error;
    });

    expect(() => controller.syncEffect()).not.toThrow();

    expect(initialize).toHaveBeenCalledTimes(1);
    expect(dispatchFocusEntrySyncPulseIfReady).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      '同步脉冲派发失败，已跳过本次脉冲',
      error,
    );
  });

  it('fails closed when focus-entry intent checks throw during dispatch', () => {
    const error = new Error('focus-entry intent read failed');
    const {
      controller,
      dispatchFocusEntrySyncPulseIfReady,
      warn,
    } = createController({
      focusModeIntentActivated: () => {
        throw error;
      },
    });

    expect(() => controller.dispatchFocusEntrySyncPulseIfReady()).not.toThrow();

    expect(dispatchFocusEntrySyncPulseIfReady).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      '同步脉冲状态检查失败，已跳过本次脉冲',
      error,
    );
  });

  it('does not initialize the pulse engine twice while effect state remains ready', () => {
    const { controller, dispatchFocusEntrySyncPulseIfReady, initialize } = createController();

    controller.syncEffect();
    controller.syncEffect();

    expect(initialize).toHaveBeenCalledTimes(1);
    expect(dispatchFocusEntrySyncPulseIfReady).toHaveBeenCalledTimes(2);
  });

  it('allows the pulse engine to initialize again after lifecycle cleanup', () => {
    const { controller, initialize } = createController();

    controller.syncEffect();
    controller.destroy();
    controller.syncEffect();

    expect(initialize).toHaveBeenCalledTimes(2);
  });

  it('isolates pulse engine initialize failures during sync effect startup', () => {
    const error = new Error('engine initialize failed');
    const {
      controller,
      dispatchFocusEntrySyncPulseIfReady,
      initialize,
      warn,
    } = createController();
    initialize.mockImplementationOnce(() => {
      throw error;
    });

    expect(() => controller.syncEffect()).not.toThrow();

    expect(dispatchFocusEntrySyncPulseIfReady).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      '同步脉冲服务初始化失败，已跳过本次脉冲',
      error,
    );
  });

  it('fails closed when sync effect readiness checks throw', () => {
    const error = new Error('readiness check failed');
    const {
      controller,
      destroy,
      initialize,
      warn,
    } = createController({
      currentUserId: () => {
        throw error;
      },
    });

    expect(() => controller.syncEffect()).not.toThrow();

    expect(initialize).not.toHaveBeenCalled();
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      '同步脉冲状态检查失败，已跳过本次脉冲',
      error,
    );
  });

  it('destroys the pulse engine when sync effect state is not ready', () => {
    const { controller, destroy, initialize, setCoreDataLoaded } = createController();
    setCoreDataLoaded(false);

    controller.syncEffect();

    expect(destroy).toHaveBeenCalledTimes(1);
    expect(initialize).not.toHaveBeenCalled();
  });

  it('isolates pulse engine destroy failures during lifecycle cleanup', () => {
    const error = new Error('engine destroy failed');
    const { controller, destroy, warn } = createController();
    destroy.mockImplementationOnce(() => {
      throw error;
    });

    expect(() => controller.destroy()).not.toThrow();

    expect(warn).toHaveBeenCalledWith(
      '同步脉冲服务销毁失败，已跳过本次销毁',
      error,
    );
  });

  it('clears focus-entry retry timers during lifecycle cleanup', () => {
    const { clearFocusEntrySyncPulseRetry, controller, destroy } = createController();

    controller.destroy();

    expect(clearFocusEntrySyncPulseRetry).toHaveBeenCalledTimes(1);
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('does not repeat pulse engine cleanup until a new lifecycle initializes', () => {
    const { clearFocusEntrySyncPulseRetry, controller, destroy, initialize } = createController();

    controller.destroy();
    controller.destroy();

    expect(clearFocusEntrySyncPulseRetry).toHaveBeenCalledTimes(1);
    expect(destroy).toHaveBeenCalledTimes(1);

    controller.syncEffect();
    controller.destroy();

    expect(initialize).toHaveBeenCalledTimes(1);
    expect(clearFocusEntrySyncPulseRetry).toHaveBeenCalledTimes(2);
    expect(destroy).toHaveBeenCalledTimes(2);
  });

  it('continues pulse engine cleanup when focus-entry retry cleanup fails', () => {
    const error = new Error('retry cleanup failed');
    const { clearFocusEntrySyncPulseRetry, controller, destroy, warn } = createController();
    clearFocusEntrySyncPulseRetry.mockImplementationOnce(() => {
      throw error;
    });

    expect(() => controller.destroy()).not.toThrow();

    expect(destroy).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      '同步脉冲重试清理失败，已继续销毁同步脉冲服务',
      error,
    );
  });

  it('continues pulse engine cleanup when retry cleanup warning fails', () => {
    const retryCleanupError = new Error('retry cleanup failed');
    const warningError = new Error('warning sink failed');
    const warn = vi.fn(() => {
      throw warningError;
    });
    const { clearFocusEntrySyncPulseRetry, controller, destroy } = createController({ warn });
    clearFocusEntrySyncPulseRetry.mockImplementationOnce(() => {
      throw retryCleanupError;
    });

    expect(() => controller.destroy()).not.toThrow();

    expect(destroy).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      '同步脉冲重试清理失败，已继续销毁同步脉冲服务',
      retryCleanupError,
    );
  });

  it('does not initialize a destroyed shell', () => {
    const { controller, initialize, setDestroyed } = createController();
    setDestroyed(true);

    controller.initialize();

    expect(initialize).not.toHaveBeenCalled();
  });

  it('does not trigger sync pulse after the shell is destroyed', async () => {
    const { controller, setDestroyed, trigger } = createController();
    setDestroyed(true);

    expect(controller.isReady()).toBe(false);
    await expect(controller.trigger('focus-entry')).resolves.toBeNull();

    expect(trigger).not.toHaveBeenCalled();
  });

  it('fails closed when trigger readiness checks throw', async () => {
    const error = new Error('online check failed');
    const { controller, trigger, warn } = createController({
      isOnline: () => {
        throw error;
      },
    });

    await expect(controller.trigger('focus-entry')).resolves.toBeNull();

    expect(trigger).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      '同步脉冲状态检查失败，已跳过本次脉冲',
      error,
    );
  });

  it('warns and downgrades failed trigger attempts to null', async () => {
    const { controller, trigger, warn } = createController();
    const error = new Error('sync pulse failed');
    trigger.mockRejectedValueOnce(error);

    await expect(controller.trigger('focus-entry')).resolves.toBeNull();

    expect(warn).toHaveBeenCalledWith('同步脉冲服务触发失败，跳过本次脉冲', error);
  });

  it('warns and downgrades synchronous trigger failures to null', async () => {
    const { controller, trigger, warn } = createController();
    const error = new Error('sync pulse sync failure');
    trigger.mockImplementationOnce(() => {
      throw error;
    });

    await expect(controller.trigger('focus-entry')).resolves.toBeNull();

    expect(warn).toHaveBeenCalledWith('同步脉冲服务触发失败，跳过本次脉冲', error);
  });

  it('drops a pulse result when readiness is lost before trigger resolves', async () => {
    const { controller, setDestroyed, trigger } = createController();
    let resolveTrigger: ((result: { status: 'success' }) => void) | undefined;
    trigger.mockReturnValueOnce(new Promise(resolve => {
      resolveTrigger = resolve;
    }));

    const result = controller.trigger('focus-entry');
    setDestroyed(true);
    expect(resolveTrigger).toBeDefined();
    resolveTrigger?.({ status: 'success' });

    await expect(result).resolves.toBeNull();
  });

  it('deduplicates concurrent trigger attempts for the same reason', async () => {
    const { controller, trigger } = createController();
    let resolveTrigger: ((result: { status: 'success' }) => void) | undefined;
    trigger.mockReturnValueOnce(new Promise(resolve => {
      resolveTrigger = resolve;
    }));

    const first = controller.trigger('visible');
    const second = controller.trigger('visible');

    expect(trigger).toHaveBeenCalledTimes(1);
    expect(resolveTrigger).toBeDefined();
    resolveTrigger?.({ status: 'success' });

    await expect(first).resolves.toEqual({ status: 'success' });
    await expect(second).resolves.toEqual({ status: 'success' });
  });

  it('clears pending trigger dedupe and drops stale results when lifecycle is destroyed', async () => {
    const { controller, trigger } = createController();
    let resolveStaleTrigger: ((result: { status: 'success' }) => void) | undefined;
    trigger
      .mockReturnValueOnce(new Promise(resolve => {
        resolveStaleTrigger = resolve;
      }))
      .mockResolvedValueOnce({ status: 'success' });

    const stale = controller.trigger('visible');
    controller.destroy();

    const fresh = controller.trigger('visible');

    expect(trigger).toHaveBeenCalledTimes(2);
    await expect(fresh).resolves.toEqual({ status: 'success' });

    expect(resolveStaleTrigger).toBeDefined();
    resolveStaleTrigger?.({ status: 'success' });
    await expect(stale).resolves.toBeNull();
  });

  it('settles pending trigger callers when lifecycle is destroyed before the engine responds', async () => {
    const { controller, trigger } = createController();
    trigger.mockReturnValueOnce(new Promise(() => undefined));

    const stale = controller.trigger('visible');
    controller.destroy();

    await expect(stale).resolves.toBeNull();
  });

  it('does not warn when an in-flight trigger fails after lifecycle destroy', async () => {
    const { controller, trigger, warn } = createController();
    const triggerError = new Error('late sync pulse failure');
    let rejectTrigger!: (reason?: unknown) => void;
    trigger.mockReturnValueOnce(new Promise((_resolve, reject) => {
      rejectTrigger = reject;
    }));

    const stale = controller.trigger('visible');
    controller.destroy();

    await expect(stale).resolves.toBeNull();
    rejectTrigger(triggerError);
    await Promise.resolve();
    await Promise.resolve();

    expect(warn).not.toHaveBeenCalledWith(
      '同步脉冲服务触发失败，跳过本次脉冲',
      triggerError,
    );
  });

  it('does not let a stale trigger settlement clear a fresh pending trigger after destroy', async () => {
    const { controller, trigger } = createController();
    let resolveStaleTrigger: ((result: { status: 'success' }) => void) | undefined;
    let resolveFreshTrigger: ((result: { status: 'success' }) => void) | undefined;
    trigger
      .mockReturnValueOnce(new Promise(resolve => {
        resolveStaleTrigger = resolve;
      }))
      .mockReturnValueOnce(new Promise(resolve => {
        resolveFreshTrigger = resolve;
      }));

    const stale = controller.trigger('visible');
    controller.destroy();
    const fresh = controller.trigger('visible');

    expect(trigger).toHaveBeenCalledTimes(2);
    expect(resolveStaleTrigger).toBeDefined();
    resolveStaleTrigger?.({ status: 'success' });
    await expect(stale).resolves.toBeNull();

    const duplicate = controller.trigger('visible');

    expect(trigger).toHaveBeenCalledTimes(2);

    expect(resolveFreshTrigger).toBeDefined();
    resolveFreshTrigger?.({ status: 'success' });
    await expect(fresh).resolves.toEqual({ status: 'success' });
    await expect(duplicate).resolves.toEqual({ status: 'success' });
  });

  it('keeps focus-entry lifecycle operations behind controller methods', () => {
    const {
      clearFocusEntrySyncPulseRetry,
      controller,
      resetFocusEntrySyncPulse,
    } = createController();

    controller.resetFocusEntrySyncPulse(false);
    controller.clearFocusEntrySyncPulseRetry();

    expect(resetFocusEntrySyncPulse).toHaveBeenCalledWith(false);
    expect(clearFocusEntrySyncPulseRetry).toHaveBeenCalledTimes(1);
  });
});
