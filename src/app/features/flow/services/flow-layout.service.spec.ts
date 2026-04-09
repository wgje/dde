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