import * as go from 'gojs';

type ClickSelectHandler = (e?: go.InputEvent, obj?: go.GraphObject | null) => void;

interface FlowClickSelectingTool {
  standardMouseSelect: ClickSelectHandler;
  standardTouchSelect?: ClickSelectHandler;
}

interface ToggleSelectionOptions {
  transactionName: string;
  missingEventWarning: string;
  startLog?: string;
  finishLog?: string;
}

interface FlowDiagramInteractionLogger {
  debug(message: string, context?: unknown): void;
  warn(message: string, context?: unknown): void;
}

export function setupDesktopPanAndSelectTools(diagram: go.Diagram): void {
  const panningTool = diagram.toolManager.panningTool;
  const dragSelectTool = diagram.toolManager.dragSelectingTool;

  panningTool.isEnabled = true;
  panningTool.canStart = function () {
    if (!this.diagram || !this.isEnabled || this.diagram.isReadOnly) return false;

    const e = this.diagram.lastInput;
    if (!e || !e.left) return false;
    if (e.shift || e.alt) return false;
    if (e.targetDiagram !== this.diagram) return false;

    const part = this.diagram.findPartAt(e.documentPoint, true);
    if (part && (part instanceof go.Node || part instanceof go.Link)) {
      return false;
    }

    return this.diagram.allowHorizontalScroll || this.diagram.allowVerticalScroll;
  };

  dragSelectTool.isEnabled = true;
  dragSelectTool.isPartialInclusion = true;
  dragSelectTool.canStart = function () {
    if (!this.diagram || !this.isEnabled || this.diagram.isReadOnly) return false;

    const e = this.diagram.lastInput;
    if (!e || !e.right) return false;
    if (e.targetDiagram !== this.diagram) return false;

    const part = this.diagram.findPartAt(e.documentPoint, true);
    if (part && (part instanceof go.Node || part instanceof go.Link)) {
      return false;
    }

    return true;
  };
}

export function setupMultiSelectClickTool(
  diagram: go.Diagram,
  isMobileMode: boolean,
  logger: FlowDiagramInteractionLogger,
): void {
  const clickTool = diagram.toolManager.clickSelectingTool as FlowClickSelectingTool;
  const originalStandardMouseSelect = clickTool.standardMouseSelect.bind(clickTool);
  const originalStandardTouchSelect = clickTool.standardTouchSelect?.bind(clickTool);

  clickTool.standardMouseSelect = createStandardMouseSelectOverride(
    diagram,
    isMobileMode,
    originalStandardMouseSelect,
    logger,
  );

  if (typeof originalStandardTouchSelect === 'function') {
    clickTool.standardTouchSelect = createStandardTouchSelectOverride(
      diagram,
      isMobileMode,
      originalStandardTouchSelect,
      logger,
    );
  }
}

function createStandardMouseSelectOverride(
  diagram: go.Diagram,
  isMobileMode: boolean,
  originalStandardMouseSelect: ClickSelectHandler,
  logger: FlowDiagramInteractionLogger,
): ClickSelectHandler {
  return (e?: go.InputEvent, obj?: go.GraphObject | null) => {
    if (e?.handled) return;

    const dragSelectTool = diagram.toolManager.dragSelectingTool;
    const lastInput = diagram.lastInput as go.InputEvent | null;
    const domEvent = (e as go.InputEvent & { event?: MouseEvent | PointerEvent | KeyboardEvent })?.event;
    const isSelectModeActive = isMobileMode && Boolean(dragSelectTool && dragSelectTool.isEnabled);

    if (isSelectModeActive && obj?.part instanceof go.Node) {
      toggleNodeSelectionFromClick(diagram, obj.part, e, {
        transactionName: 'toggle-selection',
        missingEventWarning: '[FlowDiagram] 事件对象为 undefined，无法标记为已处理',
        startLog: '[standardMouseSelect] 框选模式激活',
        finishLog: '[toggle-selection] 切换选中状态完成',
      }, logger);
      return;
    }

    if (wantsMultiSelect(e, lastInput, domEvent) && obj?.part instanceof go.Node) {
      toggleNodeSelectionFromClick(diagram, obj.part, e, {
        transactionName: 'multi-select',
        missingEventWarning: '[FlowDiagram] 多选模式下事件对象为 undefined',
      }, logger);
      return;
    }

    if (e) {
      originalStandardMouseSelect(e, obj);
    } else {
      logger.debug('[FlowDiagram] 跳过 originalStandardMouseSelect 调用（事件为 undefined）');
    }
  };
}

function createStandardTouchSelectOverride(
  diagram: go.Diagram,
  isMobileMode: boolean,
  originalStandardTouchSelect: ClickSelectHandler,
  logger: FlowDiagramInteractionLogger,
): ClickSelectHandler {
  return (e?: go.InputEvent, obj?: go.GraphObject | null) => {
    const dragSelectTool = diagram.toolManager.dragSelectingTool;
    const isSelectModeActive = isMobileMode && Boolean(dragSelectTool && dragSelectTool.isEnabled);

    if (isSelectModeActive && obj?.part instanceof go.Node) {
      toggleNodeSelectionFromClick(diagram, obj.part, e, {
        transactionName: 'toggle-selection',
        missingEventWarning: '[FlowDiagram] Touch 事件对象为 undefined',
        finishLog: '[Touch toggle] 切换完成',
      }, logger);
      return;
    }

    if (e) {
      originalStandardTouchSelect(e, obj);
    } else {
      logger.warn('[FlowDiagram] 跳过 originalStandardTouchSelect 调用（事件为 undefined）');
    }
  };
}

function wantsMultiSelect(
  event: go.InputEvent | undefined,
  lastInput: go.InputEvent | null,
  domEvent: MouseEvent | PointerEvent | KeyboardEvent | undefined,
): boolean {
  return Boolean(
    event?.shift ||
    lastInput?.shift ||
    domEvent?.shiftKey ||
    event?.control ||
    lastInput?.control ||
    (domEvent as MouseEvent | undefined)?.ctrlKey ||
    event?.meta ||
    lastInput?.meta ||
    (domEvent as MouseEvent | undefined)?.metaKey
  );
}

function toggleNodeSelectionFromClick(
  diagram: go.Diagram,
  node: go.Node,
  event: go.InputEvent | undefined,
  options: ToggleSelectionOptions,
  logger: FlowDiagramInteractionLogger,
): void {
  if (options.startLog) {
    logger.debug(options.startLog, { nodeKey: node.key, isSelected: node.isSelected });
  }

  if (event) {
    event.handled = true;
  } else {
    logger.warn(options.missingEventWarning);
  }

  diagram.startTransaction(options.transactionName);
  node.isSelected = !node.isSelected;
  diagram.commitTransaction(options.transactionName);
  diagram.raiseDiagramEvent('ChangedSelection');

  if (options.finishLog) {
    logger.debug(options.finishLog, {
      nodeKey: node.key,
      newState: node.isSelected,
      totalSelected: diagram.selection.count
    });
  }
}
