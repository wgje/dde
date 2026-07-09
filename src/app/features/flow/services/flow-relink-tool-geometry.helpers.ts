export interface RelinkPoint {
  x: number;
  y: number;
}

export interface RelinkBounds {
  x: number;
  y: number;
  right: number;
  bottom: number;
}

export function expandBounds(bounds: RelinkBounds, tolerance: number): RelinkBounds {
  return {
    x: bounds.x - tolerance,
    y: bounds.y - tolerance,
    right: bounds.right + tolerance,
    bottom: bounds.bottom + tolerance,
  };
}

export function isPointInsideBounds(point: RelinkPoint, bounds: RelinkBounds): boolean {
  return point.x >= bounds.x
    && point.x <= bounds.right
    && point.y >= bounds.y
    && point.y <= bounds.bottom;
}

export function distanceToBoundsSquared(point: RelinkPoint, bounds: RelinkBounds): number {
  const clampedX = Math.min(Math.max(point.x, bounds.x), bounds.right);
  const clampedY = Math.min(Math.max(point.y, bounds.y), bounds.bottom);
  const dx = point.x - clampedX;
  const dy = point.y - clampedY;
  return dx * dx + dy * dy;
}

export function computeRelinkPortGravity(pointerTolerance: number): number {
  return Math.max(4, pointerTolerance * 2);
}
