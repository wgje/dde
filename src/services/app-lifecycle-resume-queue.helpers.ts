import type { AppResumeReason } from './app-lifecycle-orchestrator.types';

export function shouldQueueResumeAfterCurrent(
  activeReason: AppResumeReason | null,
  incomingReason: AppResumeReason,
): boolean {
  if (!activeReason) {
    return false;
  }
  return resumeReasonPriority(incomingReason) > resumeReasonPriority(activeReason);
}

export function selectHigherPriorityResumeReason(
  current: AppResumeReason | null,
  incoming: AppResumeReason,
): AppResumeReason {
  if (!current) {
    return incoming;
  }
  return resumeReasonPriority(incoming) > resumeReasonPriority(current)
    ? incoming
    : current;
}

function resumeReasonPriority(reason: AppResumeReason): number {
  switch (reason) {
    case 'pageshow':
      return 5;
    case 'visibility-threshold':
      return 4;
    case 'online':
      return 3;
    case 'manual':
      return 2;
    case 'visibility-quick':
      return 1;
  }
}
