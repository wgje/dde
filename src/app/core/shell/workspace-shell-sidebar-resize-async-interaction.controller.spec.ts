import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { WorkspaceShellSidebarResizeAsyncDelegate } from './workspace-shell-sidebar-resize-async-delegate.controller';
import { WorkspaceShellSidebarResizePendingGestureController } from './workspace-shell-sidebar-resize-pending-gesture.controller';
import { WorkspaceShellSidebarResizePendingMouseMoveController } from './workspace-shell-sidebar-resize-pending-mouse-move.controller';
import {
  createWorkspaceShellSidebarResizeDelegate,
  createWorkspaceShellSidebarResizeMouseEvent,
} from './workspace-shell-sidebar-resize.spec-helpers';

interface AsyncDelegateHost {
  loadedDelegate: WorkspaceShellSidebarResizeAsyncDelegate | null;
  teardown(): void;
}

interface AsyncInteractionControllerOptions {
  delegateHost: AsyncDelegateHost;
  pendingGesture: WorkspaceShellSidebarResizePendingGestureController;
  pendingMouseMove: WorkspaceShellSidebarResizePendingMouseMoveController;
  warn: (message: string, error: unknown) => void;
}

type AsyncInteractionWarnMock = ReturnType<
  typeof vi.fn<AsyncInteractionControllerOptions['warn']>
>;

interface AsyncInteractionController {
  failActiveGesture(message: string, error: unknown): void;
  isResizingAny(): boolean;
  onMouseMove(event: MouseEvent): void;
  onMouseUp(): void;
  teardown(): void;
}

type AsyncInteractionControllerConstructor = new (
  options: AsyncInteractionControllerOptions,
) => AsyncInteractionController;

async function loadController(): Promise<AsyncInteractionControllerConstructor> {
  const modulePath = './workspace-shell-sidebar-resize-async-interaction.controller';
  const controllerModule = await import(/* @vite-ignore */ modulePath)
    .catch(() => ({}));
  const Controller = Reflect.get(
    controllerModule,
    'WorkspaceShellSidebarResizeAsyncInteractionController',
  ) as AsyncInteractionControllerConstructor | undefined;

  expect(Controller).toEqual(expect.any(Function));
  return Controller!;
}

function createContext(
  loadedDelegate: WorkspaceShellSidebarResizeAsyncDelegate | null = null,
): {
  delegateHost: AsyncDelegateHost;
  pendingGesture: WorkspaceShellSidebarResizePendingGestureController;
  pendingMouseMove: WorkspaceShellSidebarResizePendingMouseMoveController;
  warn: AsyncInteractionWarnMock;
} {
  return {
    delegateHost: {
      loadedDelegate,
      teardown: vi.fn(),
    },
    pendingGesture: new WorkspaceShellSidebarResizePendingGestureController(),
    pendingMouseMove: new WorkspaceShellSidebarResizePendingMouseMoveController(),
    warn: vi.fn<AsyncInteractionControllerOptions['warn']>(),
  };
}

describe('WorkspaceShellSidebarResizeAsyncInteractionController', () => {
  it('owns async interaction boundaries outside the delegate facade', async () => {
    await loadController();
    const source = readFileSync(
      join(__dirname, 'workspace-shell-sidebar-resize-async-delegate.controller.ts'),
      'utf8',
    );

    expect(source).toContain('WorkspaceShellSidebarResizeAsyncInteractionController');
    expect(source).toContain('return this.interactionController.isResizingAny()');
    expect(source).not.toContain('private failActiveGesture(');
    expect(source).not.toContain('sidebar resize state check failed');
    expect(source).not.toContain('sidebar mousemove failed');
    expect(source).not.toContain('sidebar mouseup failed');
  });

  it('queues the latest mousemove while loading and forwards events after load', async () => {
    const Controller = await loadController();
    const context = createContext();
    const controller = new Controller(context);
    const firstMove = createWorkspaceShellSidebarResizeMouseEvent();
    const latestMove = createWorkspaceShellSidebarResizeMouseEvent();
    const loadedMove = createWorkspaceShellSidebarResizeMouseEvent();
    const queuedAction = vi.fn();

    context.pendingGesture.start();
    controller.onMouseMove(firstMove);
    controller.onMouseMove(latestMove);
    context.pendingMouseMove.flush(queuedAction);

    expect(queuedAction).toHaveBeenCalledTimes(1);
    expect(queuedAction).toHaveBeenCalledWith(latestMove);

    const delegate = createWorkspaceShellSidebarResizeDelegate();
    delegate.isResizingAny.mockReturnValue(true);
    context.delegateHost.loadedDelegate = delegate;
    controller.onMouseMove(loadedMove);

    expect(delegate.onMouseMove).toHaveBeenCalledWith(loadedMove);
    expect(controller.isResizingAny()).toBe(true);
    expect(context.warn).not.toHaveBeenCalled();
  });

  it('recovers state-check failures even when the warning sink throws', async () => {
    const Controller = await loadController();
    const stateError = new Error('delegate resize state failed');
    const delegate = createWorkspaceShellSidebarResizeDelegate();
    delegate.isResizingAny.mockImplementationOnce(() => {
      throw stateError;
    });
    const context = createContext(delegate);
    const controller = new Controller(context);
    const pendingAction = vi.fn();
    context.warn.mockImplementationOnce(() => {
      throw new Error('logger unavailable');
    });
    context.pendingGesture.start();
    context.pendingMouseMove.queue(createWorkspaceShellSidebarResizeMouseEvent());

    expect(() => controller.isResizingAny()).not.toThrow();

    expect(controller.isResizingAny()).toBe(false);
    expect(context.pendingGesture.isResizingAny(false)).toBe(false);
    context.pendingMouseMove.flush(pendingAction);
    expect(pendingAction).not.toHaveBeenCalled();
    expect(context.warn).toHaveBeenCalledWith(
      'sidebar resize state check failed',
      stateError,
    );
  });

  it('cancels pending state and isolates loaded mouseup failures', async () => {
    const Controller = await loadController();
    const mouseUpError = new Error('delegate mouseup failed');
    const delegate = createWorkspaceShellSidebarResizeDelegate();
    delegate.onMouseUp.mockImplementationOnce(() => {
      throw mouseUpError;
    });
    const context = createContext(delegate);
    const controller = new Controller(context);
    const pendingAction = vi.fn();
    context.pendingGesture.start();
    context.pendingMouseMove.queue(createWorkspaceShellSidebarResizeMouseEvent());

    expect(() => controller.onMouseUp()).not.toThrow();

    expect(context.pendingGesture.isResizingAny(false)).toBe(false);
    context.pendingMouseMove.flush(pendingAction);
    expect(pendingAction).not.toHaveBeenCalled();
    expect(delegate.onMouseUp).toHaveBeenCalledTimes(1);
    expect(context.warn).toHaveBeenCalledWith('sidebar mouseup failed', mouseUpError);
  });

  it('tears down the delegate host after clearing pending interaction state', async () => {
    const Controller = await loadController();
    const context = createContext();
    const controller = new Controller(context);
    const pendingAction = vi.fn();
    context.pendingGesture.start();
    context.pendingMouseMove.queue(createWorkspaceShellSidebarResizeMouseEvent());

    controller.teardown();

    expect(context.pendingGesture.isResizingAny(false)).toBe(false);
    context.pendingMouseMove.flush(pendingAction);
    expect(pendingAction).not.toHaveBeenCalled();
    expect(context.delegateHost.teardown).toHaveBeenCalledTimes(1);
  });
});
