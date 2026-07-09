import { expect, it } from 'vitest';

import { LAYOUT_CONFIG } from '../../../../config';
import {
  computeFamilyBlockAutoLayout,
  type AutoLayoutLinkData,
} from './flow-layout.service';
import {
  createLayoutLink,
  createLayoutNode,
  toPositionMap,
} from './flow-layout.service.spec-helpers';

export function registerFlowLayoutRelationSpacingSpecs(): void {
  it('reorders sibling subtrees toward their unassigned relation neighborhoods', () => {
    const positions = computeFamilyBlockAutoLayout(
      [
        createLayoutNode({ key: 'root-main', stage: 1, rank: 100 }),
        createLayoutNode({ key: 'child-a', stage: 2, rank: 110 }),
        createLayoutNode({ key: 'grand-a', stage: 3, rank: 120 }),
        createLayoutNode({ key: 'child-b', stage: 2, rank: 210 }),
        createLayoutNode({ key: 'grand-b', stage: 3, rank: 220 }),
        createLayoutNode({ key: 'floating-early', stage: null, rank: 50 }),
        createLayoutNode({ key: 'floating-late', stage: null, rank: 400 }),
      ],
      [
        createLayoutLink({ from: 'root-main', to: 'child-a' }),
        createLayoutLink({ from: 'child-a', to: 'grand-a' }),
        createLayoutLink({ from: 'root-main', to: 'child-b' }),
        createLayoutLink({ from: 'child-b', to: 'grand-b' }),
        createLayoutLink({ from: 'grand-a', to: 'floating-late', isCrossTree: true }),
        createLayoutLink({ from: 'grand-b', to: 'floating-early', isCrossTree: true }),
      ],
    );

    const positionMap = toPositionMap(positions);
    expect(positionMap.get('child-b')?.y ?? Number.MAX_SAFE_INTEGER)
      .toBeLessThan(positionMap.get('child-a')?.y ?? -1);
  });

  it('reorders sibling subtrees toward their external relation neighborhoods', () => {
    const positions = computeFamilyBlockAutoLayout(
      [
        createLayoutNode({ key: 'target-early', stage: 1, rank: 50 }),
        createLayoutNode({ key: 'root-main', stage: 1, rank: 100 }),
        createLayoutNode({ key: 'child-a', stage: 2, rank: 110 }),
        createLayoutNode({ key: 'grand-a', stage: 3, rank: 120 }),
        createLayoutNode({ key: 'child-b', stage: 2, rank: 210 }),
        createLayoutNode({ key: 'grand-b', stage: 3, rank: 220 }),
        createLayoutNode({ key: 'target-late', stage: 4, rank: 400 }),
      ],
      [
        createLayoutLink({ from: 'root-main', to: 'child-a' }),
        createLayoutLink({ from: 'child-a', to: 'grand-a' }),
        createLayoutLink({ from: 'root-main', to: 'child-b' }),
        createLayoutLink({ from: 'child-b', to: 'grand-b' }),
        createLayoutLink({ from: 'grand-a', to: 'target-late', isCrossTree: true }),
        createLayoutLink({ from: 'grand-b', to: 'target-early', isCrossTree: true }),
      ],
    );

    const positionMap = toPositionMap(positions);
    expect(positionMap.get('child-b')?.y ?? Number.MAX_SAFE_INTEGER)
      .toBeLessThan(positionMap.get('child-a')?.y ?? -1);
  });

  it('keeps stage-major neighborhood ordering even when rank spans are production-sized', () => {
    const positions = computeFamilyBlockAutoLayout(
      [
        createLayoutNode({ key: 'target-stage1-late', stage: 1, rank: 250_000 }),
        createLayoutNode({ key: 'root-main', stage: 1, rank: 100 }),
        createLayoutNode({ key: 'child-a', stage: 2, rank: 110 }),
        createLayoutNode({ key: 'grand-a', stage: 3, rank: 120 }),
        createLayoutNode({ key: 'child-b', stage: 2, rank: 210 }),
        createLayoutNode({ key: 'grand-b', stage: 3, rank: 220 }),
        createLayoutNode({ key: 'target-stage2-early', stage: 2, rank: 10_000 }),
      ],
      [
        createLayoutLink({ from: 'root-main', to: 'child-a' }),
        createLayoutLink({ from: 'child-a', to: 'grand-a' }),
        createLayoutLink({ from: 'root-main', to: 'child-b' }),
        createLayoutLink({ from: 'child-b', to: 'grand-b' }),
        createLayoutLink({ from: 'grand-a', to: 'target-stage2-early', isCrossTree: true }),
        createLayoutLink({ from: 'grand-b', to: 'target-stage1-late', isCrossTree: true }),
      ],
    );

    const positionMap = toPositionMap(positions);
    expect(positionMap.get('child-b')?.y ?? Number.MAX_SAFE_INTEGER)
      .toBeLessThan(positionMap.get('child-a')?.y ?? -1);
  });

  it('keeps natural sibling order when only one subtree has an external relation neighborhood', () => {
    const positions = computeFamilyBlockAutoLayout(
      [
        createLayoutNode({ key: 'root-main', stage: 1, rank: 100 }),
        createLayoutNode({ key: 'child-a', stage: 2, rank: 110 }),
        createLayoutNode({ key: 'grand-a', stage: 3, rank: 120 }),
        createLayoutNode({ key: 'child-b', stage: 2, rank: 210 }),
        createLayoutNode({ key: 'grand-b', stage: 3, rank: 220 }),
        createLayoutNode({ key: 'target-late', stage: 4, rank: 400 }),
      ],
      [
        createLayoutLink({ from: 'root-main', to: 'child-a' }),
        createLayoutLink({ from: 'child-a', to: 'grand-a' }),
        createLayoutLink({ from: 'root-main', to: 'child-b' }),
        createLayoutLink({ from: 'child-b', to: 'grand-b' }),
        createLayoutLink({ from: 'grand-b', to: 'target-late', isCrossTree: true }),
      ],
    );

    const positionMap = toPositionMap(positions);
    expect(positionMap.get('child-a')?.y ?? Number.MAX_SAFE_INTEGER)
      .toBeLessThan(positionMap.get('child-b')?.y ?? -1);
  });

  it('keeps natural sibling order when siblings point to the same external neighborhood', () => {
    const positions = computeFamilyBlockAutoLayout(
      [
        createLayoutNode({ key: 'root-main', stage: 1, rank: 100 }),
        createLayoutNode({ key: 'child-a', stage: 2, rank: 110 }),
        createLayoutNode({ key: 'grand-a', stage: 3, rank: 120 }),
        createLayoutNode({ key: 'child-b', stage: 2, rank: 210 }),
        createLayoutNode({ key: 'grand-b', stage: 3, rank: 220 }),
        createLayoutNode({ key: 'target-shared', stage: 4, rank: 400 }),
      ],
      [
        createLayoutLink({ from: 'root-main', to: 'child-a' }),
        createLayoutLink({ from: 'child-a', to: 'grand-a' }),
        createLayoutLink({ from: 'root-main', to: 'child-b' }),
        createLayoutLink({ from: 'child-b', to: 'grand-b' }),
        createLayoutLink({ from: 'grand-a', to: 'target-shared', isCrossTree: true }),
        createLayoutLink({ from: 'grand-b', to: 'target-shared', isCrossTree: true }),
        createLayoutLink({ from: 'child-b', to: 'target-shared', isCrossTree: true }),
      ],
    );

    const positionMap = toPositionMap(positions);
    expect(positionMap.get('child-a')?.y ?? Number.MAX_SAFE_INTEGER)
      .toBeLessThan(positionMap.get('child-b')?.y ?? -1);
  });

  it('ignores same-family cross-tree links when reordering sibling subtrees', () => {
    const positions = computeFamilyBlockAutoLayout(
      [
        createLayoutNode({ key: 'root-main', stage: 1, rank: 100 }),
        createLayoutNode({ key: 'child-a', stage: 2, rank: 110 }),
        createLayoutNode({ key: 'grand-a', stage: 3, rank: 120 }),
        createLayoutNode({ key: 'child-b', stage: 2, rank: 210 }),
        createLayoutNode({ key: 'grand-b', stage: 3, rank: 220 }),
      ],
      [
        createLayoutLink({ from: 'root-main', to: 'child-a' }),
        createLayoutLink({ from: 'child-a', to: 'grand-a' }),
        createLayoutLink({ from: 'root-main', to: 'child-b' }),
        createLayoutLink({ from: 'child-b', to: 'grand-b' }),
        createLayoutLink({ from: 'grand-a', to: 'grand-b', isCrossTree: true }),
      ],
    );

    const positionMap = toPositionMap(positions);
    expect(positionMap.get('child-a')?.y ?? Number.MAX_SAFE_INTEGER)
      .toBeLessThan(positionMap.get('child-b')?.y ?? -1);
  });

  it('adds extra sibling spacing when adjacent subtrees both carry relation load', () => {
    const nodes = [
      createLayoutNode({ key: 'root-main', stage: 1, rank: 100 }),
      createLayoutNode({ key: 'child-left', stage: 2, rank: 110 }),
      createLayoutNode({ key: 'grand-left', stage: 3, rank: 120 }),
      createLayoutNode({ key: 'child-right', stage: 2, rank: 210 }),
      createLayoutNode({ key: 'grand-right', stage: 3, rank: 220 }),
      createLayoutNode({ key: 'target-left', stage: 4, rank: 320 }),
      createLayoutNode({ key: 'target-right', stage: 4, rank: 360 }),
    ];
    const baseLinks = [
      createLayoutLink({ from: 'root-main', to: 'child-left' }),
      createLayoutLink({ from: 'child-left', to: 'grand-left' }),
      createLayoutLink({ from: 'root-main', to: 'child-right' }),
      createLayoutLink({ from: 'child-right', to: 'grand-right' }),
    ];

    const compactPositions = computeFamilyBlockAutoLayout(nodes, baseLinks);
    const relationHeavyPositions = computeFamilyBlockAutoLayout(nodes, [
      ...baseLinks,
      createLayoutLink({ from: 'grand-left', to: 'target-left', isCrossTree: true }),
      createLayoutLink({ from: 'grand-right', to: 'target-right', isCrossTree: true }),
    ]);

    const compactMap = toPositionMap(compactPositions);
    const relationHeavyMap = toPositionMap(relationHeavyPositions);
    const compactGap = (compactMap.get('child-right')?.y ?? 0) - (compactMap.get('child-left')?.y ?? 0);
    const relationHeavyGap = (relationHeavyMap.get('child-right')?.y ?? 0)
      - (relationHeavyMap.get('child-left')?.y ?? 0);

    expect(relationHeavyGap).toBeGreaterThan(compactGap);
  });

  it('still widens sibling spacing when only one subtree carries heavy relation load', () => {
    const nodes = [
      createLayoutNode({ key: 'root-main', stage: 1, rank: 100 }),
      createLayoutNode({ key: 'child-left', stage: 2, rank: 110 }),
      createLayoutNode({ key: 'grand-left', stage: 3, rank: 120 }),
      createLayoutNode({ key: 'child-right', stage: 2, rank: 210 }),
      createLayoutNode({ key: 'grand-right', stage: 3, rank: 220 }),
      createLayoutNode({ key: 'target-left', stage: 4, rank: 320 }),
    ];
    const baseLinks = [
      createLayoutLink({ from: 'root-main', to: 'child-left' }),
      createLayoutLink({ from: 'child-left', to: 'grand-left' }),
      createLayoutLink({ from: 'root-main', to: 'child-right' }),
      createLayoutLink({ from: 'child-right', to: 'grand-right' }),
    ];

    const compactPositions = computeFamilyBlockAutoLayout(nodes, baseLinks);
    const relationHeavyPositions = computeFamilyBlockAutoLayout(nodes, [
      ...baseLinks,
      createLayoutLink({ from: 'grand-left', to: 'target-left', isCrossTree: true }),
    ]);

    const compactMap = toPositionMap(compactPositions);
    const relationHeavyMap = toPositionMap(relationHeavyPositions);
    const compactGap = (compactMap.get('child-right')?.y ?? 0) - (compactMap.get('child-left')?.y ?? 0);
    const relationHeavyGap = (relationHeavyMap.get('child-right')?.y ?? 0)
      - (relationHeavyMap.get('child-left')?.y ?? 0);

    expect(relationHeavyGap).toBeGreaterThan(compactGap);
  });

  it('adds extra sibling spacing when a subtree has multiple parent candidates', () => {
    const nodes = [
      createLayoutNode({ key: 'root-main', stage: 1, rank: 100 }),
      createLayoutNode({ key: 'child-left', stage: 2, rank: 110 }),
      createLayoutNode({ key: 'child-right', stage: 2, rank: 210 }),
      createLayoutNode({ key: 'shared-grandchild', stage: 3, rank: 320 }),
    ];
    const baseLinks = [
      createLayoutLink({ from: 'root-main', to: 'child-left' }),
      createLayoutLink({ from: 'root-main', to: 'child-right' }),
      createLayoutLink({ from: 'child-right', to: 'shared-grandchild' }),
    ];

    const compactPositions = computeFamilyBlockAutoLayout(nodes, baseLinks);
    const multiParentPositions = computeFamilyBlockAutoLayout(nodes, [
      ...baseLinks,
      createLayoutLink({ from: 'child-left', to: 'shared-grandchild' }),
    ]);

    const compactMap = toPositionMap(compactPositions);
    const multiParentMap = toPositionMap(multiParentPositions);
    const compactGap = (compactMap.get('child-right')?.y ?? 0) - (compactMap.get('child-left')?.y ?? 0);
    const multiParentGap = (multiParentMap.get('child-right')?.y ?? 0)
      - (multiParentMap.get('child-left')?.y ?? 0);

    expect(multiParentGap).toBeGreaterThan(compactGap);
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

    const maxAllowedGap = (1 + LAYOUT_CONFIG.AUTO_LAYOUT_MAX_EXTRA_GAP_ROWS) * LAYOUT_CONFIG.ROW_SPACING;
    expect(family2MinY - family1MaxY).toBeLessThanOrEqual(maxAllowedGap + 1);
    expect(family2MinY - family1MaxY).toBeGreaterThan(0);
  });

  it('globally minimizes cross-tree span via 2-opt beyond greedy nearest-neighbor', () => {
    const makeFamily = (rootRank: number, prefix: string) => [
      createLayoutNode({ key: `${prefix}-root`, stage: 1, rank: rootRank }),
      createLayoutNode({ key: `${prefix}-child`, stage: 2, rank: rootRank + 10 }),
    ];
    const nodes = [
      ...makeFamily(100, 'A'),
      ...makeFamily(200, 'B'),
      ...makeFamily(300, 'C'),
      ...makeFamily(400, 'D'),
    ];
    const links: AutoLayoutLinkData[] = [
      createLayoutLink({ from: 'A-root', to: 'A-child' }),
      createLayoutLink({ from: 'B-root', to: 'B-child' }),
      createLayoutLink({ from: 'C-root', to: 'C-child' }),
      createLayoutLink({ from: 'D-root', to: 'D-child' }),
      createLayoutLink({ from: 'A-child', to: 'C-child', isCrossTree: true }),
      createLayoutLink({ from: 'A-child', to: 'C-root', isCrossTree: true }),
      createLayoutLink({ from: 'B-child', to: 'D-child', isCrossTree: true }),
      createLayoutLink({ from: 'B-child', to: 'D-root', isCrossTree: true }),
    ];

    const positions = computeFamilyBlockAutoLayout(nodes, links);
    const positionMap = toPositionMap(positions);

    const ySortedFamilyOrder = (['A', 'B', 'C', 'D'] as const)
      .map(prefix => ({ prefix, y: positionMap.get(`${prefix}-root`)?.y ?? 0 }))
      .sort((a, b) => a.y - b.y)
      .map(entry => entry.prefix);

    expect(ySortedFamilyOrder[0]).toBe('A');

    const indexOf = (prefix: 'A' | 'B' | 'C' | 'D') => ySortedFamilyOrder.indexOf(prefix);
    const crossTreeSpan = Math.abs(indexOf('A') - indexOf('C')) + Math.abs(indexOf('B') - indexOf('D'));

    expect(crossTreeSpan).toBeLessThanOrEqual(3);
  });

  it('widens stage boundary when multiple merge points funnel into the same child', () => {
    const baseNodes = [
      createLayoutNode({ key: 'root-1', stage: 1, rank: 100 }),
      createLayoutNode({ key: 'root-2', stage: 1, rank: 200 }),
      createLayoutNode({ key: 'child-a', stage: 2, rank: 110 }),
      createLayoutNode({ key: 'child-b', stage: 2, rank: 120 }),
    ];
    const baseLinks: AutoLayoutLinkData[] = [
      createLayoutLink({ from: 'root-1', to: 'child-a' }),
      createLayoutLink({ from: 'root-2', to: 'child-b' }),
    ];
    const mergeLinks: AutoLayoutLinkData[] = [
      createLayoutLink({ from: 'root-1', to: 'child-a' }),
      createLayoutLink({ from: 'root-2', to: 'child-a' }),
      createLayoutLink({ from: 'root-1', to: 'child-b' }),
      createLayoutLink({ from: 'root-2', to: 'child-b' }),
    ];

    const baseMap = toPositionMap(computeFamilyBlockAutoLayout(baseNodes, baseLinks));
    const mergeMap = toPositionMap(computeFamilyBlockAutoLayout(baseNodes, mergeLinks));

    const baseGap = (baseMap.get('child-a')?.x ?? 0) - (baseMap.get('root-1')?.x ?? 0);
    const mergeGap = (mergeMap.get('child-a')?.x ?? 0) - (mergeMap.get('root-1')?.x ?? 0);

    expect(mergeGap).toBeGreaterThan(baseGap);
    const maxExpectedGap = LAYOUT_CONFIG.STAGE_SPACING
      * (1 + LAYOUT_CONFIG.AUTO_LAYOUT_MAX_STAGE_EXTRA_FACTOR);
    expect(mergeGap).toBeLessThanOrEqual(maxExpectedGap + 0.5);
  });
}
