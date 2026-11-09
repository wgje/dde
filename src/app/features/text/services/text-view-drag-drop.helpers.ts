import type {
  TouchDragGestureMode,
  TouchDragState,
} from '../components/text-view.types';

interface DragGhostLogger {
  debug(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
}

export interface TouchMoveMetrics {
  deltaX: number;
  deltaY: number;
  totalDistance: number;
  isVerticalScroll: boolean;
  threshold: number;
  gestureMode: TouchDragGestureMode;
}

export interface DragGhostPosition {
  x: number;
  y: number;
  width: number;
  height: number;
}

type ClientPoint = Pick<Touch, 'clientX' | 'clientY'>;

export function createInitialTouchDragState(): TouchDragState {
  return {
    task: null,
    isDragging: false,
    targetStage: null,
    targetBeforeId: null,
    targetUnassignedId: null,
    startX: 0,
    startY: 0,
    currentX: 0,
    currentY: 0,
    gestureMode: 'default',
    longPressTimer: null,
    dragGhost: null,
    previousHoverStage: null,
    expandedDuringDrag: new Set<number>(),
    originalStage: null,
  };
}

export function createTouchMoveMetrics(input: {
  touch: ClientPoint;
  startX: number;
  startY: number;
  gestureMode: TouchDragGestureMode;
  defaultMoveThreshold: number;
  handleMoveThreshold: number;
  defaultVerticalScrollRatio: number;
}): TouchMoveMetrics {
  const deltaX = Math.abs(input.touch.clientX - input.startX);
  const deltaY = Math.abs(input.touch.clientY - input.startY);
  const threshold = input.gestureMode === 'handle'
    ? input.handleMoveThreshold
    : input.defaultMoveThreshold;
  const isVerticalScroll = input.gestureMode === 'handle'
    ? false
    : deltaY > deltaX * input.defaultVerticalScrollRatio;

  return {
    deltaX,
    deltaY,
    totalDistance: Math.sqrt(deltaX * deltaX + deltaY * deltaY),
    isVerticalScroll,
    threshold,
    gestureMode: input.gestureMode,
  };
}

export function calculateDragGhostPosition(input: {
  x: number;
  y: number;
  width: number;
  height: number;
  margin: number;
  viewportWidth: number;
  viewportHeight: number;
}): DragGhostPosition {
  const maxX = input.viewportWidth - input.width - input.margin;
  const maxY = input.viewportHeight - input.height - input.margin;

  return {
    x: Math.max(input.margin, Math.min(input.x - input.width / 2, maxX)),
    y: Math.max(input.margin, Math.min(input.y, maxY)),
    width: input.width,
    height: input.height,
  };
}

export function createDragGhostCss(position: DragGhostPosition): string {
  return `
      position: fixed !important;
      z-index: 2147483647 !important;
      left: ${position.x}px !important;
      top: ${position.y}px !important;
      width: ${position.width}px !important;
      min-height: ${position.height}px !important;
      background-color: #FFFFFF !important;
      color: #44403C !important;
      border: 2px solid #4A8C8C !important;
      border-radius: 10px !important;
      font-family: "LXGW WenKai Screen", sans-serif !important;
      font-size: 14px !important;
      font-weight: 500 !important;
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      pointer-events: none !important;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.15), 0 2px 8px rgba(74, 140, 140, 0.2) !important;
      text-align: center !important;
      padding: 10px 16px !important;
      box-sizing: border-box !important;
      visibility: visible !important;
      transform: none !important;
      overflow: hidden !important;
      text-overflow: ellipsis !important;
      white-space: nowrap !important;
      opacity: 0.3 !important;
    `;
}

export function createDragGhostElement(input: {
  taskId: string;
  title: string | null | undefined;
  x: number;
  y: number;
  viewportWidth: number;
  viewportHeight: number;
  timestamp: number;
  logger: Pick<DragGhostLogger, 'debug'>;
}): HTMLElement {
  const ghostId = 'touch-drag-ghost-' + input.timestamp;
  const position = calculateDragGhostPosition({
    x: input.x,
    y: input.y,
    width: Math.min(200, input.viewportWidth - 20),
    height: 48,
    margin: 10,
    viewportWidth: input.viewportWidth,
    viewportHeight: input.viewportHeight,
  });

  const ghost = document.createElement('div');
  ghost.id = ghostId;
  ghost.setAttribute('data-drag-ghost', 'true');
  ghost.className = 'nf-drag-ghost';
  ghost.innerText = input.title || '未命名任务';
  ghost.style.cssText = createDragGhostCss(position);

  document.body.appendChild(ghost);

  input.logger.debug('🎯 Ghost created:', {
    taskId: input.taskId.slice(-4) || 'unknown',
    ghostId,
    position: { x: position.x, y: position.y },
  });

  return ghost;
}

export function removeDragGhostElement(input: {
  ghost: HTMLElement | null;
  getActiveGhostId: () => string | undefined;
  logger: DragGhostLogger;
}): void {
  if (input.ghost) {
    try {
      input.ghost.style.display = 'none';
      input.ghost.style.opacity = '0';
      input.ghost.remove();
    } catch (error) {
      input.logger.warn('Failed to remove drag ghost', { error });
    }
  }

  setTimeout(() => {
    const ghosts = document.querySelectorAll('[data-drag-ghost="true"]');
    const activeGhostId = input.getActiveGhostId();
    ghosts.forEach(ghost => {
      if (ghost.id === activeGhostId) {
        return;
      }
      try {
        input.logger.debug('🧹 Cleaning orphaned ghost:', ghost.id);
        (ghost as HTMLElement).style.display = 'none';
        (ghost as HTMLElement).style.opacity = '0';
        ghost.remove();
      } catch (error) {
        input.logger.warn('Failed to remove orphaned ghost element', { error });
      }
    });
  });
}

export function applyDragGhostFeedback(
  ghost: HTMLElement,
  isOverValidTarget: boolean,
): void {
  if (isOverValidTarget) {
    ghost.style.borderColor = '#4A8C8C';
    ghost.style.boxShadow = '0 8px 24px rgba(0, 0, 0, 0.2), 0 2px 8px rgba(74, 140, 140, 0.4)';
    return;
  }

  ghost.style.borderColor = '#C15B3E';
  ghost.style.boxShadow = '0 8px 24px rgba(0, 0, 0, 0.2), 0 2px 8px rgba(193, 91, 62, 0.3)';
}

export function getNestedAutoScrollAmount(
  clientY: number,
  rect: DOMRect,
  edgeSize = 80,
  maxScrollSpeed = 12,
): number {
  if (clientY >= rect.top && clientY < rect.top + edgeSize) {
    const distance = edgeSize - (clientY - rect.top);
    const ratio = Math.min(1, Math.max(0, distance / edgeSize));
    return -maxScrollSpeed * ratio * ratio;
  }

  if (clientY > rect.bottom - edgeSize && clientY <= rect.bottom) {
    const distance = edgeSize - (rect.bottom - clientY);
    const ratio = Math.min(1, Math.max(0, distance / edgeSize));
    return maxScrollSpeed * ratio * ratio;
  }

  return 0;
}

export function getAutoScrollAmount(
  clientY: number,
  rect: DOMRect,
  edgeSize = 100,
  maxScrollSpeed = 18,
): number {
  if (clientY < rect.top + edgeSize && clientY > rect.top - 20) {
    const distance = rect.top + edgeSize - clientY;
    const ratio = Math.min(1, Math.max(0, distance / edgeSize));
    return -maxScrollSpeed * ratio * ratio;
  }

  if (clientY > rect.bottom - edgeSize && clientY < rect.bottom + 20) {
    const distance = clientY - (rect.bottom - edgeSize);
    const ratio = Math.min(1, Math.max(0, distance / edgeSize));
    return maxScrollSpeed * ratio * ratio;
  }

  return 0;
}

export function applyAutoScrollAmount(container: HTMLElement, scrollAmount: number): boolean {
  const previousScrollTop = container.scrollTop;
  container.scrollTop += scrollAmount;
  return container.scrollTop !== previousScrollTop;
}

export function getNextAutoScrollContainer(container: HTMLElement): HTMLElement | null {
  if (container.hasAttribute('data-stage-task-list')) {
    const stageScrollContainer = container.closest('[data-stage-scroll-container]');
    if (stageScrollContainer instanceof HTMLElement && stageScrollContainer !== container) {
      return stageScrollContainer;
    }
  }

  if (container.hasAttribute('data-stage-scroll-container')) {
    const outerScrollContainer = container.closest('.text-view-scroll-container');
    if (outerScrollContainer instanceof HTMLElement && outerScrollContainer !== container) {
      return outerScrollContainer;
    }
  }

  return null;
}
