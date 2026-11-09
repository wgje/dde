import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { WorkspaceShellSidebarResizeAsyncDelegate } from './workspace-shell-sidebar-resize-async-delegate.controller';
import { WorkspaceShellSidebarResizePendingGestureController } from './workspace-shell-sidebar-resize-pending-gesture.controller';
import { WorkspaceShellSidebarResizePendingMouseMoveController } from './workspace-shell-sidebar-resize-pending-mouse-move.controller';
import {
  createWorkspaceShellSidebarResizeDelegate,
  createWorkspaceShellSidebarResizeMouseEvent,
  flushWorkspaceShellSidebarResizeMicrotasks,
} from './workspace-shell-sidebar-resize.spec-helpers';

type ResizeTarget = 'sidebar' | 'content';

interface AsyncDelegateHost {
  call(
    action: (delegate: WorkspaceShellSidebarResizeAsyncDelegate) => boolean,
    fallback: boolean,
    failureMessage?: string,
    loadFailureMessage?: string,
  ): Promise<boolean>;
}

interface AsyncStartControllerOptions {
  delegateHost: AsyncDelegateHost;
  failActiveGesture: (message: string, error: unknown) => void;
  pendingGesture: WorkspaceShellSidebarResizePendingGestureController;
  pendingMouseMove: WorkspaceShellSidebarResizePendingMouseMoveController;
  resolveFailureMessage: (target: ResizeTarget) => string;
  resolveStartFailureMessage?: (target: ResizeTarget) => string;
}

interface AsyncStartController {
  start(event: MouseEvent, target: ResizeTarget): void;
}

type AsyncStartControllerConstructor = new (
  options: AsyncStartControllerOptions,
) => AsyncStartController;

async function loadController(): Promise<AsyncStartControllerConstructor> {
  const modulePath = './workspace-shell-sidebar-resize-async-start.controller';
  const controllerModule = await import(/* @vite-ignore */ modulePath)
    .catch(() => ({}));
  const Controller = Reflect.get(
    controllerModule,
    'WorkspaceShellSidebarResizeAsyncStartController',
  ) as AsyncStartControllerConstructor | undefined;

  expect(Controller).toEqual(expect.any(Function));
  return Controller!;
}

function createDeferredHost(delegate: WorkspaceShellSidebarResizeAsyncDelegate): {
  host: AsyncDelegateHost;
  runLoaded: () => void;
} {
  let runLoaded = (): void => {
    throw new Error('delegate host action was not registered');
  };
  const host: AsyncDelegateHost = {
    call: vi.fn(action => new Promise<boolean>(resolve => {
      runLoaded = () => resolve(action(delegate));
    })),
  };

  return {
    host,
    runLoaded: () => runLoaded(),
  };
}

describe('WorkspaceShellSidebarResizeAsyncStartController', () => {
  it('owns async resize start coordination outside the async delegate', async () => {
    await loadController();
    const source = readFileSync(
      join(__dirname, 'workspace-shell-sidebar-resize-async-delegate.controller.ts'),
      'utf8',
    );

    expect(source).toContain('WorkspaceShellSidebarResizeAsyncStartController');
    expect(source).not.toContain('private start(');
    expect(source).not.toContain('private startLoadedDelegate(');
    expect(source).not.toContain('private resolveStartFailureMessage(');
  });

  it('starts the current delegate gesture and flushes the latest pending mousemove', async () => {
    const Controller = await loadController();
    const delegate = createWorkspaceShellSidebarResizeDelegate();
    const { host, runLoaded } = createDeferredHost(delegate);
    const pendingGesture = new WorkspaceShellSidebarResizePendingGestureController();
    const pendingMouseMove = new WorkspaceShellSidebarResizePendingMouseMoveController();
    const failActiveGesture = vi.fn();
    const controller = new Controller({
      delegateHost: host,
      pendingGesture,
      pendingMouseMove,
      resolveFailureMessage: target => `${target} load failed`,
      resolveStartFailureMessage: target => `${target} start failed`,
      failActiveGesture,
    });
    const startEvent = createWorkspaceShellSidebarResizeMouseEvent();
    const staleMoveEvent = createWorkspaceShellSidebarResizeMouseEvent();
    const latestMoveEvent = createWorkspaceShellSidebarResizeMouseEvent();

    controller.start(startEvent, 'sidebar');
    pendingMouseMove.queue(staleMoveEvent);
    pendingMouseMove.queue(latestMoveEvent);
    runLoaded();
    await flushWorkspaceShellSidebarResizeMicrotasks();

    expect(startEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(delegate.startSidebarResize).toHaveBeenCalledWith(startEvent);
    expect(delegate.onMouseMove).toHaveBeenCalledWith(latestMoveEvent);
    expect(pendingGesture.isResizingAny(false)).toBe(true);
    expect(host.call).toHaveBeenCalledWith(
      expect.any(Function),
      false,
      'sidebar start failed',
      'sidebar load failed',
    );
    expect(failActiveGesture).not.toHaveBeenCalled();
  });

  it('does not start a delegate for a cancelled gesture', async () => {
    const Controller = await loadController();
    const delegate = createWorkspaceShellSidebarResizeDelegate();
    const { host, runLoaded } = createDeferredHost(delegate);
    const pendingGesture = new WorkspaceShellSidebarResizePendingGestureController();
    const pendingMouseMove = new WorkspaceShellSidebarResizePendingMouseMoveController();
    const controller = new Controller({
      delegateHost: host,
      pendingGesture,
      pendingMouseMove,
      resolveFailureMessage: target => `${target} load failed`,
      failActiveGesture: vi.fn(),
    });

    controller.start(createWorkspaceShellSidebarResizeMouseEvent(), 'content');
    pendingGesture.cancel();
    runLoaded();
    await flushWorkspaceShellSidebarResizeMicrotasks();

    expect(delegate.startContentResize).not.toHaveBeenCalled();
    expect(pendingGesture.isResizingAny(false)).toBe(false);
  });

  it('isolates failure-message resolution before loading the delegate', async () => {
    const Controller = await loadController();
    const resolverError = new Error('start failure message unavailable');
    const pendingGesture = new WorkspaceShellSidebarResizePendingGestureController();
    const pendingMouseMove = new WorkspaceShellSidebarResizePendingMouseMoveController();
    const host: AsyncDelegateHost = { call: vi.fn() };
    const failActiveGesture = vi.fn(() => {
      pendingGesture.cancel();
      pendingMouseMove.clear();
    });
    const controller = new Controller({
      delegateHost: host,
      pendingGesture,
      pendingMouseMove,
      resolveFailureMessage: target => `${target} load failed`,
      resolveStartFailureMessage: () => {
        throw resolverError;
      },
      failActiveGesture,
    });
    const startEvent = createWorkspaceShellSidebarResizeMouseEvent();

    expect(() => controller.start(startEvent, 'sidebar')).not.toThrow();

    expect(startEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(host.call).not.toHaveBeenCalled();
    expect(pendingGesture.isResizingAny(false)).toBe(false);
    expect(failActiveGesture).toHaveBeenCalledWith(
      'sidebar resize start failure message resolution failed',
      resolverError,
    );
  });
});
