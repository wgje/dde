// ===================== 纯几何类型与函数（导出供单测） =====================

/** 世界坐标矩形 */
export interface MinimapWorldRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * 两个世界坐标矩形求并集。任一为空返回另一个；都为空返回 null。
 */
export function unionWorldRect(
  a: MinimapWorldRect | null,
  b: MinimapWorldRect | null,
): MinimapWorldRect | null {
  if (!a) return b ? { ...b } : null;
  if (!b) return { ...a };
  const minX = Math.min(a.x, b.x);
  const minY = Math.min(a.y, b.y);
  const maxX = Math.max(a.x + a.w, b.x + b.w);
  const maxY = Math.max(a.y + a.h, b.y + b.h);
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/**
 * Constellation viewBox：沿用 React Flow 的等比完整可见公式，但为星图保留短边
 * 12.5% 的视觉呼吸区。这样桌面 180×140 与移动 100×80 都维持相同比例，
 * 不会让超大视口框贴边压扁节点层次。
 */
export function computeViewBox(
  bounding: MinimapWorldRect,
  elW: number,
  elH: number,
): MinimapWorldRect {
  const safeElW = elW > 0 ? elW : 1;
  const safeElH = elH > 0 ? elH : 1;
  const scaleW = bounding.w / safeElW;
  const scaleH = bounding.h / safeElH;
  const viewScale = Math.max(scaleW, scaleH, 1e-6);
  const visualPadding = Math.min(safeElW, safeElH) * 0.125;
  const offset = visualPadding * viewScale;
  const viewW = viewScale * safeElW;
  const viewH = viewScale * safeElH;
  return {
    x: bounding.x - (viewW - bounding.w) / 2 - offset,
    y: bounding.y - (viewH - bounding.h) / 2 - offset,
    w: viewW + offset * 2,
    h: viewH + offset * 2,
  };
}

export type MinimapFrameHandle = {
  id: number;
  kind: 'raf' | 'timeout';
};

export function requestMinimapFrame(callback: FrameRequestCallback): MinimapFrameHandle {
  if (typeof globalThis.requestAnimationFrame === 'function') {
    return { kind: 'raf', id: globalThis.requestAnimationFrame(callback) };
  }

  const startedAt = Date.now();
  const id = setTimeout(() => callback(Date.now() - startedAt), 16) as unknown as number;
  return { kind: 'timeout', id };
}

export function cancelMinimapFrame(handle: MinimapFrameHandle): void {
  if (handle.kind === 'raf' && typeof globalThis.cancelAnimationFrame === 'function') {
    globalThis.cancelAnimationFrame(handle.id);
    return;
  }

  clearTimeout(handle.id as unknown as ReturnType<typeof setTimeout>);
}

export interface MinimapPip {
  /** 稳定 track key（= `${nodeKey}:${type}`）。 */
  key: string;
  cx: number;
  cy: number;
  r: number;
  color: string;
}

export const MINIMAP_LEGEND_CATEGORIES = [
  'sidecar',
  'siyuan',
  'docked',
  'parked',
  'focused',
  'search',
] as const;

export type MinimapLegendCategory = (typeof MINIMAP_LEGEND_CATEGORIES)[number];

/** Constellation 图层中的非颜色语义标记。 */
export interface MinimapSemanticMarker extends MinimapWorldRect {
  key: string;
  kind: MinimapLegendCategory;
  cx: number;
  cy: number;
  /** 角标与准星的世界坐标尺寸。 */
  size: number;
}

/** 节点 data 中本组件关心的字段子集 */
export interface MinimapNodeData {
  color?: string;
  familyColor?: string;
  borderColor?: string;
  borderWidth?: number;
  isSearchMatch?: boolean;
  isParked?: boolean;
  isDockFocused?: boolean;
  isDocked?: boolean;
  hasSiyuanLink?: boolean;
  sidecarHasSignals?: boolean;
}

// ===================== 视觉常量 =====================

const PIP_SIDECAR = '#f59e0b'; // 僚机：琥珀（右上）
const PIP_SIYUAN = '#818cf8'; // 思源：靛蓝（右下）
const PIP_DOCKED = '#0284c7'; // 入坞：天蓝（左上）
const STROKE_PARKED = '#d97706'; // 停泊描边
const STROKE_DOCK_FOCUS = '#6366f1'; // 专注高亮描边
const FALLBACK_FILL = '#fbbf24'; // 节点无 familyColor/color 时回退
const FALLBACK_STROKE = '#78716c'; // 节点无 borderColor 时回退
export const VIEWPORT_STROKE = '#6366f1'; // 视口框描边
export const VIEWPORT_FILL = 'none';
/**
 * 滚轮缩放步长，对齐 React Flow MiniMap `zoomStep` 默认值 1
 * （packages/system/src/xyminimap/index.ts）。
 */
export const MINIMAP_ZOOM_STEP = 1;
export const MINIMAP_KEYBOARD_PAN_PX = 32;
export const MINIMAP_KEYBOARD_ZOOM_FACTOR = 1.1;
export const MINIMAP_PARKED_OUTLINE_SCALE = 0.52;
export const MINIMAP_FOCUSED_OUTLINE_SCALE = 0.8;
export const MINIMAP_SEARCH_CROSSHAIR_SCALE = 1.7;
/** 视口越界时的安全兜底世界范围 */
export const FALLBACK_WORLD: MinimapWorldRect = { x: -250, y: -250, w: 500, h: 500 };
/**
 * 就绪/重绑看门狗轮询间隔（ms）。低频心跳：捕获首次就绪 + GoJS 硬恢复后的 diagram 实例替换。
 * 仅做引用比较，开销可忽略；500ms 足以让小地图在主图就绪后亚秒内填充，且对硬恢复重建快速重绑。
 */
export const MINIMAP_REBIND_INTERVAL_MS = 500;
/** onWheel 兜底缩放下限（diagram.minScale 不可用时）。 */
export const FALLBACK_MIN_SCALE = 0.05;
/** onWheel 兜底缩放上限（diagram.maxScale 不可用时）。 */
export const FALLBACK_MAX_SCALE = 3;

/**
 * 解析节点填充色：搜索命中优先（保留高亮 UX），其次血缘色（最具辨识度），
 * 再回退 data.color（已分配白/待分配面板/已完成橄榄），最后琥珀兜底。
 * 注意：已分配节点 data.color = #FFFFFF（白），故 familyColor 必须先于 color。
 */
export function resolveNodeFill(data: MinimapNodeData): string {
  if (data.isSearchMatch && data.color) return data.color;
  if (data.familyColor) return data.familyColor;
  return data.color || FALLBACK_FILL;
}

/**
 * 解析节点描边色：停泊 > 专注 > data.borderColor > 兜底灰。
 */
export function resolveNodeStroke(data: MinimapNodeData): string {
  if (data.isParked) return STROKE_PARKED;
  if (data.isDockFocused) return STROKE_DOCK_FOCUS;
  return data.borderColor || FALLBACK_STROKE;
}

/** 解析节点描边宽：停泊/搜索/专注加粗，否则取 data.borderWidth 或 1。 */
export function resolveNodeStrokeWidth(data: MinimapNodeData): number {
  if (data.isParked || data.isSearchMatch || data.isDockFocused) return 2;
  return typeof data.borderWidth === 'number' && data.borderWidth > 0 ? data.borderWidth : 1;
}

/**
 * 由节点世界矩形 + data 生成角落装饰 pip：僚机（右上）/思源（右下）/入坞（左上）。
 * 纯函数（不依赖 GoJS 对象），供单测直接断言位置/颜色/key。
 * @param bounds 节点世界矩形
 * @param data 节点 data 子集
 * @param nodeKey 节点 key（用于派生稳定 track key）
 */
export function buildDecorationPips(
  bounds: MinimapWorldRect,
  data: MinimapNodeData,
  nodeKey: string,
): MinimapPip[] {
  const r = Math.max(2, Math.min(bounds.w, bounds.h) * 0.16);
  const pips: MinimapPip[] = [];
  if (data.sidecarHasSignals)
    pips.push({ key: `${nodeKey}:sidecar`, cx: bounds.x + bounds.w, cy: bounds.y, r, color: PIP_SIDECAR });
  if (data.hasSiyuanLink)
    pips.push({ key: `${nodeKey}:siyuan`, cx: bounds.x + bounds.w, cy: bounds.y + bounds.h, r, color: PIP_SIYUAN });
  if (data.isDocked)
    pips.push({ key: `${nodeKey}:docked`, cx: bounds.x, cy: bounds.y, r, color: PIP_DOCKED });
  return pips;
}

/**
 * 将节点状态投影为六类几何标记。颜色由主题 CSS 决定，数据层只保留稳定语义和坐标。
 */
export function buildMinimapSemanticMarkers(
  bounds: MinimapWorldRect,
  data: MinimapNodeData,
  nodeKey: string,
): MinimapSemanticMarker[] {
  const size = Math.max(2, Math.min(bounds.w, bounds.h) * 0.16);
  const centerX = bounds.x + bounds.w / 2;
  const centerY = bounds.y + bounds.h / 2;
  const markers: MinimapSemanticMarker[] = [];

  const add = (kind: MinimapLegendCategory, cx: number, cy: number): void => {
    markers.push({
      key: `${nodeKey}:${kind}`,
      kind,
      x: bounds.x,
      y: bounds.y,
      w: bounds.w,
      h: bounds.h,
      cx,
      cy,
      size,
    });
  };

  if (data.sidecarHasSignals) add('sidecar', bounds.x + bounds.w, bounds.y);
  if (data.hasSiyuanLink) add('siyuan', bounds.x + bounds.w, bounds.y + bounds.h);
  if (data.isDocked) add('docked', bounds.x, bounds.y);
  if (data.isParked) add('parked', centerX, centerY);
  if (data.isDockFocused) add('focused', centerX, centerY);
  if (data.isSearchMatch) add('search', centerX, centerY);
  return markers;
}

/** 返回语义标记的完整世界坐标外接矩形，供 viewBox 预留稳定空间。 */
export function resolveMinimapSemanticMarkerBounds(
  marker: MinimapSemanticMarker,
): MinimapWorldRect {
  if (marker.kind === 'parked' || marker.kind === 'focused') {
    const scale = marker.kind === 'parked'
      ? MINIMAP_PARKED_OUTLINE_SCALE
      : MINIMAP_FOCUSED_OUTLINE_SCALE;
    const pad = marker.size * scale;
    return {
      x: marker.x - pad,
      y: marker.y - pad,
      w: marker.w + pad * 2,
      h: marker.h + pad * 2,
    };
  }

  const radius = marker.kind === 'search'
    ? marker.size * MINIMAP_SEARCH_CROSSHAIR_SCALE
    : marker.size;
  return {
    x: marker.cx - radius,
    y: marker.cy - radius,
    w: radius * 2,
    h: radius * 2,
  };
}

export function toggleMinimapLegendCategory(
  hiddenCategories: ReadonlySet<MinimapLegendCategory>,
  category: MinimapLegendCategory,
): Set<MinimapLegendCategory> {
  const next = new Set(hiddenCategories);
  if (next.has(category)) next.delete(category);
  else next.add(category);
  return next;
}

export function filterMinimapSemanticMarkers(
  markers: readonly MinimapSemanticMarker[],
  hiddenCategories: ReadonlySet<MinimapLegendCategory>,
): MinimapSemanticMarker[] {
  return markers.filter(marker => !hiddenCategories.has(marker.kind));
}
