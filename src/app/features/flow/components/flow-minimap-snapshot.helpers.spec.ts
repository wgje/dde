import { describe, expect, it } from 'vitest';
import * as go from 'gojs';

import type { MinimapNodeData } from './flow-minimap-geometry';
import {
  collectMinimapLinks,
  collectMinimapNodeSnapshot,
} from './flow-minimap-snapshot.helpers';

interface FakeNode {
  key: string;
  data: MinimapNodeData;
  actualBounds: go.Rect;
}

class FakeDiagram {
  nodeEntries: FakeNode[] = [];
  linkEntries: Array<Record<string, unknown>> = [];
  readonly nodes = {
    each: (callback: (node: FakeNode) => void) => {
      this.nodeEntries.forEach(callback);
    },
  };
  readonly links = {
    each: (callback: (link: Record<string, unknown>) => void) => {
      this.linkEntries.forEach(callback);
    },
  };
}

function node(key: string, bounds: go.Rect, data: MinimapNodeData = {}): FakeNode {
  return { key, actualBounds: bounds, data };
}

describe('flow-minimap-snapshot.helpers', () => {
  it('单趟采集节点 shape、Constellation 标记和世界 bounds', () => {
    const diagram = new FakeDiagram();
    diagram.nodeEntries = [
      node('task-1', new go.Rect(0, 0, 80, 40), {
        familyColor: '#22c55e',
        borderColor: '#0f172a',
        sidecarHasSignals: true,
      }),
      node('task-2', new go.Rect(120, 60, 40, 40), {
        color: '#ffffff',
        familyColor: '#818cf8',
        isDockFocused: true,
      }),
      node('bad', new go.Rect(Number.NaN, 0, 10, 10)),
    ];

    const snapshot = collectMinimapNodeSnapshot(diagram as unknown as go.Diagram, {
      showDecorationPips: true,
    });

    expect(snapshot.shapes).toEqual([
      {
        key: 'task-1',
        x: 0,
        y: 0,
        w: 80,
        h: 40,
        fill: '#22c55e',
        stroke: '#0f172a',
        strokeW: 1,
      },
      {
        key: 'task-2',
        x: 120,
        y: 60,
        w: 40,
        h: 40,
        fill: '#818cf8',
        stroke: '#6366f1',
        strokeW: 2,
      },
    ]);
    expect(snapshot.pips.map(pip => pip.key)).toEqual(['task-1:sidecar']);
    expect(snapshot.markers.map(marker => marker.key)).toEqual([
      'task-1:sidecar',
      'task-2:focused',
    ]);
    expect(snapshot.bounds?.x).toBe(0);
    expect(snapshot.bounds?.y).toBeCloseTo(-6.4);
    expect(snapshot.bounds?.w).toBeCloseTo(165.12);
    expect(snapshot.bounds?.h).toBeCloseTo(111.52);
  });

  it('关闭装饰标记时仍保留停泊/专注/搜索注意标记', () => {
    const diagram = new FakeDiagram();
    diagram.nodeEntries = [
      node('task-1', new go.Rect(0, 0, 80, 40), { isDocked: true, isParked: true }),
    ];

    const snapshot = collectMinimapNodeSnapshot(diagram as unknown as go.Diagram, {
      showDecorationPips: false,
    });

    expect(snapshot.shapes).toHaveLength(1);
    expect(snapshot.pips).toEqual([]);
    expect(snapshot.markers.map(marker => marker.key)).toEqual(['task-1:parked']);
    // 即使关闭装饰展示，也保留入坞角标外接范围，避免切换时 viewBox 跳动。
    expect(snapshot.bounds?.x).toBeCloseTo(-6.4);
    expect(snapshot.bounds?.y).toBeCloseTo(-6.4);
    expect(snapshot.bounds?.w).toBeCloseTo(89.728);
    expect(snapshot.bounds?.h).toBeCloseTo(49.728);
  });

  it('采集连线中心点、跨树虚线和 familyColor 回退', () => {
    const diagram = new FakeDiagram();
    const fromNode = node('from', new go.Rect(0, 0, 80, 40));
    const toNode = node('to', new go.Rect(120, 80, 40, 20));
    diagram.linkEntries = [
      {
        key: 'explicit-link',
        fromNode,
        toNode,
        data: { isCrossTree: true, familyColor: '#22c55e' },
      },
      {
        fromNode: toNode,
        toNode: fromNode,
        data: { familyColor: '#f97316' },
      },
    ];

    expect(collectMinimapLinks(diagram as unknown as go.Diagram, {
      crossTreeColor: '#818cf8',
      parentChildColor: '#94a3b8',
    })).toEqual([
      {
        key: 'explicit-link',
        x1: 40,
        y1: 20,
        x2: 140,
        y2: 90,
        color: '#818cf8',
        dashed: true,
      },
      {
        key: 'to->from',
        x1: 140,
        y1: 90,
        x2: 40,
        y2: 20,
        color: '#f97316',
        dashed: false,
      },
    ]);
  });
});
