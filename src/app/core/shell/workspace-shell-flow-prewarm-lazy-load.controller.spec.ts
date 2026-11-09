import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  createWorkspaceShellFlowPrewarmLazyLoadController,
  type WorkspaceShellFlowPrewarmDelegate,
} from './workspace-shell-flow-prewarm-lazy-load.controller';
import { readWorkspaceShellSource } from './workspace-shell-source.spec-helpers';

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, reject, resolve };
}

function readFlowPrewarmLazyLoadControllerSource(): string {
  return readFileSync(
    join(process.cwd(), 'src/app/core/shell/workspace-shell-flow-prewarm-lazy-load.controller.ts'),
    'utf8',
  );
}

describe('createWorkspaceShellFlowPrewarmLazyLoadController', () => {
  it('keeps the concrete flow prewarm controller out of the workspace shell eager path', () => {
    const source = readWorkspaceShellSource();

    expect(source).not.toContain('createWorkspaceShellFlowPrewarmLazyLoadController');
    expect(source).not.toContain('WorkspaceShellFlowPrewarmController');
    expect(source).not.toContain("workspace-shell-flow-prewarm.controller'");
  });

  it('delegates concrete flow prewarm controller loading to the loader factory', () => {
    const source = readFlowPrewarmLazyLoadControllerSource();

    expect(source).toContain('createWorkspaceShellFlowPrewarmControllerLoader');
    expect(source).not.toContain("import('./workspace-shell-flow-prewarm.controller')");
    expect(source).not.toContain('new WorkspaceShellFlowPrewarmController');
  });

  it('keeps lazy host state inside the flow prewarm lazy-load controller', () => {
    const source = readFlowPrewarmLazyLoadControllerSource();
    const factoryBody = source.match(
      /export function createWorkspaceShellFlowPrewarmLazyLoadController[\s\S]*?\n}\n/,
    )?.[0];

    expect(source).toContain('export class WorkspaceShellFlowPrewarmLazyLoadController');
    expect(factoryBody).toContain('return new WorkspaceShellFlowPrewarmLazyLoadController(');
    expect(factoryBody).not.toContain('WorkspaceShellLazyDelegateCallHostController');
  });

  it('loads the flow prewarm controller on first prewarm request', async () => {
    const delegate: WorkspaceShellFlowPrewarmDelegate = {
      scheduleAggressivePrewarm: vi.fn(),
      teardown: vi.fn(),
    };
    const createController = vi.fn().mockResolvedValue(delegate);
    const controller = createWorkspaceShellFlowPrewarmLazyLoadController({
      isDestroyed: () => false,
      prewarmFlow: () => Promise.resolve({ warmed: true }),
      warn: vi.fn(),
    }, createController);

    controller.scheduleAggressivePrewarm('after-view-init');
    await vi.dynamicImportSettled();

    expect(createController).toHaveBeenCalledTimes(1);
    expect(delegate.scheduleAggressivePrewarm).toHaveBeenCalledWith('after-view-init');
  });

  it('tears down a pending lazy controller after it resolves', async () => {
    const deferred = createDeferred<WorkspaceShellFlowPrewarmDelegate>();
    const delegate: WorkspaceShellFlowPrewarmDelegate = {
      scheduleAggressivePrewarm: vi.fn(),
      teardown: vi.fn(),
    };
    const controller = createWorkspaceShellFlowPrewarmLazyLoadController({
      isDestroyed: () => false,
      prewarmFlow: () => Promise.resolve({ warmed: true }),
      warn: vi.fn(),
    }, vi.fn(() => deferred.promise));

    controller.scheduleAggressivePrewarm('after-view-init');
    controller.teardown();
    deferred.resolve(delegate);
    await vi.dynamicImportSettled();

    expect(delegate.scheduleAggressivePrewarm).not.toHaveBeenCalled();
    expect(delegate.teardown).toHaveBeenCalledTimes(1);
  });

  it('reports lazy-load failures without throwing into shell lifecycle', async () => {
    const warn = vi.fn();
    const controller = createWorkspaceShellFlowPrewarmLazyLoadController({
      isDestroyed: () => false,
      prewarmFlow: () => Promise.resolve({ warmed: true }),
      warn,
    }, vi.fn().mockRejectedValue(new Error('load failed')));

    controller.scheduleAggressivePrewarm('after-view-init');
    await vi.dynamicImportSettled();

    expect(warn).toHaveBeenCalledWith(
      'Flow 预热控制器懒加载失败，已跳过本次预热',
      expect.any(Error),
    );
  });
});
