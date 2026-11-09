import { afterEach, describe, expect, it, vi } from 'vitest';

import { FlowDropOperationGuard } from './flow-drag-drop-operation-guard';

describe('FlowDropOperationGuard', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps the drop claim until async position persistence settles', async () => {
    vi.useFakeTimers();
    const guard = new FlowDropOperationGuard();
    let resolvePersist!: () => void;
    const persistPromise = new Promise<void>(resolve => {
      resolvePersist = resolve;
    });
    const updateTaskPosition = vi.fn(() => persistPromise);
    const insertInfo = { parentId: 'parent-1' };
    const docPoint = { x: 20, y: 40 };
    const firstClaim = guard.claim('task-1', insertInfo, docPoint);

    guard.schedulePositionUpdate(updateTaskPosition, 'task-1', docPoint, 100, firstClaim.key);
    await vi.advanceTimersByTimeAsync(100);

    expect(updateTaskPosition).toHaveBeenCalledWith('task-1', 20, 40);
    expect(guard.claim('task-1', insertInfo, docPoint).claimed).toBe(false);

    resolvePersist();
    await vi.runAllTimersAsync();
    await persistPromise;

    expect(guard.claim('task-1', insertInfo, docPoint).claimed).toBe(true);
  });

  it('retries a false position persistence result before releasing the drop claim', async () => {
    vi.useFakeTimers();
    const guard = new FlowDropOperationGuard();
    const updateTaskPosition = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const insertInfo = { parentId: 'parent-1' };
    const docPoint = { x: 20, y: 40 };
    const firstClaim = guard.claim('task-1', insertInfo, docPoint);

    guard.schedulePositionUpdate(updateTaskPosition, 'task-1', docPoint, 100, firstClaim.key);
    await vi.advanceTimersByTimeAsync(100);

    expect(updateTaskPosition).toHaveBeenCalledWith('task-1', 20, 40);
    expect(guard.claim('task-1', insertInfo, docPoint).claimed).toBe(false);

    await vi.advanceTimersByTimeAsync(1000);

    expect(updateTaskPosition).toHaveBeenCalledTimes(2);
    expect(guard.claim('task-1', insertInfo, docPoint).claimed).toBe(true);
  });

  it('retries a rejected position persistence result before releasing the drop claim', async () => {
    vi.useFakeTimers();
    const guard = new FlowDropOperationGuard();
    const updateTaskPosition = vi.fn()
      .mockRejectedValueOnce(new Error('local persistence failed'))
      .mockResolvedValueOnce(true);
    const insertInfo = { parentId: 'parent-1' };
    const docPoint = { x: 20, y: 40 };
    const firstClaim = guard.claim('task-1', insertInfo, docPoint);

    guard.schedulePositionUpdate(updateTaskPosition, 'task-1', docPoint, 100, firstClaim.key);
    await vi.advanceTimersByTimeAsync(100);

    expect(updateTaskPosition).toHaveBeenCalledWith('task-1', 20, 40);
    expect(guard.claim('task-1', insertInfo, docPoint).claimed).toBe(false);

    await vi.advanceTimersByTimeAsync(1000);

    expect(updateTaskPosition).toHaveBeenCalledTimes(2);
    expect(guard.claim('task-1', insertInfo, docPoint).claimed).toBe(true);
  });
});
