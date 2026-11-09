import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  WorkspaceShellSidebarResizeDeferredLazyLoadHostController,
} from './workspace-shell-sidebar-resize-deferred-lazy-load-host.controller';
import {
  createWorkspaceShellSidebarResizeDelegate,
  createWorkspaceShellSidebarResizeMouseEvent,
} from './workspace-shell-sidebar-resize.spec-helpers';

function readDeferredHostSource(): string {
  return readFileSync(
    join(process.cwd(), 'src/app/core/shell/workspace-shell-sidebar-resize-deferred-lazy-load-host.controller.ts'),
    'utf8',
  );
}

function readDeferredHostRuntimeFactorySource(): string {
  try {
    return readFileSync(
      join(process.cwd(), 'src/app/core/shell/workspace-shell-sidebar-resize-deferred-lazy-load-host-runtime.factory.ts'),
      'utf8',
    );
  } catch (error) {
    if (
      error instanceof Error
      && 'code' in error
      && error.code === 'ENOENT'
    ) {
      return '';
    }

    throw error;
  }
}

describe('WorkspaceShellSidebarResizeDeferredLazyLoadHostController', () => {
  it('keeps deferred resize runtime wiring behind the named factory', () => {
    const source = readDeferredHostSource();
    const runtimeFactorySource = readDeferredHostRuntimeFactorySource();

    expect(source).toContain('createWorkspaceShellSidebarResizeDeferredLazyLoadHostRuntime');
    expect(source).not.toContain('createWorkspaceShellSidebarResizeDeferredLazyLoadHostLoader');
    expect(source).not.toContain('WorkspaceShellSidebarResizeAsyncDelegateController');
    expect(source).not.toContain('WorkspaceShellSidebarResizeBootstrapListenersController');
    expect(source).not.toContain('WorkspaceShellSidebarResizeDelegateHostController');
    expect(runtimeFactorySource)
      .toContain('createWorkspaceShellSidebarResizeDeferredLazyLoadHostLoader');
    expect(runtimeFactorySource)
      .toContain('WorkspaceShellSidebarResizeAsyncDelegateController');
    expect(runtimeFactorySource)
      .toContain('WorkspaceShellSidebarResizeBootstrapListenersController');
    expect(runtimeFactorySource)
      .toContain('WorkspaceShellSidebarResizeDelegateHostController');
  });

  it('does not register document listeners after the shell is destroyed', () => {
    const listenToDocument = vi.fn();
    const controller = new WorkspaceShellSidebarResizeDeferredLazyLoadHostController({
      destroyed: () => true,
      listenToDocument,
      warn: vi.fn(),
    });

    controller.setup();

    expect(listenToDocument).not.toHaveBeenCalled();
  });

  it('does not lazy-load the resize host after the shell is destroyed', () => {
    const loadSidebarResizeHost = vi.fn().mockResolvedValue(createWorkspaceShellSidebarResizeDelegate());
    const controller = new WorkspaceShellSidebarResizeDeferredLazyLoadHostController({
      destroyed: () => true,
      loadSidebarResizeHost,
      warn: vi.fn(),
    });
    const event = createWorkspaceShellSidebarResizeMouseEvent();

    controller.startSidebarResize(event);

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(loadSidebarResizeHost).not.toHaveBeenCalled();
    expect(controller.isResizingAny()).toBe(false);
  });

  it('continues teardown when one document listener cleanup fails', async () => {
    const cleanupError = new Error('remove listener failed');
    const firstRemove = vi.fn(() => {
      throw cleanupError;
    });
    const secondRemove = vi.fn();
    const listenToDocument = vi.fn()
      .mockReturnValueOnce(firstRemove)
      .mockReturnValueOnce(secondRemove);
    const delegate = createWorkspaceShellSidebarResizeDelegate();
    const warn = vi.fn();
    const controller = new WorkspaceShellSidebarResizeDeferredLazyLoadHostController({
      loadSidebarResizeHost: vi.fn().mockResolvedValue(delegate),
      listenToDocument,
      warn,
    });

    controller.setup();
    controller.startSidebarResize({ preventDefault: vi.fn() } as unknown as MouseEvent);
    await vi.waitFor(() => expect(delegate.startSidebarResize).toHaveBeenCalledOnce());

    controller.teardown();

    expect(firstRemove).toHaveBeenCalledOnce();
    expect(secondRemove).toHaveBeenCalledOnce();
    expect(delegate.teardown).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      '侧栏拖拽 document listener 清理失败，已继续清理',
      cleanupError,
    );
  });

  it('rolls back mousemove listener when mouseup listener setup fails', () => {
    const setupError = new Error('mouseup listener setup failed');
    const removeMouseMove = vi.fn();
    const retryRemoveMouseMove = vi.fn();
    const removeMouseUp = vi.fn();
    const warn = vi.fn();
    const listenToDocument = vi.fn()
      .mockReturnValueOnce(removeMouseMove)
      .mockImplementationOnce(() => {
        throw setupError;
      })
      .mockReturnValueOnce(retryRemoveMouseMove)
      .mockReturnValueOnce(removeMouseUp);
    const controller = new WorkspaceShellSidebarResizeDeferredLazyLoadHostController({
      listenToDocument,
      warn,
    });

    expect(() => controller.setup()).not.toThrow();

    expect(removeMouseMove).toHaveBeenCalledTimes(1);
    expect(retryRemoveMouseMove).not.toHaveBeenCalled();
    expect(removeMouseUp).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      '侧栏拖拽 bootstrap document listener 注册失败，已跳过本次绑定',
      setupError,
    );

    expect(() => controller.setup()).not.toThrow();
    controller.teardown();

    expect(removeMouseMove).toHaveBeenCalledTimes(1);
    expect(retryRemoveMouseMove).toHaveBeenCalledTimes(1);
    expect(removeMouseUp).toHaveBeenCalledTimes(1);
  });

  it('delegates document listener state to the shared sidebar resize listener controller', () => {
    const source = readDeferredHostRuntimeFactorySource();

    expect(source).toContain('WorkspaceShellSidebarResizeBootstrapListenersController');
    expect(source).not.toContain('removeMouseMoveListener');
    expect(source).not.toContain('removeMouseUpListener');
    expect(source).not.toContain('private removeDocumentListeners');
    expect(source).not.toContain('private removeDocumentListener');
  });

  it('delegates final resize lazy-load host resolution to the loader factory', () => {
    const source = readDeferredHostRuntimeFactorySource();

    expect(source).not.toContain('workspace-shell-sidebar-resize-delegation.controller');
    expect(source).not.toContain('WorkspaceShellSidebarResizeDelegationController');
    expect(source).not.toContain("import('./workspace-shell-sidebar-resize-lazy-load.controller')");
    expect(source).not.toContain('WorkspaceShellSidebarResizeLazyLoadController');
    expect(source).toContain('createWorkspaceShellSidebarResizeDeferredLazyLoadHostLoader');
  });

  it('delegates destroyed guards and resize forwarding to the shared delegate host', () => {
    const source = readDeferredHostRuntimeFactorySource();

    expect(source).toContain('WorkspaceShellSidebarResizeDelegateHostController');
    expect(source).not.toContain('private isDestroyed');
    expect(source).not.toContain('if (this.isDestroyed()) return');
  });
});
