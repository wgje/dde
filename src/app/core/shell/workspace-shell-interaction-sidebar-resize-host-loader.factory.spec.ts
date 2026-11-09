import { describe, expect, it, vi } from 'vitest';

import {
  createWorkspaceShellInteractionSidebarResizeHostLoader,
} from './workspace-shell-interaction-sidebar-resize-host-loader.factory';
import type {
  WorkspaceShellInteractionSidebarResizeDelegate,
  WorkspaceShellInteractionSidebarResizeHostOptions,
} from './workspace-shell-interaction-sidebar-resize-host.factory';

type WorkspaceShellInteractionSidebarResizeHostLoaderSpecOptions =
  WorkspaceShellInteractionSidebarResizeHostOptions & {
    readonly listenToDocument: (eventName: string, listener: EventListener) => () => void;
  };

function createSidebarResizeDelegate(): WorkspaceShellInteractionSidebarResizeDelegate {
  return {
    isResizingAny: vi.fn(() => false),
    onMouseMove: vi.fn(),
    onMouseUp: vi.fn(),
    setup: vi.fn(),
    startContentResize: vi.fn(),
    startSidebarResize: vi.fn(),
    teardown: vi.fn(),
  };
}

function createOptions(
  overrides: Partial<WorkspaceShellInteractionSidebarResizeHostLoaderSpecOptions> = {},
): WorkspaceShellInteractionSidebarResizeHostLoaderSpecOptions {
  return {
    destroyed: () => false,
    injector: {} as never,
    listenToDocument: vi.fn(() => vi.fn()),
    warn: vi.fn(),
    ...overrides,
  };
}

describe('createWorkspaceShellInteractionSidebarResizeHostLoader', () => {
  it('uses the provided sidebar resize factory host lazily', async () => {
    const delegate = createSidebarResizeDelegate();
    const createSidebarResizeFactoryHost = vi.fn().mockResolvedValue(delegate);
    const loadHost = createWorkspaceShellInteractionSidebarResizeHostLoader({
      options: createOptions({ createSidebarResizeFactoryHost }),
    });

    expect(createSidebarResizeFactoryHost).not.toHaveBeenCalled();

    await expect(loadHost()).resolves.toBe(delegate);

    expect(createSidebarResizeFactoryHost).toHaveBeenCalledTimes(1);
  });

  it('converts synchronous sidebar resize factory host failures to rejected promises and retries later', async () => {
    const error = new Error('sidebar resize factory host failed synchronously');
    const delegate = createSidebarResizeDelegate();
    const createSidebarResizeFactoryHost = vi.fn()
      .mockImplementationOnce(() => {
        throw error;
      })
      .mockResolvedValueOnce(delegate);
    const loadHost = createWorkspaceShellInteractionSidebarResizeHostLoader({
      options: createOptions({ createSidebarResizeFactoryHost }),
    });

    await expect(loadHost()).rejects.toBe(error);
    await expect(loadHost()).resolves.toBe(delegate);

    expect(createSidebarResizeFactoryHost).toHaveBeenCalledTimes(2);
  });

  it('converts synchronous sidebar resize delegate factory failures to rejected promises and retries later', async () => {
    const error = new Error('sidebar resize delegate factory failed synchronously');
    const delegate = createSidebarResizeDelegate();
    const createSidebarResizeDelegateFactory = vi.fn()
      .mockImplementationOnce(() => {
        throw error;
      })
      .mockImplementationOnce(() => delegate);
    const loadHost = createWorkspaceShellInteractionSidebarResizeHostLoader({
      options: createOptions({
        createSidebarResizeDelegate: createSidebarResizeDelegateFactory,
      }),
    });

    await expect(loadHost()).rejects.toBe(error);
    await expect(loadHost()).resolves.toBe(delegate);

    expect(createSidebarResizeDelegateFactory).toHaveBeenCalledTimes(2);
  });
});
