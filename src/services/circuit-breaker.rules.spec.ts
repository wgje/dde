import { describe, expect, it } from 'vitest';
import { buildTaskCountDropViolation } from './circuit-breaker.rules';

describe('circuit breaker task count drop rules', () => {
  it('returns no violation when task count is unchanged or increased', () => {
    expect(buildTaskCountDropViolation('project-1', 10, 10)).toBeNull();
    expect(buildTaskCountDropViolation('project-1', 10, 12)).toBeNull();
  });

  it('uses an L3 violation for small projects that drop to zero', () => {
    const violation = buildTaskCountDropViolation('project-1', 8, 0);

    expect(violation).toEqual({
      rule: 'task_count_drop',
      message: '小项目任务全部删除（8 → 0）',
      details: {
        projectId: 'project-1',
        previousCount: 8,
        currentCount: 0,
        dropCount: 8,
        dropRatio: 1,
        level: 'L3',
      },
    });
  });

  it('classifies larger project drops into warning, soft block, and hard block levels', () => {
    expect(buildTaskCountDropViolation('project-1', 20, 15)?.details['level']).toBe('L1');
    expect(buildTaskCountDropViolation('project-1', 50, 20)?.details['level']).toBe('L2');
    expect(buildTaskCountDropViolation('project-1', 100, 15)?.details['level']).toBe('L3');
  });
});
