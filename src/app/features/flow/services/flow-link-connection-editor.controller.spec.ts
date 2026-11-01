import { signal } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FlowLinkConnectionEditorController } from './flow-link-connection-editor.controller';
import type {
  ConnectionEditorData,
  PanelPosition,
} from '../../../../models/flow-view-state';
import type { Task } from '../../../../models';

describe('FlowLinkConnectionEditorController', () => {
  let connectionEditorData: ReturnType<typeof signal<ConnectionEditorData | null>>;
  let connectionEditorPos: ReturnType<typeof signal<PanelPosition>>;
  let guardMutation: ReturnType<typeof vi.fn<(actionLabel: string) => boolean>>;
  let getTask: ReturnType<typeof vi.fn<(taskId: string) => Task | null | undefined>>;
  let updateConnectionContent: ReturnType<typeof vi.fn<(
    sourceId: string,
    targetId: string,
    title: string,
    description: string,
  ) => Promise<boolean>>>;
  let removeConnection: ReturnType<typeof vi.fn<(sourceId: string, targetId: string) => Promise<boolean>>>;
  let detachTask: ReturnType<typeof vi.fn<(taskId: string) => Promise<boolean>>>;
  let ownerGeneration: number;
  let controller: FlowLinkConnectionEditorController;

  beforeEach(() => {
    vi.useFakeTimers();
    connectionEditorData = signal<ConnectionEditorData | null>(null);
    connectionEditorPos = signal<PanelPosition>({ x: 0, y: 0 });
    guardMutation = vi.fn<(actionLabel: string) => boolean>(() => false);
    getTask = vi.fn<(taskId: string) => Task | null | undefined>(() => null);
    updateConnectionContent = vi.fn<(
      sourceId: string,
      targetId: string,
      title: string,
      description: string,
    ) => Promise<boolean>>().mockResolvedValue(true);
    removeConnection = vi.fn<(sourceId: string, targetId: string) => Promise<boolean>>().mockResolvedValue(true);
    detachTask = vi.fn<(taskId: string) => Promise<boolean>>().mockResolvedValue(true);
    ownerGeneration = 1;

    controller = new FlowLinkConnectionEditorController({
      connectionEditorData,
      connectionEditorPos,
      drag: {
        currentDiagramBounds: null,
        start: vi.fn(),
        updateDiagramBounds: vi.fn(),
        dispose: vi.fn(),
      },
      isMobile: () => true,
      guardMutation,
      getTask,
      updateConnectionContent,
      removeConnection,
      detachTask,
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
      },
      captureOperationOwner: () => ({ projectId: 'project-1', generation: ownerGeneration }),
      isOperationOwnerCurrent: owner =>
        owner.projectId === 'project-1' && owner.generation === ownerGeneration,
    });
  });

  afterEach(() => {
    controller.dispose();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('opens a new editor and arms the background close guard', () => {
    controller.open('source-task', 'target-task', 'Description', 200, 300, 'Title', {
      isCrossTree: true,
      mode: 'preview',
    });

    expect(connectionEditorPos()).toEqual({ x: 96, y: 110 });
    expect(connectionEditorData()).toMatchObject({
      sourceId: 'source-task',
      targetId: 'target-task',
      title: 'Title',
      description: 'Description',
      isCrossTree: true,
      mode: 'preview',
      x: 96,
      y: 110,
    });
    expect(controller.shouldIgnoreBackgroundClose()).toBe(true);

    vi.advanceTimersByTime(350);
    expect(controller.shouldIgnoreBackgroundClose()).toBe(false);
  });

  it('updates connection content and keeps the open editor in sync', async () => {
    connectionEditorData.set(editor());

    await expect(controller.saveContent('source-task', 'target-task', 'New title', 'New description')).resolves.toBe(true);

    expect(updateConnectionContent).toHaveBeenCalledWith(
      'source-task',
      'target-task',
      'New title',
      'New description'
    );
    expect(connectionEditorData()).toMatchObject({
      title: 'New title',
      description: 'New description',
    });
  });

  it('keeps existing editor content when durable content save fails', async () => {
    connectionEditorData.set(editor());
    updateConnectionContent.mockResolvedValueOnce(false);

    await expect(controller.saveContent('source-task', 'target-task', 'New title', 'New description')).resolves.toBe(false);

    expect(connectionEditorData()).toMatchObject({
      title: 'Old title',
      description: 'Old description',
    });
  });

  it('does not publish a save into the same editor reopened after close', async () => {
    const save = createDeferred<boolean>();
    connectionEditorData.set(editor({ title: 'Original A' }));
    updateConnectionContent.mockReturnValueOnce(save.promise);

    const pending = controller.saveContent('source-task', 'target-task', 'Saved A', 'Saved A description');
    controller.close();
    connectionEditorData.set(editor({ title: 'Reopened A', description: 'Reopened description' }));
    save.resolve(true);

    await expect(pending).resolves.toBe(true);
    expect(connectionEditorData()).toMatchObject({
      title: 'Reopened A',
      description: 'Reopened description',
    });
  });

  it('does not publish a save into the same editor reopened after reset', async () => {
    const save = createDeferred<boolean>();
    connectionEditorData.set(editor({ title: 'Original A' }));
    updateConnectionContent.mockReturnValueOnce(save.promise);

    const pending = controller.saveContent('source-task', 'target-task', 'Saved A', 'Saved A description');
    controller.reset();
    connectionEditorData.set(editor({ title: 'Reset A', description: 'Reset description' }));
    save.resolve(true);

    await expect(pending).resolves.toBe(true);
    expect(connectionEditorData()).toMatchObject({
      title: 'Reset A',
      description: 'Reset description',
    });
  });

  it('does not publish a save after A to B editor replacement', async () => {
    const save = createDeferred<boolean>();
    connectionEditorData.set(editor({ title: 'Editor A' }));
    updateConnectionContent.mockReturnValueOnce(save.promise);

    const pending = controller.saveContent('source-task', 'target-task', 'Saved A', 'Saved A description');
    connectionEditorData.set(editor({
      sourceId: 'source-b',
      targetId: 'target-b',
      title: 'Editor B',
    }));
    save.resolve(true);

    await expect(pending).resolves.toBe(true);
    expect(connectionEditorData()).toMatchObject({
      sourceId: 'source-b',
      targetId: 'target-b',
      title: 'Editor B',
    });
  });

  it('does not publish a save after A to B to A session reuse', async () => {
    const save = createDeferred<boolean>();
    controller.open('source-task', 'target-task', 'Original description', 100, 100, 'Original A');
    updateConnectionContent.mockReturnValueOnce(save.promise);

    const pending = controller.saveContent('source-task', 'target-task', 'Saved A', 'Saved A description');
    controller.open('source-b', 'target-b', 'B description', 120, 120, 'Editor B');
    controller.open('source-task', 'target-task', 'Newest description', 140, 140, 'Newest A');
    save.resolve(true);

    await expect(pending).resolves.toBe(true);
    expect(connectionEditorData()).toMatchObject({
      sourceId: 'source-task',
      targetId: 'target-task',
      title: 'Newest A',
      description: 'Newest description',
    });
  });

  it('rejects direct same-key editor instance replacement while a save is pending', async () => {
    const save = createDeferred<boolean>();
    connectionEditorData.set(editor({ title: 'Original instance' }));
    updateConnectionContent.mockReturnValueOnce(save.promise);

    const pending = controller.saveContent('source-task', 'target-task', 'Saved A', 'Saved A description');
    connectionEditorData.set(editor({ title: 'Replacement instance', description: 'Replacement description' }));
    save.resolve(true);

    await expect(pending).resolves.toBe(true);
    expect(connectionEditorData()).toMatchObject({
      title: 'Replacement instance',
      description: 'Replacement description',
    });
  });

  it('serializes connection content saves so an older request cannot settle after a newer draft', async () => {
    const firstSave = createDeferred<boolean>();
    const secondSave = createDeferred<boolean>();
    connectionEditorData.set(editor());
    updateConnectionContent
      .mockReturnValueOnce(firstSave.promise)
      .mockReturnValueOnce(secondSave.promise);

    const first = controller.saveContent('source-task', 'target-task', 'First title', 'First description');
    const second = controller.saveContent('source-task', 'target-task', 'Second title', 'Second description');

    expect(updateConnectionContent).toHaveBeenCalledTimes(1);

    firstSave.resolve(true);
    await expect(first).resolves.toBe(true);
    await Promise.resolve();

    expect(updateConnectionContent).toHaveBeenCalledTimes(2);
    expect(connectionEditorData()).toMatchObject({
      title: 'Old title',
      description: 'Old description',
    });
    expect(updateConnectionContent).toHaveBeenLastCalledWith(
      'source-task',
      'target-task',
      'Second title',
      'Second description',
    );

    secondSave.resolve(true);
    await expect(second).resolves.toBe(true);
    expect(connectionEditorData()).toMatchObject({
      title: 'Second title',
      description: 'Second description',
    });
  });

  it('isolates save queues by connection while preserving order within each connection', async () => {
    const firstConnectionSave = createDeferred<boolean>();
    const secondConnectionSave = createDeferred<boolean>();
    const laterFirstConnectionSave = createDeferred<boolean>();
    updateConnectionContent
      .mockReturnValueOnce(firstConnectionSave.promise)
      .mockReturnValueOnce(secondConnectionSave.promise)
      .mockReturnValueOnce(laterFirstConnectionSave.promise);

    const first = controller.saveContent('source-a', 'target-a', 'A1', 'A1 description');
    const second = controller.saveContent('source-b', 'target-b', 'B1', 'B1 description');
    const laterFirst = controller.saveContent('source-a', 'target-a', 'A2', 'A2 description');

    expect(updateConnectionContent).toHaveBeenCalledTimes(2);
    expect(updateConnectionContent).toHaveBeenNthCalledWith(
      1,
      'source-a',
      'target-a',
      'A1',
      'A1 description',
    );
    expect(updateConnectionContent).toHaveBeenNthCalledWith(
      2,
      'source-b',
      'target-b',
      'B1',
      'B1 description',
    );

    secondConnectionSave.resolve(true);
    await expect(second).resolves.toBe(true);
    expect(updateConnectionContent).toHaveBeenCalledTimes(2);

    firstConnectionSave.resolve(true);
    await expect(first).resolves.toBe(true);
    await Promise.resolve();

    expect(updateConnectionContent).toHaveBeenCalledTimes(3);
    expect(updateConnectionContent).toHaveBeenLastCalledWith(
      'source-a',
      'target-a',
      'A2',
      'A2 description',
    );

    laterFirstConnectionSave.resolve(true);
    await expect(laterFirst).resolves.toBe(true);
  });

  it('deletes the current cross-tree connection and closes the editor', async () => {
    connectionEditorData.set(editor({ isCrossTree: true }));

    await expect(controller.deleteCurrent()).resolves.toBe(true);

    expect(removeConnection).toHaveBeenCalledWith('source-task', 'target-task');
    expect(detachTask).not.toHaveBeenCalled();
    expect(connectionEditorData()).toBeNull();
  });

  it('keeps the current editor open when durable delete fails', async () => {
    connectionEditorData.set(editor({ isCrossTree: true }));
    removeConnection.mockResolvedValueOnce(false);

    await expect(controller.deleteCurrent()).resolves.toBe(false);

    expect(connectionEditorData()).toMatchObject({
      sourceId: 'source-task',
      targetId: 'target-task',
    });
  });

  it('does not let a stale delete close an A editor reopened after A to B to A', async () => {
    const deletion = createDeferred<boolean>();
    controller.open('source-task', 'target-task', 'Original description', 100, 100, 'Original A');
    removeConnection.mockReturnValueOnce(deletion.promise);

    const pending = controller.deleteCurrent();
    controller.open('source-b', 'target-b', 'B description', 120, 120, 'Editor B');
    controller.open('source-task', 'target-task', 'Newest description', 140, 140, 'Newest A');
    deletion.resolve(true);

    await expect(pending).resolves.toBe(true);
    expect(connectionEditorData()).toMatchObject({
      sourceId: 'source-task',
      targetId: 'target-task',
      title: 'Newest A',
    });
  });

  it('allows only the latest delete attempt in a session to close the editor', async () => {
    const firstDelete = createDeferred<boolean>();
    const secondDelete = createDeferred<boolean>();
    connectionEditorData.set(editor());
    removeConnection
      .mockReturnValueOnce(firstDelete.promise)
      .mockReturnValueOnce(secondDelete.promise);

    const first = controller.deleteCurrent();
    const second = controller.deleteCurrent();
    firstDelete.resolve(true);

    await expect(first).resolves.toBe(true);
    expect(connectionEditorData()).toMatchObject({ sourceId: 'source-task' });

    secondDelete.resolve(true);
    await expect(second).resolves.toBe(true);
    expect(connectionEditorData()).toBeNull();
  });

  it('keeps save and delete attempt ownership independent', async () => {
    const save = createDeferred<boolean>();
    const deletion = createDeferred<boolean>();
    connectionEditorData.set(editor());
    updateConnectionContent.mockReturnValueOnce(save.promise);
    removeConnection.mockReturnValueOnce(deletion.promise);

    const pendingSave = controller.saveContent('source-task', 'target-task', 'Saved title', 'Saved description');
    const pendingDelete = controller.deleteCurrent();
    save.resolve(true);

    await expect(pendingSave).resolves.toBe(true);
    expect(connectionEditorData()).toMatchObject({ title: 'Saved title' });

    deletion.resolve(true);
    await expect(pendingDelete).resolves.toBe(true);
    expect(connectionEditorData()).toBeNull();
  });

  it('preserves operation results while owner drift suppresses save and delete publication', async () => {
    const save = createDeferred<boolean>();
    const deletion = createDeferred<boolean>();
    connectionEditorData.set(editor());
    updateConnectionContent.mockReturnValueOnce(save.promise);
    removeConnection.mockReturnValueOnce(deletion.promise);

    const pendingSave = controller.saveContent('source-task', 'target-task', 'Saved title', 'Saved description');
    const pendingDelete = controller.deleteCurrent();
    ownerGeneration += 1;
    save.resolve(true);
    deletion.resolve(true);

    await expect(pendingSave).resolves.toBe(true);
    await expect(pendingDelete).resolves.toBe(true);
    expect(connectionEditorData()).toMatchObject({
      title: 'Old title',
      description: 'Old description',
    });
  });

  it('detaches a replacement editor save from the retired same-key queue', async () => {
    const saveA = createDeferred<boolean>();
    const saveB = createDeferred<boolean>();
    updateConnectionContent.mockReturnValueOnce(saveA.promise).mockReturnValueOnce(saveB.promise);
    connectionEditorData.set(editor({ title: 'A title', description: 'A description' }));
    const pendingA = controller.saveContent('source-task', 'target-task', 'Saved A', 'Saved A description');

    controller.dispose();
    connectionEditorData.set(editor({ title: 'B title', description: 'B description' }));
    const pendingB = controller.saveContent('source-task', 'target-task', 'Saved B', 'Saved B description');

    expect(updateConnectionContent).toHaveBeenCalledTimes(2);
    saveB.resolve(true);
    await expect(pendingB).resolves.toBe(true);
    saveA.resolve(true);
    await expect(pendingA).resolves.toBe(true);
    expect(connectionEditorData()).toMatchObject({ title: 'Saved B', description: 'Saved B description' });
  });

  it('does not let a retired delete close its replacement editor', async () => {
    const deleteA = createDeferred<boolean>();
    removeConnection.mockReturnValueOnce(deleteA.promise);
    connectionEditorData.set(editor({ title: 'A title' }));
    const pendingA = controller.deleteCurrent();

    controller.dispose();
    connectionEditorData.set(editor({ title: 'B title' }));
    deleteA.resolve(true);

    await expect(pendingA).resolves.toBe(true);
    expect(connectionEditorData()).toMatchObject({ title: 'B title' });
  });

  it('returns source and target tasks for the current editor', () => {
    const source = task('source-task');
    const target = task('target-task');
    connectionEditorData.set(editor());
    getTask.mockImplementation((id: string) => id === 'source-task' ? source : target);

    expect(controller.getTasks()).toEqual({ source, target });
  });

  it('blocks guarded edit mutations without changing editor data', async () => {
    connectionEditorData.set(editor({ mode: 'preview' }));
    guardMutation.mockReturnValue(true);

    controller.setMode('edit');
    const saved = await controller.saveContent('source-task', 'target-task', 'New title', 'New description');
    const deleted = await controller.deleteCurrent();

    expect(connectionEditorData()).toMatchObject({ mode: 'preview', title: 'Old title' });
    expect(saved).toBe(false);
    expect(deleted).toBe(false);
    expect(updateConnectionContent).not.toHaveBeenCalled();
    expect(removeConnection).not.toHaveBeenCalled();
  });
});

function editor(overrides: Partial<ConnectionEditorData> = {}): ConnectionEditorData {
  return {
    sourceId: 'source-task',
    targetId: 'target-task',
    title: 'Old title',
    description: 'Old description',
    isCrossTree: true,
    mode: 'preview',
    x: 120,
    y: 220,
    ...overrides,
  };
}

function task(id: string): Task {
  return {
    id,
    title: id,
    content: '',
    stage: 1,
    parentId: null,
    order: 0,
    rank: 0,
    status: 'active',
    x: 0,
    y: 0,
    createdDate: '2026-06-09T00:00:00.000Z',
    updatedAt: '2026-06-09T00:00:00.000Z',
    displayId: id,
  };
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
