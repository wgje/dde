import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { runTaskDurableFieldMutation } from './task-operation-durable-field.helpers';

function readTaskOperationAdapterSource(): string {
  return fs.readFileSync(
    path.join(process.cwd(), 'src/services/task-operation-adapter.service.ts'),
    'utf8',
  ).replace(/\r\n/g, '\n');
}

function findAdapterMethodSource(source: string, methodName: string): string | undefined {
  const escapedMethodName = methodName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return source.match(new RegExp(`\\n  (?:async\\s+)?${escapedMethodName}\\([\\s\\S]*?\\n  }\\n`))?.[0];
}

describe('task-operation-durable-field.helpers', () => {
  it('blocked mutation 不会标记编辑或执行持久化', async () => {
    const runtime = {
      blockLocalMutation: vi.fn(() => true),
      markContentEditing: vi.fn(),
      warn: vi.fn(),
    };
    const mutate = vi.fn().mockResolvedValue(true);

    const saved = await runTaskDurableFieldMutation({
      actionLabel: '更新任务优先级',
      failureMessage: '任务优先级本地持久化失败，未提交 UI 更新',
      failureData: { taskId: 'task-1' },
      mutate,
    }, runtime);

    expect(saved).toBe(false);
    expect(runtime.markContentEditing).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
  });

  it('durable mutation 成功时标记 content 编辑并返回 true', async () => {
    const runtime = {
      blockLocalMutation: vi.fn(() => false),
      markContentEditing: vi.fn(),
      warn: vi.fn(),
    };

    const saved = await runTaskDurableFieldMutation({
      actionLabel: '更新任务标签',
      failureMessage: '任务标签本地持久化失败，未提交 UI 更新',
      failureData: { taskId: 'task-1' },
      mutate: vi.fn().mockResolvedValue(true),
    }, runtime);

    expect(saved).toBe(true);
    expect(runtime.markContentEditing).toHaveBeenCalledOnce();
    expect(runtime.warn).not.toHaveBeenCalled();
  });

  it('durable mutation 失败时记录原始失败上下文', async () => {
    const runtime = {
      blockLocalMutation: vi.fn(() => false),
      markContentEditing: vi.fn(),
      warn: vi.fn(),
    };

    const saved = await runTaskDurableFieldMutation({
      actionLabel: '更新任务等待时长',
      failureMessage: '任务等待时长本地持久化失败，未提交 UI 更新',
      failureData: { taskId: 'task-1', waitMinutes: 15 },
      mutate: vi.fn().mockResolvedValue(false),
    }, runtime);

    expect(saved).toBe(false);
    expect(runtime.warn).toHaveBeenCalledWith(
      '任务等待时长本地持久化失败，未提交 UI 更新',
      { taskId: 'task-1', waitMinutes: 15 },
    );
  });

  it('TaskOperationAdapterService 的待办写入复用 durable field helper', () => {
    const source = readTaskOperationAdapterSource();
    const addTodoItem = findAdapterMethodSource(source, 'addTodoItem');

    expect(addTodoItem).toContain('runTaskDurableFieldMutation');
  });

  it('TaskOperationAdapterService 的内容和标题写入复用 durable field helper', () => {
    const source = readTaskOperationAdapterSource();
    const updateTaskContent = findAdapterMethodSource(source, 'updateTaskContent');
    const updateTaskTitle = findAdapterMethodSource(source, 'updateTaskTitle');

    expect(updateTaskContent).toContain('runTaskDurableFieldMutation');
    expect(updateTaskTitle).toContain('runTaskDurableFieldMutation');
  });

  it('TaskOperationAdapterService 的附件和注意事项写入复用 durable field helper', () => {
    const source = readTaskOperationAdapterSource();
    const updateTaskAttachments = findAdapterMethodSource(source, 'updateTaskAttachments');
    const addTaskAttachment = findAdapterMethodSource(source, 'addTaskAttachment');
    const removeTaskAttachment = findAdapterMethodSource(source, 'removeTaskAttachment');
    const updateTaskAttentionItems = findAdapterMethodSource(source, 'updateTaskAttentionItems');

    expect(updateTaskAttachments).toContain('runTaskDurableFieldMutation');
    expect(addTaskAttachment).toContain('runTaskDurableFieldMutation');
    expect(removeTaskAttachment).toContain('runTaskDurableFieldMutation');
    expect(updateTaskAttentionItems).toContain('runTaskDurableFieldMutation');
  });
});
