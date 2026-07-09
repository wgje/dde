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
