export type AppResumeReason =
  | 'visibility-threshold'
  | 'visibility-quick'
  | 'pageshow'
  | 'online'
  | 'manual';

export interface RecoveryMetricsSnapshot {
  ticketId: string;
  reason: string;
  interactionReadyMs: number;
  backgroundRefreshMs?: number;
  fastPathHit?: boolean;
}

export type LifecycleRecoveryTicket = {
  id: string;
  startedAt: number;
  mode: 'light' | 'heavy';
};

export interface ResumePipelineResult {
  deferred: boolean;
  reason?: 'client-unready' | 'no-session' | 'refresh-failed';
  interactionReadyMs?: number;
  fastPathHit?: boolean;
}
