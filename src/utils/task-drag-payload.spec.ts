import { describe, expect, it } from 'vitest';
import { readTaskDragPayload, writeTaskDragPayload } from './task-drag-payload';

class MockDataTransfer {
  private store = new Map<string, string>();

  setData(format: string, data: string): void {
    this.store.set(format, data);
  }

  getData(format: string): string {
    return this.store.get(format) ?? '';
  }
}

describe('task-drag-payload', () => {
  it('应写入并读出 v1 payload', () => {
    const dataTransfer = new MockDataTransfer() as unknown as DataTransfer;
    writeTaskDragPayload(dataTransfer, {
      v: 1,
      type: 'task',
      taskId: 'task-1',
      projectId: 'project-1',
      source: 'flow',
    });

    expect(readTaskDragPayload(dataTransfer)).toEqual({
      v: 1,
      type: 'task',
      taskId: 'task-1',
      projectId: 'project-1',
      source: 'flow',
      relationHint: null,
      fromProjectId: 'project-1',
    });
  });

  it('应兼容 legacy application/json task 对象', () => {
    const dataTransfer = new MockDataTransfer() as unknown as DataTransfer;
    dataTransfer.setData('application/json', JSON.stringify({ id: 'legacy-task', projectId: 'legacy-project' }));

    expect(readTaskDragPayload(dataTransfer)).toEqual({
      v: 1,
      type: 'task',
      taskId: 'legacy-task',
      projectId: 'legacy-project',
      source: 'dock',
      relationHint: null,
      fromProjectId: 'legacy-project',
    });
  });

  it('应兼容 text/task-id 与 text/plain 回退', () => {
    const fromTaskId = new MockDataTransfer() as unknown as DataTransfer;
    fromTaskId.setData('text/task-id', 'task-via-taskid');
    expect(readTaskDragPayload(fromTaskId)?.taskId).toBe('task-via-taskid');

    const fromPlainText = new MockDataTransfer() as unknown as DataTransfer;
    fromPlainText.setData('text/plain', 'task-via-plain');
    expect(readTaskDragPayload(fromPlainText)?.taskId).toBe('task-via-plain');
  });

  it('无有效数据时返回 null', () => {
    const dataTransfer = new MockDataTransfer() as unknown as DataTransfer;
    dataTransfer.setData('application/json', JSON.stringify({ hello: 'world' }));
    expect(readTaskDragPayload(dataTransfer)).toBeNull();
  });
});
