import { FEATURE_FLAGS } from '../config/feature-flags.config';
import type {
  AppResumeReason,
  LifecycleRecoveryTicket,
  RecoveryMetricsSnapshot,
} from './app-lifecycle-orchestrator.types';

export interface AppLifecycleRecoveryMetricsReporter {
  setMeasurement(name: string, value: number, unit: string): void;
}

export interface RecoveryCompensationReportInput {
  currentMetrics: RecoveryMetricsSnapshot | null;
  reason: AppResumeReason;
  recoveryTicket: LifecycleRecoveryTicket;
  interactionReadyMs: number;
  backgroundRefreshMs: number;
  fastPathHit: boolean | undefined;
}

export function mergeRecoveryMetrics(
  current: RecoveryMetricsSnapshot | null,
  metrics: RecoveryMetricsSnapshot,
): RecoveryMetricsSnapshot {
  return current && current.ticketId === metrics.ticketId
    ? { ...current, ...metrics }
    : metrics;
}

export function publishRecoveryMetrics(
  metrics: RecoveryMetricsSnapshot,
  reporter: AppLifecycleRecoveryMetricsReporter,
): void {
  if (FEATURE_FLAGS.RESUME_METRICS_GATE_V1) {
    reporter.setMeasurement('resume.interaction_ready_ms', metrics.interactionReadyMs, 'millisecond');
    if (typeof metrics.backgroundRefreshMs === 'number') {
      reporter.setMeasurement('resume.background_refresh_ms', metrics.backgroundRefreshMs, 'millisecond');
    }
    if (typeof metrics.fastPathHit === 'boolean') {
      reporter.setMeasurement('resume.fast_path_hit', metrics.fastPathHit ? 1 : 0, 'none');
    }
  }

  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('nanoflow:resume-metrics', {
      detail: metrics,
    }));
  }
}

export function buildRecoveryCompensationMetrics(
  reason: AppResumeReason,
  recoveryTicket: LifecycleRecoveryTicket,
  interactionReadyMs: number,
  backgroundRefreshMs: number,
  fastPathHit: boolean | undefined,
): RecoveryMetricsSnapshot {
  return {
    ticketId: recoveryTicket.id,
    reason,
    interactionReadyMs,
    backgroundRefreshMs,
    fastPathHit,
  };
}

export function buildRecoveryCompensationReport(
  input: RecoveryCompensationReportInput,
): RecoveryMetricsSnapshot | null {
  if (input.currentMetrics && input.currentMetrics.ticketId !== input.recoveryTicket.id) {
    return null;
  }

  return buildRecoveryCompensationMetrics(
    input.reason,
    input.recoveryTicket,
    input.interactionReadyMs,
    input.backgroundRefreshMs,
    input.fastPathHit,
  );
}
