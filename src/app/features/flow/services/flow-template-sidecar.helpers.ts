import * as go from 'gojs';

type SidecarBadgePart = 'chip' | 'dot' | 'leaderH' | 'leaderV';
type SidecarPanelType = 'Horizontal' | 'Vertical';

export interface FlowNodeSidecarTemplateContext {
  isMobile: boolean;
  sidecarTitleMaxSize: go.Size;
}

export interface FlowNodeSidecarTemplatePartsOptions {
  context: FlowNodeSidecarTemplateContext;
  onToggle: (taskId: string, part: go.Part | undefined) => void;
}

export function createFlowNodeSidecarTemplateParts(
  options: FlowNodeSidecarTemplatePartsOptions,
): go.GraphObject[] {
  return [
    createSidecarToggle(options.context, options.onToggle),
    ...createSidecarWingPanels(options.context),
  ];
}

export function readFlowNodeSidecarCount(items: unknown): string {
  return Array.isArray(items) ? String(items.length) : '0';
}

function createSidecarToggle(
  context: FlowNodeSidecarTemplateContext,
  onToggle: (taskId: string, part: go.Part | undefined) => void,
): go.Panel {
  const $ = go.GraphObject.make;
  const tooltip = createSidecarToggleTooltip(context);
  return $(go.Panel, 'Auto',
    {
      name: 'SIDECAR_TOGGLE',
      alignment: new go.Spot(1, 0, -6, 6),
      cursor: 'pointer',
      isActionable: true,
      pickable: true,
      visible: false,
      ...(tooltip ? { toolTip: tooltip } : {}),
      click: (event: go.InputEvent, obj: go.GraphObject) => handleSidecarToggleClick(event, obj, onToggle),
    },
    new go.Binding('visible', 'sidecarHasSignals', (hasSignals: boolean) => Boolean(hasSignals)),
    createSidecarToggleShape(),
    createSidecarToggleLabelPanel(),
  ) as go.Panel;
}

function createSidecarToggleShape(): go.Shape {
  const $ = go.GraphObject.make;
  return $(go.Shape, 'RoundedRectangle', {
    fill: '#fef3c7',
    stroke: '#f59e0b',
    strokeWidth: 1,
    parameter1: 6,
  },
  new go.Binding('fill', 'sidecarExpanded', (expanded: boolean) => expanded ? '#f59e0b' : '#fef3c7'),
  new go.Binding('stroke', 'sidecarExpanded', (expanded: boolean) => expanded ? '#b45309' : '#f59e0b')) as go.Shape;
}

function createSidecarToggleLabelPanel(): go.Panel {
  const $ = go.GraphObject.make;
  return $(go.Panel, 'Horizontal',
    { margin: new go.Margin(1, 4, 1, 4), defaultAlignment: go.Spot.Center },
    $(go.TextBlock, '僚', {
      font: '700 8px "LXGW WenKai Screen", sans-serif',
      stroke: '#92400e',
    },
      new go.Binding('stroke', 'sidecarExpanded', (expanded: boolean) => expanded ? '#fff7ed' : '#92400e')),
    $(go.TextBlock, {
      margin: new go.Margin(0, 0, 0, 2),
      font: '700 8px "LXGW WenKai Screen", sans-serif',
      stroke: '#92400e',
    },
      new go.Binding('text', 'sidecarBadgeItems', readFlowNodeSidecarCount),
      new go.Binding('stroke', 'sidecarExpanded', (expanded: boolean) => expanded ? '#fff7ed' : '#92400e')),
  ) as go.Panel;
}

function handleSidecarToggleClick(
  event: go.InputEvent,
  obj: go.GraphObject,
  onToggle: (taskId: string, part: go.Part | undefined) => void,
): void {
  event.handled = true;
  const taskId = obj.part?.data?.key;
  if (typeof taskId === 'string') onToggle(taskId, obj.part ?? undefined);
}

function createSidecarWingPanels(context: FlowNodeSidecarTemplateContext): go.GraphObject[] {
  return [
    createSidecarWing(
      context,
      'SIDECAR_WING_TOP',
      'Horizontal',
      new go.Spot(0.58, 0, 0, -10),
      go.Spot.Bottom,
      'sidecarTopBadgeItems',
      'sidecarTopVisible',
      createSidecarBadgeItemTemplate(context, 'Vertical', new go.Margin(0, 4, 0, 1), ['chip', 'leaderV', 'dot']),
    ),
    createSidecarWing(
      context,
      'SIDECAR_WING_RIGHT',
      'Vertical',
      new go.Spot(1, 0.38, 10, 0),
      go.Spot.Left,
      'sidecarRightBadgeItems',
      'sidecarRightVisible',
      createSidecarBadgeItemTemplate(context, 'Horizontal', new go.Margin(1, 0, 4, 0), ['dot', 'leaderH', 'chip']),
    ),
    createSidecarWing(
      context,
      'SIDECAR_WING_BOTTOM',
      'Horizontal',
      new go.Spot(0.42, 1, 0, 10),
      go.Spot.Top,
      'sidecarBottomBadgeItems',
      'sidecarBottomVisible',
      createSidecarBadgeItemTemplate(context, 'Vertical', new go.Margin(0, 1, 0, 4), ['dot', 'leaderV', 'chip']),
    ),
    createSidecarWing(
      context,
      'SIDECAR_WING_LEFT',
      'Vertical',
      new go.Spot(0, 0.58, -10, 0),
      go.Spot.Right,
      'sidecarLeftBadgeItems',
      'sidecarLeftVisible',
      createSidecarBadgeItemTemplate(context, 'Horizontal', new go.Margin(3, 0, 2, 0), ['chip', 'leaderH', 'dot']),
    ),
  ];
}

function createSidecarWing(
  context: FlowNodeSidecarTemplateContext,
  name: string,
  panelType: SidecarPanelType,
  alignment: go.Spot,
  alignmentFocus: go.Spot,
  itemArray: string,
  visible: string,
  itemTemplate: go.Panel,
): go.Panel {
  const $ = go.GraphObject.make;
  return $(go.Panel, panelType, {
    name,
    alignment,
    alignmentFocus,
    itemTemplate,
    maxSize: context.sidecarTitleMaxSize,
    pickable: true,
    visible: false,
  },
  new go.Binding('itemArray', itemArray),
  new go.Binding('visible', visible, Boolean)) as go.Panel;
}

function createSidecarBadgeItemTemplate(
  context: FlowNodeSidecarTemplateContext,
  panelType: SidecarPanelType,
  margin: go.Margin,
  parts: SidecarBadgePart[],
): go.Panel {
  const $ = go.GraphObject.make;
  return $(go.Panel, panelType,
    { margin, pickable: true, ...createSidecarTooltipConfig(context) },
    ...parts.map(part => createSidecarBadgePart(part, context)),
  ) as go.Panel;
}

function createSidecarBadgePart(part: SidecarBadgePart, context: FlowNodeSidecarTemplateContext): go.GraphObject {
  if (part === 'chip') return createSidecarBadgeChip(context);
  if (part === 'dot') return createSidecarDot();
  return createSidecarLeader(part === 'leaderH' ? 'LineH' : 'LineV', 8);
}

function createSidecarTooltipConfig(context: FlowNodeSidecarTemplateContext): { toolTip?: go.Adornment } {
  return context.isMobile ? {} : { toolTip: createSidecarBadgeTooltip() };
}

function createSidecarBadgeTooltip(): go.Adornment {
  const $ = go.GraphObject.make;
  return $(go.Adornment, 'Auto',
    $(go.Shape, 'RoundedRectangle', {
      fill: 'rgba(255, 251, 235, 0.98)',
      stroke: '#f59e0b',
      strokeWidth: 1,
      parameter1: 6,
    }),
    $(go.TextBlock, {
      margin: 6,
      font: '10px "LXGW WenKai Screen", sans-serif',
      stroke: '#78350f',
      maxSize: new go.Size(180, NaN),
      wrap: go.TextBlock.WrapFit,
    },
    new go.Binding('text', 'tooltipText')),
  ) as go.Adornment;
}

function createSidecarToggleTooltip(context: FlowNodeSidecarTemplateContext): go.Adornment | undefined {
  if (context.isMobile) return undefined;
  const $ = go.GraphObject.make;
  return $(go.Adornment, 'Auto',
    $(go.Shape, 'RoundedRectangle', {
      fill: 'rgba(255, 251, 235, 0.98)',
      stroke: '#f59e0b',
      strokeWidth: 1,
      parameter1: 6,
    }),
    $(go.TextBlock, {
      margin: 6,
      font: '10px "LXGW WenKai Screen", sans-serif',
      stroke: '#78350f',
      maxSize: new go.Size(160, NaN),
      wrap: go.TextBlock.WrapFit,
    },
      new go.Binding('text', 'sidecarExpanded', (expanded: boolean) => expanded ? '收起任务僚机' : '展开任务僚机')),
  ) as go.Adornment;
}

function createSidecarBadgeChip(context: FlowNodeSidecarTemplateContext): go.Panel {
  const $ = go.GraphObject.make;
  return $(go.Panel, 'Auto',
    { pickable: true, ...createSidecarTooltipConfig(context) },
    $(go.Shape, 'RoundedRectangle', {
      fill: '#fef3c7',
      stroke: '#fbbf24',
      strokeWidth: 1,
      parameter1: 7,
      minSize: new go.Size(18, 16),
    },
    new go.Binding('fill', 'tone', (tone: string) => tone === 'attention' ? '#fef3c7' : '#fafaf9'),
    new go.Binding('stroke', 'tone', (tone: string) => tone === 'attention' ? '#fbbf24' : '#d6d3d1')),
    $(go.TextBlock, {
      margin: new go.Margin(1, 5, 1, 5),
      font: '700 8px "LXGW WenKai Screen", sans-serif',
      stroke: '#a16207',
    },
      new go.Binding('text', 'cue')),
  ) as go.Panel;
}

function createSidecarLeader(figure: 'LineH' | 'LineV', size: number): go.Shape {
  const $ = go.GraphObject.make;
  return $(go.Shape, figure, {
    width: figure === 'LineH' ? size : 1,
    height: figure === 'LineV' ? size : 1,
    stroke: 'rgba(245, 158, 11, 0.35)',
    strokeWidth: 1,
    pickable: false,
  }) as go.Shape;
}

function createSidecarDot(): go.Shape {
  const $ = go.GraphObject.make;
  return $(go.Shape, 'Circle', {
    desiredSize: new go.Size(3, 3),
    fill: '#f59e0b',
    stroke: null,
    opacity: 0.65,
    pickable: false,
  }) as go.Shape;
}
