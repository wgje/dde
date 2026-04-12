import { Injector } from '@angular/core';
import * as go from 'gojs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AutoLayoutLinkData,
  AutoLayoutNodeData,
  computeFamilyBlockAutoLayout,
  FlowLayoutService,
} from './flow-layout.service';
import { LoggerService } from '../../../../services/logger.service';
import { TaskOperationAdapterService } from '../../../../services/task-operation-adapter.service';
import { LAYOUT_CONFIG } from '../../../../config';

const mockLoggerCategory = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

function createLayoutNode(overrides: Partial<AutoLayoutNodeData> & Pick<AutoLayoutNodeData, 'key'>): AutoLayoutNodeData {
  return {
    key: overrides.key,
    stage: Object.prototype.hasOwnProperty.call(overrides, 'stage')
      ? (overrides.stage ?? null)
      : 1,
    rank: overrides.rank ?? 0,
  };
}

function createLayoutLink(overrides: AutoLayoutLinkData): AutoLayoutLinkData {
  return {
    from: overrides.from,
    to: overrides.to,
    isCrossTree: overrides.isCrossTree ?? false,
  };
}

function toPositionMap(positions: readonly { key: string; x: number; y: number }[]) {
  return new Map(positions.map(position => [position.key, position]));
}

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

  it('adds controlled extra spacing when cross-tree link labels need breathing room', () => {
    const nodes = [
      createLayoutNode({ key: 'root-1', stage: 1, rank: 100 }),
      createLayoutNode({ key: 'child-1', stage: 2, rank: 110 }),
      createLayoutNode({ key: 'root-2', stage: 1, rank: 200 }),
      createLayoutNode({ key: 'child-2', stage: 2, rank: 210 }),
    ];
    const baseLinks = [
      createLayoutLink({ from: 'root-1', to: 'child-1' }),
      createLayoutLink({ from: 'root-2', to: 'child-2' }),
    ];

    const compactPositions = computeFamilyBlockAutoLayout(nodes, baseLinks);
    const crossTreePositions = computeFamilyBlockAutoLayout(nodes, [
      ...baseLinks,
      createLayoutLink({ from: 'child-1', to: 'child-2', isCrossTree: true }),
    ]);

    const compactMap = toPositionMap(compactPositions);
    const crossTreeMap = toPositionMap(crossTreePositions);

    expect(crossTreeMap.get('root-2')?.y ?? -1)
      .toBeGreaterThan(compactMap.get('root-2')?.y ?? Number.MAX_SAFE_INTEGER);
    expect((crossTreeMap.get('root-2')?.y ?? Number.MAX_SAFE_INTEGER) - (compactMap.get('root-2')?.y ?? 0))
      .toBeLessThan(LAYOUT_CONFIG.ROW_SPACING);
  });

  it('caps extra gap under MAX_EXTRA_GAP_ROWS even with many cross-tree links and dense families', () => {
    // 构造大型复杂场景：密集家族 + 多条跨树链接
    const nodes = [
      createLayoutNode({ key: 'root-1', stage: 1, rank: 100 }),
      ...Array.from({ length: 6 }, (_, i) =>
        createLayoutNode({ key: `child-1-${i}`, stage: 2, rank: 110 + i }),
      ),
      createLayoutNode({ key: 'root-2', stage: 1, rank: 200 }),
      ...Array.from({ length: 4 }, (_, i) =>
        createLayoutNode({ key: `child-2-${i}`, stage: 2, rank: 210 + i }),
      ),
    ];
    const links = [
      ...Array.from({ length: 6 }, (_, i) =>
        createLayoutLink({ from: 'root-1', to: `child-1-${i}` }),
      ),
      ...Array.from({ length: 4 }, (_, i) =>
        createLayoutLink({ from: 'root-2', to: `child-2-${i}` }),
      ),
      // 多条跨树链接
      createLayoutLink({ from: 'child-1-0', to: 'child-2-0', isCrossTree: true }),
      createLayoutLink({ from: 'child-1-2', to: 'child-2-1', isCrossTree: true }),
      createLayoutLink({ from: 'child-1-4', to: 'child-2-3', isCrossTree: true }),
    ];

    const positions = computeFamilyBlockAutoLayout(nodes, links);
    const positionMap = toPositionMap(positions);

    const family1Keys = ['root-1', ...Array.from({ length: 6 }, (_, i) => `child-1-${i}`)];
    const family2Keys = ['root-2', ...Array.from({ length: 4 }, (_, i) => `child-2-${i}`)];
    const family1MaxY = Math.max(...family1Keys.map(key => positionMap.get(key)?.y ?? -Infinity));
    const family2MinY = Math.min(...family2Keys.map(key => positionMap.get(key)?.y ?? Infinity));

    // 家族之间的边界间距 = 家族 2 最上方节点 - 家族 1 最下方节点
    // 应被 (1 + MAX_EXTRA_GAP_ROWS) * ROW_SPACING 严格约束
    const maxAllowedGap = (1 + LAYOUT_CONFIG.AUTO_LAYOUT_MAX_EXTRA_GAP_ROWS) * LAYOUT_CONFIG.ROW_SPACING;
    expect(family2MinY - family1MaxY).toBeLessThanOrEqual(maxAllowedGap + 1); // +1 浮点容差
    expect(family2MinY - family1MaxY).toBeGreaterThan(0); // 家族之间必须有正间距
  });
});

describe('FlowLayoutService', () => {
  let service: FlowLayoutService;
  let updateTaskPosition: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    updateTaskPosition = vi.fn();

    const injector = Injector.create({
      providers: [
        { provide: FlowLayoutService, useClass: FlowLayoutService },
        { provide: LoggerService, useValue: { category: () => mockLoggerCategory } },
        { provide: TaskOperationAdapterService, useValue: { updateTaskPosition } },
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

    expect(updateTaskPosition).toHaveBeenCalledTimes(3);

    const persistedPositions = new Map(
      updateTaskPosition.mock.calls.map(([key, x, y]) => [key, { x, y }]),
    );

    expect(persistedPositions.get('root-1')).toMatchObject({ x: 0, y: 0 });
    expect(persistedPositions.get('child-1')).toMatchObject({ x: LAYOUT_CONFIG.STAGE_SPACING, y: 0 });
    expect(persistedPositions.get('root-2')?.x).toBe(0);
    expect(persistedPositions.get('root-2')?.y ?? -1).toBeGreaterThan(0);
  });
});
