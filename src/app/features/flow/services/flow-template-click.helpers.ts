export interface NodeClickModifierStateInput {
  eventShift: boolean;
  eventControl: boolean;
  eventMeta: boolean;
  lastInputShift: boolean;
  lastInputControl: boolean;
  lastInputMeta: boolean;
  domShiftKey: boolean;
  domCtrlKey: boolean;
  domMetaKey: boolean;
}

export function resolveNodeClickModifierState(input: NodeClickModifierStateInput): boolean {
  return input.eventShift
    || input.lastInputShift
    || input.domShiftKey
    || input.eventControl
    || input.lastInputControl
    || input.domCtrlKey
    || input.eventMeta
    || input.lastInputMeta
    || input.domMetaKey;
}

export interface NodeClickInputState {
  isMobileMode: boolean;
  isDragSelectEnabled: boolean;
  isSelectModifierPressed: boolean;
}

interface NodeClickInputEventLike {
  shift?: boolean;
  control?: boolean;
  meta?: boolean;
  event?: Event | null;
  diagram?: {
    lastInput?: {
      shift?: boolean;
      control?: boolean;
      meta?: boolean;
    };
    toolManager?: {
      dragSelectingTool?: {
        isEnabled?: boolean;
      };
    };
  };
}

interface NodeTemplateClickEventLike {
  handled?: boolean;
  diagram?: {
    lastInput?: {
      clickCount?: number;
    };
    toolManager?: {
      draggingTool?: {
        isActive?: boolean;
      };
    };
  };
}

export function shouldIgnoreNodeTemplateClick(event: NodeTemplateClickEventLike): boolean {
  const diagram = event.diagram;
  return Boolean(
    diagram?.toolManager?.draggingTool?.isActive
    || (diagram?.lastInput?.clickCount ?? 0) >= 2
    || event.handled
  );
}

export function resolveNodeClickInputState(input: {
  event: NodeClickInputEventLike;
  isMobileMode: boolean;
}): NodeClickInputState {
  const lastInput = input.event.diagram?.lastInput;
  const domEvent = input.event.event as Partial<KeyboardEvent | MouseEvent | PointerEvent> | null | undefined;
  const dragSelectTool = input.event.diagram?.toolManager?.dragSelectingTool;

  return {
    isMobileMode: input.isMobileMode,
    isDragSelectEnabled: Boolean(dragSelectTool?.isEnabled),
    isSelectModifierPressed: resolveNodeClickModifierState({
      eventShift: Boolean(input.event.shift),
      eventControl: Boolean(input.event.control),
      eventMeta: Boolean(input.event.meta),
      lastInputShift: Boolean(lastInput?.shift),
      lastInputControl: Boolean(lastInput?.control),
      lastInputMeta: Boolean(lastInput?.meta),
      domShiftKey: Boolean(domEvent?.shiftKey),
      domCtrlKey: Boolean(domEvent?.ctrlKey),
      domMetaKey: Boolean(domEvent?.metaKey),
    }),
  };
}
