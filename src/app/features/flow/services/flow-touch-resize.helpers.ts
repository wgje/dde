export interface TouchResizeHandler {
  startResize: (event: TouchEvent) => void;
  cleanup: () => void;
}

export interface TouchResizeOptions {
  onHeightChange: (height: number) => void;
  getInitialHeight: () => number;
  calculateHeight: (startHeight: number, startY: number, currentY: number) => number;
  onResizingChange?: (isResizing: boolean) => void;
}

interface TouchResizeListenerRegistry {
  track: (type: string, handler: EventListener, options?: boolean | AddEventListenerOptions) => void;
  remove: (type: string, handler: EventListener) => void;
}

function installTouchResizeListeners(
  onMove: (event: TouchEvent) => void,
  onEnd: () => void,
  listeners: TouchResizeListenerRegistry,
): void {
  window.addEventListener('touchmove', onMove as EventListener, { passive: false });
  window.addEventListener('touchend', onEnd);
  window.addEventListener('touchcancel', onEnd);
  listeners.track('touchmove', onMove as EventListener, { passive: false });
  listeners.track('touchend', onEnd);
  listeners.track('touchcancel', onEnd);
}

export function createTrackedTouchResizeHandler(
  options: TouchResizeOptions,
  listeners: TouchResizeListenerRegistry,
): TouchResizeHandler {
  let isResizing = false;
  let startY = 0;
  let startHeight = 0;
  let onMove: ((event: TouchEvent) => void) | null = null;
  let onEnd: (() => void) | null = null;

  const removeListeners = () => {
    const moveHandler = onMove;
    const endHandler = onEnd;
    onMove = null;
    onEnd = null;
    if (moveHandler) listeners.remove('touchmove', moveHandler as EventListener);
    if (endHandler) {
      listeners.remove('touchend', endHandler);
      listeners.remove('touchcancel', endHandler);
    }
  };

  return {
    startResize: event => {
      if (event.touches.length !== 1) return;
      event.preventDefault();
      removeListeners();

      isResizing = true;
      options.onResizingChange?.(true);
      startY = event.touches[0].clientY;
      startHeight = options.getInitialHeight();

      onMove = moveEvent => {
        if (!isResizing || moveEvent.touches.length !== 1) return;
        moveEvent.preventDefault();
        options.onHeightChange(
          options.calculateHeight(startHeight, startY, moveEvent.touches[0].clientY),
        );
      };
      onEnd = () => {
        isResizing = false;
        options.onResizingChange?.(false);
        removeListeners();
      };

      installTouchResizeListeners(onMove, onEnd, listeners);
    },
    cleanup: removeListeners,
  };
}
