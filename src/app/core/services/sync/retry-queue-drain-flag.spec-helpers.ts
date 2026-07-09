import { expect, it, vi } from 'vitest';

import type { Project, Task } from '../../../../models';
import type { RetryOperationHandler, RetryQueueService } from './retry-queue.service';

type MockFn = ReturnType<typeof vi.fn>;

const SYNC_OPERATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[45][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface RetryQueueDrainFlagSpecContext {
  service: RetryQueueService;
  handler: RetryOperationHandler;
  toastMock: {
    error: MockFn;
  };
  setOnline(value: boolean): void;
  createTask(label: string): Task;
  createProject(label: string): Project;
}

export function registerRetryQueueDrainFlagSpecs(
  getContext: () => RetryQueueDrainFlagSpecContext,
): void {
  it('仅项目回放成功见底时也应记录 successful drain flag', async () => {
    const { service, handler, setOnline, createProject } = getContext();
    const project = createProject('successful-drain-project');

    service.add('project', 'upsert', project, undefined, 'test-user');
    setOnline(true);

    const result = await service.processQueueSlice({ maxItems: 1, maxDurationMs: 1000 });

    expect(result.completed).toBe(true);
    expect(handler.pushProject).toHaveBeenCalledWith(
      project,
      'test-user',
      undefined,
      undefined,
      expect.stringMatching(SYNC_OPERATION_ID_PATTERN),
    );
    expect(service.consumeSuccessfulDrainFlag()).toBe(true);
  });

  it('新重试项入队时应清除旧的 successful drain flag', async () => {
    const { service, setOnline, createProject, createTask } = getContext();
    const project = createProject('successful-drain-reset');

    service.add('project', 'upsert', project, undefined, 'test-user');
    setOnline(true);

    await service.processQueueSlice({ maxItems: 1, maxDurationMs: 1000 });
    expect(service.hasSuccessfulDrainFlag()).toBe(true);

    service.add('task', 'upsert', createTask('reset-flag'), 'p-1', 'test-user');

    expect(service.hasSuccessfulDrainFlag()).toBe(false);
  });

  it('Layer 5: 混合"成功 + 终态拒绝"场景应同时记录 success 与 terminal-conflict 双标记', async () => {
    const { service, handler, setOnline, createProject, createTask } = getContext();
    const project = createProject('layer5-mixed-success');
    const orphanTask = createTask('layer5-mixed-terminal');

    service.add('project', 'upsert', project, undefined, 'test-user');
    service.add('task', 'upsert', orphanTask, undefined, 'test-user');
    setOnline(true);

    const result = await service.processQueueSlice({ maxItems: 10, maxDurationMs: 1000 });

    expect(result.completed).toBe(true);
    expect(handler.pushProject).toHaveBeenCalledWith(
      project,
      'test-user',
      undefined,
      undefined,
      expect.stringMatching(SYNC_OPERATION_ID_PATTERN),
    );
    expect(service.hasSuccessfulDrainFlag()).toBe(true);
    expect(service.hasTerminalConflictDrainFlag()).toBe(true);
  });

  it('Layer 5: consumeTerminalConflictDrainFlag 读取后应自动复位', async () => {
    const { service, setOnline, createTask } = getContext();
    const orphanTask = createTask('layer5-consume-terminal');
    service.add('task', 'upsert', orphanTask, undefined, 'test-user');
    setOnline(true);

    await service.processQueueSlice({ maxItems: 1, maxDurationMs: 1000 });
    expect(service.hasTerminalConflictDrainFlag()).toBe(true);
    expect(service.consumeTerminalConflictDrainFlag()).toBe(true);
    expect(service.hasTerminalConflictDrainFlag()).toBe(false);
  });

  it('Layer 5: 纯终态拒绝场景（无成功 replay）不应触发 successful drain，但应触发 terminal-conflict', async () => {
    const { service, setOnline, createTask } = getContext();
    const orphanTask = createTask('layer5-only-terminal');
    service.add('task', 'upsert', orphanTask, undefined, 'test-user');
    setOnline(true);

    await service.processQueueSlice({ maxItems: 1, maxDurationMs: 1000 });

    expect(service.hasSuccessfulDrainFlag()).toBe(false);
    expect(service.hasTerminalConflictDrainFlag()).toBe(true);
  });

  it('缺少 updatedAt 的 task upsert 重试项应在回放前终止清理', async () => {
    const { service, handler, toastMock, setOnline, createTask } = getContext();
    const staleTask = createTask('missing-updated-at-retry');
    delete staleTask.updatedAt;

    service.add('task', 'upsert', staleTask, 'project-missing-updated-at', 'test-user');
    setOnline(true);

    const result = await service.processQueueSlice({ maxItems: 1, maxDurationMs: 1000 });

    expect(result.completed).toBe(true);
    expect(handler.pushTask).not.toHaveBeenCalled();
    expect(service.length).toBe(0);
    expect(service.hasSuccessfulDrainFlag()).toBe(false);
    expect(service.hasTerminalConflictDrainFlag()).toBe(true);
    expect(toastMock.error).not.toHaveBeenCalled();
  });
}
