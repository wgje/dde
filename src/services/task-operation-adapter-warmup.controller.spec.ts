import { describe, expect, it, vi } from 'vitest';

import { TaskOperationAdapterWarmupController } from './task-operation-adapter-warmup.controller';

describe('TaskOperationAdapterWarmupController', () => {
  it('warmup 应触发轻量依赖访问', async () => {
    const runtime = {
      activeProjectId: vi.fn(() => 'project-1'),
      isEditing: vi.fn(() => false),
      hasPendingLocalChanges: vi.fn(() => false),
      clearHistory: vi.fn(),
    };
    const controller = new TaskOperationAdapterWarmupController(runtime);

    await expect(controller.warmup()).resolves.toBeUndefined();

    expect(runtime.activeProjectId).toHaveBeenCalledTimes(1);
    expect(runtime.isEditing).toHaveBeenCalledTimes(1);
    expect(runtime.hasPendingLocalChanges).toHaveBeenCalledTimes(1);
    expect(runtime.clearHistory).toHaveBeenCalledTimes(1);
  });

  it('warmup 进行中应复用同一个 promise，完成后允许下一轮预热', async () => {
    let release!: () => void;
    const runtime = {
      activeProjectId: vi.fn(() => 'project-1'),
      isEditing: vi.fn(() => false),
      hasPendingLocalChanges: vi.fn(() => false),
      clearHistory: vi.fn(() => new Promise<void>(resolve => {
        release = resolve;
      })),
    };
    const controller = new TaskOperationAdapterWarmupController(runtime);

    const first = controller.warmup();
    const second = controller.warmup();
    expect(second).toBe(first);
    await Promise.resolve();
    expect(runtime.activeProjectId).toHaveBeenCalledTimes(1);

    release();
    await first;

    await controller.warmup();
    expect(runtime.activeProjectId).toHaveBeenCalledTimes(2);
    expect(runtime.clearHistory).toHaveBeenCalledTimes(2);
  });
});
