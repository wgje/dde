import * as go from 'gojs';

type DragOutDirection = 'bottom' | 'left' | 'right' | 'top';

interface DragOutLogger {
  debug(message: string): void;
  info(message: string, context?: Record<string, unknown>): void;
}

interface DragOutContext {
  direction: DragOutDirection;
  mouseClientX: number;
  mouseClientY: number;
  selectedTaskIds: string[];
}

interface DragOutToolOptions {
  getDiagramDiv: () => HTMLDivElement | null;
  logger: DragOutLogger;
  onNodesDragOutOfBounds: (taskIds: string[], clientX: number, clientY: number) => void;
}

interface OutOfBoundsPointer {
  direction: DragOutDirection;
  mouseClientX: number;
  mouseClientY: number;
}

const OUT_OF_BOUNDS_THRESHOLD = 40;

export function installDragOutOfBoundsTool(
  diagram: go.Diagram,
  options: DragOutToolOptions,
): void {
  const draggingTool = diagram.toolManager.draggingTool;
  let savedPositions: Map<string, go.Point> = new Map();
  let hasFiredDragOut = false;

  const originalDoActivate = draggingTool.doActivate.bind(draggingTool);
  draggingTool.doActivate = function () {
    savedPositions = captureSelectedNodePositions(diagram);
    hasFiredDragOut = false;
    originalDoActivate();
  };

  const originalDoMouseMove = draggingTool.doMouseMove.bind(draggingTool);
  draggingTool.doMouseMove = function () {
    if (hasFiredDragOut) return;

    const pointer = getOutOfBoundsPointer(diagram, options.getDiagramDiv());
    if (!pointer) {
      originalDoMouseMove();
      return;
    }

    hasFiredDragOut = true;
    const selectedTaskIds = collectSelectedTaskIds(diagram);
    if (selectedTaskIds.length > 0) {
      handleDragOut(diagram, draggingTool, savedPositions, options, {
        ...pointer,
        selectedTaskIds,
      });
    }
  };

  options.logger.debug('DraggingTool 边界检测已配置');
}

function captureSelectedNodePositions(diagram: go.Diagram): Map<string, go.Point> {
  const positions = new Map<string, go.Point>();
  diagram.selection.each((part: go.Part) => {
    if (part instanceof go.Node && typeof part.key === 'string') {
      positions.set(part.key, part.location.copy());
    }
  });
  return positions;
}

function collectSelectedTaskIds(diagram: go.Diagram): string[] {
  const selectedTaskIds: string[] = [];
  diagram.selection.each((part: go.Part) => {
    if (part instanceof go.Node && typeof part.key === 'string') {
      selectedTaskIds.push(part.key);
    }
  });
  return selectedTaskIds;
}

function getOutOfBoundsPointer(
  diagram: go.Diagram,
  diagramDiv: HTMLDivElement | null,
): OutOfBoundsPointer | null {
  const input = diagram.lastInput;
  if (!input || !diagramDiv) {
    return null;
  }

  const divRect = diagramDiv.getBoundingClientRect();
  const mouseClientX = divRect.left + input.viewPoint.x;
  const mouseClientY = divRect.top + input.viewPoint.y;
  const direction = resolveOutOfBoundsDirection(divRect, mouseClientX, mouseClientY);

  return direction ? { direction, mouseClientX, mouseClientY } : null;
}

function resolveOutOfBoundsDirection(
  divRect: DOMRect,
  mouseClientX: number,
  mouseClientY: number,
): DragOutDirection | null {
  if (mouseClientY > divRect.bottom + OUT_OF_BOUNDS_THRESHOLD) return 'bottom';
  if (mouseClientY < divRect.top - OUT_OF_BOUNDS_THRESHOLD) return 'top';
  if (mouseClientX < divRect.left - OUT_OF_BOUNDS_THRESHOLD) return 'left';
  if (mouseClientX > divRect.right + OUT_OF_BOUNDS_THRESHOLD) return 'right';
  return null;
}

function handleDragOut(
  diagram: go.Diagram,
  draggingTool: go.DraggingTool,
  savedPositions: Map<string, go.Point>,
  options: DragOutToolOptions,
  context: DragOutContext,
): void {
  options.logger.info('节点拖出画布边界，启动拖入停泊坞流程', {
    taskIds: context.selectedTaskIds,
    count: context.selectedTaskIds.length,
    direction: context.direction,
  });

  draggingTool.doCancel();
  restoreSavedNodePositions(diagram, savedPositions);
  options.onNodesDragOutOfBounds(
    context.selectedTaskIds,
    context.mouseClientX,
    context.mouseClientY,
  );
}

function restoreSavedNodePositions(
  diagram: go.Diagram,
  savedPositions: Map<string, go.Point>,
): void {
  diagram.startTransaction('restore-drag-positions');
  savedPositions.forEach((position, key) => {
    const node = diagram.findNodeForKey(key);
    if (node) {
      node.location = position;
    }
  });
  diagram.commitTransaction('restore-drag-positions');
}
