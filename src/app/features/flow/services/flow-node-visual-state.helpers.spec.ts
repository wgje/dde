import { describe, expect, it } from 'vitest';
import type { TaskSidecarTone } from '../../../../utils/task-sidecar';
import {
  FLOW_V2_ALERT_BAND_HEIGHT,
  FLOW_V2_DESKTOP_LINK_CORRIDOR_WIDTH,
  FLOW_V2_MOBILE_LINK_CORRIDOR_WIDTH,
  FLOW_V2_NODE_HEIGHT,
  FLOW_V2_NODE_WIDTH,
  FLOW_V2_SEMANTIC_ZOOM_DETAIL_MIN,
  FLOW_V2_SEMANTIC_ZOOM_OVERVIEW_MAX,
  FLOW_V2_SIDE_SAFETY_ZONE_WIDTH,
  type FlowNodeVisualState,
  type FlowVisualMarker,
} from './flow-visual-system.types';
import {
  deriveFlowNodeVisualState,
  layoutFlowMarkers,
  resolveFlowSemanticZoom,
  type FlowNodeVisualStateInput,
} from './flow-node-visual-state.helpers';

const SIDECAR_TONES: readonly TaskSidecarTone[] = [
  'attention',
  'risk',
  'wait',
  'load',
  'time',
  'resource',
  'state',
  'tag',
];

function visualStateInput(
  overrides: Partial<FlowNodeVisualStateInput> = {},
): FlowNodeVisualStateInput {
  return {
    scale: 1,
    stage: 0,
    status: 'active',
    isSearchMatch: false,
    isSelected: false,
    hasKeyboardFocus: false,
    isParked: false,
    isDocked: false,
    isDockFocused: false,
    knowledgeAnchorCount: 0,
    sidecarBadges: [],
    ...overrides,
  };
}

function marker(
  id: string,
  region: FlowVisualMarker['region'],
): FlowVisualMarker {
  return {
    id,
    label: id,
    tone: region === 'alerts' ? 'risk' : region === 'status' ? 'state' : 'tag',
    icon: id,
    region,
  };
}

describe('Flow V2 visual system geometry', () => {
  it('exports the approved node, marker, safety-zone, corridor, and zoom dimensions', () => {
    expect({
      nodeWidth: FLOW_V2_NODE_WIDTH,
      nodeHeight: FLOW_V2_NODE_HEIGHT,
      alertBandHeight: FLOW_V2_ALERT_BAND_HEIGHT,
      sideSafetyZoneWidth: FLOW_V2_SIDE_SAFETY_ZONE_WIDTH,
      desktopLinkCorridorWidth: FLOW_V2_DESKTOP_LINK_CORRIDOR_WIDTH,
      mobileLinkCorridorWidth: FLOW_V2_MOBILE_LINK_CORRIDOR_WIDTH,
      semanticZoomOverviewMax: FLOW_V2_SEMANTIC_ZOOM_OVERVIEW_MAX,
      semanticZoomDetailMin: FLOW_V2_SEMANTIC_ZOOM_DETAIL_MIN,
    }).toEqual({
      nodeWidth: 216,
      nodeHeight: 84,
      alertBandHeight: 24,
      sideSafetyZoneWidth: 32,
      desktopLinkCorridorWidth: 64,
      mobileLinkCorridorWidth: 48,
      semanticZoomOverviewMax: 0.7,
      semanticZoomDetailMin: 1.15,
    });
  });
});

describe('resolveFlowSemanticZoom', () => {
  it('uses exact overview and detail boundaries', () => {
    expect(resolveFlowSemanticZoom(0.6999, false)).toBe('overview');
    expect(resolveFlowSemanticZoom(0.7, false)).toBe('standard');
    expect(resolveFlowSemanticZoom(1.1499, false)).toBe('standard');
    expect(resolveFlowSemanticZoom(1.15, false)).toBe('detail');
  });

  it('always resolves selected nodes to detail', () => {
    expect(resolveFlowSemanticZoom(0.1, true)).toBe('detail');
    expect(resolveFlowSemanticZoom(Number.NaN, true)).toBe('detail');
  });

  it('falls back to standard for non-finite or negative scales', () => {
    expect(resolveFlowSemanticZoom(Number.NaN, false)).toBe('standard');
    expect(resolveFlowSemanticZoom(Number.POSITIVE_INFINITY, false)).toBe('standard');
    expect(resolveFlowSemanticZoom(Number.NEGATIVE_INFINITY, false)).toBe('standard');
    expect(resolveFlowSemanticZoom(-0.01, false)).toBe('standard');
  });
});

describe('deriveFlowNodeVisualState', () => {
  it('keeps unassigned, completed, and search states side by side', () => {
    const state = deriveFlowNodeVisualState(visualStateInput({
      scale: 0.5,
      stage: null,
      status: 'completed',
      isSearchMatch: true,
    }));

    expect(state).toMatchObject({
      version: 'v2',
      semanticZoom: 'overview',
      assignment: 'unassigned',
      completion: 'completed',
      search: true,
      selection: false,
      keyboardFocus: false,
      knowledgeAnchorCount: 0,
    });
    expect(state.statuses).toContainEqual(expect.objectContaining({
      id: 'completed',
      icon: '✓',
      region: 'status',
    }));
  });

  it('maps every sidecar tone plus explicit state and SiYuan markers without color-only semantics', () => {
    const state = deriveFlowNodeVisualState(visualStateInput({
      status: 'completed',
      isParked: true,
      isDocked: true,
      isDockFocused: true,
      knowledgeAnchorCount: 2,
      sidecarBadges: SIDECAR_TONES.map(tone => ({
        id: `sidecar-${tone}`,
        label: tone,
        tone,
        tooltipText: `${tone} tooltip`,
      })),
    }));

    expect(state.alerts.map(item => [item.id, item.icon, item.region])).toEqual([
      ['sidecar-attention', '!', 'alerts'],
      ['sidecar-risk', '▲', 'alerts'],
      ['sidecar-load', '≋', 'alerts'],
    ]);
    expect(state.statuses.map(item => [item.id, item.icon, item.region])).toEqual([
      ['completed', '✓', 'status'],
      ['parked', '泊', 'status'],
      ['docked', '坞', 'status'],
      ['focused', '◎', 'status'],
      ['sidecar-state', '●', 'status'],
    ]);
    expect(state.metadata.map(item => [item.id, item.icon, item.region])).toEqual([
      ['sidecar-wait', '⏸', 'metadata'],
      ['sidecar-time', '◷', 'metadata'],
      ['sidecar-resource', '▣', 'metadata'],
      ['sidecar-tag', '#', 'metadata'],
      ['knowledge-anchor', '思', 'metadata'],
    ]);
    expect(state.metadata[0]).toMatchObject({ tooltipText: 'wait tooltip' });
    expect(state.knowledgeAnchorCount).toBe(2);
  });

  it('deduplicates marker ids while preserving the first semantic marker', () => {
    const state = deriveFlowNodeVisualState(visualStateInput({
      status: 'completed',
      sidecarBadges: [
        { id: 'completed', label: 'duplicate completed', tone: 'state' },
        { id: 'same-id', label: 'first', tone: 'attention' },
        { id: 'same-id', label: 'second', tone: 'tag' },
      ],
    }));

    const allMarkers = [...state.alerts, ...state.statuses, ...state.metadata];
    expect(allMarkers.map(item => item.id)).toEqual(['same-id', 'completed']);
    expect(allMarkers.filter(item => item.id === 'completed')).toEqual([
      expect.objectContaining({ label: '已完成', icon: '✓' }),
    ]);
  });

  it('keeps any finite positive knowledge anchor count visible', () => {
    const state = deriveFlowNodeVisualState(visualStateInput({ knowledgeAnchorCount: 0.5 }));

    expect(state.knowledgeAnchorCount).toBe(0.5);
    expect(state.metadata).toContainEqual(expect.objectContaining({
      id: 'knowledge-anchor',
      icon: '思',
    }));
  });

  it('does not mutate the input or its sidecar badges', () => {
    const sidecarBadge = Object.freeze({
      id: 'risk',
      label: '风险',
      tone: 'risk' as const,
      tooltipText: '保持原值',
    });
    const sidecarBadges = Object.freeze([sidecarBadge]);
    const input = Object.freeze(visualStateInput({
      isSelected: true,
      knowledgeAnchorCount: 1,
      sidecarBadges,
    }));

    const state = deriveFlowNodeVisualState(input);

    expect(input.sidecarBadges).toBe(sidecarBadges);
    expect(input.sidecarBadges[0]).toBe(sidecarBadge);
    expect(state.alerts[0]).not.toBe(sidecarBadge);
    expect(state.semanticZoom).toBe('detail');
  });
});

describe('layoutFlowMarkers', () => {
  it('caps visible regions, reports exact overflow, and pins SiYuan first without changing raw lists', () => {
    const alerts = [marker('alert-1', 'alerts'), marker('alert-2', 'alerts'), marker('alert-3', 'alerts')];
    const statuses = [marker('status-1', 'status'), marker('status-2', 'status'), marker('status-3', 'status')];
    const metadata = [
      marker('metadata-1', 'metadata'),
      marker('metadata-2', 'metadata'),
      marker('metadata-3', 'metadata'),
      marker('knowledge-anchor', 'metadata'),
    ];
    const state: FlowNodeVisualState = {
      version: 'v2',
      semanticZoom: 'standard',
      assignment: 'assigned',
      completion: 'active',
      search: false,
      selection: false,
      keyboardFocus: false,
      alerts,
      statuses,
      metadata,
      knowledgeAnchorCount: 1,
    };

    const layout = layoutFlowMarkers(state);

    expect(layout.alertRow.map(item => item.id)).toEqual(['alert-1', 'alert-2']);
    expect(layout.alertOverflowCount).toBe(1);
    expect(layout.statusArea.map(item => item.id)).toEqual(['status-1', 'status-2']);
    expect(layout.statusOverflowCount).toBe(1);
    expect(layout.metadataRow.map(item => item.id)).toEqual([
      'knowledge-anchor',
      'metadata-1',
      'metadata-2',
    ]);
    expect(layout.metadataOverflowCount).toBe(1);
    expect(state.alerts).toBe(alerts);
    expect(state.statuses).toBe(statuses);
    expect(state.metadata).toBe(metadata);
    expect(state.metadata.map(item => item.id)).toEqual([
      'metadata-1',
      'metadata-2',
      'metadata-3',
      'knowledge-anchor',
    ]);
  });
});
