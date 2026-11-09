import { Subject } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';

import { WorkspaceShellConflictHandlerController } from './workspace-shell-conflict-handler.controller';
import type { ConflictEvent } from '../../../services/sync-coordinator.service';

function createConflictEvent(overrides: Partial<ConflictEvent> = {}): ConflictEvent {
  return {
    localProject: { id: 'project-1' },
    remoteProject: { id: 'project-1' },
    projectId: 'project-1',
    pendingTaskDeleteIds: ['task-1'],
    ...overrides,
  } as ConflictEvent;
}

function createController() {
  const conflict$ = new Subject<ConflictEvent>();
  const setPendingConflict = vi.fn();
  const openConflictModal = vi.fn().mockResolvedValue(undefined);
  const warn = vi.fn();
  const controller = new WorkspaceShellConflictHandlerController({
    subscribeToConflictEvents: listener => conflict$.subscribe(listener),
    setPendingConflict,
    openConflictModal,
    warn,
  });

  return {
    conflict$,
    controller,
    openConflictModal,
    setPendingConflict,
    warn,
  };
}

describe('WorkspaceShellConflictHandlerController', () => {
  it('stores conflict data and opens the conflict modal when a conflict event arrives', () => {
    const { conflict$, controller, openConflictModal, setPendingConflict } = createController();
    const conflict = createConflictEvent();

    controller.setup();
    conflict$.next(conflict);

    expect(setPendingConflict).toHaveBeenCalledWith(conflict);
    expect(openConflictModal).toHaveBeenCalledWith(conflict);
  });

  it('replaces an existing subscription on setup and cleans it up', () => {
    const { conflict$, controller, openConflictModal } = createController();

    controller.setup();
    controller.setup();
    controller.cleanup();
    conflict$.next(createConflictEvent());

    expect(openConflictModal).not.toHaveBeenCalled();
  });

  it('contains asynchronous modal open failures from conflict events', async () => {
    const { conflict$, controller, openConflictModal, setPendingConflict, warn } = createController();
    const conflict = createConflictEvent();
    const error = new Error('modal failed');
    openConflictModal.mockRejectedValueOnce(error);

    controller.setup();
    conflict$.next(conflict);

    expect(setPendingConflict).toHaveBeenCalledWith(conflict);
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith(
        'Workspace conflict modal open failed',
        error,
      );
    });
  });

  it('contains synchronous modal open failures from conflict events', () => {
    const { conflict$, controller, openConflictModal, setPendingConflict, warn } = createController();
    const conflict = createConflictEvent();
    const error = new Error('modal sync failed');
    openConflictModal.mockImplementationOnce(() => {
      throw error;
    });

    controller.setup();

    expect(() => conflict$.next(conflict)).not.toThrow();
    expect(setPendingConflict).toHaveBeenCalledWith(conflict);
    expect(warn).toHaveBeenCalledWith(
      'Workspace conflict modal open failed',
      error,
    );
  });

  it('contains modal warning sink failures from conflict events', () => {
    const { conflict$, controller, openConflictModal, setPendingConflict, warn } = createController();
    const conflict = createConflictEvent();
    const modalError = new Error('modal sync failed');
    warn.mockImplementationOnce(() => {
      throw new Error('warning sink failed');
    });
    openConflictModal.mockImplementationOnce(() => {
      throw modalError;
    });

    controller.setup();

    expect(() => conflict$.next(conflict)).not.toThrow();
    expect(setPendingConflict).toHaveBeenCalledWith(conflict);
    expect(warn).toHaveBeenCalledWith(
      'Workspace conflict modal open failed',
      modalError,
    );
  });

  it('contains subscription cleanup failures while replacing conflict listeners', () => {
    const conflict$ = new Subject<ConflictEvent>();
    const unsubscribeError = new Error('conflict subscription cleanup failed');
    const firstSubscription = {
      unsubscribe: vi.fn(() => {
        throw unsubscribeError;
      }),
    };
    const secondSubscription = {
      unsubscribe: vi.fn(),
    };
    const subscribeToConflictEvents = vi.fn()
      .mockReturnValueOnce(firstSubscription)
      .mockReturnValueOnce(secondSubscription);
    const openConflictModal = vi.fn().mockResolvedValue(undefined);
    const warn = vi.fn();
    const controller = new WorkspaceShellConflictHandlerController({
      subscribeToConflictEvents,
      setPendingConflict: vi.fn(),
      openConflictModal,
      warn,
    });

    controller.setup();

    expect(() => controller.setup()).not.toThrow();
    controller.cleanup();
    conflict$.next(createConflictEvent());

    expect(openConflictModal).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      'Workspace conflict subscription cleanup failed',
      unsubscribeError,
    );
  });

  it('clears subscription state when cleanup warning sink fails', () => {
    const unsubscribeError = new Error('conflict subscription cleanup failed');
    const firstSubscription = {
      unsubscribe: vi.fn(() => {
        throw unsubscribeError;
      }),
    };
    const subscribeToConflictEvents = vi.fn().mockReturnValueOnce(firstSubscription);
    const warn = vi.fn(() => {
      throw new Error('warning sink failed');
    });
    const controller = new WorkspaceShellConflictHandlerController({
      subscribeToConflictEvents,
      setPendingConflict: vi.fn(),
      openConflictModal: vi.fn().mockResolvedValue(undefined),
      warn,
    });

    controller.setup();

    expect(() => controller.cleanup()).not.toThrow();
    controller.cleanup();

    expect(firstSubscription.unsubscribe).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      'Workspace conflict subscription cleanup failed',
      unsubscribeError,
    );
  });
});
