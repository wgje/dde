import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  createWorkspaceShellStorageEscapeLazyLoadDelegate,
  type WorkspaceShellStorageEscapeLazyLoadDelegate,
} from './workspace-shell-storage-escape-lazy-load-delegate.factory';
import type { WorkspaceShellStorageFailureData } from './workspace-shell-storage-escape.controller';

async function flushMicrotasks(): Promise<void> {
  // 纯微任务多轮排空：轮次覆盖原生/zone-patched Promise 的最深链（thenable 采纳会放大跳数），
  // 不用宏任务 setTimeout —— 共享车道 CPU 饱和时宏任务可能 2s 内不被调度导致超时
  for (let flushRound = 0; flushRound < 25; flushRound += 1) {
    await Promise.resolve();
  }
}

function createController(): WorkspaceShellStorageEscapeLazyLoadDelegate {
  return {
    close: vi.fn(),
    setup: vi.fn(),
    teardown: vi.fn(),
  };
}

function createOptions(overrides: {
  closeStorageEscapeModal?: () => void;
  createStorageEscapeController?: () => Promise<WorkspaceShellStorageEscapeLazyLoadDelegate>;
  warn?: (message: string, error: unknown) => void;
} = {}) {
  return {
    onStorageFailure: vi.fn((callback: (data: WorkspaceShellStorageFailureData) => void) => {
      void callback;
    }),
    getProjects: vi.fn(() => []),
    setStorageEscapeData: vi.fn(),
    openStorageEscapeModalImperative: vi.fn(),
    closeStorageEscapeModal: overrides.closeStorageEscapeModal ?? vi.fn(),
    nowIso: vi.fn(() => '2026-06-12T00:00:00.000Z'),
    warn: overrides.warn ?? vi.fn(),
    createStorageEscapeController: overrides.createStorageEscapeController,
  };
}

describe('createWorkspaceShellStorageEscapeLazyLoadDelegate', () => {
  it('delegates storage escape controller caching to the shared lazy delegate host', () => {
    const source = readFileSync(
      join(__dirname, 'workspace-shell-storage-escape-lazy-load-delegate.controller.ts'),
      'utf8',
    );

    expect(source).toContain('WorkspaceShellLazyDelegateCallHostController');
    expect(source).toContain('createWorkspaceShellStorageEscapeControllerLoader');
    expect(source).not.toContain("import('./workspace-shell-storage-escape.controller')");
    expect(source).not.toContain('new WorkspaceShellStorageEscapeController');
    expect(source).not.toContain('storageEscapePromise');
  });

  it('keeps storage escape lazy-load delegate controller logic out of the factory entry', () => {
    const factorySource = readFileSync(
      join(__dirname, 'workspace-shell-storage-escape-lazy-load-delegate.factory.ts'),
      'utf8',
    );

    expect(factorySource).toContain(
      "from './workspace-shell-storage-escape-lazy-load-delegate.controller'",
    );
    expect(factorySource).not.toContain(
      'class WorkspaceShellStorageEscapeLazyLoadDelegateController',
    );
    expect(factorySource).not.toContain('WorkspaceShellLazyDelegateCallHostController');
    expect(factorySource).not.toContain('createWorkspaceShellStorageEscapeControllerLoader');
  });

  it('loads the storage escape controller only when setup runs', async () => {
    const controller = createController();
    const createStorageEscapeController = vi.fn().mockResolvedValue(controller);
    const delegate = createWorkspaceShellStorageEscapeLazyLoadDelegate(
      createOptions({ createStorageEscapeController }),
    );

    expect(createStorageEscapeController).not.toHaveBeenCalled();

    delegate.setup();
    await flushMicrotasks();

    expect(createStorageEscapeController).toHaveBeenCalledTimes(1);
    expect(controller.setup).toHaveBeenCalledTimes(1);
  });

  it('keeps close synchronous without loading the controller chunk', () => {
    const closeStorageEscapeModal = vi.fn();
    const createStorageEscapeController = vi.fn().mockResolvedValue(createController());
    const delegate = createWorkspaceShellStorageEscapeLazyLoadDelegate(
      createOptions({ closeStorageEscapeModal, createStorageEscapeController }),
    );

    delegate.close();

    expect(closeStorageEscapeModal).toHaveBeenCalledTimes(1);
    expect(createStorageEscapeController).not.toHaveBeenCalled();
  });

  it('warns and allows setup retry when the controller chunk fails', async () => {
    const error = new Error('storage escape chunk missing');
    const controller = createController();
    const createStorageEscapeController = vi.fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(controller);
    const warn = vi.fn();
    const delegate = createWorkspaceShellStorageEscapeLazyLoadDelegate(
      createOptions({ createStorageEscapeController, warn }),
    );

    delegate.setup();
    await flushMicrotasks();
    delegate.setup();
    await flushMicrotasks();

    expect(createStorageEscapeController).toHaveBeenCalledTimes(2);
    expect(controller.setup).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      'Storage escape controller 懒加载失败，已跳过本次注册',
      error,
    );
  });

  it('warns with a setup failure when a loaded controller setup fails', async () => {
    const error = new Error('storage escape setup failed');
    const controller = createController();
    vi.mocked(controller.setup).mockImplementation(() => {
      throw error;
    });
    const warn = vi.fn();
    const delegate = createWorkspaceShellStorageEscapeLazyLoadDelegate(
      createOptions({
        createStorageEscapeController: vi.fn().mockResolvedValue(controller),
        warn,
      }),
    );

    delegate.setup();
    await flushMicrotasks();

    expect(controller.setup).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      'Storage escape controller 注册失败，已跳过本次注册',
      error,
    );
    expect(warn).not.toHaveBeenCalledWith(
      'Storage escape controller 懒加载失败，已跳过本次注册',
      error,
    );
  });

  it('tears down a loaded storage escape controller', async () => {
    const controller = createController();
    const createStorageEscapeController = vi.fn().mockResolvedValue(controller);
    const delegate = createWorkspaceShellStorageEscapeLazyLoadDelegate(
      createOptions({ createStorageEscapeController }),
    );

    delegate.setup();
    await flushMicrotasks();
    delegate.teardown();

    expect(controller.teardown).toHaveBeenCalledTimes(1);
  });

  it('does not run setup after teardown while the controller chunk is still loading', async () => {
    let resolveController!: (controller: WorkspaceShellStorageEscapeLazyLoadDelegate) => void;
    const controllerPromise = new Promise<WorkspaceShellStorageEscapeLazyLoadDelegate>(
      resolve => {
        resolveController = resolve;
      },
    );
    const controller = createController();
    const createStorageEscapeController = vi.fn(() => controllerPromise);
    const delegate = createWorkspaceShellStorageEscapeLazyLoadDelegate(
      createOptions({ createStorageEscapeController }),
    );

    delegate.setup();
    delegate.teardown();
    resolveController(controller);
    await flushMicrotasks();

    expect(controller.setup).not.toHaveBeenCalled();
    expect(controller.teardown).toHaveBeenCalledTimes(1);
  });
});
