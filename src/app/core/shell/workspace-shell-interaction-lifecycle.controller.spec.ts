import { describe, expect, it, vi } from 'vitest';

import { WorkspaceShellInteractionLifecycleController } from './workspace-shell-interaction-lifecycle.controller';

function createController() {
  const record: string[] = [];
  const push = (label: string) => vi.fn(() => record.push(label));
  const controller = new WorkspaceShellInteractionLifecycleController({
    sidebarResize: { setup: push('sidebarResize.setup'), teardown: push('sidebarResize.teardown') },
    viewportResize: { setup: push('viewportResize.setup'), cleanup: push('viewportResize.cleanup') },
    actions: {
      setupDocumentClickListener: push('actions.setupDocumentClickListener'),
      teardown: push('actions.teardown'),
    },
    authModal: { teardown: push('authModal.teardown') },
  });

  return { controller, record };
}

function createControllerWithThrowingSidebarTeardown() {
  const record: string[] = [];
  const controller = new WorkspaceShellInteractionLifecycleController({
    sidebarResize: {
      setup: vi.fn(() => record.push('sidebarResize.setup')),
      teardown: vi.fn(() => {
        record.push('sidebarResize.teardown');
        throw new Error('sidebar teardown failed');
      }),
    },
    viewportResize: {
      setup: vi.fn(() => record.push('viewportResize.setup')),
      cleanup: vi.fn(() => record.push('viewportResize.cleanup')),
    },
    actions: {
      setupDocumentClickListener: vi.fn(() => record.push('actions.setupDocumentClickListener')),
      teardown: vi.fn(() => record.push('actions.teardown')),
    },
    authModal: { teardown: vi.fn(() => record.push('authModal.teardown')) },
  });

  return { controller, record };
}

function createControllerWithRecoveringSidebarTeardown() {
  const record: string[] = [];
  const sidebarTeardown = vi
    .fn()
    .mockImplementationOnce(() => {
      record.push('sidebarResize.teardown');
      throw new Error('sidebar teardown failed');
    })
    .mockImplementationOnce(() => {
      record.push('sidebarResize.teardown');
    });
  const controller = new WorkspaceShellInteractionLifecycleController({
    sidebarResize: {
      setup: vi.fn(() => record.push('sidebarResize.setup')),
      teardown: sidebarTeardown,
    },
    viewportResize: {
      setup: vi.fn(() => record.push('viewportResize.setup')),
      cleanup: vi.fn(() => record.push('viewportResize.cleanup')),
    },
    actions: {
      setupDocumentClickListener: vi.fn(() => record.push('actions.setupDocumentClickListener')),
      teardown: vi.fn(() => record.push('actions.teardown')),
    },
    authModal: { teardown: vi.fn(() => record.push('authModal.teardown')) },
  });

  return { controller, record };
}

function createControllerWithFailingViewportSetup() {
  const record: string[] = [];
  const viewportSetup = vi
    .fn()
    .mockImplementationOnce(() => {
      record.push('viewportResize.setup');
      throw new Error('viewport setup failed');
    })
    .mockImplementationOnce(() => {
      record.push('viewportResize.setup');
    });
  const controller = new WorkspaceShellInteractionLifecycleController({
    sidebarResize: {
      setup: vi.fn(() => record.push('sidebarResize.setup')),
      teardown: vi.fn(() => record.push('sidebarResize.teardown')),
    },
    viewportResize: {
      setup: viewportSetup,
      cleanup: vi.fn(() => record.push('viewportResize.cleanup')),
    },
    actions: {
      setupDocumentClickListener: vi.fn(() => record.push('actions.setupDocumentClickListener')),
      teardown: vi.fn(() => record.push('actions.teardown')),
    },
    authModal: { teardown: vi.fn(() => record.push('authModal.teardown')) },
  });

  return { controller, record };
}

function createControllerWithFailingDocumentClickSetup() {
  const record: string[] = [];
  const setupDocumentClickListener = vi
    .fn()
    .mockImplementationOnce(() => {
      record.push('actions.setupDocumentClickListener');
      throw new Error('document click setup failed');
    })
    .mockImplementationOnce(() => {
      record.push('actions.setupDocumentClickListener');
    });
  const controller = new WorkspaceShellInteractionLifecycleController({
    sidebarResize: {
      setup: vi.fn(() => record.push('sidebarResize.setup')),
      teardown: vi.fn(() => record.push('sidebarResize.teardown')),
    },
    viewportResize: {
      setup: vi.fn(() => record.push('viewportResize.setup')),
      cleanup: vi.fn(() => record.push('viewportResize.cleanup')),
    },
    actions: {
      setupDocumentClickListener,
      teardown: vi.fn(() => record.push('actions.teardown')),
    },
    authModal: { teardown: vi.fn(() => record.push('authModal.teardown')) },
  });

  return { controller, record };
}

function createControllerWithFailingDocumentClickSetupAndFailingSidebarRollback() {
  const record: string[] = [];
  const setupDocumentClickListener = vi
    .fn()
    .mockImplementationOnce(() => {
      record.push('actions.setupDocumentClickListener');
      throw new Error('document click setup failed');
    })
    .mockImplementationOnce(() => {
      record.push('actions.setupDocumentClickListener');
    });
  const sidebarTeardown = vi
    .fn()
    .mockImplementationOnce(() => {
      record.push('sidebarResize.teardown');
      throw new Error('sidebar teardown failed');
    })
    .mockImplementationOnce(() => {
      record.push('sidebarResize.teardown');
    });
  const controller = new WorkspaceShellInteractionLifecycleController({
    sidebarResize: {
      setup: vi.fn(() => record.push('sidebarResize.setup')),
      teardown: sidebarTeardown,
    },
    viewportResize: {
      setup: vi.fn(() => record.push('viewportResize.setup')),
      cleanup: vi.fn(() => record.push('viewportResize.cleanup')),
    },
    actions: {
      setupDocumentClickListener,
      teardown: vi.fn(() => record.push('actions.teardown')),
    },
    authModal: { teardown: vi.fn(() => record.push('authModal.teardown')) },
  });

  return { controller, record };
}

function createControllerWithFailingViewportCleanup() {
  const record: string[] = [];
  const viewportCleanup = vi
    .fn()
    .mockImplementationOnce(() => {
      record.push('viewportResize.cleanup');
      throw new Error('viewport cleanup failed');
    })
    .mockImplementationOnce(() => {
      record.push('viewportResize.cleanup');
    });
  const controller = new WorkspaceShellInteractionLifecycleController({
    sidebarResize: {
      setup: vi.fn(() => record.push('sidebarResize.setup')),
      teardown: vi.fn(() => record.push('sidebarResize.teardown')),
    },
    viewportResize: {
      setup: vi.fn(() => record.push('viewportResize.setup')),
      cleanup: viewportCleanup,
    },
    actions: {
      setupDocumentClickListener: vi.fn(() => record.push('actions.setupDocumentClickListener')),
      teardown: vi.fn(() => record.push('actions.teardown')),
    },
    authModal: { teardown: vi.fn(() => record.push('authModal.teardown')) },
  });

  return { controller, record };
}

describe('WorkspaceShellInteractionLifecycleController', () => {
  it('sets up resize and document-click delegates for the ngOnInit stage', () => {
    const { controller, record } = createController();

    controller.setupNgOnInitStage();

    expect(record).toEqual([
      'sidebarResize.setup',
      'viewportResize.setup',
      'actions.setupDocumentClickListener',
    ]);
  });

  it('does not register ngOnInit interaction delegates more than once', () => {
    const { controller, record } = createController();

    controller.setupNgOnInitStage();
    controller.setupNgOnInitStage();

    expect(record).toEqual([
      'sidebarResize.setup',
      'viewportResize.setup',
      'actions.setupDocumentClickListener',
    ]);
  });

  it('rolls back successful ngOnInit delegates when viewport setup fails', () => {
    const { controller, record } = createControllerWithFailingViewportSetup();

    expect(() => controller.setupNgOnInitStage()).toThrow('viewport setup failed');
    expect(record).toEqual([
      'sidebarResize.setup',
      'viewportResize.setup',
      'sidebarResize.teardown',
    ]);

    controller.setupNgOnInitStage();

    expect(record).toEqual([
      'sidebarResize.setup',
      'viewportResize.setup',
      'sidebarResize.teardown',
      'sidebarResize.setup',
      'viewportResize.setup',
      'actions.setupDocumentClickListener',
    ]);
  });

  it('rolls back sidebar and viewport delegates when document-click setup fails', () => {
    const { controller, record } = createControllerWithFailingDocumentClickSetup();

    expect(() => controller.setupNgOnInitStage()).toThrow('document click setup failed');
    expect(record).toEqual([
      'sidebarResize.setup',
      'viewportResize.setup',
      'actions.setupDocumentClickListener',
      'viewportResize.cleanup',
      'sidebarResize.teardown',
    ]);

    controller.setupNgOnInitStage();

    expect(record).toEqual([
      'sidebarResize.setup',
      'viewportResize.setup',
      'actions.setupDocumentClickListener',
      'viewportResize.cleanup',
      'sidebarResize.teardown',
      'sidebarResize.setup',
      'viewportResize.setup',
      'actions.setupDocumentClickListener',
    ]);
  });

  it('does not duplicate a delegate whose rollback cleanup failed', () => {
    const { controller, record } =
      createControllerWithFailingDocumentClickSetupAndFailingSidebarRollback();

    expect(() => controller.setupNgOnInitStage()).toThrow('document click setup failed');
    expect(record).toEqual([
      'sidebarResize.setup',
      'viewportResize.setup',
      'actions.setupDocumentClickListener',
      'viewportResize.cleanup',
      'sidebarResize.teardown',
    ]);

    controller.setupNgOnInitStage();
    controller.teardownDestroyStage();

    expect(record).toEqual([
      'sidebarResize.setup',
      'viewportResize.setup',
      'actions.setupDocumentClickListener',
      'viewportResize.cleanup',
      'sidebarResize.teardown',
      'viewportResize.setup',
      'actions.setupDocumentClickListener',
      'sidebarResize.teardown',
      'authModal.teardown',
      'actions.teardown',
    ]);
  });

  it('tears down interaction delegates in the existing destroy stages once', () => {
    const { controller, record } = createController();

    controller.teardownDestroyStage();
    controller.teardownDestroyStage();
    controller.cleanupViewportStage();
    controller.cleanupViewportStage();

    expect(record).toEqual([
      'sidebarResize.teardown',
      'authModal.teardown',
      'actions.teardown',
      'viewportResize.cleanup',
    ]);
  });

  it('continues later teardown stages when one interaction delegate throws', () => {
    const { controller, record } = createControllerWithThrowingSidebarTeardown();

    expect(() => controller.teardown()).not.toThrow();

    expect(record).toEqual([
      'sidebarResize.teardown',
      'authModal.teardown',
      'actions.teardown',
      'viewportResize.cleanup',
    ]);
  });

  it('retries failed destroy-stage teardown steps without repeating successful releases', () => {
    const { controller, record } = createControllerWithRecoveringSidebarTeardown();

    expect(() => controller.teardownDestroyStage()).not.toThrow();
    expect(record).toEqual([
      'sidebarResize.teardown',
      'authModal.teardown',
      'actions.teardown',
    ]);

    controller.teardownDestroyStage();

    expect(record).toEqual([
      'sidebarResize.teardown',
      'authModal.teardown',
      'actions.teardown',
      'sidebarResize.teardown',
    ]);
  });

  it('allows viewport cleanup to retry when the first cleanup attempt throws', () => {
    const { controller, record } = createControllerWithFailingViewportCleanup();

    expect(() => controller.cleanupViewportStage()).not.toThrow();
    expect(record).toEqual([
      'viewportResize.cleanup',
    ]);

    controller.cleanupViewportStage();

    expect(record).toEqual([
      'viewportResize.cleanup',
      'viewportResize.cleanup',
    ]);
  });
});
