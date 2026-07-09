import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  WorkspaceShellSidebarResizeLazyLoadController,
  type WorkspaceShellSidebarResizeServiceLike,
} from './workspace-shell-sidebar-resize-lazy-load.controller';

function createMouseEvent(): MouseEvent {
  return {
    preventDefault: vi.fn(),
  } as unknown as MouseEvent;
}

function createService(overrides: Partial<WorkspaceShellSidebarResizeServiceLike> = {}): WorkspaceShellSidebarResizeServiceLike {
  return {
    isResizingAny: vi.fn(() => true),
    onMouseMove: vi.fn(),
    onMouseUp: vi.fn(),
    startContent: vi.fn(),
    startSidebar: vi.fn(),
    teardown: vi.fn(),
    ...overrides,
  };
}

function createController(options: {
  destroyed?: () => boolean;
  loadSidebarResize?: () => Promise<WorkspaceShellSidebarResizeServiceLike>;
  warn?: (message: string, error: unknown) => void;
} = {}) {
  const warn = options.warn ?? vi.fn();
  const controller = new WorkspaceShellSidebarResizeLazyLoadController({
    destroyed: options.destroyed ?? (() => false),
    loadSidebarResize: options.loadSidebarResize ?? vi.fn(),
    warn,
  });

  return { controller, warn };
}

describe('WorkspaceShellSidebarResizeLazyLoadController', () => {
  it('receives sidebar resize service resolution from a loader instead of importing it directly', () => {
    const source = readFileSync(
      join(__dirname, 'workspace-shell-sidebar-resize-lazy-load.controller.ts'),
      'utf8',
    );

    expect(source).not.toContain("import('../../../services/sidebar-resize.service')");
    expect(source).not.toContain('SidebarResizeService })');
    expect(source).not.toContain('injector.get(SidebarResizeService)');
  });

  it('does not keep a second resize service lazy-load cache', () => {
    const source = readFileSync(
      join(__dirname, 'workspace-shell-sidebar-resize-lazy-load.controller.ts'),
      'utf8',
    );

    expect(source).not.toContain('resizePromise');
    expect(source).not.toContain('resizeInstance');
  });

  it('delegates destroyed guards and resize forwarding to the shared delegate host', () => {
    const source = readFileSync(
      join(__dirname, 'workspace-shell-sidebar-resize-lazy-load.controller.ts'),
      'utf8',
    );

    expect(source).toContain('WorkspaceShellSidebarResizeDelegateHostController');
    expect(source).not.toContain('private isDestroyed');
    expect(source).not.toContain('if (this.isDestroyed()) return');
  });

  it('loads the resize service and delegates sidebar drag startup', async () => {
    const service = createService();
    const loadSidebarResize = vi.fn().mockResolvedValue(service);
    const { controller } = createController({ loadSidebarResize });
    const event = createMouseEvent();

    controller.startSidebarResize(event);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(controller.isResizingAny()).toBe(true);

    expect(loadSidebarResize).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(service.startSidebar).toHaveBeenCalledWith(event));
    expect(controller.isResizingAny()).toBe(true);
  });

  it('does not lazy-load sidebar resize after the shell is destroyed', () => {
    const loadSidebarResize = vi.fn().mockResolvedValue(createService());
    const { controller } = createController({
      destroyed: () => true,
      loadSidebarResize,
    });
    const event = createMouseEvent();

    controller.startSidebarResize(event);

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(loadSidebarResize).not.toHaveBeenCalled();
    expect(controller.isResizingAny()).toBe(false);
  });

  it('does not lazy-load sidebar resize during setup', () => {
    const loadSidebarResize = vi.fn().mockResolvedValue(createService());
    const { controller } = createController({ loadSidebarResize });

    controller.setup();

    expect(loadSidebarResize).not.toHaveBeenCalled();
    expect(controller.isResizingAny()).toBe(false);
  });

  it('ignores a resolved startup when teardown cancels the active gesture', async () => {
    const service = createService();
    let resolveService: (service: WorkspaceShellSidebarResizeServiceLike) => void = () => undefined;
    const loadSidebarResize = vi.fn().mockImplementation(() => new Promise<WorkspaceShellSidebarResizeServiceLike>(resolve => {
      resolveService = resolve;
    }));
    const { controller } = createController({ loadSidebarResize });

    controller.startContentResize(createMouseEvent());
    controller.teardown();
    resolveService(service);

    expect(service.startContent).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(service.teardown).toHaveBeenCalledTimes(1));
    expect(controller.isResizingAny()).toBe(false);
  });

  it('delegates move and mouseup events after the service is loaded', async () => {
    const service = createService({ isResizingAny: vi.fn(() => false) });
    const { controller } = createController({
      loadSidebarResize: vi.fn().mockResolvedValue(service),
    });
    const startEvent = createMouseEvent();
    const moveEvent = createMouseEvent();

    controller.startSidebarResize(startEvent);
    await vi.waitFor(() => expect(service.startSidebar).toHaveBeenCalledWith(startEvent));
    controller.onMouseMove(moveEvent);
    controller.onMouseUp();

    expect(service.onMouseMove).toHaveBeenCalledWith(moveEvent);
    expect(service.onMouseUp).toHaveBeenCalledTimes(1);
    expect(controller.isResizingAny()).toBe(false);
  });

  it('warns and clears active drag state when lazy loading fails', async () => {
    const error = new Error('chunk missing');
    const loadSidebarResize = vi.fn().mockRejectedValue(error);
    const { controller, warn } = createController({ loadSidebarResize });

    controller.startSidebarResize(createMouseEvent());

    await vi.waitFor(() => expect(controller.isResizingAny()).toBe(false));
    expect(warn).toHaveBeenCalledWith('侧栏拖拽服务懒加载失败，已跳过本次拖拽', error);
  });

  it('allows retry after a sidebar resize lazy-load failure', async () => {
    const error = new Error('first chunk failed');
    const service = createService();
    const loadSidebarResize = vi.fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(service);
    const { controller, warn } = createController({ loadSidebarResize });
    const retryEvent = createMouseEvent();

    controller.startSidebarResize(createMouseEvent());
    await vi.waitFor(() => expect(controller.isResizingAny()).toBe(false));
    controller.startSidebarResize(retryEvent);

    await vi.waitFor(() => expect(service.startSidebar).toHaveBeenCalledWith(retryEvent));
    expect(loadSidebarResize).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith('侧栏拖拽服务懒加载失败，已跳过本次拖拽', error);
  });
});
