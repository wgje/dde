import { describe, expect, it, vi } from 'vitest';

import { WorkspaceShellActionsDocumentClickListenerController } from './workspace-shell-actions-document-click-listener.controller';

function createController(options: {
  listenToDocument?: (eventName: string, listener: EventListener) => () => void;
} = {}) {
  const onDocumentClick = vi.fn();
  const warn = vi.fn();
  const controller = new WorkspaceShellActionsDocumentClickListenerController({
    listenToDocument: options.listenToDocument,
    onDocumentClick,
    warn,
  });

  return {
    controller,
    onDocumentClick,
    warn,
  };
}

describe('WorkspaceShellActionsDocumentClickListenerController', () => {
  it('does nothing when document listening is unavailable', () => {
    const { controller } = createController();

    expect(() => controller.setup()).not.toThrow();
  });

  it('registers document clicks and forwards mouse events', () => {
    const captured: { listener?: EventListener } = {};
    const listenToDocument = vi.fn((_eventName: string, registered: EventListener) => {
      captured.listener = registered;
      return vi.fn();
    });
    const { controller, onDocumentClick } = createController({ listenToDocument });
    const event = new MouseEvent('click');

    controller.setup();
    captured.listener?.(event);

    expect(listenToDocument).toHaveBeenCalledWith('click', expect.any(Function));
    expect(onDocumentClick).toHaveBeenCalledWith(event);
  });

  it('replaces an existing listener on repeated setup', () => {
    const removers: Array<ReturnType<typeof vi.fn>> = [];
    const listenToDocument = vi.fn(() => {
      const remove = vi.fn();
      removers.push(remove);
      return remove;
    });
    const { controller } = createController({ listenToDocument });

    controller.setup();
    controller.setup();

    expect(listenToDocument).toHaveBeenCalledTimes(2);
    expect(removers[0]).toHaveBeenCalledTimes(1);
    expect(removers[1]).not.toHaveBeenCalled();
  });

  it('removes the current listener and prevents setup after teardown', () => {
    const remove = vi.fn();
    const listenToDocument = vi.fn(() => remove);
    const { controller } = createController({ listenToDocument });

    controller.setup();
    controller.teardown();
    controller.setup();

    expect(remove).toHaveBeenCalledTimes(1);
    expect(listenToDocument).toHaveBeenCalledTimes(1);
  });

  it('warns without throwing when listener cleanup fails', () => {
    const error = new Error('listener cleanup failed');
    const remove = vi.fn(() => {
      throw error;
    });
    const { controller, warn } = createController({
      listenToDocument: () => remove,
    });

    controller.setup();

    expect(() => controller.teardown()).not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      'Workspace shell actions controller 文档点击监听清理失败，已继续清理',
      error,
    );
  });

  it('isolates warning sink failures during cleanup', () => {
    const remove = vi.fn(() => {
      throw new Error('listener cleanup failed');
    });
    const { controller, warn } = createController({
      listenToDocument: () => remove,
    });
    warn.mockImplementation(() => {
      throw new Error('warning sink failed');
    });
    controller.setup();

    expect(() => controller.teardown()).not.toThrow();
  });
});
