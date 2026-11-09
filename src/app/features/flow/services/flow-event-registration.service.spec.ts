import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as go from 'gojs';

import { FlowDiagramService } from './flow-diagram.service';
import { FlowDiagramDataService } from './flow-diagram-data.service';
import { FlowDragDropService } from './flow-drag-drop.service';
import { FlowEventRegistrationService } from './flow-event-registration.service';
import { FlowEventService, type LinkRelinkCallback, type SelectionMovedCallback } from './flow-event.service';
import { FlowLinkRelinkService } from './flow-link-relink.service';
import { FlowLinkService } from './flow-link.service';
import { FlowSelectionService } from './flow-selection.service';
import { TaskOperationAdapterService } from '../../../../services/task-operation-adapter.service';
import { UiStateService } from '../../../../services/ui-state.service';
import { ToastService } from '../../../../services/toast.service';
import { LoggerService } from '../../../../services/logger.service';

describe('flow-event-registration.service.ts', () => {
  const sourcePath = join(process.cwd(), 'src/app/features/flow/services/flow-event-registration.service.ts');
  const source = readFileSync(sourcePath, 'utf8');

  it('移动端单击关联块时应显式以预览态打开编辑器', () => {
    expect(source).toContain("mode: 'preview'");
  });

  it('背景点击处理在移动端编辑态下应切换到预览模式而非关闭', () => {
    expect(source).toContain('this.link.shouldIgnoreConnectionEditorBackgroundClose()');
    expect(source).toContain("this.link.setConnectionEditorMode('preview')");
    expect(source).toContain('this.link.closeConnectionEditor();');
  });

  it('hint-only 时节点拖拽完成后应立即按 store 回滚图上位置', () => {
    expect(source).toContain('this.taskOpsAdapter.isHintOnlyStartupReadOnly()');
    expect(source).toContain('diagramInstance.updateAllTargetBindings()');
    expect(source).toContain('diagramInstance.requestUpdate()');
  });

  it('节点移动持久化入口只协调只读保护和写入批次', () => {
    expect(source).toContain('private rollbackSelectionMovedWhenReadOnly(');
    expect(source).toContain('private async persistSelectionMovedPositions(');
    expect(source).toContain('await this.persistSelectionMovedPositions(movedNodes, handleNodeMoved);');
  });
});

describe('FlowEventRegistrationService', () => {
  let service: FlowEventRegistrationService;
  let capturedLinkRelink: LinkRelinkCallback | null;
  let capturedSelectionMoved: SelectionMovedCallback | null;
  let mockDiagram: {
    removeLink: ReturnType<typeof vi.fn>;
    diagramInstance?: Partial<go.Diagram>;
  };
  let mockRelinkService: {
    handleCrossTreeRelink: ReturnType<typeof vi.fn>;
    handleParentChildRelink: ReturnType<typeof vi.fn>;
    handleParentChildRelinkToEnd: ReturnType<typeof vi.fn>;
  };
  let mockTaskOpsAdapter: {
    isHintOnlyStartupReadOnly: ReturnType<typeof vi.fn>;
    beginPositionBatch: ReturnType<typeof vi.fn>;
    updateTaskPositionWithRankSync: ReturnType<typeof vi.fn>;
    updateTaskPositionWithUndo: ReturnType<typeof vi.fn>;
    cancelPositionBatch: ReturnType<typeof vi.fn>;
    endPositionBatch: ReturnType<typeof vi.fn>;
  };
  let mockLoggerCategory: {
    debug: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    capturedLinkRelink = null;
    capturedSelectionMoved = null;
    mockDiagram = {
      removeLink: vi.fn(),
    };
    mockRelinkService = {
      handleCrossTreeRelink: vi.fn().mockResolvedValue('cancelled'),
      handleParentChildRelink: vi.fn().mockResolvedValue('success'),
      handleParentChildRelinkToEnd: vi.fn().mockResolvedValue('success'),
    };
    mockTaskOpsAdapter = {
      isHintOnlyStartupReadOnly: vi.fn(() => false),
      beginPositionBatch: vi.fn(),
      updateTaskPositionWithRankSync: vi.fn(),
      updateTaskPositionWithUndo: vi.fn(),
      cancelPositionBatch: vi.fn(),
      endPositionBatch: vi.fn(),
    };
    mockLoggerCategory = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    TestBed.configureTestingModule({
      providers: [
        FlowEventRegistrationService,
        {
          provide: FlowEventService,
          useValue: {
            onLinkRelink: vi.fn((callback: LinkRelinkCallback) => {
              capturedLinkRelink = callback;
            }),
            onSelectionMoved: vi.fn((callback: SelectionMovedCallback) => {
              capturedSelectionMoved = callback;
            }),
          },
        },
        { provide: FlowLinkService, useValue: {} },
        { provide: FlowLinkRelinkService, useValue: mockRelinkService },
        { provide: FlowDiagramService, useValue: mockDiagram },
        { provide: FlowDiagramDataService, useValue: {} },
        { provide: FlowDragDropService, useValue: {} },
        { provide: FlowSelectionService, useValue: {} },
        { provide: TaskOperationAdapterService, useValue: mockTaskOpsAdapter },
        { provide: UiStateService, useValue: {} },
        { provide: ToastService, useValue: {} },
        {
          provide: LoggerService,
          useValue: {
            category: () => mockLoggerCategory,
          },
        },
      ],
    });

    service = TestBed.inject(FlowEventRegistrationService);
  });

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it('cancelled cross-tree relink refreshes the diagram after removing the temporary GoJS link', async () => {
    const refreshDiagram = vi.fn();
    const gojsLink = { key: 'temporary-relink' } as unknown as go.Link;

    service.registerLinkRelinkHandler(refreshDiagram);
    expect(capturedLinkRelink).not.toBeNull();

    await capturedLinkRelink?.(
      'cross-tree',
      {
        changedEnd: 'to',
        oldFromId: 'old-source',
        oldToId: 'old-target',
        newFromId: 'new-source',
        newToId: 'new-target',
      },
      120,
      180,
      gojsLink,
    );

    expect(mockDiagram.removeLink).toHaveBeenCalledWith(gojsLink);
    expect(mockRelinkService.handleCrossTreeRelink).toHaveBeenCalledWith(
      'old-source',
      'old-target',
      'new-source',
      'new-target',
      'to',
    );
    expect(refreshDiagram).toHaveBeenCalledTimes(1);
  });

  it('cross-tree relink error still refreshes the diagram so the removed GoJS link is restored from store', async () => {
    const refreshDiagram = vi.fn();
    const gojsLink = { key: 'temporary-relink' } as unknown as go.Link;
    mockRelinkService.handleCrossTreeRelink.mockResolvedValue('error');

    service.registerLinkRelinkHandler(refreshDiagram);
    await capturedLinkRelink?.(
      'cross-tree',
      {
        changedEnd: 'to',
        oldFromId: 'old-source',
        oldToId: 'old-target',
        newFromId: 'new-source',
        newToId: 'new-target',
      },
      120,
      180,
      gojsLink,
    );

    expect(mockDiagram.removeLink).toHaveBeenCalledWith(gojsLink);
    expect(refreshDiagram).toHaveBeenCalledTimes(1);
  });

  it.each(['cancelled', 'error'] as const)(
    'parent-child relink %s still refreshes the diagram so the removed GoJS link is restored from store',
    async (result) => {
      const refreshDiagram = vi.fn();
      const gojsLink = { key: 'temporary-relink' } as unknown as go.Link;
      mockRelinkService.handleParentChildRelink.mockResolvedValue(result);

      service.registerLinkRelinkHandler(refreshDiagram);
      await capturedLinkRelink?.(
        'parent-child',
        {
          changedEnd: 'from',
          oldFromId: 'old-parent',
          oldToId: 'child',
          newFromId: 'new-parent',
          newToId: 'child',
        },
        120,
        180,
        gojsLink,
      );

      expect(mockDiagram.removeLink).toHaveBeenCalledWith(gojsLink);
      expect(mockRelinkService.handleParentChildRelink).toHaveBeenCalledWith('child', 'old-parent', 'new-parent');
      expect(refreshDiagram).toHaveBeenCalledTimes(1);
    },
  );

  it('parent-child to-end relink error still refreshes the diagram so the removed GoJS link is restored from store', async () => {
    const refreshDiagram = vi.fn();
    const gojsLink = { key: 'temporary-relink' } as unknown as go.Link;
    mockRelinkService.handleParentChildRelinkToEnd.mockResolvedValue('error');

    service.registerLinkRelinkHandler(refreshDiagram);
    await capturedLinkRelink?.(
      'parent-child',
      {
        changedEnd: 'to',
        oldFromId: 'parent',
        oldToId: 'old-child',
        newFromId: 'parent',
        newToId: 'new-target',
      },
      120,
      180,
      gojsLink,
    );

    expect(mockDiagram.removeLink).toHaveBeenCalledWith(gojsLink);
    expect(mockRelinkService.handleParentChildRelinkToEnd).toHaveBeenCalledWith('parent', 'old-child', 'new-target');
    expect(refreshDiagram).toHaveBeenCalledTimes(1);
  });

  it('relink handler rejection still refreshes the diagram after the GoJS link was removed', async () => {
    const refreshDiagram = vi.fn();
    const gojsLink = { key: 'temporary-relink' } as unknown as go.Link;
    mockRelinkService.handleCrossTreeRelink.mockRejectedValue(new Error('queue write failed'));

    service.registerLinkRelinkHandler(refreshDiagram);
    await expect(
      capturedLinkRelink?.(
        'cross-tree',
        {
          changedEnd: 'to',
          oldFromId: 'old-source',
          oldToId: 'old-target',
          newFromId: 'new-source',
          newToId: 'new-target',
        },
        120,
        180,
        gojsLink,
      ),
    ).rejects.toThrow('queue write failed');

    expect(refreshDiagram).toHaveBeenCalledTimes(1);
  });

  it('ends multi-node position batch only after all local position writes settle', async () => {
    let resolveFirst!: () => void;
    let resolveSecond!: () => void;
    const firstWrite = new Promise<boolean>(resolve => {
      resolveFirst = () => resolve(true);
    });
    const secondWrite = new Promise<boolean>(resolve => {
      resolveSecond = () => resolve(true);
    });
    mockTaskOpsAdapter.updateTaskPositionWithRankSync
      .mockReturnValueOnce(firstWrite)
      .mockReturnValueOnce(secondWrite);

    service.registerSelectionMovedHandler(vi.fn());
    expect(capturedSelectionMoved).not.toBeNull();

    capturedSelectionMoved?.([
      { key: 'task-1', x: 10, y: 20, isUnassigned: false },
      { key: 'task-2', x: 30, y: 40, isUnassigned: false },
    ]);

    expect(mockTaskOpsAdapter.beginPositionBatch).toHaveBeenCalledTimes(1);
    expect(mockTaskOpsAdapter.updateTaskPositionWithRankSync).toHaveBeenCalledWith('task-1', 10, 20, { toast: false });
    expect(mockTaskOpsAdapter.updateTaskPositionWithRankSync).toHaveBeenCalledWith('task-2', 30, 40, { toast: false });
    expect(mockTaskOpsAdapter.endPositionBatch).not.toHaveBeenCalled();

    resolveFirst();
    await firstWrite;
    await Promise.resolve();
    expect(mockTaskOpsAdapter.endPositionBatch).not.toHaveBeenCalled();

    resolveSecond();
    await secondWrite;
    await Promise.resolve();

    expect(mockTaskOpsAdapter.endPositionBatch).toHaveBeenCalledTimes(1);
  });

  it('does not commit a multi-node position batch when any local write reports false', async () => {
    mockTaskOpsAdapter.updateTaskPositionWithRankSync
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    service.registerSelectionMovedHandler(vi.fn());
    expect(capturedSelectionMoved).not.toBeNull();

    capturedSelectionMoved?.([
      { key: 'task-1', x: 10, y: 20, isUnassigned: false },
      { key: 'task-2', x: 30, y: 40, isUnassigned: false },
    ]);

    await Promise.resolve();
    await Promise.resolve();

    expect(mockTaskOpsAdapter.cancelPositionBatch).toHaveBeenCalledTimes(1);
    expect(mockTaskOpsAdapter.endPositionBatch).not.toHaveBeenCalled();
    expect(mockLoggerCategory.warn).toHaveBeenCalledWith(
      '节点位置本地持久化失败',
      expect.any(Error),
    );
  });

  it('logs single-node position persistence failure when the local write reports false', async () => {
    mockTaskOpsAdapter.updateTaskPositionWithUndo.mockResolvedValueOnce(false);

    service.registerSelectionMovedHandler(vi.fn());
    expect(capturedSelectionMoved).not.toBeNull();

    capturedSelectionMoved?.([
      { key: 'task-1', x: 10, y: 20, isUnassigned: false },
    ]);

    await Promise.resolve();
    await Promise.resolve();

    expect(mockTaskOpsAdapter.updateTaskPositionWithUndo).toHaveBeenCalledWith('task-1', 10, 20);
    expect(mockLoggerCategory.warn).toHaveBeenCalledWith(
      '节点位置本地持久化失败',
      expect.any(Error),
    );
  });

  it('rolls back diagram position when single-node local position persistence fails', async () => {
    const diagramInstance = {
      updateAllTargetBindings: vi.fn(),
      requestUpdate: vi.fn(),
    };
    mockDiagram.diagramInstance = diagramInstance;
    mockTaskOpsAdapter.updateTaskPositionWithUndo.mockResolvedValueOnce(false);

    service.registerSelectionMovedHandler(vi.fn());
    expect(capturedSelectionMoved).not.toBeNull();

    capturedSelectionMoved?.([
      { key: 'task-1', x: 10, y: 20, isUnassigned: false },
    ]);

    await Promise.resolve();
    await Promise.resolve();

    expect(diagramInstance.updateAllTargetBindings).toHaveBeenCalledTimes(1);
    expect(diagramInstance.requestUpdate).toHaveBeenCalledTimes(1);
  });

  it('waits for unassigned node move handler persistence before ending a mixed batch', async () => {
    let resolveUnassignedMove!: () => void;
    const unassignedMove = new Promise<void>(resolve => {
      resolveUnassignedMove = resolve;
    });
    const handleNodeMoved = vi.fn(() => unassignedMove);
    mockDiagram = {
      removeLink: vi.fn(),
      diagramInstance: {},
    } as unknown as typeof mockDiagram;
    TestBed.resetTestingModule();

    TestBed.configureTestingModule({
      providers: [
        FlowEventRegistrationService,
        {
          provide: FlowEventService,
          useValue: {
            onLinkRelink: vi.fn((callback: LinkRelinkCallback) => {
              capturedLinkRelink = callback;
            }),
            onSelectionMoved: vi.fn((callback: SelectionMovedCallback) => {
              capturedSelectionMoved = callback;
            }),
          },
        },
        { provide: FlowLinkService, useValue: {} },
        { provide: FlowLinkRelinkService, useValue: mockRelinkService },
        { provide: FlowDiagramService, useValue: mockDiagram },
        { provide: FlowDiagramDataService, useValue: {} },
        { provide: FlowDragDropService, useValue: {} },
        { provide: FlowSelectionService, useValue: {} },
        { provide: TaskOperationAdapterService, useValue: mockTaskOpsAdapter },
        { provide: UiStateService, useValue: {} },
        { provide: ToastService, useValue: {} },
        {
          provide: LoggerService,
          useValue: {
            category: () => mockLoggerCategory,
          },
        },
      ],
    });
    service = TestBed.inject(FlowEventRegistrationService);
    mockTaskOpsAdapter.updateTaskPositionWithRankSync.mockResolvedValue(true);

    service.registerSelectionMovedHandler(handleNodeMoved);
    capturedSelectionMoved?.([
      { key: 'unassigned-1', x: 10, y: 20, isUnassigned: true },
      { key: 'task-1', x: 30, y: 40, isUnassigned: false },
    ]);

    expect(handleNodeMoved).toHaveBeenCalled();
    expect(mockTaskOpsAdapter.endPositionBatch).not.toHaveBeenCalled();

    await Promise.resolve();
    await Promise.resolve();
    expect(mockTaskOpsAdapter.endPositionBatch).not.toHaveBeenCalled();

    resolveUnassignedMove();
    await unassignedMove;
    await Promise.resolve();

    expect(mockTaskOpsAdapter.endPositionBatch).toHaveBeenCalledTimes(1);
  });
});
