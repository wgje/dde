import { describe, expect, it, vi } from 'vitest';

import { createWorkspaceShellStartupBootstrapController } from './workspace-shell-startup-bootstrap.factory';

function createController(overrides: {
  isMobile?: () => boolean;
} = {}) {
  const record: string[] = [];
  const push = (label: string) => vi.fn(() => record.push(label));
  const callbacks = { onLogin: vi.fn() };
  const controller = createWorkspaceShellStartupBootstrapController({
    isMobile: overrides.isMobile ?? (() => false),
    isSidebarOpen: { set: (open: boolean) => record.push(`sidebarOpen.set:${open}`) },
    lazyLifecycles: { initializeConstructorStage: push('lazyLifecycles.initializeConstructorStage') },
    conflictHandler: { setup: push('conflictHandler.setup') },
    sidebarToggleEvent: { setup: push('sidebarToggleEvent.setup') },
    storageEscape: {
      setup: push('storageEscape.setup'),
      teardown: push('storageEscape.teardown'),
    },
    beforeUnloadController: { setup: push('beforeUnloadController.setup') },
    modalCallbacks: {
      createCallbacks: vi.fn(() => {
        record.push('modalCallbacks.createCallbacks');
        return callbacks;
      }),
    },
    modalCoord: { initCallbacks: vi.fn(() => record.push('modalCoord.initCallbacks')) },
    appLifecycle: { initialize: push('appLifecycle.initialize') },
    userSession: { prehydrateFromSnapshot: push('userSession.prehydrateFromSnapshot') },
    androidWidgetLazyLoad: { restoreAll: push('androidWidgetLazyLoad.restoreAll') },
    signalEffects: { setup: push('signalEffects.setup') },
  });

  return { callbacks, controller, record };
}

describe('createWorkspaceShellStartupBootstrapController', () => {
  it('wires constructor-stage startup dependencies into the bootstrap controller', () => {
    const { controller, record } = createController();

    controller.initialize();

    expect(record).toEqual([
      'lazyLifecycles.initializeConstructorStage',
      'conflictHandler.setup',
      'sidebarToggleEvent.setup',
      'storageEscape.setup',
      'beforeUnloadController.setup',
      'modalCallbacks.createCallbacks',
      'modalCoord.initCallbacks',
      'appLifecycle.initialize',
      'userSession.prehydrateFromSnapshot',
      'androidWidgetLazyLoad.restoreAll',
      'signalEffects.setup',
    ]);
  });

  it('maps mobile startup to the sidebar-open signal setter', () => {
    const { controller, record } = createController({
      isMobile: () => true,
    });

    controller.initialize();

    expect(record[0]).toBe('sidebarOpen.set:false');
  });
});
