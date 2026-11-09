import type * as go from 'gojs';

export interface FlowEventPoint {
  x: number;
  y: number;
}

export interface FlowEventWindowPoint {
  windowX: number;
  windowY: number;
}

export interface FlowEventGeometryDiagram {
  lastInput?: { viewPoint?: FlowEventPoint | null } | null;
  transformDocToView(point: go.Point): FlowEventPoint;
}

export interface FlowEventGeometryElement {
  getBoundingClientRect(): Pick<DOMRect, 'left' | 'top'>;
}

export function convertFlowViewPointToWindowCoords({
  diagramDiv,
  viewX,
  viewY,
}: {
  diagramDiv: FlowEventGeometryElement | null;
  viewX: number;
  viewY: number;
}): FlowEventWindowPoint {
  if (!diagramDiv) {
    return { windowX: viewX, windowY: viewY };
  }

  const rect = diagramDiv.getBoundingClientRect();
  return {
    windowX: rect.left + viewX,
    windowY: rect.top + viewY,
  };
}

export function getFlowClickPositionFromEvent({
  diagram,
  diagramDiv,
  link,
}: {
  diagram: FlowEventGeometryDiagram | null;
  diagramDiv: FlowEventGeometryElement | null;
  link: go.Link;
}): FlowEventPoint {
  if (!diagram || !diagramDiv) {
    return { x: 0, y: 0 };
  }

  const lastInputViewPoint = diagram.lastInput?.viewPoint;
  if (lastInputViewPoint) {
    const rect = diagramDiv.getBoundingClientRect();
    return {
      x: rect.left + lastInputViewPoint.x,
      y: rect.top + lastInputViewPoint.y,
    };
  }

  return getFlowLinkClickPosition({ diagram, diagramDiv, link });
}

export function getFlowLinkClickPosition({
  diagram,
  diagramDiv,
  link,
}: {
  diagram: FlowEventGeometryDiagram | null;
  diagramDiv: FlowEventGeometryElement | null;
  link: go.Link;
}): FlowEventPoint {
  if (!diagram || !diagramDiv) {
    return { x: 0, y: 0 };
  }

  const midPoint = link.midPoint || link.toNode?.location;
  if (!midPoint) {
    return { x: 0, y: 0 };
  }

  const viewPt = diagram.transformDocToView(midPoint);
  const rect = diagramDiv.getBoundingClientRect();
  return {
    x: rect.left + viewPt.x,
    y: rect.top + viewPt.y,
  };
}
