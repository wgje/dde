import type { WritableSignal } from '@angular/core';
import {
  ErrorCodes,
  failure,
  humanizeErrorMessage,
  type OperationError,
  type Result,
} from '../utils/result';
import type { AuthState } from './auth.service';
import type { AuthResult } from './auth-types';

export type AuthCredentialStateIdentity = { userId?: string | null; email?: string | null };
export type AuthCredentialStateCommitPredicate = (identity?: AuthCredentialStateIdentity) => boolean;

export interface AuthCredentialFlowControllerContext {
  authState: WritableSignal<AuthState>;
  applyCredentialIdentity: (result: AuthResult) => void;
}

export class AuthCredentialFlowController {
  private flowSequence = 0;

  constructor(private readonly context: AuthCredentialFlowControllerContext) {}

  async run<T extends AuthResult | void>(
    request: () => Promise<Result<T, OperationError>>,
    canCommitCredentialState?: AuthCredentialStateCommitPredicate,
  ): Promise<Result<T, OperationError>> {
    const flowId = ++this.flowSequence;
    this.context.authState.update(s => ({ ...s, isLoading: true, error: null }));
    let resolvedIdentity: AuthResult | undefined;

    try {
      const result = await request();
      if (!result.ok) {
        if (this.canCommitCredentialState(canCommitCredentialState)) {
          this.context.authState.update(s => ({ ...s, error: result.error.message }));
        }
        return result;
      }

      if (
        result.value
        && typeof result.value === 'object'
        && 'userId' in result.value
      ) {
        resolvedIdentity = result.value;
        if (this.canCommitCredentialState(canCommitCredentialState, resolvedIdentity)) {
          this.context.applyCredentialIdentity(resolvedIdentity);
        }
      }

      return result;
    } catch (error: unknown) {
      const err = error as Error | undefined;
      const errorMsg = humanizeErrorMessage(err?.message ?? String(error));
      if (this.canCommitCredentialState(canCommitCredentialState)) {
        this.context.authState.update(s => ({ ...s, error: errorMsg }));
      }
      return failure(ErrorCodes.UNKNOWN, errorMsg);
    } finally {
      if (this.flowSequence === flowId) {
        this.context.authState.update(s => ({ ...s, isLoading: false }));
      }
    }
  }

  private canCommitCredentialState(
    predicate?: AuthCredentialStateCommitPredicate,
    identity?: AuthCredentialStateIdentity,
  ): boolean {
    if (!predicate) {
      return true;
    }

    try {
      return predicate(identity) === true;
    } catch {
      return false;
    }
  }
}
