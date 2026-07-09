import { describe, expect, it, vi } from 'vitest';

import type { Task, TaskParkingMeta } from '../models';
import type { ParkingService } from './parking.service';

type MockFunction = ReturnType<typeof vi.fn>;

interface ParkingNoteAndKeepSpecContext {
  getService: () => ParkingService;
  createTask: (overrides?: Partial<Task>) => Task;
  createParkingMeta: (overrides?: Partial<TaskParkingMeta>) => TaskParkingMeta;
  taskMap: Map<string, Task>;
  syncParkedSignals: () => void;
  mockTaskStore: {
    setTask: MockFunction;
  };
  mockTaskOpsAdapter: {
    updateTaskContent: MockFunction;
    updateTaskParkingMeta: MockFunction;
  };
  mockToastService: {
    info: MockFunction;
  };
}

export function registerParkingNoteAndKeepSpecs(context: ParkingNoteAndKeepSpecContext): void {
  describe('P-37: addNote', () => {
    it('添加备注应通过本地 durable 内容写入追加到 content 末尾', async () => {
      const task = context.createTask({
        id: 'note-1',
        content: '原始内容',
        parkingMeta: context.createParkingMeta(),
      });
      context.taskMap.set(task.id, task);
      context.syncParkedSignals();

      await expect(context.getService().addNote('note-1', '这是备注')).resolves.toBe(true);

      const updated = context.taskMap.get('note-1');
      expect(context.mockTaskStore.setTask).not.toHaveBeenCalled();
      expect(context.mockTaskOpsAdapter.updateTaskContent).toHaveBeenCalledWith(
        'note-1',
        expect.stringContaining('这是备注'),
      );
      expect(updated?.content).toContain('原始内容');
      expect(updated?.content).toContain('这是备注');
      expect(updated?.content).toContain('---');
    });

    it('添加备注本地 durable 写入失败时不应直接改 store', async () => {
      const task = context.createTask({
        id: 'note-fail',
        content: '原始内容',
        parkingMeta: context.createParkingMeta(),
      });
      context.taskMap.set(task.id, task);
      context.syncParkedSignals();
      context.mockTaskOpsAdapter.updateTaskContent.mockResolvedValueOnce(false);

      await expect(context.getService().addNote('note-fail', '失败备注')).resolves.toBe(false);

      expect(context.mockTaskStore.setTask).not.toHaveBeenCalled();
      expect(context.taskMap.get('note-fail')?.content).toBe('原始内容');
    });
  });

  describe('keepParked', () => {
    it('keepParked 应刷新 lastVisitedAt 防止衰老', async () => {
      const oldTime = new Date('2026-02-20T00:00:00.000Z').toISOString();
      const task = context.createTask({
        id: 'keep-1',
        parkingMeta: context.createParkingMeta({ lastVisitedAt: oldTime }),
      });
      context.taskMap.set(task.id, task);
      context.syncParkedSignals();

      await expect(context.getService().keepParked('keep-1')).resolves.toBe(true);

      const updated = context.taskMap.get('keep-1');
      expect(updated?.parkingMeta?.lastVisitedAt).not.toBe(oldTime);
      expect(context.mockToastService.info).toHaveBeenCalledWith('已保留，不会被自动清理');
    });

    it('本地 durable 写入失败时不应刷新状态或显示成功提示', async () => {
      const oldTime = new Date('2026-02-20T00:00:00.000Z').toISOString();
      const task = context.createTask({
        id: 'keep-fail',
        parkingMeta: context.createParkingMeta({ lastVisitedAt: oldTime }),
      });
      context.taskMap.set(task.id, task);
      context.syncParkedSignals();
      context.mockTaskOpsAdapter.updateTaskParkingMeta.mockResolvedValueOnce(false);

      await expect(context.getService().keepParked('keep-fail')).resolves.toBe(false);

      expect(context.taskMap.get('keep-fail')?.parkingMeta?.lastVisitedAt).toBe(oldTime);
      expect(context.mockToastService.info).not.toHaveBeenCalledWith('已保留，不会被自动清理');
    });
  });
}
