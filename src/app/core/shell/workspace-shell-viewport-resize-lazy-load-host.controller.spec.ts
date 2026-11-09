import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  WorkspaceShellViewportResizeLazyLoadHostController,
  type WorkspaceShellViewportResizeHostDelegate,
} from './workspace-shell-viewport-resize-lazy-load-host.controller';

function createViewportResizeDelegate(): WorkspaceShellViewportResizeHostDelegate {
  return {
    cleanup: vi.fn(),
    handleResize: vi.fn(),
  };
}

function createController(overrides: {
  createViewportResizeController?: () => Promise<WorkspaceShellViewportResizeHostDelegate>;
  listenToWindow?: (eventName: string, listener: EventListener) => () => void;
  warn?: (message: string, error: unknown) => void;
} = {}) {
  const viewportResize = createViewportResizeDelegate();
  const createViewportResizeController = overrides.createViewportResizeController
    ?? vi.fn().mockResolvedValue(viewportResize);
  const warn = overrides.warn ?? vi.fn();
  const controller = new WorkspaceShellViewportResizeLazyLoadHostController({
    createViewportResizeController,
    listenToWindow: overrides.listenToWindow,
    warn,
  });

  return { controller, createViewportResizeController, viewportResize, warn };
}

async function flushMicrotasks(): Promise<void> {
  // 纯微任务多轮排空：轮次覆盖原生/zone-patched Promise 的最深链（thenable 采纳会放大跳数），
  // 不用宏任务 setTimeout —— 共享车道 CPU 饱和时宏任务可能 2s 内不被调度导致超时
  for (let flushRound = 0; flushRound < 25; flushRound += 1) {
    await Promise.resolve();
  }
}

describe('WorkspaceShellViewportResizeLazyLoadHostController', () => {
  it('delegates final viewport resize controller resolution to the loader factory', () => {
    const source = readFileSync(
      join(__dirname, 'workspace-shell-viewport-resize-lazy-load-host.controller.ts'),
      'utf8',
    );

    expect(source).toContain('createWorkspaceShellViewportResizeControllerLoader');
    expect(source).not.toContain("import('./workspace-shell-viewport-resize.controller')");
    expect(source).not.toContain('new WorkspaceShellViewportResizeController');
  });

  it('loads the viewport resize controller once and handles queued resize events', async () => {
    const viewportResize = createViewportResizeDelegate();
    const createViewportResizeController = vi.fn().mockResolvedValue(viewportResize);
    const { controller } = createController({ createViewportResizeController });

    controller.handleResize();
    controller.handleResize();
    await flushMicrotasks();

    expect(createViewportResizeController).toHaveBeenCalledTimes(1);
    expect(viewportResize.handleResize).toHaveBeenCalledTimes(2);
  });

  it('warns and allows retrying after the controller fails to load', async () => {
    const error = new Error('viewport chunk missing');
    const viewportResize = createViewportResizeDelegate();
    const createViewportResizeController = vi.fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(viewportResize);
    const { controller, warn } = createController({ createViewportResizeController });

    controller.handleResize();
    await flushMicrotasks();
    controller.handleResize();
    await flushMicrotasks();

    expect(createViewportResizeController).toHaveBeenCalledTimes(2);
    expect(viewportResize.handleResize).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('视口 resize 控制器懒加载失败，已跳过本次窗口变化', error);
  });

  it('warns and allows retrying after controller creation throws synchronously', async () => {
    const error = new Error('viewport factory sync failure');
    const viewportResize = createViewportResizeDelegate();
    const createViewportResizeController = vi.fn()
      .mockImplementationOnce(() => {
        throw error;
      })
      .mockResolvedValueOnce(viewportResize);
    const { controller, warn } = createController({ createViewportResizeController });

    controller.handleResize();
    await flushMicrotasks();
    controller.handleResize();
    await flushMicrotasks();

    expect(createViewportResizeController).toHaveBeenCalledTimes(2);
    expect(viewportResize.handleResize).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('视口 resize 控制器懒加载失败，已跳过本次窗口变化', error);
  });

  it('cleans up a pending viewport resize controller without handling stale resize once it resolves', async () => {
    const viewportResize = createViewportResizeDelegate();
    const createViewportResizeController = vi.fn().mockResolvedValue(viewportResize);
    const { controller } = createController({ createViewportResizeController });

    controller.handleResize();
    controller.cleanup();
    await flushMicrotasks();

    expect(viewportResize.handleResize).not.toHaveBeenCalled();
    expect(viewportResize.cleanup).toHaveBeenCalledTimes(1);
  });

  it('cleans up a pending viewport resize controller only once when cleanup repeats', async () => {
    const viewportResize = createViewportResizeDelegate();
    const createViewportResizeController = vi.fn().mockResolvedValue(viewportResize);
    const { controller } = createController({ createViewportResizeController });

    controller.handleResize();
    controller.cleanup();
    controller.cleanup();
    await flushMicrotasks();

    expect(viewportResize.handleResize).not.toHaveBeenCalled();
    expect(viewportResize.cleanup).toHaveBeenCalledTimes(1);
  });

  it('owns window resize listener and removes it during cleanup', () => {
    const removers: Array<ReturnType<typeof vi.fn>> = [];
    const listenToWindow = vi.fn((eventName: string, listener: EventListener) => {
      const remove = vi.fn();
      removers.push(remove);
      return remove;
    });
    const { controller } = createController({ listenToWindow });
    const handleResize = vi.spyOn(controller, 'handleResize');

    controller.setup();

    expect(listenToWindow).toHaveBeenCalledWith('resize', expect.any(Function));

    const resizeListener = listenToWindow.mock.calls[0]?.[1] as EventListener;
    resizeListener(new Event('resize'));

    expect(handleResize).toHaveBeenCalledTimes(1);

    controller.cleanup();

    expect(removers).toHaveLength(1);
    expect(removers[0]).toHaveBeenCalledTimes(1);
  });

  it('warns and allows retrying when window resize listener setup fails', () => {
    const setupError = new Error('resize listener setup failed');
    const removeResizeListener = vi.fn();
    const listenToWindow = vi.fn()
      .mockImplementationOnce(() => {
        throw setupError;
      })
      .mockImplementation((_eventName: string, listener: EventListener) => {
        return removeResizeListener;
      });
    const { controller, warn } = createController({ listenToWindow });
    const handleResize = vi.spyOn(controller, 'handleResize');

    expect(() => controller.setup()).not.toThrow();
    expect(warn).toHaveBeenCalledWith('视口 resize 监听注册失败，已跳过本次安装并允许重试', setupError);

    controller.setup();

    const resizeListener = listenToWindow.mock.calls[1]?.[1] as EventListener;
    resizeListener(new Event('resize'));

    expect(handleResize).toHaveBeenCalledTimes(1);
    controller.cleanup();
    expect(removeResizeListener).toHaveBeenCalledTimes(1);
  });

  it('continues cleanup when removing the window resize listener fails', async () => {
    const cleanupError = new Error('resize listener cleanup failed');
    const removeResizeListener = vi.fn(() => {
      throw cleanupError;
    });
    const viewportResize = createViewportResizeDelegate();
    const createViewportResizeController = vi.fn().mockResolvedValue(viewportResize);
    const { controller, warn } = createController({
      createViewportResizeController,
      listenToWindow: vi.fn(() => removeResizeListener),
    });

    controller.setup();
    controller.handleResize();

    expect(() => controller.cleanup()).not.toThrow();
    await flushMicrotasks();

    expect(removeResizeListener).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('视口 resize 监听清理失败，已继续清理控制器', cleanupError);
    expect(viewportResize.cleanup).toHaveBeenCalledTimes(1);
  });

  it('continues cleanup when window resize listener warning fails', async () => {
    const cleanupError = new Error('resize listener cleanup failed');
    const removeResizeListener = vi.fn(() => {
      throw cleanupError;
    });
    const viewportResize = createViewportResizeDelegate();
    const createViewportResizeController = vi.fn().mockResolvedValue(viewportResize);
    const warn = vi.fn(() => {
      throw new Error('warning sink failed');
    });
    const { controller } = createController({
      createViewportResizeController,
      listenToWindow: vi.fn(() => removeResizeListener),
      warn,
    });

    controller.setup();
    controller.handleResize();

    expect(() => controller.cleanup()).not.toThrow();
    await flushMicrotasks();

    expect(removeResizeListener).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('视口 resize 监听清理失败，已继续清理控制器', cleanupError);
    expect(viewportResize.cleanup).toHaveBeenCalledTimes(1);
  });

  it('does not reattach the window resize listener after cleanup', () => {
    const listenToWindow = vi.fn((_eventName: string, _listener: EventListener) => vi.fn());
    const { controller } = createController({ listenToWindow });

    controller.setup();
    controller.cleanup();
    controller.setup();

    expect(listenToWindow).toHaveBeenCalledTimes(1);
  });
});
