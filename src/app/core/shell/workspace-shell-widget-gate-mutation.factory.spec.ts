import { describe, expect, it, vi } from 'vitest';

import { createWorkspaceShellWidgetGateMutationController } from './workspace-shell-widget-gate-mutation.factory';

function createController() {
  const sidebarOpen = { set: vi.fn() };
  const preloadSidebarTools = vi.fn();
  const blackBoxService = {
    markAsRead: vi.fn(() => ({ ok: true } as const)),
    markAsReadDurably: vi.fn().mockResolvedValue({ ok: true } as const),
    markAsCompleted: vi.fn(() => ({ ok: true } as const)),
    markAsCompletedDurably: vi.fn().mockResolvedValue({ ok: true } as const),
  };
  const logger = { info: vi.fn() };
  const warn = vi.fn();
  const controller = createWorkspaceShellWidgetGateMutationController({
    sidebarOpen,
    preloadSidebarTools,
    blackBoxService,
    logger,
    warn,
  });

  return {
    blackBoxService,
    controller,
    logger,
    preloadSidebarTools,
    sidebarOpen,
  };
}

describe('createWorkspaceShellWidgetGateMutationController', () => {
  it('maps shell dependencies into the widget gate mutation controller', async () => {
    const {
      blackBoxService,
      controller,
      logger,
      preloadSidebarTools,
      sidebarOpen,
    } = createController();

    controller.apply({ intent: 'mark-gate-read', widgetGateEntryId: null });
    await controller.apply({ intent: 'mark-gate-complete', widgetGateEntryId: 'entry-1' });

    expect(sidebarOpen.set).toHaveBeenCalledWith(true);
    expect(preloadSidebarTools).toHaveBeenCalledWith('intent');
    expect(blackBoxService.markAsCompletedDurably).toHaveBeenCalledWith('entry-1');
    expect(blackBoxService.markAsCompleted).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith('Widget gate mutation applied', {
      intent: 'mark-gate-complete',
      entryId: 'entry-1',
    });
  });
});
