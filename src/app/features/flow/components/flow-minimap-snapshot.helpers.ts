import * as go from 'gojs';

import {
  buildDecorationPips,
  resolveNodeFill,
  resolveNodeStroke,
  resolveNodeStrokeWidth,
  unionWorldRect,
  type MinimapNodeData,
  type MinimapPip,
  type MinimapWorldRect,
} from './flow-minimap-geometry';

export interface MinimapNodeShape {
  /** 稳定 track key（= node.key），让 OnPush 仅 diff 变化的 rect，而非整组重渲染。 */
  key: string;
  x: number;
  y: number;
  w: number;
  h: number;
  fill: string;
  stroke: string;
  strokeW: number;
}

export interface MinimapLinkShape {
  /** 稳定 track key（= link.key 或 from->to）。 */
  key: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
  dashed: boolean;
}

export interface MinimapNodeSnapshot {
  shapes: MinimapNodeShape[];
  pips: MinimapPip[];
  bounds: MinimapWorldRect | null;
}

export interface MinimapLinkStyles {
  crossTreeColor: string;
  parentChildColor: string;
}

/** 连线 data 中小地图快照关心的字段子集 */
interface MinimapLinkData {
  isCrossTree?: boolean;
  familyColor?: string;
}

export function collectMinimapNodeSnapshot(
  diagram: go.Diagram,
  options: { showDecorationPips: boolean },
): MinimapNodeSnapshot {
  const shapes: MinimapNodeShape[] = [];
  const pips: MinimapPip[] = [];
  let bounds: MinimapWorldRect | null = null;

  diagram.nodes.each((node) => {
    const b = node.actualBounds;
    if (!b || !b.isReal()) return;
    const data = (node.data ?? {}) as MinimapNodeData;
    const rect: MinimapWorldRect = { x: b.x, y: b.y, w: b.width, h: b.height };
    const key = String(node.key ?? `${b.x},${b.y}`);
    shapes.push({
      key,
      x: rect.x,
      y: rect.y,
      w: rect.w,
      h: rect.h,
      fill: resolveNodeFill(data),
      stroke: resolveNodeStroke(data),
      strokeW: resolveNodeStrokeWidth(data),
    });
    bounds = unionWorldRect(bounds, rect);
    if (options.showDecorationPips) pips.push(...buildDecorationPips(rect, data, key));
  });

  return { shapes, pips, bounds };
}

export function collectMinimapLinks(
  diagram: go.Diagram,
  styles: MinimapLinkStyles,
): MinimapLinkShape[] {
  const shapes: MinimapLinkShape[] = [];
  diagram.links.each((link) => {
    const from = link.fromNode?.actualBounds;
    const to = link.toNode?.actualBounds;
    if (!from || !to || !from.isReal() || !to.isReal()) return;
    const data = (link.data ?? {}) as MinimapLinkData;
    const isCross = data.isCrossTree === true;
    const key = String(
      link.key ?? `${String(link.fromNode?.key ?? '?')}->${String(link.toNode?.key ?? '?')}`,
    );
    shapes.push({
      key,
      x1: from.x + from.width / 2,
      y1: from.y + from.height / 2,
      x2: to.x + to.width / 2,
      y2: to.y + to.height / 2,
      color: isCross ? styles.crossTreeColor : data.familyColor || styles.parentChildColor,
      dashed: isCross,
    });
  });
  return shapes;
}
