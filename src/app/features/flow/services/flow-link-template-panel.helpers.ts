import * as go from 'gojs';
import { LAYOUT_CONFIG } from '../../../../config/layout.config';
import { flowTemplateEventHandlers } from './flow-template-events';
import { GojsMake } from './flow-template.types';

export function createConnectionLabelPanel($: GojsMake, isMobile: boolean): go.Panel {
  const panelConfig: Partial<go.Panel> & { toolTip?: go.Adornment } = {
    segmentIndex: NaN,
    segmentFraction: LAYOUT_CONFIG.AUTO_LAYOUT_CROSS_TREE_LABEL_TARGET_SIDE_FRACTION,
    cursor: 'pointer',
    background: 'transparent',
  };

  if (!isMobile) {
    panelConfig.toolTip = createConnectionLabelTooltip($);
  }

  return $(go.Panel, 'Auto',
    panelConfig,
    createLabelSegmentFractionBinding(),
    createLabelSegmentOffsetBinding(),
    createDesktopLabelClickConfig(isMobile),
    $(go.Shape, 'RoundedRectangle', {
      fill: '#f5f3ff',
      stroke: '#8b5cf6',
      strokeWidth: 1,
      parameter1: 4,
      ...(isMobile ? { minSize: new go.Size(44, 24) } : {}),
      cursor: 'pointer',
    }),
    createConnectionLabelContent($, isMobile)
  );
}

function createConnectionLabelTooltip($: GojsMake): go.Adornment {
  return $(go.Adornment, 'Auto',
    {
      background: null,
      isShadowed: true,
      shadowOffset: new go.Point(0, 2),
      shadowColor: 'rgba(0, 0, 0, 0.12)',
    },
    new go.Binding('segmentOffset', '', (_data: unknown, obj: go.GraphObject) =>
      resolveTooltipSegmentOffset(obj)
    ).ofObject(),
    $(go.Shape, 'RoundedRectangle', {
      fill: 'rgba(255, 255, 255, 0.98)',
      stroke: '#a78bfa',
      strokeWidth: 1,
      parameter1: 5,
    }),
    $(go.TextBlock, {
      font: '10px "LXGW WenKai Screen", sans-serif',
      stroke: '#525252',
      margin: 8,
      maxSize: new go.Size(180, 120),
      overflow: go.TextBlock.OverflowEllipsis,
      wrap: go.TextBlock.WrapFit,
    },
    new go.Binding('text', 'description', (desc: string) => desc || '暂无描述'))
  );
}

function createLabelSegmentFractionBinding(): go.Binding {
  return new go.Binding(
    'segmentFraction',
    'labelSegmentFraction',
    (fraction: number | undefined) => typeof fraction === 'number'
      ? fraction
      : LAYOUT_CONFIG.AUTO_LAYOUT_CROSS_TREE_LABEL_TARGET_SIDE_FRACTION
  );
}

function createLabelSegmentOffsetBinding(): go.Binding {
  return new go.Binding(
    'segmentOffset',
    'labelSegmentOffsetY',
    (offsetY: number | undefined) => new go.Point(0, typeof offsetY === 'number' ? offsetY : 0)
  );
}

function createDesktopLabelClickConfig(isMobile: boolean): Partial<go.Panel> {
  if (isMobile) {
    return {};
  }

  // 桌面端保留标签点击直达编辑；移动端交由 ObjectSingleClicked 统一处理
  return {
    click: (e: go.InputEvent, obj: go.GraphObject) => {
      const link = obj?.part as go.Link | undefined;
      if (!link?.data?.isCrossTree) return;
      e.handled = true;

      const { viewX, viewY } = resolveLabelClickViewPoint(e, obj, link);
      flowTemplateEventHandlers.onCrossTreeLabelClick?.(link, viewX, viewY);
    },
  };
}

function createConnectionLabelContent($: GojsMake, isMobile: boolean): go.Panel {
  return $(go.Panel, 'Horizontal',
    { margin: isMobile ? 6 : 3, defaultAlignment: go.Spot.Center, cursor: 'pointer' },
    $(go.TextBlock, '🔗', {
      font: `${isMobile ? '10px' : '8px'} "LXGW WenKai Screen", sans-serif`,
      cursor: 'pointer',
    }),
    $(go.TextBlock, {
      font: `500 ${isMobile ? '10px' : '8px'} "LXGW WenKai Screen", sans-serif`,
      stroke: '#6d28d9',
      maxSize: new go.Size(resolveLabelMaxWidth(isMobile), 14),
      overflow: go.TextBlock.OverflowEllipsis,
      margin: new go.Margin(0, 0, 0, 2),
      cursor: 'pointer',
    },
    new go.Binding('text', '', formatConnectionLabelText))
  );
}

function resolveTooltipSegmentOffset(obj: go.GraphObject): go.Point {
  const adornment = obj.part;
  if (!(adornment instanceof go.Adornment)) {
    return new go.Point(0, -25);
  }

  const link = adornment.adornedPart;
  if (!(link instanceof go.Link)) {
    return new go.Point(0, -25);
  }

  const normalized = Math.abs(link.midAngle % 180);
  return normalized > 45 && normalized < 135
    ? new go.Point(25, 0)
    : new go.Point(0, -25);
}

function resolveLabelClickViewPoint(
  event: go.InputEvent,
  obj: go.GraphObject,
  link: go.Link
): { viewX: number; viewY: number } {
  const diagram = event.diagram;
  if (!diagram || !link) {
    return {
      viewX: event.viewPoint?.x ?? 0,
      viewY: event.viewPoint?.y ?? 0,
    };
  }

  const labelPoint = obj.getDocumentPoint(go.Spot.Center);
  if (!labelPoint || !isFinite(labelPoint.x) || !isFinite(labelPoint.y)) {
    return {
      viewX: event.viewPoint?.x ?? 0,
      viewY: event.viewPoint?.y ?? 0,
    };
  }

  const viewPoint = diagram.transformDocToView(labelPoint);
  return {
    viewX: viewPoint.x,
    viewY: viewPoint.y,
  };
}

function resolveLabelMaxWidth(isMobile: boolean): number {
  return isMobile
    ? Math.min(100, LAYOUT_CONFIG.AUTO_LAYOUT_CROSS_TREE_LABEL_MAX_WIDTH_PX + 12)
    : LAYOUT_CONFIG.AUTO_LAYOUT_CROSS_TREE_LABEL_MAX_WIDTH_PX;
}

function formatConnectionLabelText(data: go.ObjectData): string {
  const d = data as { title?: string; description?: string };
  const maxChars = LAYOUT_CONFIG.AUTO_LAYOUT_CROSS_TREE_LABEL_TEXT_MAX_CHARS;
  const raw = d.title?.trim() || d.description?.trim() || '';
  if (!raw) return '...';

  const chars = Array.from(raw);
  return chars.length <= maxChars ? raw : `${chars.slice(0, maxChars).join('')}…`;
}
