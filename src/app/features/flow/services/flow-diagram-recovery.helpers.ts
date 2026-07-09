export type FlowDiagramRecoveryVerificationAction =
  | 'finish'
  | 'hard-recovery'
  | 'fit-fallback'
  | 'keep-armed'
  | 'wait-for-safe-size';

export interface FlowDiagramRecoveryVerificationInput {
  allowHardRecovery: boolean;
  containerIsSafe: boolean;
  contentIsVisible: boolean;
  recoveryFitFallbackUsed: boolean;
}

export function resolveFlowDiagramRecoveryVerificationAction(
  input: FlowDiagramRecoveryVerificationInput,
): FlowDiagramRecoveryVerificationAction {
  if (!input.containerIsSafe) {
    return 'wait-for-safe-size';
  }

  if (input.contentIsVisible) {
    return 'finish';
  }

  if (input.allowHardRecovery) {
    return 'hard-recovery';
  }

  if (!input.recoveryFitFallbackUsed) {
    return 'fit-fallback';
  }

  return 'keep-armed';
}

export interface FlowDiagramHardRecoveryStartInput {
  attemptCount: number;
  canClearDiagram: boolean;
  hasDiagram: boolean;
  hasDiagramDiv: boolean;
  hardRecoveryInProgress: boolean;
  isDestroyed: boolean;
  maxAttempts: number;
}

export type FlowDiagramHardRecoveryStartResult =
  | { status: 'start' }
  | { status: 'skip' }
  | { status: 'limit-reached' };

export function resolveFlowDiagramHardRecoveryStart(
  input: FlowDiagramHardRecoveryStartInput,
): FlowDiagramHardRecoveryStartResult {
  if (
    !input.hasDiagramDiv
    || !input.hasDiagram
    || input.isDestroyed
    || input.hardRecoveryInProgress
    || !input.canClearDiagram
  ) {
    return { status: 'skip' };
  }

  if (input.attemptCount >= input.maxAttempts) {
    return { status: 'limit-reached' };
  }

  return { status: 'start' };
}
