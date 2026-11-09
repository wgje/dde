import { describe, expect, it, vi } from 'vitest';

import {
  WorkspaceShellSidebarResizeBootstrapListenersController,
} from './workspace-shell-sidebar-resize-bootstrap-listeners.controller';

describe('WorkspaceShellSidebarResizeBootstrapListenersController', () => {
  it('registers bootstrap document listeners and forwards document events', () => {
    const listeners = new Map<string, EventListener>();
    const removeMouseMove = vi.fn();
    const removeMouseUp = vi.fn();
    const listenToDocument = vi.fn((eventName: string, listener: EventListener) => {
      listeners.set(eventName, listener);
      return eventName === 'mousemove' ? removeMouseMove : removeMouseUp;
    });
    const onMouseMove = vi.fn();
    const onMouseUp = vi.fn();
    const controller = new WorkspaceShellSidebarResizeBootstrapListenersController({
      listenToDocument,
      onMouseMove,
      onMouseUp,
      warn: vi.fn(),
    });
    const moveEvent = new MouseEvent('mousemove');

    controller.setup();

    expect(listenToDocument).toHaveBeenCalledWith('mousemove', expect.any(Function));
    expect(listenToDocument).toHaveBeenCalledWith('mouseup', expect.any(Function));

    listeners.get('mousemove')?.(moveEvent);
    listeners.get('mouseup')?.(new MouseEvent('mouseup'));

    expect(onMouseMove).toHaveBeenCalledWith(moveEvent);
    expect(onMouseUp).toHaveBeenCalledTimes(1);
    expect(removeMouseMove).not.toHaveBeenCalled();
    expect(removeMouseUp).not.toHaveBeenCalled();
  });

  it('removes existing listeners before registering a replacement pair', () => {
    const firstRemoveMouseMove = vi.fn();
    const firstRemoveMouseUp = vi.fn();
    const secondRemoveMouseMove = vi.fn();
    const secondRemoveMouseUp = vi.fn();
    const listenToDocument = vi.fn()
      .mockReturnValueOnce(firstRemoveMouseMove)
      .mockReturnValueOnce(firstRemoveMouseUp)
      .mockReturnValueOnce(secondRemoveMouseMove)
      .mockReturnValueOnce(secondRemoveMouseUp);
    const controller = new WorkspaceShellSidebarResizeBootstrapListenersController({
      listenToDocument,
      onMouseMove: vi.fn(),
      onMouseUp: vi.fn(),
      warn: vi.fn(),
    });

    controller.setup();
    controller.setup();

    expect(firstRemoveMouseMove).toHaveBeenCalledTimes(1);
    expect(firstRemoveMouseUp).toHaveBeenCalledTimes(1);
    expect(secondRemoveMouseMove).not.toHaveBeenCalled();
    expect(secondRemoveMouseUp).not.toHaveBeenCalled();
  });

  it('ignores events from replaced bootstrap document listeners', () => {
    const listeners: Record<string, EventListener[]> = {
      mousemove: [],
      mouseup: [],
    };
    const listenToDocument = vi.fn((eventName: string, listener: EventListener) => {
      listeners[eventName]?.push(listener);
      return vi.fn();
    });
    const onMouseMove = vi.fn();
    const onMouseUp = vi.fn();
    const controller = new WorkspaceShellSidebarResizeBootstrapListenersController({
      listenToDocument,
      onMouseMove,
      onMouseUp,
      warn: vi.fn(),
    });
    const moveEvent = new MouseEvent('mousemove');

    controller.setup();
    controller.setup();

    listeners.mousemove[0]?.(moveEvent);
    listeners.mouseup[0]?.(new MouseEvent('mouseup'));

    expect(onMouseMove).not.toHaveBeenCalled();
    expect(onMouseUp).not.toHaveBeenCalled();

    listeners.mousemove[1]?.(moveEvent);
    listeners.mouseup[1]?.(new MouseEvent('mouseup'));

    expect(onMouseMove).toHaveBeenCalledWith(moveEvent);
    expect(onMouseUp).toHaveBeenCalledTimes(1);
  });

  it('rolls back partial setup failures without throwing and allows retry', () => {
    const setupError = new Error('mouseup listener failed');
    const firstRemoveMouseMove = vi.fn();
    const retryRemoveMouseMove = vi.fn();
    const retryRemoveMouseUp = vi.fn();
    const warn = vi.fn();
    const listenToDocument = vi.fn()
      .mockReturnValueOnce(firstRemoveMouseMove)
      .mockImplementationOnce(() => {
        throw setupError;
      })
      .mockReturnValueOnce(retryRemoveMouseMove)
      .mockReturnValueOnce(retryRemoveMouseUp);
    const controller = new WorkspaceShellSidebarResizeBootstrapListenersController({
      listenToDocument,
      onMouseMove: vi.fn(),
      onMouseUp: vi.fn(),
      warn,
    });

    expect(() => controller.setup()).not.toThrow();
    expect(firstRemoveMouseMove).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      '侧栏拖拽 bootstrap document listener 注册失败，已跳过本次绑定',
      setupError,
    );

    controller.setup();
    controller.teardown();

    expect(retryRemoveMouseMove).toHaveBeenCalledTimes(1);
    expect(retryRemoveMouseUp).toHaveBeenCalledTimes(1);
  });

  it('continues removing listeners when one cleanup callback throws', () => {
    const cleanupError = new Error('remove failed');
    const removeMouseMove = vi.fn(() => {
      throw cleanupError;
    });
    const removeMouseUp = vi.fn();
    const warn = vi.fn();
    const controller = new WorkspaceShellSidebarResizeBootstrapListenersController({
      listenToDocument: vi.fn()
        .mockReturnValueOnce(removeMouseMove)
        .mockReturnValueOnce(removeMouseUp),
      onMouseMove: vi.fn(),
      onMouseUp: vi.fn(),
      warn,
    });

    controller.setup();
    controller.teardown();

    expect(removeMouseMove).toHaveBeenCalledTimes(1);
    expect(removeMouseUp).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      '侧栏拖拽 bootstrap document listener 清理失败，已继续清理',
      cleanupError,
    );
  });

  it('continues removing listeners when cleanup warning sink throws', () => {
    const cleanupError = new Error('remove failed');
    const removeMouseMove = vi.fn(() => {
      throw cleanupError;
    });
    const removeMouseUp = vi.fn();
    const warn = vi.fn(() => {
      throw new Error('logger unavailable');
    });
    const controller = new WorkspaceShellSidebarResizeBootstrapListenersController({
      listenToDocument: vi.fn()
        .mockReturnValueOnce(removeMouseMove)
        .mockReturnValueOnce(removeMouseUp),
      onMouseMove: vi.fn(),
      onMouseUp: vi.fn(),
      warn,
    });

    controller.setup();

    expect(() => controller.teardown()).not.toThrow();

    expect(removeMouseMove).toHaveBeenCalledTimes(1);
    expect(removeMouseUp).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      '侧栏拖拽 bootstrap document listener 清理失败，已继续清理',
      cleanupError,
    );
  });

  it('uses a caller-specific cleanup warning message when provided', () => {
    const cleanupError = new Error('remove failed');
    const warn = vi.fn();
    const controller = new WorkspaceShellSidebarResizeBootstrapListenersController({
      cleanupFailureMessage: '侧栏拖拽 document listener 清理失败，已继续清理',
      listenToDocument: vi.fn()
        .mockReturnValueOnce(() => {
          throw cleanupError;
        })
        .mockReturnValueOnce(vi.fn()),
      onMouseMove: vi.fn(),
      onMouseUp: vi.fn(),
      warn,
    });

    controller.setup();
    controller.teardown();

    expect(warn).toHaveBeenCalledWith(
      '侧栏拖拽 document listener 清理失败，已继续清理',
      cleanupError,
    );
  });
});
