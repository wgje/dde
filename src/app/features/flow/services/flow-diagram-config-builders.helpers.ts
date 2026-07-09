import type { FlowStyleConfig } from '../../../../config/flow-styles';
import * as go from 'gojs';

interface FlowNodeTemplateConfig {
  unassignedWidth: number;
  assignedWidth: number;
  cornerRadius: number;
}

interface FlowLinkTemplateConfig {
  mobileStrokeWidth: number;
  desktopStrokeWidth: number;
  visibleStrokeWidth: number;
  arrowType: string;
  arrowScale: number;
  arrowStrokeWidth: number;
}

export function createFlowPort(
  make: typeof go.GraphObject.make,
  name: string,
  spot: go.Spot,
  output: boolean,
  input: boolean,
  isMobile = false,
): go.Shape {
  const portSize = isMobile ? 24 : 8;

  return make(go.Shape, 'Circle', {
    fill: 'transparent',
    stroke: 'transparent',
    strokeWidth: isMobile ? 3 : 2,
    desiredSize: new go.Size(portSize, portSize),
    alignment: spot,
    alignmentFocus: spot,
    portId: name,
    fromLinkable: output,
    toLinkable: input,
    cursor: 'pointer',
    fromSpot: go.Spot.None,
    toSpot: go.Spot.None,
    mouseEnter: (event: go.InputEvent, object: go.GraphObject) => {
      if (event.diagram?.isReadOnly) return;
      const port = object as go.Shape;
      port.stroke = '#6366f1';
      port.fill = 'rgba(99, 102, 241, 0.15)';
    },
    mouseLeave: (_event: go.InputEvent, object: go.GraphObject) => {
      const port = object as go.Shape;
      port.stroke = 'transparent';
      port.fill = 'transparent';
    },
  });
}

export function createFlowNodeMainPanelConfig(
  make: typeof go.GraphObject.make,
  nodeConfig: FlowNodeTemplateConfig,
): go.Panel {
  return make(go.Panel, 'Spot',
    make(go.Panel, 'Auto',
      new go.Binding('width', 'isUnassigned', (isUnassigned: boolean) =>
        isUnassigned ? nodeConfig.unassignedWidth : nodeConfig.assignedWidth),
      make(go.Shape, 'RoundedRectangle', {
        fill: 'white',
        stroke: '#e7e5e4',
        strokeWidth: 1,
        parameter1: nodeConfig.cornerRadius,
        portId: '',
        fromLinkable: false,
        toLinkable: true,
        cursor: 'move',
        fromSpot: go.Spot.AllSides,
        toSpot: go.Spot.AllSides,
      },
        new go.Binding('fill', 'color'),
        new go.Binding('stroke', 'borderColor'),
        new go.Binding('strokeWidth', 'borderWidth')),

      make(go.Panel, 'Vertical',
        new go.Binding('margin', 'isUnassigned', (isUnassigned: boolean) => isUnassigned ? 10 : 16),
        make(go.TextBlock, { font: "bold 9px 'LXGW WenKai Screen', sans-serif", stroke: '#78716C', alignment: go.Spot.Left },
          new go.Binding('text', 'displayId'),
          new go.Binding('stroke', 'displayIdColor'),
          new go.Binding('visible', 'isUnassigned', (isUnassigned: boolean) => !isUnassigned)),
        make(go.TextBlock, { margin: new go.Margin(4, 0, 0, 0), font: "400 12px 'LXGW WenKai Screen', sans-serif", stroke: '#57534e' },
          new go.Binding('text', 'title'),
          new go.Binding('font', 'isUnassigned', (isUnassigned: boolean) =>
            isUnassigned ? "500 11px 'LXGW WenKai Screen', sans-serif" : "400 12px 'LXGW WenKai Screen', sans-serif"),
          new go.Binding('stroke', 'titleColor'),
          new go.Binding('maxSize', 'isUnassigned', (isUnassigned: boolean) =>
            isUnassigned ? new go.Size(120, NaN) : new go.Size(160, NaN)))
      )
    ),
    createParkedBadgePanel(make)
  );
}

export function createParkedBadgePanel(make: typeof go.GraphObject.make): go.Panel {
  return make(go.Panel, 'Auto',
    {
      alignment: new go.Spot(1, 0, -4, 4),
      visible: false,
    },
    new go.Binding('visible', 'isParked'),
    make(go.Shape, 'RoundedRectangle', {
      fill: '#fef3c7',
      stroke: '#d97706',
      strokeWidth: 1,
      parameter1: 4,
    }),
    make(go.TextBlock, '⏸ 停泊', {
      font: "500 8px 'LXGW WenKai Screen', sans-serif",
      stroke: '#d97706',
      margin: new go.Margin(2, 4, 2, 4),
    })
  );
}

export function createFlowLinkMainShapesConfig(
  make: typeof go.GraphObject.make,
  isMobile: boolean,
  linkConfig: FlowLinkTemplateConfig,
  styles: FlowStyleConfig,
): go.Shape[] {
  const resolveLinkColor = (data: go.ObjectData): string => {
    if (data.isCrossTree) return styles.link.crossTreeColor;
    return (data.familyColor as string) || styles.link.parentChildColor;
  };

  return [
    make(go.Shape, {
      isPanelMain: true,
      strokeWidth: isMobile ? linkConfig.mobileStrokeWidth : linkConfig.desktopStrokeWidth,
      stroke: 'transparent',
      strokeCap: 'round',
      strokeJoin: 'round',
    }),
    make(go.Shape, {
      isPanelMain: true,
      strokeWidth: linkConfig.visibleStrokeWidth,
      strokeCap: 'round',
      strokeJoin: 'round',
    },
      new go.Binding('stroke', '', resolveLinkColor),
      new go.Binding('strokeDashArray', 'isCrossTree', (isCross: boolean) => isCross ? [6, 10] : null)),
    make(go.Shape, {
      toArrow: linkConfig.arrowType,
      scale: linkConfig.arrowScale,
      strokeWidth: linkConfig.arrowStrokeWidth,
      strokeCap: 'round',
      strokeJoin: 'round',
      segmentOrientation: go.Orientation.Along,
      segmentIndex: -1,
      alignmentFocus: go.Spot.Right,
    },
      new go.Binding('fill', '', resolveLinkColor),
      new go.Binding('stroke', '', resolveLinkColor)),
  ];
}

export function createFlowConnectionLabelConfig(make: typeof go.GraphObject.make): go.Panel {
  return make(go.Panel, 'Auto', {
    segmentIndex: NaN,
    segmentFraction: 0.5,
    cursor: 'pointer',
  },
    new go.Binding('visible', 'isCrossTree'),
    make(go.Shape, 'RoundedRectangle', {
      fill: '#f5f3ff',
      stroke: '#8b5cf6',
      strokeWidth: 1,
      parameter1: 4,
    }),
    make(go.Panel, 'Horizontal',
      { margin: 3, defaultAlignment: go.Spot.Center },
      make(go.TextBlock, '🔗', { font: "8px 'LXGW WenKai Screen', sans-serif" }),
      make(go.TextBlock, {
        font: "500 8px 'LXGW WenKai Screen', sans-serif",
        stroke: '#6d28d9',
        maxSize: new go.Size(50, 14),
        overflow: go.TextBlock.OverflowEllipsis,
        margin: new go.Margin(0, 0, 0, 2),
      },
        new go.Binding('text', 'description', (description: string) =>
          description ? description.substring(0, 6) : '...'))
    ));
}
