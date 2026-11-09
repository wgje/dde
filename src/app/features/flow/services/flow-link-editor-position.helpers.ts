import { PanelPosition } from '../../../../models/flow-view-state';

export const CONNECTION_EDITOR_DIMENSIONS = {
  width: 208,
  height: 180,
} as const;

const CONNECTION_EDITOR_PADDING = 12;
const CONNECTION_EDITOR_GAP = 10;
const CONNECTION_EDITOR_DRAG_PADDING = 8;

export interface ConnectionEditorCoordinateRootBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface ConnectionEditorDiagramBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface ConnectionEditorPositionInput {
  tapX: number;
  tapY: number;
  isMobile: boolean;
  coordinateRoot: ConnectionEditorCoordinateRootBounds;
  diagramBounds: ConnectionEditorDiagramBounds | null;
}

interface ConnectionEditorDragPositionInput {
  dragStartX: number;
  dragStartY: number;
  dragOffsetX: number;
  dragOffsetY: number;
  pointerX: number;
  pointerY: number;
  diagramBounds: ConnectionEditorDiagramBounds | null;
}

export function resolveConnectionEditorPosition(
  input: ConnectionEditorPositionInput
): PanelPosition {
  const anchorX = input.tapX - input.coordinateRoot.left;
  const anchorY = input.tapY - input.coordinateRoot.top;

  if (input.isMobile) {
    return resolveMobileConnectionEditorPosition(anchorX, anchorY, input.coordinateRoot);
  }

  return resolveDesktopConnectionEditorPosition(anchorX, anchorY, input);
}

export function resolveConnectionEditorDragPosition(
  input: ConnectionEditorDragPositionInput
): PanelPosition {
  const deltaX = input.pointerX - input.dragStartX;
  const deltaY = input.pointerY - input.dragStartY;
  const rawX = input.dragOffsetX + deltaX;
  const rawY = input.dragOffsetY + deltaY;

  if (!input.diagramBounds) {
    return {
      x: Math.max(0, rawX),
      y: Math.max(0, rawY),
    };
  }

  return {
    x: clamp(
      rawX,
      input.diagramBounds.left + CONNECTION_EDITOR_DRAG_PADDING,
      input.diagramBounds.right - CONNECTION_EDITOR_DIMENSIONS.width - CONNECTION_EDITOR_DRAG_PADDING,
    ),
    y: clamp(
      rawY,
      input.diagramBounds.top + CONNECTION_EDITOR_DRAG_PADDING,
      input.diagramBounds.bottom - CONNECTION_EDITOR_DIMENSIONS.height - CONNECTION_EDITOR_DRAG_PADDING,
    ),
  };
}

export function getConnectionEditorCoordinateRootBounds(): ConnectionEditorCoordinateRootBounds {
  const rootEl = typeof document !== 'undefined'
    ? document.querySelector('[data-testid="project-shell-main-content"]')
    : null;
  if (rootEl) {
    const rect = rootEl.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      return {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      };
    }
  }

  const viewport = typeof window !== 'undefined' ? window.visualViewport : null;
  const fallbackWidth = typeof window !== 'undefined' && Number.isFinite(window.innerWidth)
    ? window.innerWidth
    : 1000;
  const fallbackHeight = typeof window !== 'undefined' && Number.isFinite(window.innerHeight)
    ? window.innerHeight
    : 800;
  return {
    left: viewport?.offsetLeft ?? 0,
    top: viewport?.offsetTop ?? 0,
    width: Number.isFinite(viewport?.width) ? viewport!.width : fallbackWidth,
    height: Number.isFinite(viewport?.height) ? viewport!.height : fallbackHeight,
  };
}

function resolveMobileConnectionEditorPosition(
  anchorX: number,
  anchorY: number,
  coordinateRoot: ConnectionEditorCoordinateRootBounds
): PanelPosition {
  const maxX =
    coordinateRoot.width - CONNECTION_EDITOR_DIMENSIONS.width - CONNECTION_EDITOR_PADDING;
  const maxY =
    coordinateRoot.height - CONNECTION_EDITOR_DIMENSIONS.height - CONNECTION_EDITOR_PADDING;
  const preferredAboveY =
    anchorY - CONNECTION_EDITOR_DIMENSIONS.height - CONNECTION_EDITOR_GAP;
  const fallbackBelowY = anchorY + CONNECTION_EDITOR_GAP;

  const x = clamp(
    anchorX - CONNECTION_EDITOR_DIMENSIONS.width / 2,
    CONNECTION_EDITOR_PADDING,
    maxX
  );
  const unclampedY =
    preferredAboveY >= CONNECTION_EDITOR_PADDING ? preferredAboveY : fallbackBelowY;

  return {
    x,
    y: clamp(unclampedY, CONNECTION_EDITOR_PADDING, maxY),
  };
}

function resolveDesktopConnectionEditorPosition(
  anchorX: number,
  anchorY: number,
  input: ConnectionEditorPositionInput
): PanelPosition {
  const initialX = anchorX - CONNECTION_EDITOR_DIMENSIONS.width / 2;
  const initialY = anchorY - CONNECTION_EDITOR_DIMENSIONS.height - CONNECTION_EDITOR_GAP;

  if (!input.diagramBounds) {
    return {
      x: clamp(
        initialX,
        CONNECTION_EDITOR_PADDING,
        input.coordinateRoot.width - CONNECTION_EDITOR_DIMENSIONS.width - CONNECTION_EDITOR_PADDING
      ),
      y: clamp(
        initialY,
        CONNECTION_EDITOR_PADDING,
        input.coordinateRoot.height - CONNECTION_EDITOR_DIMENSIONS.height - CONNECTION_EDITOR_PADDING
      ),
    };
  }

  return {
    x: clamp(
      initialX,
      input.diagramBounds.left + CONNECTION_EDITOR_PADDING,
      input.diagramBounds.right - CONNECTION_EDITOR_DIMENSIONS.width - CONNECTION_EDITOR_PADDING
    ),
    y: clamp(
      initialY,
      input.diagramBounds.top + CONNECTION_EDITOR_PADDING,
      input.diagramBounds.bottom - CONNECTION_EDITOR_DIMENSIONS.height - CONNECTION_EDITOR_PADDING
    ),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
