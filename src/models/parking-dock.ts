// ============================================
// Dock v3 domain model
// ============================================

export type DockTaskStatus =
  | 'pending_start'
  | 'focusing'
  | 'suspended_waiting'
  | 'wait_finished'
  | 'completed';

export type CognitiveLoad = 'high' | 'low';
export type AffinityZone = 'strong' | 'weak';
export type DockZoneSource = 'auto' | 'manual';
export type DockSourceSection = 'text' | 'flow' | 'dock-create';
export type StatusMachineLabel = '待启动' | '专注中' | '挂起等待' | '等待结束';

export interface DockEntry {
  taskId: string;
  title: string;
  sourceProjectId: string | null;
  status: DockTaskStatus;
  load: CognitiveLoad;
  expectedMinutes: number | null;
  waitMinutes: number | null;
  waitStartedAt: string | null;
  zone: AffinityZone;
  zoneSource: DockZoneSource;
  isMain: boolean;
  dockedOrder: number;
  detail: string;
  sourceKind: 'project-task' | 'dock-created';
  systemSelected: boolean;
  recommendedScore: number | null;
  sourceSection?: DockSourceSection;
  manualMainSelected?: boolean;
  recommendationLocked?: boolean;
  snoozeRingMuted?: boolean;
}

export interface WaitPreset {
  label: string;
  minutes: number;
}

export const WAIT_PRESETS: WaitPreset[] = [
  { label: '5 min', minutes: 5 },
  { label: '15 min', minutes: 15 },
  { label: '30 min', minutes: 30 },
  { label: '1 小时', minutes: 60 },
  { label: '2 小时', minutes: 120 },
  { label: '1 天', minutes: 1440 },
];

export interface StatusMachineEntry {
  taskId: string;
  title: string;
  label: StatusMachineLabel;
  waitRemainingSeconds: number | null;
  waitTotalSeconds: number | null;
}

export interface DailySlotEntry {
  id: string;
  title: string;
  maxDailyCount: number;
  todayCompletedCount: number;
  createdAt: string;
}

export interface ScheduleRecommendation {
  recommended: string[];
  reason: string;
  isFragmentPhase: boolean;
}

export interface DockPendingDecision {
  rootTaskId: string;
  rootRemainingMinutes: number;
  candidateTaskIds: string[];
  reason: string;
  expiresAt?: string;
  createdAt: string;
}

export interface DockPendingDecisionEntry {
  taskId: string;
  title: string;
  zone: AffinityZone;
  load: CognitiveLoad;
  expectedMinutes: number | null;
  recommendedScore: number | null;
}

export interface PendingDecisionViewModel {
  candidateCId: string;
  candidateDId: string;
  reason: string;
  expiresAt?: string;
}

export interface DockSessionState {
  firstDragIntervened: boolean;
  focusBlurOn: boolean;
  mainTaskId: string | null;
  strongZoneIds: string[];
  weakZoneIds: string[];
}

export interface DockSnapshot {
  version: 3;
  entries: DockEntry[];
  focusMode: boolean;
  isDockExpanded: boolean;
  muteWaitTone: boolean;
  session: DockSessionState;
  dailySlots: DailySlotEntry[];
  suspendChainRootTaskId: string | null;
  suspendRecommendationLocked: boolean;
  pendingDecision: DockPendingDecision | null;
  dailyResetDate: string;
  savedAt: string;

  // Backward compatibility for legacy v3 snapshots before session refactor.
  firstDragDone?: boolean;
}
