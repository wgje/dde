import { signal } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';

import { WorkspaceShellModalActionRunner } from './workspace-shell-modal-action-runner.controller';

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });

  return { promise, resolve };
}

function createRunner(options: {
  initialLoading?: Record<string, boolean>;
  coordinatorLoading?: (type: string) => boolean;
  getModalCoord?: () => Promise<{ id: string } | null>;
} = {}) {
  const modalLoading = signal<Record<string, boolean>>(options.initialLoading ?? {});
  const modalCoord = { id: 'modal-coord' };
  const getModalCoord = vi.fn(options.getModalCoord ?? (() => Promise.resolve(modalCoord)));
  const runner = new WorkspaceShellModalActionRunner({
    modalLoading,
    getModalCoord,
    isCoordinatorLoading: options.coordinatorLoading,
  });

  return { getModalCoord, modalCoord, modalLoading, runner };
}

describe('WorkspaceShellModalActionRunner', () => {
  it('tracks loading state by modal type and removes cleared flags', () => {
    const { modalLoading, runner } = createRunner();

    runner.setLoading('settings', true);
    expect(runner.isLoading('settings')).toBe(true);
    expect(modalLoading()).toEqual({ settings: true });

    runner.setLoading('settings', false);
    expect(runner.isLoading('settings')).toBe(false);
    expect(modalLoading()).toEqual({});
  });

  it('falls back to coordinator loading state when local loading is absent', () => {
    const { runner } = createRunner({
      coordinatorLoading: (type) => type === 'login',
    });

    expect(runner.isLoading('login')).toBe(true);
    expect(runner.isLoading('settings')).toBe(false);
  });

  it('treats coordinator loading lookup failures as not loading', () => {
    const error = new Error('coordinator loading failed');
    const { runner } = createRunner({
      coordinatorLoading: () => {
        throw error;
      },
    });

    expect(() => runner.isLoading('login')).not.toThrow();
    expect(runner.isLoading('login')).toBe(false);
  });

  it('skips duplicate modal actions while the loading type is already active', async () => {
    const { getModalCoord, runner } = createRunner({ initialLoading: { settings: true } });
    const action = vi.fn();

    await runner.run('settings', action);

    expect(getModalCoord).not.toHaveBeenCalled();
    expect(action).not.toHaveBeenCalled();
  });

  it('skips duplicate modal actions while the first async action is loading', async () => {
    const deferredCoord = createDeferred<{ id: string }>();
    const { getModalCoord, modalCoord, modalLoading, runner } = createRunner({
      getModalCoord: () => deferredCoord.promise,
    });
    const firstAction = vi.fn();
    const duplicateAction = vi.fn();

    const firstRun = runner.run('settings', firstAction);
    expect(modalLoading()).toEqual({ settings: true });
    await runner.run('settings', duplicateAction);

    deferredCoord.resolve(modalCoord);
    await firstRun;

    expect(getModalCoord).toHaveBeenCalledTimes(1);
    expect(firstAction).toHaveBeenCalledWith(modalCoord);
    expect(duplicateAction).not.toHaveBeenCalled();
    expect(modalLoading()).toEqual({});
  });

  it('runs the modal action and clears loading after failures', async () => {
    const { modalCoord, modalLoading, runner } = createRunner();
    const error = new Error('modal failed');

    await expect(runner.run('trash', async (coord) => {
      expect(coord).toBe(modalCoord);
      expect(modalLoading()).toEqual({ trash: true });
      throw error;
    })).rejects.toBe(error);

    expect(modalLoading()).toEqual({});
    expect(runner.isLoading('trash')).toBe(false);
  });
});
