import { describe, expect, it, vi } from 'vitest';

import { FlowTaskDetailPlannerSaveController } from './flow-task-detail-planner-save.controller';

function createHarness() {
  let activeTaskId: string | null = 'task-a';
  let detailOpen = true;
  const markForCheck = vi.fn();
  const controller = new FlowTaskDetailPlannerSaveController({
    isScopeActive: taskId => detailOpen && activeTaskId === taskId,
    markForCheck,
  });
  controller.setScope('task-a');

  return {
    controller,
    markForCheck,
    setActiveTaskId: (value: string | null) => {
      activeTaskId = value;
    },
    setDetailOpen: (value: boolean) => {
      detailOpen = value;
    },
  };
}

describe('FlowTaskDetailPlannerSaveController', () => {
  it('publishes saving then idle for the active task', async () => {
    let resolveSave!: (saved: boolean) => void;
    const { controller, markForCheck } = createHarness();

    const saving = controller.persist('task-a', () => new Promise(resolve => {
      resolveSave = resolve;
    }));
    expect(controller.state()).toBe('saving');

    resolveSave(true);
    await expect(saving).resolves.toBe(true);

    expect(controller.state()).toBe('idle');
    expect(markForCheck).toHaveBeenCalledTimes(1);
  });

  it('converts rejected saves into a failed result and state', async () => {
    const { controller } = createHarness();

    await expect(controller.persist('task-a', async () => {
      throw new Error('save failed');
    })).resolves.toBe(false);

    expect(controller.state()).toBe('failed');
  });

  it('keeps the newest request state when an older save finishes late', async () => {
    let resolveFirst!: (saved: boolean) => void;
    let resolveSecond!: (saved: boolean) => void;
    const { controller } = createHarness();
    const first = controller.persist('task-a', () => new Promise(resolve => {
      resolveFirst = resolve;
    }));
    const second = controller.persist('task-a', () => new Promise(resolve => {
      resolveSecond = resolve;
    }));

    resolveSecond(false);
    await second;
    expect(controller.state()).toBe('failed');

    resolveFirst(true);
    await first;
    expect(controller.state()).toBe('failed');
  });

  it('invalidates an in-flight save when the detail scope changes', async () => {
    let resolveSave!: (saved: boolean) => void;
    const { controller, setActiveTaskId } = createHarness();
    const saving = controller.persist('task-a', () => new Promise(resolve => {
      resolveSave = resolve;
    }));

    setActiveTaskId('task-b');
    controller.setScope('task-b');
    expect(controller.state()).toBe('idle');

    resolveSave(false);
    await saving;
    expect(controller.state()).toBe('idle');
  });

  it('does not expose saving state for an inactive task', async () => {
    const { controller, setDetailOpen } = createHarness();
    setDetailOpen(false);

    await expect(controller.persist('task-a', async () => true)).resolves.toBe(true);

    expect(controller.state()).toBe('idle');
  });

  it('invalidates state when destroyed', () => {
    const { controller } = createHarness();
    controller.destroy();

    expect(controller.state()).toBe('idle');
  });
});
