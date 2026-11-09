import * as go from 'gojs';

export function syncOverviewBoxToViewport(overview: go.Overview | null, viewportBounds: go.Rect): void {
  if (!overview || !viewportBounds.isReal()) return;

  const box = overview.box;
  if (!box) return;

  const scale = Number.isFinite(overview.scale) && overview.scale > 0 ? overview.scale : 1;
  const strokeWidth = 2 / scale;
  const selectionObject = box.selectionObject as (go.GraphObject & { strokeWidth?: number }) | null;
  if (selectionObject) {
    const desiredSize = new go.Size(viewportBounds.width, viewportBounds.height);
    if (!selectionObject.desiredSize.equals(desiredSize)) {
      selectionObject.desiredSize = desiredSize;
    }
    if (typeof selectionObject.strokeWidth === 'number' && Math.abs(selectionObject.strokeWidth - strokeWidth) > 0.001) {
      selectionObject.strokeWidth = strokeWidth;
    }
  }

  const nextPosition = new go.Point(viewportBounds.x, viewportBounds.y);
  if (!box.position.equals(nextPosition)) {
    box.position = nextPosition;
  }

  const boxWithLocation = box as go.Part & { location?: go.Point };
  const nextLocation = new go.Point(viewportBounds.x - strokeWidth / 2, viewportBounds.y - strokeWidth / 2);
  if (boxWithLocation.location?.equals && !boxWithLocation.location.equals(nextLocation)) {
    boxWithLocation.location = nextLocation;
  }

  box.isSelected = true;
}
