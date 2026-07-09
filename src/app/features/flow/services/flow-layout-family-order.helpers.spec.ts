import { describe, expect, it } from 'vitest';

import { optimizeFamilyOrder } from './flow-layout-family-order.helpers';
import type {
  AutoLayoutLinkData,
  FamilyLayoutBlock,
  ResolvedAutoLayoutOptions,
} from './flow-layout-auto-layout-core.helpers';

const resolvedOptions: ResolvedAutoLayoutOptions = {
  layerSpacing: 100,
  columnSpacing: 80,
  familyGapRows: 2,
  siblingGapRows: 1,
  crossTreeLabelGapRows: 1,
  relatedSiblingGapRows: 1,
  denseFamilyGapRows: 1,
  multiParentSiblingGapRows: 1,
  maxExtraGapRows: 8,
  maxSiblingGapRows: 6,
  stageDensityGapFactor: 0.1,
  stageLinkGapFactor: 0.1,
  stageCrossTreeGapFactor: 0.1,
  stageMultiParentGapFactor: 0.1,
  maxStageExtraFactor: 2,
  twoOptMaxPasses: 4,
  twoOptImprovementEpsilon: 0,
};

function createFamilyBlock(rootKey: string, nodeKeys: string[]): FamilyLayoutBlock {
  const nodes = nodeKeys.map((key, index) => ({ key, stage: index + 1, rank: index }));
  return {
    rootKey,
    nodes,
    nodeKeys: new Set(nodeKeys),
    localRowMap: new Map(nodeKeys.map((key, index) => [key, index])),
    minRow: 0,
    maxRow: Math.max(0, nodeKeys.length - 1),
    maxStageDensity: 1,
    leafCount: Math.max(1, nodeKeys.length),
  };
}

describe('optimizeFamilyOrder', () => {
  it('returns a new array with original order when no cross-tree affinity exists', () => {
    const families = [
      createFamilyBlock('family-a', ['a']),
      createFamilyBlock('family-b', ['b']),
      createFamilyBlock('family-c', ['c']),
    ];

    const ordered = optimizeFamilyOrder(families, [], resolvedOptions);

    expect(ordered).toEqual(families);
    expect(ordered).not.toBe(families);
  });

  it('places cross-tree related families next to each other using greedy affinity', () => {
    const families = [
      createFamilyBlock('family-a', ['a']),
      createFamilyBlock('family-b', ['b']),
      createFamilyBlock('family-c', ['c']),
      createFamilyBlock('family-d', ['d']),
    ];
    const links: AutoLayoutLinkData[] = [
      { from: 'a', to: 'c', isCrossTree: true },
      { from: 'a', to: 'c', isCrossTree: true },
      { from: 'c', to: 'd', isCrossTree: true },
    ];

    const ordered = optimizeFamilyOrder(families, links, resolvedOptions);

    expect(ordered.map(block => block.rootKey)).toEqual([
      'family-a',
      'family-c',
      'family-d',
      'family-b',
    ]);
  });

  it('uses two-opt refinement to reduce weighted cross-family distance', () => {
    const families = [
      createFamilyBlock('family-a', ['a']),
      createFamilyBlock('family-b', ['b']),
      createFamilyBlock('family-c', ['c']),
      createFamilyBlock('family-d', ['d']),
    ];
    const links: AutoLayoutLinkData[] = [
      { from: 'a', to: 'c', isCrossTree: true },
      { from: 'a', to: 'c', isCrossTree: true },
      { from: 'a', to: 'd', isCrossTree: true },
      { from: 'a', to: 'd', isCrossTree: true },
      { from: 'b', to: 'd', isCrossTree: true },
      { from: 'b', to: 'd', isCrossTree: true },
      { from: 'b', to: 'd', isCrossTree: true },
      { from: 'b', to: 'd', isCrossTree: true },
      { from: 'b', to: 'd', isCrossTree: true },
    ];

    const ordered = optimizeFamilyOrder(families, links, resolvedOptions);

    expect(ordered.map(block => block.rootKey)).toEqual([
      'family-a',
      'family-c',
      'family-d',
      'family-b',
    ]);
  });
});
