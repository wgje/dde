import type {
  AutoLayoutLinkData,
  AutoLayoutNodeData,
} from './flow-layout.service';

export function createLayoutNode(
  overrides: Partial<AutoLayoutNodeData> & Pick<AutoLayoutNodeData, 'key'>,
): AutoLayoutNodeData {
  return {
    key: overrides.key,
    stage: Object.prototype.hasOwnProperty.call(overrides, 'stage')
      ? (overrides.stage ?? null)
      : 1,
    rank: overrides.rank ?? 0,
  };
}

export function createLayoutLink(overrides: AutoLayoutLinkData): AutoLayoutLinkData {
  return {
    from: overrides.from,
    to: overrides.to,
    isCrossTree: overrides.isCrossTree ?? false,
  };
}

export function toPositionMap(positions: readonly { key: string; x: number; y: number }[]) {
  return new Map(positions.map(position => [position.key, position]));
}
