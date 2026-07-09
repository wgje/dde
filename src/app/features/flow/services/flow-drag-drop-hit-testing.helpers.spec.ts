import { describe, expect, it } from 'vitest';

import {
  findNearestParentLinkAtPosition,
  pointToLinkDistance,
  pointToSegmentDistance,
} from './flow-drag-drop-hit-testing.helpers';

function createLink(input: {
  readonly from?: string;
  readonly to?: string;
  readonly isCrossTree?: boolean;
  readonly start?: { x: number; y: number } | null;
  readonly end?: { x: number; y: number } | null;
}) {
  return {
    data: {
      from: input.from,
      to: input.to,
      isCrossTree: input.isCrossTree,
    },
    fromNode: input.start === null ? null : { location: input.start ?? { x: 0, y: 0 } },
    toNode: input.end === null ? null : { location: input.end ?? { x: 100, y: 0 } },
  };
}

function createDiagram(links: unknown[]) {
  return {
    links: {
      each(callback: (link: never) => void): void {
        for (const link of links) {
          callback(link as never);
        }
      },
    },
  };
}

describe('flow-drag-drop-hit-testing.helpers', () => {
  it('computes point-to-segment distance including degenerate links', () => {
    expect(pointToSegmentDistance(
      { x: 50, y: 20 },
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    )).toBe(20);

    expect(pointToSegmentDistance(
      { x: 3, y: 4 },
      { x: 0, y: 0 },
      { x: 0, y: 0 },
    )).toBe(5);
  });

  it('returns Infinity when a link is missing endpoint nodes', () => {
    expect(pointToLinkDistance({ x: 0, y: 0 }, createLink({ start: null }))).toBe(Infinity);
    expect(pointToLinkDistance({ x: 0, y: 0 }, createLink({ end: null }))).toBe(Infinity);
  });

  it('finds the nearest non-cross-tree parent link within threshold', () => {
    const diagram = createDiagram([
      createLink({
        from: 'far-source',
        to: 'far-target',
        start: { x: 0, y: 100 },
        end: { x: 100, y: 100 },
      }),
      createLink({
        from: 'cross-source',
        to: 'cross-target',
        isCrossTree: true,
        start: { x: 0, y: 0 },
        end: { x: 100, y: 0 },
      }),
      createLink({
        from: 'source',
        to: 'target',
        start: { x: 0, y: 10 },
        end: { x: 100, y: 10 },
      }),
    ]);

    expect(findNearestParentLinkAtPosition({
      loc: { x: 50, y: 12 },
      diagram: diagram as never,
      threshold: 50,
    })).toEqual({
      sourceId: 'source',
      targetId: 'target',
      distance: 2,
    });
  });

  it('ignores links outside threshold or without endpoint ids', () => {
    const diagram = createDiagram([
      createLink({ from: 'too-far', to: 'target', start: { x: 0, y: 100 }, end: { x: 100, y: 100 } }),
      createLink({ from: undefined, to: 'target', start: { x: 0, y: 0 }, end: { x: 100, y: 0 } }),
    ]);

    expect(findNearestParentLinkAtPosition({
      loc: { x: 50, y: 0 },
      diagram: diagram as never,
      threshold: 10,
    })).toBeNull();
  });
});
