import { describe, expect, it, vi } from 'vitest';
import { Subscription } from 'rxjs';

import {
  createWorkspaceShellConflictHandlerController,
  type WorkspaceShellConflictHandlerFactoryOptions,
} from './workspace-shell-conflict-handler.factory';
import type { ConflictEvent } from '../../../services/sync-coordinator-conflicts.service';

function createConflictEvent(): ConflictEvent {
  return {
    projectId: 'project-1',
    localProject: {} as ConflictEvent['localProject'],
    remoteProject: {} as ConflictEvent['remoteProject'],
  };
}

describe('createWorkspaceShellConflictHandlerController', () => {
  it('maps sync conflict events into modal coordinator actions', () => {
    let listener: ((event: ConflictEvent) => void) | null = null;
    const readListener = (): ((event: ConflictEvent) => void) => {
      if (!listener) {
        throw new Error('Conflict listener was not registered');
      }
      return listener;
    };
    const unsubscribe = vi.fn();
    const syncCoordinator: WorkspaceShellConflictHandlerFactoryOptions['syncCoordinator'] = {
      onConflict$: {
        subscribe: vi.fn((next: (event: ConflictEvent) => void) => {
          listener = next;
          return new Subscription(unsubscribe);
        }),
      },
    };
    const modalCoord = {
      setPendingConflict: vi.fn(),
      openConflictModal: vi.fn(),
    };
    const warn = vi.fn();
    const controller = createWorkspaceShellConflictHandlerController({
      syncCoordinator,
      modalCoord,
      warn,
    });
    const event = createConflictEvent();

    controller.setup();
    readListener()(event);
    controller.cleanup();

    expect(syncCoordinator.onConflict$.subscribe).toHaveBeenCalledTimes(1);
    expect(modalCoord.setPendingConflict).toHaveBeenCalledWith(event);
    expect(modalCoord.openConflictModal).toHaveBeenCalledWith(event);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('wires modal open failures into the shell warning channel', async () => {
    let listener: ((event: ConflictEvent) => void) | null = null;
    const readListener = (): ((event: ConflictEvent) => void) => {
      if (!listener) {
        throw new Error('Conflict listener was not registered');
      }
      return listener;
    };
    const syncCoordinator: WorkspaceShellConflictHandlerFactoryOptions['syncCoordinator'] = {
      onConflict$: {
        subscribe: vi.fn((next: (event: ConflictEvent) => void) => {
          listener = next;
          return new Subscription();
        }),
      },
    };
    const error = new Error('modal failed');
    const modalCoord = {
      setPendingConflict: vi.fn(),
      openConflictModal: vi.fn().mockRejectedValueOnce(error),
    };
    const warn = vi.fn();
    const controller = createWorkspaceShellConflictHandlerController({
      syncCoordinator,
      modalCoord,
      warn,
    });
    const event = createConflictEvent();

    controller.setup();
    readListener()(event);
    await Promise.resolve();

    expect(modalCoord.setPendingConflict).toHaveBeenCalledWith(event);
    expect(warn).toHaveBeenCalledWith(
      'Workspace conflict modal open failed',
      error,
    );
  });
});
