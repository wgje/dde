import { describe, expect, it, vi } from 'vitest';

import { WorkspaceShellSyncPulseTriggerController } from './workspace-shell-sync-pulse-trigger.controller';

const successResult = { status: 'success' as const };

function createController() {
  let ready = true;
  const onTriggerStarted = vi.fn();
  const trigger = vi.fn();
  const warn = vi.fn();
  const controller = new WorkspaceShellSyncPulseTriggerController({
    isReady: () => ready,
    trigger,
    onTriggerStarted,
    warn,
  });

  return {
    controller,
    onTriggerStarted,
    setReady: (value: boolean) => {
      ready = value;
    },
    trigger,
    warn,
  };
}

describe('WorkspaceShellSyncPulseTriggerController', () => {
  it('skips trigger calls while sync pulse readiness is false', async () => {
    const { controller, setReady, trigger } = createController();
    setReady(false);

    await expect(controller.trigger('manual')).resolves.toBeNull();

    expect(trigger).not.toHaveBeenCalled();
  });

  it('deduplicates in-flight triggers for the same reason', async () => {
    const { controller, onTriggerStarted, trigger } = createController();
    let resolveTrigger!: (result: typeof successResult) => void;
    trigger.mockImplementation(() => new Promise<typeof successResult>(resolve => {
      resolveTrigger = resolve;
    }));

    const first = controller.trigger('manual');
    const second = controller.trigger('manual');

    expect(trigger).toHaveBeenCalledTimes(1);
    expect(onTriggerStarted).toHaveBeenCalledTimes(1);

    resolveTrigger(successResult);

    await expect(first).resolves.toEqual(successResult);
    await expect(second).resolves.toEqual(successResult);
  });

  it('allows different trigger reasons to run independently', async () => {
    const { controller, trigger } = createController();
    trigger.mockResolvedValue(successResult);

    await Promise.all([
      controller.trigger('manual'),
      controller.trigger('online'),
    ]);

    expect(trigger).toHaveBeenCalledTimes(2);
    expect(trigger).toHaveBeenCalledWith('manual');
    expect(trigger).toHaveBeenCalledWith('online');
  });

  it('isolates synchronously thrown trigger failures', async () => {
    const { controller, trigger, warn } = createController();
    const error = new Error('trigger threw');
    trigger.mockImplementation(() => {
      throw error;
    });

    await expect(controller.trigger('focus')).resolves.toBeNull();

    expect(warn).toHaveBeenCalledWith('同步脉冲服务触发失败，跳过本次脉冲', error);
  });

  it('isolates rejected trigger failures while the generation is current', async () => {
    const { controller, trigger, warn } = createController();
    const error = new Error('trigger rejected');
    trigger.mockRejectedValue(error);

    await expect(controller.trigger('visible')).resolves.toBeNull();

    expect(warn).toHaveBeenCalledWith('同步脉冲服务触发失败，跳过本次脉冲', error);
  });

  it('returns null when readiness becomes false before trigger settlement', async () => {
    const { controller, setReady, trigger } = createController();
    let resolveTrigger!: (result: typeof successResult) => void;
    trigger.mockImplementation(() => new Promise<typeof successResult>(resolve => {
      resolveTrigger = resolve;
    }));

    const result = controller.trigger('pageshow');
    setReady(false);
    resolveTrigger(successResult);

    await expect(result).resolves.toBeNull();
  });

  it('reset resolves pending triggers as null and ignores late results', async () => {
    const { controller, trigger } = createController();
    let resolveTrigger!: (result: typeof successResult) => void;
    trigger.mockImplementationOnce(() => new Promise<typeof successResult>(resolve => {
      resolveTrigger = resolve;
    })).mockResolvedValueOnce(successResult);

    const pending = controller.trigger('heartbeat');
    controller.reset();

    await expect(pending).resolves.toBeNull();
    expect(controller.hasPendingTriggers()).toBe(false);

    resolveTrigger(successResult);
    await Promise.resolve();
    await expect(controller.trigger('heartbeat')).resolves.toEqual(successResult);
    expect(trigger).toHaveBeenCalledTimes(2);
  });

  it('isolates warning sink failures', async () => {
    const { controller, trigger, warn } = createController();
    trigger.mockImplementation(() => {
      throw new Error('trigger threw');
    });
    warn.mockImplementation(() => {
      throw new Error('warning sink failed');
    });

    await expect(controller.trigger('manual')).resolves.toBeNull();
  });
});
