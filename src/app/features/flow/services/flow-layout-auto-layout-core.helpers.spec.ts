import { describe, expect, it } from 'vitest';

import {
  compareLayoutNodes,
  compareRootNodes,
  type AutoLayoutNodeData,
} from './flow-layout-auto-layout-core.helpers';

function node(input: Partial<AutoLayoutNodeData> & Pick<AutoLayoutNodeData, 'key'>): AutoLayoutNodeData {
  return {
    stage: 1,
    ...input,
  };
}

describe('compareLayoutNodes', () => {
  it('keeps legacy rank ordering when preferredOrder is absent', () => {
    const nodes = [
      node({ key: 'late', rank: 20 }),
      node({ key: 'early', rank: 10 }),
      node({ key: 'middle', rank: 15 }),
    ];

    expect(nodes.sort(compareLayoutNodes).map(item => item.key)).toEqual([
      'early',
      'middle',
      'late',
    ]);
  });

  it('lets preferredOrder override rank for soft same-stage ordering', () => {
    const nodes = [
      node({ key: 'rank-earliest', rank: 1, preferredOrder: 30 }),
      node({ key: 'preferred-earliest', rank: 999, preferredOrder: 10 }),
      node({ key: 'preferred-middle', rank: 5, preferredOrder: 20 }),
    ];

    expect(nodes.sort(compareLayoutNodes).map(item => item.key)).toEqual([
      'preferred-earliest',
      'preferred-middle',
      'rank-earliest',
    ]);
  });

  it('falls back to rank per node when only some nodes provide preferredOrder', () => {
    const nodes = [
      node({ key: 'uses-rank', rank: 15 }),
      node({ key: 'uses-preferred', rank: 99, preferredOrder: 10 }),
      node({ key: 'also-uses-rank', rank: 20 }),
    ];

    expect(nodes.sort(compareLayoutNodes).map(item => item.key)).toEqual([
      'uses-preferred',
      'uses-rank',
      'also-uses-rank',
    ]);
  });

  it('uses numeric priority and then key as stable tie-breakers', () => {
    const nodes = [
      node({ key: 'z-last', rank: 10, priority: 2 }),
      node({ key: 'b-key', rank: 10, priority: 1 }),
      node({ key: 'a-key', rank: 10, priority: 1 }),
    ];

    expect(nodes.sort(compareLayoutNodes).map(item => item.key)).toEqual([
      'a-key',
      'b-key',
      'z-last',
    ]);
  });
});

describe('compareRootNodes', () => {
  it('orders by stage before delegating same-stage order to compareLayoutNodes', () => {
    const nodes = [
      node({ key: 'stage-two', stage: 2, rank: 0, preferredOrder: 0 }),
      node({ key: 'stage-one-late', stage: 1, rank: 0, preferredOrder: 20 }),
      node({ key: 'stage-one-early', stage: 1, rank: 999, preferredOrder: 10 }),
    ];

    expect(nodes.sort(compareRootNodes).map(item => item.key)).toEqual([
      'stage-one-early',
      'stage-one-late',
      'stage-two',
    ]);
  });
});
