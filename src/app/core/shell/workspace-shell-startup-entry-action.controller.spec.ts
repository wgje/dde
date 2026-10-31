import { describe, expect, it, vi } from 'vitest';

import type { StartupEntryIntent } from '../../../utils/startup-entry-intent';
import { WorkspaceShellStartupEntryActionController } from './workspace-shell-startup-entry-action.controller';

function startupIntent(input: Partial<StartupEntryIntent>): StartupEntryIntent {
  return {
    entry: 'shortcut',
    intent: 'open-focus-tools',
    rawIntent: 'open-focus-tools',
    widgetGateEntryId: null,
    ...input,
  };
}

function createController(overrides: { blackBoxEnabled?: boolean } = {}) {
  const loadBlackBoxRecorder = vi.fn();
  const mutationEffect = {
    apply: vi.fn(),
    teardown: vi.fn(),
  };
  const activateSidebarTools = vi.fn();
  const preloadSidebarTools = vi.fn();
  const primeWidgetWorkspaceGateSync = vi.fn();
  const setSidebarOpen = vi.fn();
  const warn = vi.fn();
  const controller = new WorkspaceShellStartupEntryActionController({
    isBlackBoxEnabled: () => overrides.blackBoxEnabled ?? true,
    setSidebarOpen,
    activateSidebarTools,
    preloadSidebarTools,
    loadBlackBoxRecorder,
    primeWidgetWorkspaceGateSync,
    mutationEffect,
    warn,
  });

  return {
    controller,
    activateSidebarTools,
    loadBlackBoxRecorder,
    mutationEffect,
    preloadSidebarTools,
    primeWidgetWorkspaceGateSync,
    setSidebarOpen,
    warn,
  };
}

describe('WorkspaceShellStartupEntryActionController', () => {
  it('primes the widget workspace gate even when no startup action is required', () => {
    const { controller, primeWidgetWorkspaceGateSync } = createController();
    const intent = startupIntent({
      intent: 'open-workspace',
      rawIntent: 'open-workspace',
    });

    const deferredClearOwner = controller.apply(intent, null);

    expect(primeWidgetWorkspaceGateSync).toHaveBeenCalledWith(intent);
    expect(deferredClearOwner).toBe('caller');
  });

  it('delegates widget gate mutations to the mutation effect', () => {
    const { controller, mutationEffect } = createController();
    const context = {
      clearDeferredAfterSuccess: true,
      onFailure: vi.fn(),
    };

    const deferredClearOwner = controller.apply(startupIntent({
      intent: 'mark-gate-read',
      rawIntent: 'mark-gate-read',
      widgetGateEntryId: 'entry-1',
    }), context);

    expect(mutationEffect.apply).toHaveBeenCalledWith({
      intent: 'mark-gate-read',
      widgetGateEntryId: 'entry-1',
    }, context);
    expect(deferredClearOwner).toBe('mutation-effect');
  });

  it('opens and preloads sidebar tools for focus tool intents', () => {
    const {
      activateSidebarTools,
      controller,
      loadBlackBoxRecorder,
      preloadSidebarTools,
      setSidebarOpen,
    } = createController();

    const deferredClearOwner = controller.apply(startupIntent({}), null);

    expect(setSidebarOpen).toHaveBeenCalledWith(true);
    expect(activateSidebarTools).toHaveBeenCalledTimes(1);
    expect(preloadSidebarTools).toHaveBeenCalledWith('intent');
    expect(loadBlackBoxRecorder).not.toHaveBeenCalled();
    expect(deferredClearOwner).toBe('caller');
  });

  it('loads the black box recorder for enabled recorder intents', () => {
    const { controller, loadBlackBoxRecorder } = createController();

    controller.apply(startupIntent({
      intent: 'open-blackbox-recorder',
      rawIntent: 'open-blackbox-recorder',
    }), null);

    expect(loadBlackBoxRecorder).toHaveBeenCalledTimes(1);
  });

  it('does not load the recorder when black box tools are disabled', () => {
    const { controller, loadBlackBoxRecorder } = createController({ blackBoxEnabled: false });

    controller.apply(startupIntent({
      intent: 'open-blackbox-recorder',
      rawIntent: 'open-blackbox-recorder',
    }), null);

    expect(loadBlackBoxRecorder).not.toHaveBeenCalled();
  });

  it('isolates asynchronous recorder preload failures', async () => {
    const { controller, loadBlackBoxRecorder, warn } = createController();
    const error = new Error('recorder import failed');
    loadBlackBoxRecorder.mockRejectedValue(error);

    controller.apply(startupIntent({
      intent: 'open-blackbox-recorder',
      rawIntent: 'open-blackbox-recorder',
    }), null);

    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(
      'Startup entry black box recorder preload failed',
      error,
    ));
  });

  it('isolates synchronous recorder preload failures and warning sink failures', () => {
    const { controller, loadBlackBoxRecorder, warn } = createController();
    loadBlackBoxRecorder.mockImplementation(() => {
      throw new Error('recorder import threw');
    });
    warn.mockImplementation(() => {
      throw new Error('warning sink failed');
    });

    expect(() => controller.apply(startupIntent({
      intent: 'open-blackbox-recorder',
      rawIntent: 'open-blackbox-recorder',
    }), null)).not.toThrow();
  });

  it('tears down the mutation effect and suppresses late recorder failures', async () => {
    const { controller, loadBlackBoxRecorder, mutationEffect, warn } = createController();
    let rejectPreload!: (reason?: unknown) => void;
    loadBlackBoxRecorder.mockImplementation(() => new Promise<void>((_resolve, reject) => {
      rejectPreload = reject;
    }));

    controller.apply(startupIntent({
      intent: 'open-blackbox-recorder',
      rawIntent: 'open-blackbox-recorder',
    }), null);
    controller.teardown();
    rejectPreload(new Error('late recorder failure'));
    await Promise.resolve();
    await Promise.resolve();

    expect(mutationEffect.teardown).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });
});
