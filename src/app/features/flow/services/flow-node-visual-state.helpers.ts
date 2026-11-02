import type { TaskStatus } from '../../../../models';
import type { TaskSidecarBadge, TaskSidecarTone } from '../../../../utils/task-sidecar';
import {
  FLOW_V2_SEMANTIC_ZOOM_DETAIL_MIN,
  FLOW_V2_SEMANTIC_ZOOM_OVERVIEW_MAX,
  type FlowMarkerRegion,
  type FlowMarkerLayout,
  type FlowNodeVisualState,
  type FlowSemanticZoomLevel,
  type FlowVisualMarker,
} from './flow-visual-system.types';

export interface FlowNodeVisualStateInput {
  readonly scale: number;
  readonly stage: number | null;
  readonly status: TaskStatus;
  readonly isSearchMatch: boolean;
  readonly isSelected: boolean;
  readonly hasKeyboardFocus: boolean;
  readonly isParked: boolean;
  readonly isDocked: boolean;
  readonly isDockFocused: boolean;
  readonly knowledgeAnchorCount: number;
  readonly sidecarBadges: readonly Pick<TaskSidecarBadge, 'id' | 'label' | 'tone' | 'tooltipText'>[];
}

const SIDECAR_MARKER_REGION: Record<TaskSidecarTone, FlowMarkerRegion> = {
  attention: 'alerts',
  risk: 'alerts',
  wait: 'metadata',
  load: 'alerts',
  time: 'metadata',
  resource: 'metadata',
  state: 'status',
  tag: 'metadata',
};

const SIDECAR_MARKER_ICON: Record<TaskSidecarTone, string> = {
  attention: '!',
  risk: '▲',
  wait: '⏸',
  load: '≋',
  time: '◷',
  resource: '▣',
  state: '●',
  tag: '#',
};

const KNOWLEDGE_ANCHOR_MARKER_ID = 'knowledge-anchor';
const MAX_ALERT_MARKERS = 2;
const MAX_STATUS_MARKERS = 2;
const MAX_METADATA_MARKERS = 3;

export function resolveFlowSemanticZoom(
  scale: number,
  selected: boolean,
): FlowSemanticZoomLevel {
  if (selected) return 'detail';
  if (!Number.isFinite(scale) || scale < 0) return 'standard';
  if (scale < FLOW_V2_SEMANTIC_ZOOM_OVERVIEW_MAX) return 'overview';
  if (scale < FLOW_V2_SEMANTIC_ZOOM_DETAIL_MIN) return 'standard';
  return 'detail';
}

export function deriveFlowNodeVisualState(
  input: Readonly<FlowNodeVisualStateInput>,
): FlowNodeVisualState {
  const alerts: FlowVisualMarker[] = [];
  const statuses: FlowVisualMarker[] = [];
  const metadata: FlowVisualMarker[] = [];
  const seenIds = new Set<string>();
  const knowledgeAnchorCount = normalizeKnowledgeAnchorCount(input.knowledgeAnchorCount);

  if (input.status === 'completed') {
    appendUniqueMarker(statuses, {
      id: 'completed',
      label: '已完成',
      tone: 'state',
      icon: '✓',
      region: 'status',
    }, seenIds);
  }
  if (input.isParked) {
    appendUniqueMarker(statuses, {
      id: 'parked',
      label: '已停泊',
      tone: 'state',
      icon: '泊',
      region: 'status',
    }, seenIds);
  }
  if (input.isDocked) {
    appendUniqueMarker(statuses, {
      id: 'docked',
      label: '已入坞',
      tone: 'state',
      icon: '坞',
      region: 'status',
    }, seenIds);
  }
  if (input.isDockFocused) {
    appendUniqueMarker(statuses, {
      id: 'focused',
      label: '专注中',
      tone: 'state',
      icon: '◎',
      region: 'status',
    }, seenIds);
  }

  if (knowledgeAnchorCount > 0) {
    seenIds.add(KNOWLEDGE_ANCHOR_MARKER_ID);
  }

  for (const badge of input.sidecarBadges) {
    if (seenIds.has(badge.id)) continue;
    const marker = sidecarBadgeToMarker(badge);
    seenIds.add(marker.id);
    markerTarget(marker.region, alerts, statuses, metadata).push(marker);
  }

  if (knowledgeAnchorCount > 0) {
    metadata.push({
      id: KNOWLEDGE_ANCHOR_MARKER_ID,
      label: `思源${knowledgeAnchorCount}`,
      tone: 'resource',
      icon: '思',
      region: 'metadata',
      tooltipText: `思源锚点：${knowledgeAnchorCount}`,
    });
  }

  return {
    version: 'v2',
    semanticZoom: resolveFlowSemanticZoom(input.scale, input.isSelected),
    assignment: input.stage === null ? 'unassigned' : 'assigned',
    completion: input.status === 'completed' ? 'completed' : 'active',
    search: input.isSearchMatch,
    selection: input.isSelected,
    keyboardFocus: input.hasKeyboardFocus,
    alerts,
    statuses,
    metadata,
    knowledgeAnchorCount,
  };
}

export function layoutFlowMarkers(state: Readonly<FlowNodeVisualState>): FlowMarkerLayout {
  const alertRow = state.alerts.slice(0, MAX_ALERT_MARKERS);
  const statusArea = state.statuses.slice(0, MAX_STATUS_MARKERS);
  const metadataByPriority = prioritizeKnowledgeAnchor(state.metadata);
  const metadataRow = metadataByPriority.slice(0, MAX_METADATA_MARKERS);

  return {
    alertRow,
    alertOverflowCount: state.alerts.length - alertRow.length,
    statusArea,
    statusOverflowCount: state.statuses.length - statusArea.length,
    metadataRow,
    metadataOverflowCount: state.metadata.length - metadataRow.length,
  };
}

function normalizeKnowledgeAnchorCount(count: number): number {
  if (!Number.isFinite(count) || count <= 0) return 0;
  return count;
}

function appendUniqueMarker(
  target: FlowVisualMarker[],
  marker: FlowVisualMarker,
  seenIds: Set<string>,
): void {
  if (seenIds.has(marker.id)) return;
  seenIds.add(marker.id);
  target.push(marker);
}

function sidecarBadgeToMarker(
  badge: Pick<TaskSidecarBadge, 'id' | 'label' | 'tone' | 'tooltipText'>,
): FlowVisualMarker {
  return {
    id: badge.id,
    label: badge.label,
    tone: badge.tone,
    icon: SIDECAR_MARKER_ICON[badge.tone],
    region: SIDECAR_MARKER_REGION[badge.tone],
    ...(badge.tooltipText === undefined ? {} : { tooltipText: badge.tooltipText }),
  };
}

function markerTarget(
  region: FlowMarkerRegion,
  alerts: FlowVisualMarker[],
  statuses: FlowVisualMarker[],
  metadata: FlowVisualMarker[],
): FlowVisualMarker[] {
  if (region === 'alerts') return alerts;
  if (region === 'status') return statuses;
  return metadata;
}

function prioritizeKnowledgeAnchor(
  markers: readonly FlowVisualMarker[],
): FlowVisualMarker[] {
  const knowledgeAnchorIndex = markers.findIndex(marker => marker.id === KNOWLEDGE_ANCHOR_MARKER_ID);
  if (knowledgeAnchorIndex <= 0) return markers.slice();
  return [
    markers[knowledgeAnchorIndex],
    ...markers.slice(0, knowledgeAnchorIndex),
    ...markers.slice(knowledgeAnchorIndex + 1),
  ];
}
