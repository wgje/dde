export interface ConnectivityRecoveryContinuationInput {
  runtimeStarted: boolean;
  recoveryEpoch: number;
  currentEpoch: number;
}

export function shouldContinueConnectivityRecovery(
  input: ConnectivityRecoveryContinuationInput,
): boolean {
  return input.runtimeStarted && input.recoveryEpoch === input.currentEpoch;
}
