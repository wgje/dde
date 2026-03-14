import { describe, expect, it } from 'vitest';
import { readTaskDragPayload, writeTaskDragPayload } from './task-drag-payload';

/**
 * Minimal mock of the DataTransfer interface.
 * Only getData/setData are exercised by the payload helpers;
 * remaining stubs prevent future test failures if the surface grows.
 */
class MockDataTransfer {
  private store = new Map<string, string>();
  readonly items = [] as unknown as DataTransferItemList;
  readonly files = [] as unknown as FileList;
  dropEffect: DataTransfer['dropEffect'] = 'none';
  effectAllowed: DataTransfer['effectAllowed'] = 'uninitialized';
  readonly types: string[] = [];

  setData(format: string, data: string): void {
    this.store.set(format, data);
    if (!this.types.includes(format)) {
      (this.types as string[]).push(format);
    }
  }

  getData(format: string): string {
    return this.store.get(format) ?? '';
  }

  clearData(format?: string): void {
    if (format) {
      this.store.delete(format);
    } else {
      this.store.clear();
    }
  }

  setDragImage(_img: Element, _xOffset: number, _yOffset: number): void {
    // no-op in tests
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
      laneHint: null,
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
      laneHint: null,
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
