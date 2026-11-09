import { describe, expect, it } from 'vitest';
import { shouldContinueConnectivityRecovery } from './connectivity-recovery-flow';

describe('connectivity recovery flow helpers', () => {
  it('continues while runtime is still active and the recovery epoch has not changed', () => {
    expect(shouldContinueConnectivityRecovery({
      runtimeStarted: true,
      recoveryEpoch: 3,
      currentEpoch: 3,
    })).toBe(true);
  });

  it('stops when runtime has been stopped during recovery', () => {
    expect(shouldContinueConnectivityRecovery({
      runtimeStarted: false,
      recoveryEpoch: 3,
      currentEpoch: 3,
    })).toBe(false);
  });

  it('stops when a newer recovery epoch supersedes the current attempt', () => {
    expect(shouldContinueConnectivityRecovery({
      runtimeStarted: true,
      recoveryEpoch: 3,
      currentEpoch: 4,
    })).toBe(false);
  });
});
