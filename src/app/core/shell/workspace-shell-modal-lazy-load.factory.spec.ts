import { signal } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  createWorkspaceShellModalLazyLoadDelegates,
  type WorkspaceShellModalLazyLoadFactoryOptions,
} from './workspace-shell-modal-lazy-load.factory';
import type { ModalCallbacks } from '../../../services/workspace-modal-coordinator.service';
import type { WorkspaceShellModalCoordinatorLike } from './workspace-shell-modal-coordinator-lazy-load.controller';

type WarnFn = (message: string, error: unknown) => void;
type WorkspaceShellModalLazyLoadFactoryOptionsWithWarn =
  WorkspaceShellModalLazyLoadFactoryOptions<WorkspaceShellModalCoordinatorLike> & {
    warn?: WarnFn;
  };

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

function createModalCoord(options: { loadingType?: string } = {}): WorkspaceShellModalCoordinatorLike {
  return {
    initCallbacks: vi.fn(),
    isModalLoading: vi.fn((type: string) => type === options.loadingType),
  };
}

function createCallbacks(): ModalCallbacks {
  return {
    closeMigrationModal: vi.fn(),
    confirmCreateProject: vi.fn(),
    handleImportComplete: vi.fn(),
    handleLocalModeFromModal: vi.fn(),
    handleLoginFromModal: vi.fn(),
    handleMigrationComplete: vi.fn(),
    handleResetPasswordFromModal: vi.fn(),
    handleSignupFromModal: vi.fn(),
    signOut: vi.fn(),
    updateTheme: vi.fn(),
  } as unknown as ModalCallbacks;
}

function createOptions(
  overrides: Partial<WorkspaceShellModalLazyLoadFactoryOptionsWithWarn> = {},
): WorkspaceShellModalLazyLoadFactoryOptionsWithWarn {
  return {
    createCallbacks: vi.fn(createCallbacks),
    destroyed: () => false,
    fallbackModalCoord: createModalCoord(),
    loadModalCoord: vi.fn().mockResolvedValue(createModalCoord()),
    modalLoading: signal<Record<string, boolean>>({}),
    ...overrides,
  };
}

describe('createWorkspaceShellModalLazyLoadDelegates', () => {
  it('delegates modal coordinator service resolution to the loader factory', () => {
    const source = readFileSync(
      join(__dirname, 'workspace-shell-modal-lazy-load.factory.ts'),
      'utf8',
    );

    expect(source).toContain('createWorkspaceShellModalCoordinatorServiceLoader');
    const controllerOptions = source.slice(
      source.indexOf('new WorkspaceShellModalCoordinatorLazyLoadController'),
      source.indexOf('const actions'),
    );
    expect(controllerOptions).toContain('loadModalCoord,');
    expect(controllerOptions).not.toContain('options.loadModalCoord');
    expect(controllerOptions).not.toContain('options.injector');
  });

  it('returns lazy modal coordinator and action runner delegates', async () => {
    const callbacks = createCallbacks();
    const modalCoord = createModalCoord();
    const delegates = createWorkspaceShellModalLazyLoadDelegates(createOptions({
      createCallbacks: vi.fn(() => callbacks),
      loadModalCoord: vi.fn().mockResolvedValue(modalCoord),
    }));

    await expect(delegates.coordinator.get()).resolves.toBe(modalCoord);
    await delegates.actions.run('settings', loadedModalCoord => {
      expect(loadedModalCoord).toBe(modalCoord);
    });

    expect(modalCoord.initCallbacks).toHaveBeenCalledWith(callbacks);
    expect(delegates.actions.isLoading('settings')).toBe(false);
  });

  it('uses fallback coordinator loading state before the lazy coordinator loads', () => {
    const delegates = createWorkspaceShellModalLazyLoadDelegates(createOptions({
      fallbackModalCoord: createModalCoord({ loadingType: 'settings' }),
    }));

    expect(delegates.actions.isLoading('settings')).toBe(true);
  });

  it('skips modal actions when the shell is destroyed before lazy coordinator load resolves', async () => {
    let destroyed = false;
    const modalCoord = createModalCoord();
    const deferred = createDeferred<WorkspaceShellModalCoordinatorLike>();
    const delegates = createWorkspaceShellModalLazyLoadDelegates(createOptions({
      destroyed: () => destroyed,
      loadModalCoord: vi.fn(() => deferred.promise),
    }));
    const action = vi.fn();

    const actionRun = delegates.actions.run('settings', action);
    await Promise.resolve();

    destroyed = true;
    deferred.resolve(modalCoord);
    await actionRun;

    expect(action).not.toHaveBeenCalled();
    expect(modalCoord.initCallbacks).not.toHaveBeenCalled();
    expect(delegates.actions.isLoading('settings')).toBe(false);
  });

  it('skips modal actions and clears loading when lazy modal callback creation fails', async () => {
    const error = new Error('callbacks failed');
    const action = vi.fn();
    const warn = vi.fn();
    const modalCoord = createModalCoord();
    const delegates = createWorkspaceShellModalLazyLoadDelegates(createOptions({
      createCallbacks: vi.fn().mockRejectedValue(error),
      loadModalCoord: vi.fn().mockResolvedValue(modalCoord),
      warn,
    }));

    await expect(delegates.actions.run('settings', action)).resolves.toBeUndefined();

    expect(action).not.toHaveBeenCalled();
    expect(modalCoord.initCallbacks).not.toHaveBeenCalled();
    expect(delegates.actions.isLoading('settings')).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('modal coordinator'),
      error,
    );
  });
});
