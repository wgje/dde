import { describe, expect, it } from 'vitest';

import type { AppResumeReason } from './app-lifecycle-orchestrator.types';
import {
  selectHigherPriorityResumeReason,
  shouldQueueResumeAfterCurrent,
} from './app-lifecycle-resume-queue.helpers';

describe('app lifecycle resume queue helpers', () => {
  it('queues higher-priority resume reasons behind lower-priority active recovery', () => {
    const queuedReasons: AppResumeReason[] = [
      'visibility-threshold',
      'online',
      'pageshow',
      'manual',
    ];

    for (const reason of queuedReasons) {
      expect(shouldQueueResumeAfterCurrent('visibility-quick', reason)).toBe(true);
    }
    expect(shouldQueueResumeAfterCurrent('online', 'pageshow')).toBe(true);
    expect(shouldQueueResumeAfterCurrent('online', 'visibility-threshold')).toBe(true);
    expect(shouldQueueResumeAfterCurrent('manual', 'online')).toBe(true);
  });

  it('does not queue duplicate or lower-priority resumes behind an existing recovery', () => {
    expect(shouldQueueResumeAfterCurrent('visibility-quick', 'visibility-quick')).toBe(false);
    expect(shouldQueueResumeAfterCurrent('pageshow', 'online')).toBe(false);
    expect(shouldQueueResumeAfterCurrent('visibility-threshold', 'online')).toBe(false);
    expect(shouldQueueResumeAfterCurrent('online', 'manual')).toBe(false);
    expect(shouldQueueResumeAfterCurrent(null, 'online')).toBe(false);
  });

  it('keeps the highest-priority queued resume reason', () => {
    expect(selectHigherPriorityResumeReason(null, 'manual')).toBe('manual');
    expect(selectHigherPriorityResumeReason('online', 'pageshow')).toBe('pageshow');
    expect(selectHigherPriorityResumeReason('visibility-threshold', 'online')).toBe('visibility-threshold');
    expect(selectHigherPriorityResumeReason('manual', 'visibility-quick')).toBe('manual');
  });
});
