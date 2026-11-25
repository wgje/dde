import { describe, expect, it } from 'vitest';
import {
  buildStartupWorkerBypassUrl,
  resolveStartupRecoveryDecision,
} from './startup-recovery';

describe('startup worker recovery', () => {
  it('adds Angular worker bypass and preserves origin, path, existing query and hash route', () => {
    const current = 'https://nanoflow.pages.dev/app?campaign=restore#/projects/alpha/text?taskId=task-a';
    const result = new URL(buildStartupWorkerBypassUrl(current)!);

    expect(result.origin).toBe('https://nanoflow.pages.dev');
    expect(result.pathname).toBe('/app');
    expect(result.searchParams.get('campaign')).toBe('restore');
    expect(result.searchParams.has('ngsw-bypass')).toBe(true);
    expect(result.searchParams.get('nanoflow-startup-recovery')).toBe('bypass-worker-v1');
    expect(result.hash).toBe('#/projects/alpha/text?taskId=task-a');
  });

  it('does not loop when the bypassed startup also times out', () => {
    const recoveryUrl = 'https://nanoflow.pages.dev/?ngsw-bypass&nanoflow-startup-recovery=bypass-worker-v1#/projects';

    expect(resolveStartupRecoveryDecision(recoveryUrl)).toBe('report-only');
    expect(buildStartupWorkerBypassUrl(recoveryUrl)).toBeNull();
  });

  it('fails closed for malformed URLs', () => {
    expect(resolveStartupRecoveryDecision('not a URL')).toBe('report-only');
    expect(buildStartupWorkerBypassUrl('not a URL')).toBeNull();
  });
});
