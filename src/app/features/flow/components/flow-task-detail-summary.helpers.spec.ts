import { describe, expect, it } from 'vitest';

import type { Task } from '../../../../models';
import { buildFlowTaskDetailSidecarSummary } from './flow-task-detail-summary.helpers';

describe('flow-task-detail-summary.helpers', () => {
  it('builds an empty sidecar summary when no task is selected', () => {
    expect(buildFlowTaskDetailSidecarSummary(null)).toEqual({
      badges: [],
      tooltipLines: [],
      hasSignals: false,
      riskCount: 0,
    });
  });

  it('delegates to task sidecar summary for selected tasks', () => {
    const task: Task = {
      id: 'task-1',
      title: 'Task',
      content: '',
      stage: null,
      parentId: null,
      order: 0,
      rank: 0,
      status: 'active',
      priority: 'high',
      x: 0,
      y: 0,
      createdDate: '',
      displayId: 'T-1',
    };

    expect(buildFlowTaskDetailSidecarSummary(task).badges).toContainEqual(
      expect.objectContaining({ id: 'risk', label: '风险1' }),
    );
  });
});
