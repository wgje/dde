import { TestBed } from '@angular/core/testing';
import * as go from 'gojs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LoggerService } from '../../../../services/logger.service';
import { TaskOperationAdapterService } from '../../../../services/task-operation-adapter.service';
import { FlowDiagramService } from './flow-diagram.service';
import { FlowKeyboardService } from './flow-keyboard.service';
import { FlowLinkService } from './flow-link.service';
import { FlowSelectionService } from './flow-selection.service';

function makeKeyboardEvent(
  key: string,
  altKey = true,
  repeat = false,
  target: EventTarget | null = null,
): KeyboardEvent {
  return {
    key,
    altKey,
    repeat,
    target,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  } as unknown as KeyboardEvent;
}

function makeDiagramSelection(items: unknown[]) {
  return {
    selection: {
      each: (callback: (part: unknown) => void) => {
        items.forEach(callback);
      },
    },
  };
}

describe('FlowKeyboardService', () => {
  let service: FlowKeyboardService;
  let diagram: { isInitialized: boolean; diagramInstance: unknown };
  let selection: { getSelectedNodeKeys: ReturnType<typeof vi.fn> };
  let taskOps: { detachTask: ReturnType<typeof vi.fn> };
  let link: { handleDeleteCrossTreeLinks: ReturnType<typeof vi.fn> };
  let logger: { warn: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    diagram = {
      isInitialized: true,
      diagramInstance: makeDiagramSelection([]),
    };
    selection = {
      getSelectedNodeKeys: vi.fn(() => []),
    };
    taskOps = {
      detachTask: vi.fn().mockResolvedValue(true),
    };
    link = {
      handleDeleteCrossTreeLinks: vi.fn(),
    };
    logger = {
      warn: vi.fn(),
    };

    TestBed.configureTestingModule({
      providers: [
        FlowKeyboardService,
        { provide: FlowDiagramService, useValue: diagram },
        { provide: FlowSelectionService, useValue: selection },
        { provide: TaskOperationAdapterService, useValue: taskOps },
        { provide: FlowLinkService, useValue: link },
        { provide: LoggerService, useValue: { category: () => logger } },
      ],
    });

    service = TestBed.inject(FlowKeyboardService);
  });

  it('ignores shortcuts when the diagram is not ready or Alt is not pressed', () => {
    diagram.isInitialized = false;
    expect(service.handleShortcut(makeKeyboardEvent('z'))).toEqual({ status: 'not-handled' });

    diagram.isInitialized = true;
    expect(service.handleShortcut(makeKeyboardEvent('z', false))).toEqual({ status: 'not-handled' });

    expect(taskOps.detachTask).not.toHaveBeenCalled();
  });

  it('detaches selected tasks for Alt+Z', async () => {
    selection.getSelectedNodeKeys.mockReturnValue(['task-1', 'task-2']);
    const event = makeKeyboardEvent('Z');

    const result = service.handleShortcut(event);

    expect(result.status).toBe('handled');
    if (result.status === 'handled') {
      await result.completed;
    }
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopPropagation).toHaveBeenCalledOnce();
    expect(taskOps.detachTask).toHaveBeenCalledWith('task-1');
    expect(taskOps.detachTask).toHaveBeenCalledWith('task-2');
  });

  it('logs rejected or failed Alt+Z detach operations without surfacing an unhandled rejection', async () => {
    const error = new Error('detach rejected');
    selection.getSelectedNodeKeys.mockReturnValue(['task-1', 'task-2']);
    taskOps.detachTask
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(false);
    const event = makeKeyboardEvent('Z');

    const result = service.handleShortcut(event);

    expect(result.status).toBe('handled');
    if (result.status === 'handled') {
      await result.completed;
    }
    expect(logger.warn).toHaveBeenCalledWith(
      '解除父子关系快捷键执行失败',
      expect.objectContaining({
        failedTaskIds: ['task-1', 'task-2'],
        selectedCount: 2,
      }),
    );
  });

  it('exposes Alt+Z completion only after all detach operations settle', async () => {
    let resolveDetach!: () => void;
    selection.getSelectedNodeKeys.mockReturnValue(['task-1']);
    taskOps.detachTask.mockReturnValueOnce(new Promise<boolean>(resolve => {
      resolveDetach = () => resolve(true);
    }));
    const event = makeKeyboardEvent('Z');

    const result = service.handleShortcut(event);
    expect(result.status).toBe('handled');
    if (result.status !== 'handled') {
      throw new Error('expected handled shortcut result');
    }

    let completed = false;
    void result.completed.then(() => {
      completed = true;
    });
    await Promise.resolve();

    expect(completed).toBe(false);

    resolveDetach();
    await result.completed;
    await Promise.resolve();

    expect(completed).toBe(true);
  });

  it('ignores repeated destructive shortcuts while a key is held down', () => {
    selection.getSelectedNodeKeys.mockReturnValue(['task-1']);
    const event = makeKeyboardEvent('Z', true, true);

    expect(service.handleShortcut(event)).toEqual({ status: 'not-handled' });

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.stopPropagation).not.toHaveBeenCalled();
    expect(taskOps.detachTask).not.toHaveBeenCalled();
  });

  it('ignores Alt shortcuts from editable targets', () => {
    selection.getSelectedNodeKeys.mockReturnValue(['task-1']);
    const input = document.createElement('input');
    const textarea = document.createElement('textarea');
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');

    for (const target of [input, textarea, editable]) {
      const event = makeKeyboardEvent('Z', true, false, target);

      expect(service.handleShortcut(event)).toEqual({ status: 'not-handled' });
      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(event.stopPropagation).not.toHaveBeenCalled();
    }

    expect(taskOps.detachTask).not.toHaveBeenCalled();
  });

  it('deletes selected cross-tree links for Alt+X only', async () => {
    const crossTreeLink = new go.Link();
    crossTreeLink.data = { id: 'link-1', isCrossTree: true };
    const normalLink = new go.Link();
    normalLink.data = { id: 'link-2', isCrossTree: false };
    diagram.diagramInstance = makeDiagramSelection([crossTreeLink, normalLink]);
    const event = makeKeyboardEvent('x');

    const result = service.handleShortcut(event);

    expect(result.status).toBe('handled');
    if (result.status === 'handled') {
      await result.completed;
    }
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopPropagation).toHaveBeenCalledOnce();
    expect(link.handleDeleteCrossTreeLinks).toHaveBeenCalledWith([{ id: 'link-1', isCrossTree: true }]);
  });

  it('logs rejected Alt+X link deletion without surfacing an unhandled rejection', async () => {
    const error = new Error('delete failed');
    const crossTreeLink = new go.Link();
    crossTreeLink.data = { id: 'link-1', isCrossTree: true };
    diagram.diagramInstance = makeDiagramSelection([crossTreeLink]);
    link.handleDeleteCrossTreeLinks.mockRejectedValueOnce(error);
    const event = makeKeyboardEvent('x');

    const result = service.handleShortcut(event);

    expect(result.status).toBe('handled');
    if (result.status === 'handled') {
      await result.completed;
    }
    expect(logger.warn).toHaveBeenCalledWith(
      '删除跨树连接快捷键执行失败',
      expect.objectContaining({ error, selectedCount: 1 }),
    );
  });
});
