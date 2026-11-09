import type {
  LinkActionMenu,
  LinkDeleteHint,
} from '../../../../models/flow-view-state';

export interface FlowOverlayViewport {
  width: number;
  height: number;
}

export interface FlowOverlayPosition {
  x: number;
  y: number;
}

const DEFAULT_VIEWPORT: FlowOverlayViewport = {
  width: 400,
  height: 600,
};

const OVERLAY_PADDING = 16;
const ACTION_MENU_SIZE = {
  width: 200,
  height: 100,
};
const DELETE_HINT_SIZE = {
  width: 180,
  height: 50,
};

export function readFlowOverlayViewport(): FlowOverlayViewport {
  if (typeof window === 'undefined') {
    return DEFAULT_VIEWPORT;
  }

  return {
    width: window.innerWidth,
    height: window.innerHeight,
  };
}

export function clampFlowOverlayPosition(input: {
  rawX: number;
  rawY: number;
  overlayWidth: number;
  overlayHeight: number;
  viewport: FlowOverlayViewport;
}): FlowOverlayPosition {
  return {
    x: Math.max(
      OVERLAY_PADDING,
      Math.min(input.rawX, input.viewport.width - input.overlayWidth - OVERLAY_PADDING),
    ),
    y: Math.max(
      OVERLAY_PADDING,
      Math.min(input.rawY, input.viewport.height - input.overlayHeight - OVERLAY_PADDING),
    ),
  };
}

export function resolveFlowLinkActionMenuPosition(
  menu: Pick<LinkActionMenu, 'x' | 'y'> | null,
  viewport: FlowOverlayViewport = readFlowOverlayViewport(),
): FlowOverlayPosition {
  if (!menu) {
    return { x: 0, y: 0 };
  }

  return clampFlowOverlayPosition({
    rawX: menu.x - ACTION_MENU_SIZE.width / 2,
    rawY: menu.y - ACTION_MENU_SIZE.height - 10,
    overlayWidth: ACTION_MENU_SIZE.width,
    overlayHeight: ACTION_MENU_SIZE.height,
    viewport,
  });
}

export function resolveFlowLinkDeleteHintPosition(
  hint: Pick<LinkDeleteHint, 'x' | 'y'> | null,
  viewport: FlowOverlayViewport = readFlowOverlayViewport(),
): FlowOverlayPosition {
  if (!hint) {
    return { x: 0, y: 0 };
  }

  return clampFlowOverlayPosition({
    rawX: hint.x - 60,
    rawY: hint.y - DELETE_HINT_SIZE.height,
    overlayWidth: DELETE_HINT_SIZE.width,
    overlayHeight: DELETE_HINT_SIZE.height,
    viewport,
  });
}
