import { Injectable, inject } from '@angular/core';
import { environment } from '../environments/environment';
import {
  ErrorCodes,
  OperationError,
  Result,
  failure,
  humanizeErrorMessage,
  success,
} from '../utils/result';
import { SupabaseClientService } from './supabase-client.service';
import { AuthPasswordRecoveryService } from './auth-password-recovery.service';
import type { AuthCredentialStateCommitPredicate } from './auth-credential-flow.controller';
import type { AuthResult } from './auth-types';

type AuthProviderUser = {
  id: string;
  email?: string | null;
};

export type AuthSignupSessionPublicationFence = (session: {
  access_token: string;
  user: AuthProviderUser;
}) => Promise<boolean>;

@Injectable({
  providedIn: 'root',
})
export class AuthCredentialRequestService {
  private readonly supabase = inject(SupabaseClientService);
  private readonly passwordRecovery = inject(AuthPasswordRecoveryService, { optional: true });
  private readonly requestTimeoutMs = 15000;

  async signIn(
    email: string,
    password: string,
    credentialRequestId?: string,
  ): Promise<Result<AuthResult, OperationError>> {
    try {
      const signInRequest = credentialRequestId
        ? this.supabase.signInWithPassword(email, password, credentialRequestId)
        : this.supabase.signInWithPassword(email, password);
      const { data, error } = await this.withTimeout(
        signInRequest,
        '登录请求超时，请检查网络连接后重试',
      );

      if (error || !data.session?.user) {
        const errorMsg = humanizeErrorMessage(error?.message || '登录失败');
        return failure(ErrorCodes.SYNC_AUTH_EXPIRED, errorMsg);
      }

      return success(this.toAuthResult(data.session.user));
    } catch (error: unknown) {
      return failure(ErrorCodes.UNKNOWN, this.toSignInErrorMessage(error));
    }
  }

  async signUp(
    email: string,
    password: string,
    canCommitCredentialState?: AuthCredentialStateCommitPredicate,
    afterSessionCommit?: AuthSignupSessionPublicationFence,
  ): Promise<Result<AuthResult, OperationError>> {
    try {
      const { data, error } = await this.supabase.signUpIsolated(
        email,
        password,
        `${this.getAuthRedirectOrigin()}/auth/callback`,
        canCommitCredentialState ?? (() => false),
        afterSessionCommit ?? (async () => false),
      );

      if (error) {
        return failure(ErrorCodes.UNKNOWN, humanizeErrorMessage(error.message));
      }

      if (data.user && !data.session) {
        return success({ needsConfirmation: true });
      }

      if (data.session?.user) {
        return success(this.toAuthResult(data.session.user));
      }

      return success({});
    } catch (error: unknown) {
      return failure(ErrorCodes.UNKNOWN, this.toGenericErrorMessage(error));
    }
  }

  async resetPassword(email: string): Promise<Result<void, OperationError>> {
    try {
      if (!this.passwordRecovery) {
        return failure(ErrorCodes.UNKNOWN, '密码恢复服务未就绪，请稍后重试');
      }
      await this.withTimeout(
        this.passwordRecovery.requestPasswordReset(email, this.getAuthRedirectOrigin()),
        '请求超时，请检查网络连接后重试',
      );
      return success(undefined);
    } catch (error: unknown) {
      return failure(ErrorCodes.UNKNOWN, this.toGenericErrorMessage(error));
    }
  }

  private async withTimeout<T>(request: PromiseLike<T>, timeoutMessage: string): Promise<T> {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(timeoutMessage)), this.requestTimeoutMs);
      });
      return await Promise.race([request, timeout]);
    } finally {
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
      }
    }
  }

  private toAuthResult(user: AuthProviderUser): AuthResult {
    const email = user.email ?? null;
    return {
      userId: user.id,
      email: email ?? undefined,
    };
  }

  private getAuthRedirectOrigin(): string {
    const env = environment as unknown as {
      production?: boolean;
      canonicalOrigin?: string;
      deploymentTarget?: string;
    };
    const canonicalOrigin = typeof env.canonicalOrigin === 'string'
      ? env.canonicalOrigin.trim().replace(/\/+$/, '')
      : '';

    // The generated test/local environment can retain production-shaped defaults while
    // deploymentTarget still identifies the runtime as local. Redirect policy follows
    // the explicit deployment target so local tests and preview builds use their origin.
    const isProduction = env.deploymentTarget === 'production';
    if (isProduction) {
      if (canonicalOrigin && /^https:\/\//i.test(canonicalOrigin)) return canonicalOrigin;
      throw new Error('AUTH_REDIRECT_ORIGIN_MUST_USE_HTTPS');
    }

    return window.location.origin;
  }

  private toSignInErrorMessage(error: unknown): string {
    const err = error as Error | undefined;
    if (err?.message?.includes('超时')) {
      return err.message;
    }

    return humanizeErrorMessage(err?.message ?? String(error));
  }

  private toGenericErrorMessage(error: unknown): string {
    const err = error as Error | undefined;
    return humanizeErrorMessage(err?.message ?? String(error));
  }
}
