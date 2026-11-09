import { describe, expect, it } from 'vitest';

import {
  buildPartialPersistFailureRiskReport,
  buildPartialPersistLogData,
} from './sync-coordinator-partial-persist-risk';

describe('sync coordinator partial persist risk helpers', () => {
  it('returns null when a project save result has no partial failures', () => {
    const report = buildPartialPersistFailureRiskReport({
      projectId: 'project-1',
      failedTaskIds: [],
      failedConnectionIds: [],
      retryEnqueued: [],
      partialRetryHandoff: false,
      hasPendingProjectQueueReplay: false,
    });

    expect(report).toBeNull();
  });

  it('marks failed entities as data at risk when they were not enqueued for retry', () => {
    const report = buildPartialPersistFailureRiskReport({
      projectId: 'project-1',
      failedTaskIds: ['task-1', 'task-2'],
      failedConnectionIds: ['connection-1'],
      retryEnqueued: ['task:task-1'],
      partialRetryHandoff: false,
      hasPendingProjectQueueReplay: false,
      failureReason: 'network timeout',
    });

    expect(report).toEqual({
      projectId: 'project-1',
      failedTasks: 2,
      failedConnections: 1,
      uncoveredTasks: ['task-2'],
      uncoveredConnections: ['connection-1'],
      hasDataAtRisk: true,
      actionQueueReplayPending: false,
      failureReason: 'network timeout',
    });
  });

  it('keeps ActionQueue replay pending when partial retry handoff is active', () => {
    const report = buildPartialPersistFailureRiskReport({
      projectId: 'project-1',
      failedTaskIds: ['task-1'],
      failedConnectionIds: [],
      retryEnqueued: [],
      partialRetryHandoff: true,
      hasPendingProjectQueueReplay: true,
    });

    expect(report?.actionQueueReplayPending).toBe(true);
  });

  it('builds compact log data without leaking full entity id lists', () => {
    const logData = buildPartialPersistLogData({
      projectId: 'project-1',
      failedTasks: 2,
      failedConnections: 1,
      uncoveredTasks: ['task-2'],
      uncoveredConnections: ['connection-1'],
      hasDataAtRisk: true,
      actionQueueReplayPending: false,
      failureReason: 'network timeout',
    });

    expect(logData).toEqual({
      projectId: 'project-1',
      failedTasks: 2,
      failedConnections: 1,
      uncoveredTaskCount: 1,
      uncoveredConnectionCount: 1,
      failureReason: 'network timeout',
    });
  });
});
