import { describe, expect, it } from 'vitest';

import {
  resolveFlowDiagramHardRecoveryStart,
  resolveFlowDiagramRecoveryVerificationAction,
} from './flow-diagram-recovery.helpers';

describe('flow-diagram-recovery.helpers', () => {
  it('resolves recovery verification actions in priority order', () => {
    expect(resolveFlowDiagramRecoveryVerificationAction({
      allowHardRecovery: true,
      containerIsSafe: false,
      contentIsVisible: true,
      recoveryFitFallbackUsed: false,
    })).toBe('wait-for-safe-size');

    expect(resolveFlowDiagramRecoveryVerificationAction({
      allowHardRecovery: true,
      containerIsSafe: true,
      contentIsVisible: true,
      recoveryFitFallbackUsed: false,
    })).toBe('finish');

    expect(resolveFlowDiagramRecoveryVerificationAction({
      allowHardRecovery: true,
      containerIsSafe: true,
      contentIsVisible: false,
      recoveryFitFallbackUsed: false,
    })).toBe('hard-recovery');

    expect(resolveFlowDiagramRecoveryVerificationAction({
      allowHardRecovery: false,
      containerIsSafe: true,
      contentIsVisible: false,
      recoveryFitFallbackUsed: false,
    })).toBe('fit-fallback');

    expect(resolveFlowDiagramRecoveryVerificationAction({
      allowHardRecovery: false,
      containerIsSafe: true,
      contentIsVisible: false,
      recoveryFitFallbackUsed: true,
    })).toBe('keep-armed');
  });

  it('resolves hard recovery start eligibility', () => {
    const baseInput = {
      attemptCount: 0,
      canClearDiagram: true,
      hasDiagram: true,
      hasDiagramDiv: true,
      hardRecoveryInProgress: false,
      isDestroyed: false,
      maxAttempts: 2,
    };

    expect(resolveFlowDiagramHardRecoveryStart(baseInput)).toEqual({ status: 'start' });
    expect(resolveFlowDiagramHardRecoveryStart({
      ...baseInput,
      hardRecoveryInProgress: true,
    })).toEqual({ status: 'skip' });
    expect(resolveFlowDiagramHardRecoveryStart({
      ...baseInput,
      canClearDiagram: false,
    })).toEqual({ status: 'skip' });
    expect(resolveFlowDiagramHardRecoveryStart({
      ...baseInput,
      attemptCount: 2,
    })).toEqual({ status: 'limit-reached' });
  });
});
