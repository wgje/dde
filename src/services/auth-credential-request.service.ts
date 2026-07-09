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
import type { AuthResult } from './auth-types';

type SupabaseAuthClient = NonNullable<Awaited<ReturnType<SupabaseClientService['clientAsync']>>>;

type AuthProviderUser = {
  id: string;
  email?: string | null;
};

@Injectable({
  providedIn: 'root',
})
export class AuthCredentialRequestService {
  private readonly supabase = inject(SupabaseClientService);
  private readonly requestTimeoutMs = 15000;

  async signIn(email: string, password: string): Promise<Result<AuthResult, OperationError>> {
    try {
      const { data, error } = await this.withTimeout(
        this.supabase.signInWithPassword(email, password),
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

  async signUp(email: string, password: string): Promise<Result<AuthResult, OperationError>> {
    try {
      const client = await this.supabase.clientAsync();
      if (!client) {
        return failure(
          ErrorCodes.SYNC_AUTH_EXPIRED,
          'Supabase 客户端未就绪，请稍后重试',
        );
      }

      const { data, error } = await this.submitSignUpWithTimeout(client, email, password);

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
      const client = await this.supabase.clientAsync();
      if (!client) {
        return failure(
          ErrorCodes.SYNC_AUTH_EXPIRED,
          'Supabase 客户端未就绪，请稍后重试',
        );
      }

      const { error } = await this.withTimeout(
        client.auth.resetPasswordForEmail(email, {
          redirectTo: `${this.getAuthRedirectOrigin()}/reset-password`,
        }),
        '请求超时，请检查网络连接后重试',
      );

      if (error) {
        return failure(ErrorCodes.UNKNOWN, humanizeErrorMessage(error.message));
      }

      return success(undefined);
    } catch (error: unknown) {
      return failure(ErrorCodes.UNKNOWN, this.toGenericErrorMessage(error));
    }
  }

  private async submitSignUpWithTimeout(
    client: SupabaseAuthClient,
    email: string,
    password: string,
  ): Promise<Awaited<ReturnType<SupabaseAuthClient['auth']['signUp']>>> {
    return await this.withTimeout(
      client.auth.signUp({
        email,
        password,
        options: {
          emailRedirectTo: `${this.getAuthRedirectOrigin()}/auth/callback`,
        },
      }),
      '注册请求超时，请检查网络连接后重试',
    );
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

    if (
      canonicalOrigin
      && /^https?:\/\//i.test(canonicalOrigin)
      && (env.production === true || env.deploymentTarget === 'production')
    ) {
      return canonicalOrigin;
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
