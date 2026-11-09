import type { TaskSidecarTone } from '../../../../utils/task-sidecar';

export const FLOW_V2_NODE_WIDTH = 216;
export const FLOW_V2_NODE_HEIGHT = 84;
export const FLOW_V2_ALERT_BAND_HEIGHT = 24;
export const FLOW_V2_SIDE_SAFETY_ZONE_WIDTH = 32;
export const FLOW_V2_DESKTOP_LINK_CORRIDOR_WIDTH = 64;
export const FLOW_V2_MOBILE_LINK_CORRIDOR_WIDTH = 48;
export const FLOW_V2_SEMANTIC_ZOOM_OVERVIEW_MAX = 0.7;
export const FLOW_V2_SEMANTIC_ZOOM_DETAIL_MIN = 1.15;

export type FlowSemanticZoomLevel = 'overview' | 'standard' | 'detail';
export type FlowVisualSystemVersion = 'v1' | 'v2';
export type FlowMarkerRegion = 'alerts' | 'status' | 'metadata';

export interface FlowVisualMarker {
  id: string;
  label: string;
  tone: TaskSidecarTone;
  icon: string;
  region: FlowMarkerRegion;
  tooltipText?: string;
}

export type FlowNodeAssignmentState = 'assigned' | 'unassigned';
export type FlowNodeCompletionState = 'active' | 'completed';

export interface FlowNodeVisualState {
  version: 'v2';
  semanticZoom: FlowSemanticZoomLevel;
  assignment: FlowNodeAssignmentState;
  completion: FlowNodeCompletionState;
  search: boolean;
  selection: boolean;
  keyboardFocus: boolean;
  alerts: readonly FlowVisualMarker[];
  statuses: readonly FlowVisualMarker[];
  metadata: readonly FlowVisualMarker[];
  knowledgeAnchorCount: number;
}

export interface FlowMarkerLayout {
  alertRow: readonly FlowVisualMarker[];
  alertOverflowCount: number;
  statusArea: readonly FlowVisualMarker[];
  statusOverflowCount: number;
  metadataRow: readonly FlowVisualMarker[];
  metadataOverflowCount: number;
}

export type FlowDropPreviewKind = 'insert-link' | 'child' | 'before' | 'after' | 'invalid';

export interface FlowDropPreview {
  kind: FlowDropPreviewKind;
  valid: boolean;
  targetTaskId?: string;
  targetLinkKey?: string;
  reason?: string;
}

export type FlowPanelId =
  | 'task-pool'
  | 'project-list'
  | 'task-detail'
  | 'connection-editor'
  | 'overview'
  | 'black-box';

export type FlowPanelDock = 'top' | 'right' | 'bottom' | 'bottom-right' | 'floating';

export interface FlowPanelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FlowPanelSnapshot {
  open: boolean;
  collapsed: boolean;
  dock: FlowPanelDock;
  rect: FlowPanelRect;
  z: number;
}

export interface FlowPanelLayoutState {
  schemaVersion: 1;
  deviceMode: 'desktop' | 'mobile';
  panels: Record<FlowPanelId, FlowPanelSnapshot>;
}
