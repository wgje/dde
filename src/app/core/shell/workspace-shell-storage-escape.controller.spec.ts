import { describe, expect, it, vi } from 'vitest';

import {
  WorkspaceShellStorageEscapeController,
  type WorkspaceShellStorageFailureData,
} from './workspace-shell-storage-escape.controller';
import type { DeadLetterItem, QueuedAction } from '../../../services/action-queue.types';

function createQueuedAction(id: string): QueuedAction {
  return {
    id,
    operationId: `op-${id}`,
    type: 'update',
    entityType: 'task',
    entityId: `task-${id}`,
    payload: {
      task: { id: `task-${id}` },
      projectId: 'project-1',
    } as QueuedAction['payload'],
    timestamp: 1,
    retryCount: 0,
  };
}

function createDeadLetter(action: QueuedAction): DeadLetterItem {
  return {
    action,
    failedAt: '2026-06-10T00:00:00.000Z',
    reason: 'storage failed',
  };
}

function createController() {
  const callbacks: Array<(data: WorkspaceShellStorageFailureData) => void> = [];
  const onStorageFailure = vi.fn((registered: (data: WorkspaceShellStorageFailureData) => void) => {
    callbacks.push(registered);
  });
  const setStorageEscapeData = vi.fn();
  const openStorageEscapeModalImperative = vi.fn();
  const closeStorageEscapeModal = vi.fn();
  const projects = [{ id: 'project-1' }];
  const controller = new WorkspaceShellStorageEscapeController({
    onStorageFailure,
    getProjects: () => projects,
    setStorageEscapeData,
    openStorageEscapeModalImperative,
    closeStorageEscapeModal,
    nowIso: () => '2026-06-10T08:00:00.000Z',
  });

  return {
    callback: () => callbacks.at(-1) ?? null,
    callbacks,
    closeStorageEscapeModal,
    controller,
    onStorageFailure,
    openStorageEscapeModalImperative,
    projects,
    setStorageEscapeData,
  };
}

describe('WorkspaceShellStorageEscapeController', () => {
  it('registers a storage failure callback', () => {
    const { controller, onStorageFailure } = createController();

    controller.setup();

    expect(onStorageFailure).toHaveBeenCalledWith(expect.any(Function));
  });

  it('builds storage escape data and opens the imperative modal on storage failure', () => {
    const {
      callback,
      controller,
      openStorageEscapeModalImperative,
      projects,
      setStorageEscapeData,
    } = createController();
    const queue = [createQueuedAction('1')];
    const deadLetter = [createDeadLetter(queue[0])];

    controller.setup();
    callback()?.({ queue, deadLetter });

    expect(setStorageEscapeData).toHaveBeenCalledWith({
      queue,
      deadLetter,
      projects,
      timestamp: '2026-06-10T08:00:00.000Z',
    });
    expect(openStorageEscapeModalImperative).toHaveBeenCalledTimes(1);
  });

  it('ignores storage failure callbacks after teardown', () => {
    const {
      callback,
      controller,
      openStorageEscapeModalImperative,
      setStorageEscapeData,
    } = createController();
    const queue = [createQueuedAction('1')];
    const deadLetter = [createDeadLetter(queue[0])];

    controller.setup();
    controller.teardown();
    callback()?.({ queue, deadLetter });

    expect(setStorageEscapeData).not.toHaveBeenCalled();
    expect(openStorageEscapeModalImperative).not.toHaveBeenCalled();
  });

  it('ignores storage failure callbacks from replaced setup generations', () => {
    const {
      callbacks,
      controller,
      openStorageEscapeModalImperative,
      setStorageEscapeData,
    } = createController();
    const queue = [createQueuedAction('1')];
    const deadLetter = [createDeadLetter(queue[0])];

    controller.setup();
    controller.setup();

    callbacks[0]?.({ queue, deadLetter });
    expect(setStorageEscapeData).not.toHaveBeenCalled();
    expect(openStorageEscapeModalImperative).not.toHaveBeenCalled();

    callbacks[1]?.({ queue, deadLetter });
    expect(setStorageEscapeData).toHaveBeenCalledTimes(1);
    expect(openStorageEscapeModalImperative).toHaveBeenCalledTimes(1);
  });

  it('delegates closing the storage escape modal', () => {
    const { closeStorageEscapeModal, controller } = createController();

    controller.close();

    expect(closeStorageEscapeModal).toHaveBeenCalledTimes(1);
  });
});
