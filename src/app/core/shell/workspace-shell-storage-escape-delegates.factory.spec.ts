import { describe, expect, it, vi } from 'vitest';

import type {
  WorkspaceShellStorageEscapeLazyLoadDelegate,
  WorkspaceShellStorageEscapeLazyLoadDelegateOptions,
} from './workspace-shell-storage-escape-lazy-load-delegate.factory';

type StorageEscapeDelegatesFactoryModule = {
  createWorkspaceShellStorageEscapeDelegates?: unknown;
};

async function loadFactoryModule(): Promise<StorageEscapeDelegatesFactoryModule> {
  try {
    const modulePath = './workspace-shell-storage-escape-delegates.factory';
    return await import(/* @vite-ignore */ modulePath) as StorageEscapeDelegatesFactoryModule;
  } catch {
    return {};
  }
}

describe('createWorkspaceShellStorageEscapeDelegates', () => {
  it('adapts shell services into storage escape lazy-load options', async () => {
    const { createWorkspaceShellStorageEscapeDelegates } = await loadFactoryModule();
    expect(createWorkspaceShellStorageEscapeDelegates).toBeTypeOf('function');
    const createStorageEscapeDelegates = createWorkspaceShellStorageEscapeDelegates as (options: {
      actionQueue: {
        onStorageFailure: (callback: (data: unknown) => void) => void;
      };
      projectState: {
        projects: () => unknown[];
      };
      modalCoord: {
        storageEscapeData: { set: (data: unknown) => void };
        openStorageEscapeModalImperative: () => void;
        closeStorageEscapeModal: () => void;
      };
      nowIso: () => string;
      warn: (message: string, error: unknown) => void;
      createStorageEscapeLazyLoad: (
        options: WorkspaceShellStorageEscapeLazyLoadDelegateOptions,
      ) => WorkspaceShellStorageEscapeLazyLoadDelegate;
    }) => WorkspaceShellStorageEscapeLazyLoadDelegate;
    const storageEscape = {
      close: vi.fn(),
      setup: vi.fn(),
      teardown: vi.fn(),
    } satisfies WorkspaceShellStorageEscapeLazyLoadDelegate;
    let receivedOptions!: WorkspaceShellStorageEscapeLazyLoadDelegateOptions;
    let storageFailureCallback!: (data: unknown) => void;
    const actionQueue = {
      onStorageFailure: vi.fn((callback: (data: unknown) => void) => {
        storageFailureCallback = callback;
      }),
    };
    const projects = [{ id: 'project-1' }];
    const projectState = {
      projects: vi.fn(() => projects),
    };
    const modalCoord = {
      storageEscapeData: { set: vi.fn() },
      openStorageEscapeModalImperative: vi.fn(),
      closeStorageEscapeModal: vi.fn(),
    };
    const warn = vi.fn();

    const delegate = createStorageEscapeDelegates({
      actionQueue,
      projectState,
      modalCoord,
      nowIso: () => '2026-06-14T00:00:00.000Z',
      warn,
      createStorageEscapeLazyLoad: vi.fn(options => {
        receivedOptions = options;
        return storageEscape;
      }),
    });

    expect(delegate).toBe(storageEscape);
    receivedOptions.onStorageFailure(storageFailureCallback);
    expect(actionQueue.onStorageFailure).toHaveBeenCalledWith(storageFailureCallback);
    expect(receivedOptions.getProjects()).toBe(projects);
    const storageEscapeData = {
      queue: [],
      deadLetter: [],
      timestamp: '2026-06-14T00:00:00.000Z',
    };
    receivedOptions.setStorageEscapeData(storageEscapeData);
    expect(modalCoord.storageEscapeData.set).toHaveBeenCalledWith(storageEscapeData);
    receivedOptions.openStorageEscapeModalImperative();
    expect(modalCoord.openStorageEscapeModalImperative).toHaveBeenCalledTimes(1);
    receivedOptions.closeStorageEscapeModal();
    expect(modalCoord.closeStorageEscapeModal).toHaveBeenCalledTimes(1);
    expect(receivedOptions.nowIso()).toBe('2026-06-14T00:00:00.000Z');
    expect(receivedOptions.warn).toBe(warn);
  });
});
