import { describe, expect, it } from 'vitest';

import {
  buildMinimapSemanticMarkers,
  filterMinimapSemanticMarkers,
  resolveMinimapSemanticMarkerBounds,
  toggleMinimapLegendCategory,
  type MinimapLegendCategory,
  type MinimapNodeData,
  type MinimapWorldRect,
} from './flow-minimap-geometry';

describe('buildMinimapSemanticMarkers', () => {
  const bounds: MinimapWorldRect = { x: 10, y: 20, w: 100, h: 50 };
  const allStates: MinimapNodeData = {
    sidecarHasSignals: true,
    hasSiyuanLink: true,
    isDocked: true,
    isParked: true,
    isDockFocused: true,
    isSearchMatch: true,
  };

  it('把六类特别注意点映射为稳定且不依赖颜色的几何语义', () => {
    const markers = buildMinimapSemanticMarkers(bounds, allStates, 'task-1');

    expect(markers.map(marker => marker.kind)).toEqual([
      'sidecar',
      'siyuan',
      'docked',
      'parked',
      'focused',
      'search',
    ]);
    expect(markers.map(marker => marker.key)).toEqual([
      'task-1:sidecar',
      'task-1:siyuan',
      'task-1:docked',
      'task-1:parked',
      'task-1:focused',
      'task-1:search',
    ]);
  });

  it('把角标锚定到对应角落，并为轮廓类标记保留节点 bounds', () => {
    const markers = buildMinimapSemanticMarkers(bounds, allStates, 'task-1');
    const byKind = Object.fromEntries(markers.map(marker => [marker.kind, marker]));

    expect(byKind.sidecar).toMatchObject({ cx: 110, cy: 20 });
    expect(byKind.siyuan).toMatchObject({ cx: 110, cy: 70 });
    expect(byKind.docked).toMatchObject({ cx: 10, cy: 20 });
    expect(byKind.parked).toMatchObject({ x: 10, y: 20, w: 100, h: 50 });
    expect(byKind.focused).toMatchObject({ x: 10, y: 20, w: 100, h: 50 });
    expect(byKind.search).toMatchObject({ cx: 60, cy: 45 });
  });

  it('未命中的类别不产生标记', () => {
    expect(buildMinimapSemanticMarkers(bounds, {}, 'task-1')).toEqual([]);
  });

  it('计算六类标记的完整渲染外接范围，避免边界角标与准星被裁切', () => {
    const markers = buildMinimapSemanticMarkers(bounds, allStates, 'task-1');
    const byKind = Object.fromEntries(markers.map(marker => [
      marker.kind,
      resolveMinimapSemanticMarkerBounds(marker),
    ]));

    expect(byKind.sidecar).toEqual({ x: 102, y: 12, w: 16, h: 16 });
    expect(byKind.siyuan).toEqual({ x: 102, y: 62, w: 16, h: 16 });
    expect(byKind.docked).toEqual({ x: 2, y: 12, w: 16, h: 16 });
    expect(byKind.parked).toEqual({ x: 5.84, y: 15.84, w: 108.32, h: 58.32 });
    expect(byKind.focused).toEqual({ x: 3.5999999999999996, y: 13.6, w: 112.8, h: 62.8 });
    expect(byKind.search).toEqual({ x: 46.4, y: 31.4, w: 27.2, h: 27.2 });
  });
});

describe('临时图例筛选', () => {
  const markers = buildMinimapSemanticMarkers(
    { x: 0, y: 0, w: 80, h: 40 },
    { sidecarHasSignals: true, isParked: true, isSearchMatch: true },
    'task-1',
  );

  it('切换类别返回新 Set，不修改原筛选状态', () => {
    const original = new Set<MinimapLegendCategory>(['sidecar']);
    const next = toggleMinimapLegendCategory(original, 'parked');

    expect(original).toEqual(new Set(['sidecar']));
    expect(next).toEqual(new Set(['sidecar', 'parked']));
    expect(toggleMinimapLegendCategory(next, 'sidecar')).toEqual(new Set(['parked']));
  });

  it('筛选只生成展示数组，不修改快照标记', () => {
    const originalKeys = markers.map(marker => marker.key);
    const filtered = filterMinimapSemanticMarkers(markers, new Set(['sidecar', 'search']));

    expect(filtered.map(marker => marker.kind)).toEqual(['parked']);
    expect(markers.map(marker => marker.key)).toEqual(originalKeys);
    expect(filtered).not.toBe(markers);
  });
});
