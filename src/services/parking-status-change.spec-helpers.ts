import { describe, expect, it } from 'vitest';

import type { Task, TaskParkingMeta } from '../models';
import type { ParkingService } from './parking.service';

interface ParkingStatusChangeSpecContext {
  getService: () => ParkingService;
  createTask: (overrides?: Partial<Task>) => Task;
  createParkingMeta: (overrides?: Partial<TaskParkingMeta>) => TaskParkingMeta;
  taskMap: Map<string, Task>;
  syncParkedSignals: () => void;
}

export function registerParkingStatusChangeSpecs(context: ParkingStatusChangeSpecContext): void {
  describe('P-30: handleTaskStatusChange', () => {
    it('任务标记完成时应清除 parkingMeta', () => {
      const task = context.createTask({
        id: 'complete-1',
        parkingMeta: context.createParkingMeta({ state: 'parked' }),
      });
      context.taskMap.set(task.id, task);
      context.syncParkedSignals();

      context.getService().handleTaskStatusChange('complete-1', 'completed');

      expect(context.taskMap.get('complete-1')?.parkingMeta).toBeUndefined();
    });

    it('任务归档时应清除 parkingMeta', () => {
      const task = context.createTask({
        id: 'archive-1',
        parkingMeta: context.createParkingMeta({ state: 'parked' }),
      });
      context.taskMap.set(task.id, task);
      context.syncParkedSignals();

      context.getService().handleTaskStatusChange('archive-1', 'archived');

      expect(context.taskMap.get('archive-1')?.parkingMeta).toBeUndefined();
    });

    it('非终态状态变更不应影响 parkingMeta', () => {
      const task = context.createTask({
        id: 'status-other',
        parkingMeta: context.createParkingMeta({ state: 'parked' }),
      });
      context.taskMap.set(task.id, task);
      context.syncParkedSignals();

      context.getService().handleTaskStatusChange('status-other', 'active');

      expect(context.taskMap.get('status-other')?.parkingMeta).toBeTruthy();
    });
  });
}
