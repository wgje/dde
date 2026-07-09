import type { OperationError, Result } from '../utils/result';
import type { AuthResult } from './auth-types';

export interface AuthDevAutoLoginControllerContext {
  devAutoLogin?: { email: string; password: string } | null;
  production?: boolean;
  signIn: (email: string, password: string) => Promise<Result<AuthResult, OperationError>>;
  debug: (message: string, data?: unknown) => void;
  info: (message: string, data?: unknown) => void;
  warn: (message: string, data?: unknown) => void;
}

export class AuthDevAutoLoginController {
  private attempted = false;

  constructor(private readonly context: AuthDevAutoLoginControllerContext) {}

  reset(): void {
    this.attempted = false;
  }

  async tryDevAutoLogin(): Promise<{ userId: string | null; email: string | null } | null> {
    if (this.attempted) {
      return null;
    }
    this.attempted = true;

    const devAutoLogin = this.context.devAutoLogin;
    if (!devAutoLogin?.email || !devAutoLogin.password) {
      return null;
    }

    if (this.context.production) {
      this.context.warn('⚠️ devAutoLogin 不应在生产环境使用，已忽略');
      return null;
    }

    this.context.debug('🔐 开发环境自动登录中...');

    try {
      const result = await this.context.signIn(devAutoLogin.email, devAutoLogin.password);

      if (result.ok && result.value.userId) {
        this.context.info('✅ 开发环境自动登录成功');
        return {
          userId: result.value.userId,
          email: result.value.email ?? null,
        };
      }

      this.context.info('ℹ️ 开发环境自动登录未成功，将以未登录状态运行');
      return null;
    } catch (e) {
      this.context.info('ℹ️ 开发环境自动登录异常，静默降级', e);
      // eslint-disable-next-line no-restricted-syntax -- dev auto-login is an optional bootstrap helper; failures intentionally fall back to anonymous startup.
      return null;
    }
  }
}
