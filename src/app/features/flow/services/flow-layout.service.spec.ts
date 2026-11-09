import { Injector } from '@angular/core';
import * as go from 'gojs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  computeFamilyBlockAutoLayout,
  FlowLayoutService,
} from './flow-layout.service';
import { LoggerService } from '../../../../services/logger.service';
import { TaskOperationAdapterService } from '../../../../services/task-operation-adapter.service';
import { LAYOUT_CONFIG } from '../../../../config';
import {
  createLayoutLink,
  createLayoutNode,
  toPositionMap,
} from './flow-layout.service.spec-helpers';
import { registerFlowLayoutRelationSpacingSpecs } from './flow-layout-relation-spacing.spec-helpers';

const mockLoggerCategory = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

describe('computeFamilyBlockAutoLayout', () => {
  it('keeps nodes of the same stage in the same column', () => {
    const positions = computeFamilyBlockAutoLayout(
      [
        createLayoutNode({ key: 'root-1', stage: 1, rank: 100 }),
        createLayoutNode({ key: 'child-1a', stage: 2, rank: 110 }),
        createLayoutNode({ key: 'child-1b', stage: 2, rank: 120 }),
      ],
      [
        createLayoutLink({ from: 'root-1', to: 'child-1a' }),
        createLayoutLink({ from: 'root-1', to: 'child-1b' }),
      ],
    );

    const positionMap = toPositionMap(positions);
    expect(positionMap.get('child-1a')?.x).toBe(positionMap.get('child-1b')?.x);
    expect(positionMap.get('root-1')?.x).toBe(0);
    expect(positionMap.get('child-1a')?.x).toBe(LAYOUT_CONFIG.STAGE_SPACING);
  });

  it('widens dense parent-child stage boundaries to give branching links more breathing room', () => {
    const positions = computeFamilyBlockAutoLayout(
      [
        createLayoutNode({ key: 'root-1', stage: 1, rank: 100 }),
        ...Array.from({ length: 5 }, (_, index) =>
          createLayoutNode({ key: `child-${index}`, stage: 2, rank: 110 + index }),
        ),
      ],
      Array.from({ length: 5 }, (_, index) =>
        createLayoutLink({ from: 'root-1', to: `child-${index}` }),
      ),
    );

    const positionMap = toPositionMap(positions);
    expect(positionMap.get('child-0')?.x ?? 0).toBeGreaterThan(LAYOUT_CONFIG.STAGE_SPACING);
    expect(positionMap.get('child-0')?.x).toBe(positionMap.get('child-4')?.x);
  });

  it('reserves a dedicated block for a dense subtree before the next root family', () => {
    const positions = computeFamilyBlockAutoLayout(
      [
        createLayoutNode({ key: 'root-1', stage: 1, rank: 100 }),
        createLayoutNode({ key: 'child-1a', stage: 2, rank: 110 }),
        createLayoutNode({ key: 'child-1b', stage: 2, rank: 120 }),
        createLayoutNode({ key: 'grand-1a', stage: 3, rank: 130 }),
        createLayoutNode({ key: 'grand-1b', stage: 3, rank: 140 }),
        createLayoutNode({ key: 'root-2', stage: 1, rank: 200 }),
      ],
      [
        createLayoutLink({ from: 'root-1', to: 'child-1a' }),
        createLayoutLink({ from: 'root-1', to: 'child-1b' }),
        createLayoutLink({ from: 'child-1a', to: 'grand-1a' }),
        createLayoutLink({ from: 'child-1b', to: 'grand-1b' }),
      ],
    );

    const positionMap = toPositionMap(positions);
    const familyOneKeys = ['root-1', 'child-1a', 'child-1b', 'grand-1a', 'grand-1b'];
    const familyOneMaxY = Math.max(...familyOneKeys.map(key => positionMap.get(key)?.y ?? -1));

    expect(positionMap.get('root-2')?.y ?? -1).toBeGreaterThan(familyOneMaxY);
    expect((positionMap.get('root-2')?.y ?? Number.MAX_SAFE_INTEGER) - familyOneMaxY)
      .toBeLessThan(LAYOUT_CONFIG.ROW_SPACING * 2);
  });

  it('keeps root family order driven by root rank', () => {
    const positions = computeFamilyBlockAutoLayout(
      [
        createLayoutNode({ key: 'root-late', stage: 1, rank: 200 }),
        createLayoutNode({ key: 'root-early', stage: 1, rank: 100 }),
      ],
      [],
    );

    const positionMap = toPositionMap(positions);
    expect(positionMap.get('root-early')?.y ?? Number.MAX_SAFE_INTEGER)
      .toBeLessThan(positionMap.get('root-late')?.y ?? -1);
  });

  it('treats assigned orphan roots as their own family block', () => {
    const positions = computeFamilyBlockAutoLayout(
      [
        createLayoutNode({ key: 'root-1', stage: 1, rank: 100 }),
        createLayoutNode({ key: 'orphan-root', stage: 3, rank: 200 }),
      ],
      [],
    );

    const positionMap = toPositionMap(positions);
    expect(positionMap.get('orphan-root')?.x).toBe(LAYOUT_CONFIG.STAGE_SPACING);
    expect(positionMap.get('orphan-root')?.y ?? -1).toBeGreaterThan(positionMap.get('root-1')?.y ?? -1);
  });

  it('keeps unassigned tasks in a dedicated right-side column', () => {
    const positions = computeFamilyBlockAutoLayout(
      [
        createLayoutNode({ key: 'root-1', stage: 1, rank: 100 }),
        createLayoutNode({ key: 'child-1', stage: 2, rank: 110 }),
        createLayoutNode({ key: 'floating-1', stage: null, rank: 50 }),
        createLayoutNode({ key: 'floating-2', stage: null, rank: 60 }),
      ],
      [createLayoutLink({ from: 'root-1', to: 'child-1' })],
    );

    const positionMap = toPositionMap(positions);
    const expectedUnassignedX = 2 * LAYOUT_CONFIG.STAGE_SPACING;

    expect(positionMap.get('floating-1')?.x).toBe(expectedUnassignedX);
    expect(positionMap.get('floating-2')?.x).toBe(expectedUnassignedX);
    expect(positionMap.get('floating-1')?.y ?? Number.MAX_SAFE_INTEGER)
      .toBeLessThan(positionMap.get('floating-2')?.y ?? -1);
  });

  it('pushes the unassigned column farther right when staged nodes keep relation-heavy links to it', () => {
    const nodes = [
      createLayoutNode({ key: 'root-1', stage: 1, rank: 100 }),
      createLayoutNode({ key: 'child-1', stage: 2, rank: 110 }),
      createLayoutNode({ key: 'floating-1', stage: null, rank: 210 }),
      createLayoutNode({ key: 'floating-2', stage: null, rank: 220 }),
    ];
    const baseLinks = [createLayoutLink({ from: 'root-1', to: 'child-1' })];

    const compactPositions = computeFamilyBlockAutoLayout(nodes, baseLinks);
    const relationHeavyPositions = computeFamilyBlockAutoLayout(nodes, [
      ...baseLinks,
      createLayoutLink({ from: 'child-1', to: 'floating-1', isCrossTree: true }),
      createLayoutLink({ from: 'child-1', to: 'floating-2', isCrossTree: true }),
    ]);

    const compactMap = toPositionMap(compactPositions);
    const relationHeavyMap = toPositionMap(relationHeavyPositions);
    expect(relationHeavyMap.get('floating-1')?.x ?? 0)
      .toBeGreaterThan(compactMap.get('floating-1')?.x ?? Number.MAX_SAFE_INTEGER);
    expect(relationHeavyMap.get('floating-1')?.x).toBe(relationHeavyMap.get('floating-2')?.x);
  });

  it('ignores cross-tree links when grouping families', () => {
    const positions = computeFamilyBlockAutoLayout(
      [
        createLayoutNode({ key: 'root-1', stage: 1, rank: 100 }),
        createLayoutNode({ key: 'root-2', stage: 1, rank: 200 }),
        createLayoutNode({ key: 'child-2', stage: 2, rank: 210 }),
      ],
      [
        createLayoutLink({ from: 'root-2', to: 'child-2' }),
        createLayoutLink({ from: 'root-1', to: 'child-2', isCrossTree: true }),
      ],
    );

    const positionMap = toPositionMap(positions);
    expect(positionMap.get('root-2')?.y ?? -1).toBeGreaterThan(positionMap.get('root-1')?.y ?? Number.MAX_SAFE_INTEGER);
    expect(positionMap.get('child-2')?.y).toBe(positionMap.get('root-2')?.y);
  });

  it('keeps a single-chain tree compact instead of reserving a tall empty block', () => {
    const positions = computeFamilyBlockAutoLayout(
      [
        createLayoutNode({ key: 'root-1', stage: 1, rank: 100 }),
        createLayoutNode({ key: 'child-1', stage: 2, rank: 110 }),
        createLayoutNode({ key: 'grand-1', stage: 3, rank: 120 }),
        createLayoutNode({ key: 'root-2', stage: 1, rank: 200 }),
      ],
      [
        createLayoutLink({ from: 'root-1', to: 'child-1' }),
        createLayoutLink({ from: 'child-1', to: 'grand-1' }),
      ],
    );

    const positionMap = toPositionMap(positions);
    expect(positionMap.get('root-1')?.y).toBe(0);
    expect(positionMap.get('child-1')?.y).toBe(0);
    expect(positionMap.get('grand-1')?.y).toBe(0);
    expect(positionMap.get('root-2')?.y ?? Number.MAX_SAFE_INTEGER)
      .toBeLessThan(LAYOUT_CONFIG.ROW_SPACING * 1.5);
  });

  registerFlowLayoutRelationSpacingSpecs();
});

describe('FlowLayoutService', () => {
  let service: FlowLayoutService;
  let updateTaskPosition: ReturnType<typeof vi.fn>;
  let updateTaskPositionsDurably: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    updateTaskPosition = vi.fn();
    updateTaskPositionsDurably = vi.fn().mockResolvedValue(true);

    const injector = Injector.create({
      providers: [
        { provide: FlowLayoutService, useClass: FlowLayoutService },
        { provide: LoggerService, useValue: { category: () => mockLoggerCategory } },
        { provide: TaskOperationAdapterService, useValue: { updateTaskPosition, updateTaskPositionsDurably } },
      ],
    });

    service = injector.get(FlowLayoutService);
  });

  it('applies the computed family-block positions and persists them', () => {
    const nodes = [
      { data: { key: 'root-1', stage: 1, rank: 100 }, location: new go.Point(0, 0) },
      { data: { key: 'child-1', stage: 2, rank: 110 }, location: new go.Point(0, 0) },
      { data: { key: 'root-2', stage: 1, rank: 200 }, location: new go.Point(0, 0) },
    ] as unknown as go.Node[];
    const links = [
      {
        fromNode: nodes[0],
        toNode: nodes[1],
        data: { isCrossTree: false },
      },
    ] as unknown as go.Link[];

    const diagram = {
      startTransaction: vi.fn(),
      commitTransaction: vi.fn(),
      nodes: {
        each: (callback: (node: go.Node) => void) => nodes.forEach(node => callback(node)),
      },
      links: {
        each: (callback: (link: go.Link) => void) => links.forEach(link => callback(link)),
      },
    } as unknown as go.Diagram;

    service.setDiagram(diagram);
    service.applyAutoLayout();

    expect(updateTaskPosition).not.toHaveBeenCalled();
    expect(updateTaskPositionsDurably).toHaveBeenCalledTimes(1);

    const persistedPositions = new Map<string, { x: number; y: number }>(
      updateTaskPositionsDurably.mock.calls[0][0].map(({ taskId, x, y }: { taskId: string; x: number; y: number }) =>
        [taskId, { x, y }] as const
      ),
    );

    expect(persistedPositions.get('root-1')).toMatchObject({ x: 0, y: 0 });
    expect(persistedPositions.get('child-1')).toMatchObject({ x: LAYOUT_CONFIG.STAGE_SPACING, y: 0 });
    expect(persistedPositions.get('root-2')?.x).toBe(0);
    expect(persistedPositions.get('root-2')?.y ?? -1).toBeGreaterThan(0);
  });

  describe('layout generation 取消语义（计划 §8.4）', () => {
    function makeDiagram(nodes: Array<{ key: string; x: number; y: number }>): go.Diagram {
      const goNodes = nodes.map(n => ({
        data: { key: n.key },
        location: { x: n.x, y: n.y, isReal: () => true } as go.Point,
      })) as unknown as go.Node[];
      return {
        startTransaction: vi.fn(),
        commitTransaction: vi.fn(),
        nodes: {
          each: (cb: (node: go.Node) => void) => goNodes.forEach(node => cb(node)),
        },
        findNodeForKey: (key: string) =>
          goNodes.find(node => (node.data as { key?: string }).key === key) ?? null,
      } as unknown as go.Diagram;
    }

    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.restoreAllMocks();
      vi.useRealTimers();
    });

    it('setDiagram 切换 diagram 时丢弃 in-flight 防抖保存', () => {
      const oldDiagram = makeDiagram([{ key: 'a', x: 1, y: 1 }]);
      service.setDiagram(oldDiagram);
      service.scheduleSaveAllPositions();

      // 在 timer fire 之前替换 diagram —— 旧 diagram 的延迟保存必须被丢弃。
      const newDiagram = makeDiagram([{ key: 'b', x: 2, y: 2 }]);
      service.setDiagram(newDiagram);

      vi.advanceTimersByTime(500);

      // 既不写旧 diagram 的坐标，也不在 generation 已递进时误写新 diagram。
      expect(updateTaskPosition).not.toHaveBeenCalled();
      expect(updateTaskPositionsDurably).not.toHaveBeenCalled();
    });

    it('setDiagram(null) 释放 diagram 时丢弃 in-flight 防抖保存', () => {
      const diagram = makeDiagram([{ key: 'a', x: 1, y: 1 }]);
      service.setDiagram(diagram);
      service.scheduleSaveAllPositions();

      service.setDiagram(null);
      vi.advanceTimersByTime(500);

      expect(updateTaskPosition).not.toHaveBeenCalled();
      expect(updateTaskPositionsDurably).not.toHaveBeenCalled();
    });

    it('requestLayoutGeneration 显式递进代际并丢弃 in-flight 保存', () => {
      const diagram = makeDiagram([{ key: 'a', x: 1, y: 1 }]);
      service.setDiagram(diagram);
      const before = service.getLayoutGeneration();

      service.scheduleSaveAllPositions();
      const next = service.requestLayoutGeneration();

      expect(next).toBeGreaterThan(before);
      vi.advanceTimersByTime(500);
      expect(updateTaskPosition).not.toHaveBeenCalled();
      expect(updateTaskPositionsDurably).not.toHaveBeenCalled();
    });

    it('setDiagram 切换 diagram 时应清理 handle 为 0 的 in-flight 保存', () => {
      const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
      const oldDiagram = makeDiagram([{ key: 'a', x: 1, y: 1 }]);
      const newDiagram = makeDiagram([{ key: 'b', x: 2, y: 2 }]);
      const internal = service as unknown as {
        positionSaveTimer: ReturnType<typeof setTimeout> | null;
      };
      service.setDiagram(oldDiagram);
      internal.positionSaveTimer = 0 as unknown as ReturnType<typeof setTimeout>;

      service.setDiagram(newDiagram);

      expect(clearTimeoutSpy).toHaveBeenCalledWith(0);
      expect(internal.positionSaveTimer).toBeNull();
    });

    it('scheduleSaveAllPositions 重排时应取消 handle 为 0 的旧保存 timer', () => {
      const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
      const diagram = makeDiagram([{ key: 'a', x: 1, y: 1 }]);
      const internal = service as unknown as {
        positionSaveTimer: ReturnType<typeof setTimeout> | null;
      };
      service.setDiagram(diagram);
      internal.positionSaveTimer = 0 as unknown as ReturnType<typeof setTimeout>;

      service.scheduleSaveAllPositions();

      expect(clearTimeoutSpy).toHaveBeenCalledWith(0);
      expect(internal.positionSaveTimer).not.toBe(0);
    });

    it('已有 handle 为 0 的 retry timer 时不应重复安排位置重试', () => {
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
      const internal = service as unknown as {
        positionRetryTimer: ReturnType<typeof setTimeout> | null;
        pendingPositionRetry: Array<{ taskId: string; x: number; y: number }> | null;
        pendingPositionRetryGeneration: number | null;
        pendingPositionRetrySequence: number | null;
        schedulePositionRetry: () => void;
      };
      internal.positionRetryTimer = 0 as unknown as ReturnType<typeof setTimeout>;
      internal.pendingPositionRetry = [{ taskId: 'a', x: 1, y: 1 }];
      internal.pendingPositionRetryGeneration = service.getLayoutGeneration();
      internal.pendingPositionRetrySequence = 1;

      internal.schedulePositionRetry();

      expect(setTimeoutSpy).not.toHaveBeenCalled();
      expect(internal.positionRetryTimer).toBe(0);
    });

    it('clearPositionRetry 应清理 handle 为 0 的 retry timer', () => {
      const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
      const internal = service as unknown as {
        positionRetryTimer: ReturnType<typeof setTimeout> | null;
        pendingPositionRetry: Array<{ taskId: string; x: number; y: number }> | null;
        clearPositionRetry: () => void;
      };
      internal.positionRetryTimer = 0 as unknown as ReturnType<typeof setTimeout>;
      internal.pendingPositionRetry = [{ taskId: 'a', x: 1, y: 1 }];

      internal.clearPositionRetry();

      expect(clearTimeoutSpy).toHaveBeenCalledWith(0);
      expect(internal.positionRetryTimer).toBeNull();
      expect(internal.pendingPositionRetry).toBeNull();
    });

    it('dispose 应清理 handle 为 0 的位置保存 timer', () => {
      const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
      const internal = service as unknown as {
        positionSaveTimer: ReturnType<typeof setTimeout> | null;
      };
      internal.positionSaveTimer = 0 as unknown as ReturnType<typeof setTimeout>;

      service.dispose();

      expect(clearTimeoutSpy).toHaveBeenCalledWith(0);
      expect(internal.positionSaveTimer).toBeNull();
    });

    it('未递进 generation 且 diagram 仍存在时正常写回坐标', () => {
      const diagram = makeDiagram([{ key: 'a', x: 5, y: 6 }]);
      service.setDiagram(diagram);
      service.scheduleSaveAllPositions();

      vi.advanceTimersByTime(500);

      expect(updateTaskPosition).not.toHaveBeenCalled();
      expect(updateTaskPositionsDurably).toHaveBeenCalledWith([{ taskId: 'a', x: 5, y: 6 }]);
    });

    it('节点位置持久化失败后应自动重试上次坐标，避免弱网瞬断丢失拖拽位置', async () => {
      updateTaskPositionsDurably.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
      const diagram = makeDiagram([{ key: 'a', x: 5, y: 6 }]);
      service.setDiagram(diagram);

      service.saveAllNodePositions();
      await Promise.resolve();
      vi.advanceTimersByTime(1000);
      await Promise.resolve();

      expect(updateTaskPositionsDurably).toHaveBeenNthCalledWith(1, [{ taskId: 'a', x: 5, y: 6 }]);
      expect(updateTaskPositionsDurably).toHaveBeenNthCalledWith(2, [{ taskId: 'a', x: 5, y: 6 }]);
    });

    it('旧坐标保存晚成功时不应清掉同代际内更新坐标的待重试批次', async () => {
      const firstSave = {
        resolve: null as ((saved: boolean) => void) | null,
      };
      updateTaskPositionsDurably
        .mockImplementationOnce(() => new Promise<boolean>(resolve => {
          firstSave.resolve = resolve;
        }))
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true);

      const diagram = makeDiagram([{ key: 'a', x: 1, y: 1 }]);
      service.setDiagram(diagram);
      service.saveAllNodePositions();

      service.setNodePosition('a', 9, 9);
      service.saveAllNodePositions();
      await Promise.resolve();

      const finishFirstSave = firstSave.resolve;
      expect(finishFirstSave).toBeTypeOf('function');
      finishFirstSave?.(true);
      await Promise.resolve();
      vi.advanceTimersByTime(1000);
      await Promise.resolve();

      expect(updateTaskPositionsDurably).toHaveBeenNthCalledWith(1, [{ taskId: 'a', x: 1, y: 1 }]);
      expect(updateTaskPositionsDurably).toHaveBeenNthCalledWith(2, [{ taskId: 'a', x: 9, y: 9 }]);
      expect(updateTaskPositionsDurably).toHaveBeenNthCalledWith(3, [{ taskId: 'a', x: 9, y: 9 }]);
    });
  });
});
