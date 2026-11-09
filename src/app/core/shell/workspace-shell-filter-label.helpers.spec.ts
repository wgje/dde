import { describe, expect, it } from 'vitest';

import { resolveWorkspaceFilterLabel } from './workspace-shell-filter-label.helpers';

describe('workspace shell filter label helpers', () => {
  it('uses the all-tasks label when the filter targets every task or no task can be found', () => {
    expect(resolveWorkspaceFilterLabel({
      filterId: 'all',
      getTask: () => ({ title: 'Ignored', displayId: 'T-1' }),
    })).toBe('全部任务');

    expect(resolveWorkspaceFilterLabel({
      filterId: 'missing-task',
      getTask: () => null,
    })).toBe('全部任务');
  });

  it('prefers task title, then display id, then unnamed fallback', () => {
    expect(resolveWorkspaceFilterLabel({
      filterId: 'task-1',
      getTask: () => ({ title: 'Plan launch', displayId: 'T-1' }),
    })).toBe('Plan launch');

    expect(resolveWorkspaceFilterLabel({
      filterId: 'task-2',
      getTask: () => ({ title: '', displayId: 'T-2' }),
    })).toBe('T-2');

    expect(resolveWorkspaceFilterLabel({
      filterId: 'task-3',
      getTask: () => ({ title: '', displayId: '' }),
    })).toBe('未命名任务');
  });
});
