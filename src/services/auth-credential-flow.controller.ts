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

export interface AuthCredentialFlowControllerContext {
  authState: WritableSignal<AuthState>;
  applyCredentialIdentity: (result: AuthResult) => void;
}

export class AuthCredentialFlowController {
  constructor(private readonly context: AuthCredentialFlowControllerContext) {}

  async run<T extends AuthResult | void>(
    request: () => Promise<Result<T, OperationError>>,
  ): Promise<Result<T, OperationError>> {
    this.context.authState.update(s => ({ ...s, isLoading: true, error: null }));

    try {
      const result = await request();
      if (!result.ok) {
        this.context.authState.update(s => ({ ...s, error: result.error.message }));
        return result;
      }

      if (result.value && typeof result.value === 'object' && 'userId' in result.value) {
        this.context.applyCredentialIdentity(result.value);
      }

      return result;
    } catch (error: unknown) {
      const err = error as Error | undefined;
      const errorMsg = humanizeErrorMessage(err?.message ?? String(error));
      this.context.authState.update(s => ({ ...s, error: errorMsg }));
      return failure(ErrorCodes.UNKNOWN, errorMsg);
    } finally {
      this.context.authState.update(s => ({ ...s, isLoading: false }));
    }
  }
}
