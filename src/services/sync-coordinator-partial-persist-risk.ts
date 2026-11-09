export interface PartialPersistFailureRiskReport {
  projectId: string;
  failedTasks: number;
  failedConnections: number;
  uncoveredTasks: string[];
  uncoveredConnections: string[];
  hasDataAtRisk: boolean;
  actionQueueReplayPending: boolean;
  failureReason?: string;
}

export interface PartialPersistFailureRiskInput {
  projectId: string;
  failedTaskIds?: string[];
  failedConnectionIds?: string[];
  retryEnqueued?: string[];
  partialRetryHandoff?: boolean;
  hasPendingProjectQueueReplay: boolean;
  failureReason?: string;
}

export function buildPartialPersistFailureRiskReport(
  input: PartialPersistFailureRiskInput,
): PartialPersistFailureRiskReport | null {
  const failedTaskIds = input.failedTaskIds ?? [];
  const failedConnectionIds = input.failedConnectionIds ?? [];
  const failedTasks = failedTaskIds.length;
  const failedConnections = failedConnectionIds.length;
  if (failedTasks === 0 && failedConnections === 0) {
    return null;
  }

  const retryMarkers = new Set(input.retryEnqueued ?? []);
  const uncoveredTasks = failedTaskIds.filter(id => !retryMarkers.has(`task:${id}`));
  const uncoveredConnections = failedConnectionIds.filter(id => !retryMarkers.has(`connection:${id}`));

  return {
    projectId: input.projectId,
    failedTasks,
    failedConnections,
    uncoveredTasks,
    uncoveredConnections,
    hasDataAtRisk: uncoveredTasks.length > 0 || uncoveredConnections.length > 0,
    actionQueueReplayPending: input.partialRetryHandoff === true && input.hasPendingProjectQueueReplay,
    failureReason: input.failureReason,
  };
}

export function buildPartialPersistLogData(
  report: PartialPersistFailureRiskReport,
): Record<string, unknown> {
  return {
    projectId: report.projectId,
    failedTasks: report.failedTasks,
    failedConnections: report.failedConnections,
    uncoveredTaskCount: report.uncoveredTasks.length,
    uncoveredConnectionCount: report.uncoveredConnections.length,
    failureReason: report.failureReason,
  };
}
