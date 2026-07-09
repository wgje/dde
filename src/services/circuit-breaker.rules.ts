import type { CircuitBreakerViolation } from './circuit-breaker.service';

export interface TaskCountDropConfig {
  L1_WARNING_THRESHOLD: number;
  L2_SOFT_BLOCK_THRESHOLD: number;
  L3_HARD_BLOCK_THRESHOLD: number;
  MIN_TASK_COUNT_FOR_RATIO: number;
  DYNAMIC_THRESHOLD_FACTOR: number;
}

export const DEFAULT_TASK_COUNT_DROP_CONFIG: TaskCountDropConfig = {
  L1_WARNING_THRESHOLD: 0.2,
  L2_SOFT_BLOCK_THRESHOLD: 0.5,
  L3_HARD_BLOCK_THRESHOLD: 0.8,
  MIN_TASK_COUNT_FOR_RATIO: 10,
  DYNAMIC_THRESHOLD_FACTOR: 0.01,
};

export function buildTaskCountDropViolation(
  projectId: string,
  previousCount: number,
  currentCount: number,
  config: TaskCountDropConfig = DEFAULT_TASK_COUNT_DROP_CONFIG,
): CircuitBreakerViolation | null {
  if (currentCount >= previousCount || previousCount === 0) {
    return null;
  }

  const dropCount = previousCount - currentCount;
  const dropRatio = dropCount / previousCount;

  if (previousCount < config.MIN_TASK_COUNT_FOR_RATIO) {
    return currentCount === 0
      ? createTaskCountDropViolation(projectId, previousCount, currentCount, 'L3', '小项目任务全部删除')
      : null;
  }

  const dynamicL3Threshold = getDynamicL3Threshold(previousCount, config);

  if (dropRatio >= dynamicL3Threshold || currentCount === 0) {
    return createTaskCountDropViolation(
      projectId,
      previousCount,
      currentCount,
      'L3',
      '任务数骤降',
      dynamicL3Threshold,
    );
  }

  if (dropRatio >= config.L2_SOFT_BLOCK_THRESHOLD) {
    return createTaskCountDropViolation(projectId, previousCount, currentCount, 'L2', '任务数下降');
  }

  if (dropRatio >= config.L1_WARNING_THRESHOLD) {
    return createTaskCountDropViolation(projectId, previousCount, currentCount, 'L1', '任务数下降');
  }

  return null;
}

function getDynamicL3Threshold(
  previousCount: number,
  config: TaskCountDropConfig,
): number {
  const dynamicAdjustment =
    Math.max(0, previousCount - 100) / 100 * config.DYNAMIC_THRESHOLD_FACTOR;
  return Math.min(0.95, config.L3_HARD_BLOCK_THRESHOLD + dynamicAdjustment);
}

function createTaskCountDropViolation(
  projectId: string,
  previousCount: number,
  currentCount: number,
  level: 'L1' | 'L2' | 'L3',
  messagePrefix: string,
  threshold?: number,
): CircuitBreakerViolation {
  const dropCount = previousCount - currentCount;
  const dropRatio = dropCount / previousCount;
  const details: Record<string, unknown> = {
    projectId,
    previousCount,
    currentCount,
    dropCount,
    dropRatio,
    level,
  };

  if (threshold !== undefined) {
    details['threshold'] = threshold;
  }

  const separator = messagePrefix.endsWith('删除') ? '' : ' ';

  return {
    rule: 'task_count_drop',
    message: `${messagePrefix}${separator}${formatDropMessage(previousCount, currentCount, dropRatio)}`,
    details,
  };
}

function formatDropMessage(
  previousCount: number,
  currentCount: number,
  dropRatio: number,
): string {
  if (currentCount === 0 && previousCount < DEFAULT_TASK_COUNT_DROP_CONFIG.MIN_TASK_COUNT_FOR_RATIO) {
    return `（${previousCount} → 0）`;
  }

  return `${(dropRatio * 100).toFixed(0)}%（${previousCount} → ${currentCount}）`;
}
