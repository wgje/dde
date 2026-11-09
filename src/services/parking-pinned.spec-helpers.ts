import { describe, expect, it, vi } from 'vitest';

import type { Task, TaskParkingMeta } from '../models';
import type { ParkingService } from './parking.service';

type MockFunction = ReturnType<typeof vi.fn>;

interface ParkingPinnedSpecContext {
  getService: () => ParkingService;
  createTask: (overrides?: Partial<Task>) => Task;
  createParkingMeta: (overrides?: Partial<TaskParkingMeta>) => TaskParkingMeta;
  taskMap: Map<string, Task>;
  syncParkedSignals: () => void;
  mockTaskOpsAdapter: {
    updateTaskParkingMeta: MockFunction;
  };
}

export function registerParkingPinnedSpecs(context: ParkingPinnedSpecContext): void {
  describe('P-32: pinned 豁免', () => {
    it('pinned 任务不应被衰老清理', async () => {
      const pinnedTask = context.createTask({
        id: 'pinned-1',
        parkingMeta: context.createParkingMeta({ pinned: true }),
      });
      context.taskMap.set(pinnedTask.id, pinnedTask);
      context.syncParkedSignals();

      await runEvictionCheck(context.getService());

      expect(context.taskMap.get('pinned-1')?.parkingMeta).toBeTruthy();
      expect(context.getService().pendingNotices().length).toBe(0);
    });

    it('togglePinned 应通过本地 durable 写入切换 pinned 状态', async () => {
      const task = context.createTask({
        id: 'toggle-pin',
        parkingMeta: context.createParkingMeta({ pinned: false }),
      });
      context.taskMap.set(task.id, task);
      context.syncParkedSignals();

      await expect(context.getService().togglePinned('toggle-pin')).resolves.toBe(true);
      expect(context.taskMap.get('toggle-pin')?.parkingMeta?.pinned).toBe(true);

      await expect(context.getService().togglePinned('toggle-pin')).resolves.toBe(true);
      expect(context.taskMap.get('toggle-pin')?.parkingMeta?.pinned).toBe(false);
    });

    it('togglePinned 本地 durable 写入失败时不应改变 pinned 状态', async () => {
      const task = context.createTask({
        id: 'toggle-pin-fail',
        parkingMeta: context.createParkingMeta({ pinned: false }),
      });
      context.taskMap.set(task.id, task);
      context.syncParkedSignals();
      context.mockTaskOpsAdapter.updateTaskParkingMeta.mockResolvedValueOnce(false);

      await expect(context.getService().togglePinned('toggle-pin-fail')).resolves.toBe(false);

      expect(context.taskMap.get('toggle-pin-fail')?.parkingMeta?.pinned).toBe(false);
    });
  });
}

function runEvictionCheck(service: ParkingService): Promise<void> {
  return (service as unknown as { runEvictionCheck: () => Promise<void> }).runEvictionCheck();
}
