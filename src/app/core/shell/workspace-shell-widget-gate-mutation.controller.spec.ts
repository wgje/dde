import { describe, expect, it, vi } from 'vitest';

import { WorkspaceShellWidgetGateMutationController } from './workspace-shell-widget-gate-mutation.controller';

type WidgetGateIntent = {
  intent: 'mark-gate-read' | 'mark-gate-complete';
  widgetGateEntryId: string | null;
};

function createController(options: {
  markAsReadResult?: { ok: true } | { ok: false; error: { code: string; message: string } };
  markAsCompletedResult?: { ok: true } | { ok: false; error: { code: string; message: string } };
  markAsReadError?: unknown;
  markAsCompletedError?: unknown;
} = {}) {
  const setSidebarOpen = vi.fn();
  const preloadSidebarTools = vi.fn();
  const markAsRead = vi.fn();
  if (options.markAsReadError) {
    markAsRead.mockRejectedValue(options.markAsReadError);
  } else {
    markAsRead.mockResolvedValue(options.markAsReadResult ?? ({ ok: true } as const));
  }
  const markAsCompleted = vi.fn();
  if (options.markAsCompletedError) {
    markAsCompleted.mockRejectedValue(options.markAsCompletedError);
  } else {
    markAsCompleted.mockResolvedValue(options.markAsCompletedResult ?? ({ ok: true } as const));
  }
  const warn = vi.fn();
  const info = vi.fn();
  const controller = new WorkspaceShellWidgetGateMutationController({
    setSidebarOpen,
    preloadSidebarTools,
    markAsRead,
    markAsCompleted,
    warn,
    info,
  });

  return {
    controller,
    info,
    markAsCompleted,
    markAsRead,
    preloadSidebarTools,
    setSidebarOpen,
    warn,
  };
}

describe('WorkspaceShellWidgetGateMutationController', () => {
  it('falls back to opening sidebar tools when widget entry id is absent', () => {
    const { controller, preloadSidebarTools, setSidebarOpen, markAsRead, markAsCompleted } = createController();

    controller.apply({ intent: 'mark-gate-read', widgetGateEntryId: null });

    expect(setSidebarOpen).toHaveBeenCalledWith(true);
    expect(preloadSidebarTools).toHaveBeenCalledWith('intent');
    expect(markAsRead).not.toHaveBeenCalled();
    expect(markAsCompleted).not.toHaveBeenCalled();
  });

  it('warns when a gate mutation intent arrives without a valid entry id', () => {
    const { controller, warn } = createController();

    controller.apply({ intent: 'mark-gate-complete', widgetGateEntryId: null });

    // 非法/缺失 entry id 的网关动作不能静默降级为侧边栏——必须留下告警痕迹
    expect(warn).toHaveBeenCalledWith(
      'Widget gate mutation intent missing a valid entry id, falling back to sidebar',
      { intent: 'mark-gate-complete' },
    );
  });

  it('marks the widget gate entry as read', async () => {
    const { controller, info, markAsRead, markAsCompleted } = createController();
    const intent: WidgetGateIntent = { intent: 'mark-gate-read', widgetGateEntryId: 'entry-1' };

    await controller.apply(intent);

    expect(markAsRead).toHaveBeenCalledWith('entry-1');
    expect(markAsCompleted).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith('Widget gate mutation applied', {
      intent: 'mark-gate-read',
      entryId: 'entry-1',
    });
  });

  it('marks the widget gate entry as completed', async () => {
    const { controller, markAsCompleted, markAsRead } = createController();

    await controller.apply({ intent: 'mark-gate-complete', widgetGateEntryId: 'entry-2' });

    expect(markAsCompleted).toHaveBeenCalledWith('entry-2');
    expect(markAsRead).not.toHaveBeenCalled();
  });

  it('logs failed widget gate mutation without throwing', async () => {
    const { controller, warn } = createController({
      markAsCompletedResult: {
        ok: false,
        error: { code: 'FOCUS_ENTRY_NOT_FOUND', message: 'missing' },
      },
    });

    await expect(controller.apply({
      intent: 'mark-gate-complete',
      widgetGateEntryId: 'missing-entry',
    })).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith('Widget gate mutation failed', {
      intent: 'mark-gate-complete',
      entryId: 'missing-entry',
      code: 'FOCUS_ENTRY_NOT_FOUND',
      message: 'missing',
    });
  });

  it('swallows warning sink failures after failed mutation results', async () => {
    const { controller, info, warn } = createController({
      markAsCompletedResult: {
        ok: false,
        error: { code: 'FOCUS_ENTRY_NOT_FOUND', message: 'missing' },
      },
    });
    warn.mockImplementationOnce(() => {
      throw new Error('warning sink failed');
    });

    await expect(controller.apply({
      intent: 'mark-gate-complete',
      widgetGateEntryId: 'missing-entry',
    })).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith('Widget gate mutation failed', {
      intent: 'mark-gate-complete',
      entryId: 'missing-entry',
      code: 'FOCUS_ENTRY_NOT_FOUND',
      message: 'missing',
    });
    expect(info).not.toHaveBeenCalled();
  });

  it('logs rejected read mutations without throwing', async () => {
    const error = new Error('read durability failed');
    const { controller, warn } = createController({ markAsReadError: error });

    await expect(controller.apply({
      intent: 'mark-gate-read',
      widgetGateEntryId: 'entry-1',
    })).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith('Widget gate mutation failed', {
      intent: 'mark-gate-read',
      entryId: 'entry-1',
      error,
    });
  });

  it('swallows warning sink failures after rejected mutations', async () => {
    const error = new Error('read durability failed');
    const { controller, info, warn } = createController({ markAsReadError: error });
    warn.mockImplementationOnce(() => {
      throw new Error('warning sink failed');
    });

    await expect(controller.apply({
      intent: 'mark-gate-read',
      widgetGateEntryId: 'entry-1',
    })).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith('Widget gate mutation failed', {
      intent: 'mark-gate-read',
      entryId: 'entry-1',
      error,
    });
    expect(info).not.toHaveBeenCalled();
  });

  it('logs rejected completion mutations without throwing', async () => {
    const error = new Error('completion durability failed');
    const { controller, warn } = createController({ markAsCompletedError: error });

    await expect(controller.apply({
      intent: 'mark-gate-complete',
      widgetGateEntryId: 'entry-2',
    })).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith('Widget gate mutation failed', {
      intent: 'mark-gate-complete',
      entryId: 'entry-2',
      error,
    });
  });
});
