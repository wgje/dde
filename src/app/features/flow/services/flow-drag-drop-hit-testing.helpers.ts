import type * as go from 'gojs';

interface PointLike {
  readonly x: number;
  readonly y: number;
}

interface LinkNodeLike {
  readonly location?: PointLike | null;
}

interface LinkLike {
  readonly data?: unknown;
  readonly fromNode?: LinkNodeLike | null;
  readonly toNode?: LinkNodeLike | null;
}

export interface FlowDragDropLinkHit {
  sourceId: string;
  targetId: string;
  distance: number;
}

export function pointToSegmentDistance(
  point: PointLike,
  start: PointLike,
  end: PointLike,
): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;

  if (lengthSquared === 0) {
    return Math.sqrt((point.x - start.x) * (point.x - start.x) + (point.y - start.y) * (point.y - start.y));
  }

  const t = Math.max(
    0,
    Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared),
  );

  const projX = start.x + t * dx;
  const projY = start.y + t * dy;

  return Math.sqrt((point.x - projX) * (point.x - projX) + (point.y - projY) * (point.y - projY));
}

export function pointToLinkDistance(point: PointLike, link: LinkLike): number {
  const startPoint = link.fromNode?.location;
  const endPoint = link.toNode?.location;
  if (!startPoint || !endPoint) return Infinity;

  return pointToSegmentDistance(point, startPoint, endPoint);
}

export function findNearestParentLinkAtPosition(input: {
  loc: PointLike;
  diagram: go.Diagram;
  threshold: number;
}): FlowDragDropLinkHit | null {
  let closestHit: FlowDragDropLinkHit | null = null;

  input.diagram.links.each((link: go.Link) => {
    const linkData = link.data as { from?: unknown; to?: unknown; isCrossTree?: unknown } | null;
    if (linkData?.isCrossTree) return;
    if (typeof linkData?.from !== 'string' || typeof linkData?.to !== 'string') return;

    const distance = pointToLinkDistance(input.loc, link);
    if (distance >= input.threshold) return;
    if (closestHit && distance >= closestHit.distance) return;

    closestHit = {
      sourceId: linkData.from,
      targetId: linkData.to,
      distance,
    };
  });

  return closestHit;
}
