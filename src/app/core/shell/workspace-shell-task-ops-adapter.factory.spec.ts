import type { Injector } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';

import { TaskOperationAdapterService } from '../../../services/task-operation-adapter.service';

import { readWorkspaceShellSource } from './workspace-shell-source.spec-helpers';

type WorkspaceShellTaskOpsAdapterFactory = (options: {
  readonly injector: Pick<Injector, 'get'>;
}) => {
  readonly warmup: () => Promise<unknown>;
};

async function loadFactory(): Promise<{
  createWorkspaceShellTaskOpsAdapter?: WorkspaceShellTaskOpsAdapterFactory;
}> {
  const modulePath = './workspace-shell-task-ops-adapter.factory';
  const module = await import(/* @vite-ignore */ modulePath)
    .catch(() => ({}));

  return module as {
    createWorkspaceShellTaskOpsAdapter?: WorkspaceShellTaskOpsAdapterFactory;
  };
}

describe('workspace shell task ops adapter', () => {
  it('lazily resolves TaskOperationAdapterService for startup warmup', async () => {
    const { createWorkspaceShellTaskOpsAdapter } = await loadFactory();

    expect(createWorkspaceShellTaskOpsAdapter).toEqual(expect.any(Function));

    const service = { warmup: vi.fn(async () => 'ready') };
    const injector = {
      get: vi.fn(() => service),
    } as unknown as Pick<Injector, 'get'>;

    const taskOpsAdapter = createWorkspaceShellTaskOpsAdapter?.({ injector });

    expect(injector.get).not.toHaveBeenCalled();
    await expect(taskOpsAdapter?.warmup()).resolves.toBe('ready');
    expect(injector.get).toHaveBeenCalledWith(TaskOperationAdapterService);
    expect(service.warmup).toHaveBeenCalledTimes(1);
  });

  it('keeps TaskOperationAdapterService resolution outside WorkspaceShellComponent', () => {
    const source = readWorkspaceShellSource();

    expect(source).not.toContain('createWorkspaceShellTaskOpsAdapter');
    expect(source).not.toContain('private readonly taskOpsAdapter =');
    expect(source).not.toContain('TaskOperationAdapterService');
    expect(source).not.toContain('this.injector.get(TaskOperationAdapterService)');
  });
});
