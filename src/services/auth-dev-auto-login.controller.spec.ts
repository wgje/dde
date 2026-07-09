import { describe, expect, it, vi } from 'vitest';

import { AuthDevAutoLoginController } from './auth-dev-auto-login.controller';
import { ErrorCodes, failure, success } from '../utils/result';

describe('AuthDevAutoLoginController', () => {
  it('runs configured non-production dev auto login once', async () => {
    const ctx = createContext();
    const controller = new AuthDevAutoLoginController(ctx);

    await expect(controller.tryDevAutoLogin()).resolves.toEqual({
      userId: 'user-1',
      email: 'user@example.com',
    });
    await expect(controller.tryDevAutoLogin()).resolves.toBeNull();

    expect(ctx.signIn).toHaveBeenCalledTimes(1);
    expect(ctx.info).toHaveBeenCalledWith('✅ 开发环境自动登录成功');
  });

  it('does not run without credentials or in production', async () => {
    const missing = createContext({ devAutoLogin: null });
    await expect(new AuthDevAutoLoginController(missing).tryDevAutoLogin()).resolves.toBeNull();
    expect(missing.signIn).not.toHaveBeenCalled();

    const production = createContext({ production: true });
    await expect(new AuthDevAutoLoginController(production).tryDevAutoLogin()).resolves.toBeNull();
    expect(production.signIn).not.toHaveBeenCalled();
    expect(production.warn).toHaveBeenCalled();
  });

  it('silently degrades when sign in fails or throws', async () => {
    const failed = createContext({
      signIn: vi.fn(async () => failure(ErrorCodes.OPERATION_FAILED, 'bad credentials')),
    });
    await expect(new AuthDevAutoLoginController(failed).tryDevAutoLogin()).resolves.toBeNull();

    const thrown = createContext({
      signIn: vi.fn(async () => {
        throw new Error('network');
      }),
    });
    await expect(new AuthDevAutoLoginController(thrown).tryDevAutoLogin()).resolves.toBeNull();
    expect(thrown.info).toHaveBeenCalledWith('ℹ️ 开发环境自动登录异常，静默降级', expect.any(Error));
  });
});

function createContext(overrides: Partial<ConstructorParameters<typeof AuthDevAutoLoginController>[0]> = {}) {
  return {
    devAutoLogin: { email: 'dev@example.com', password: 'secret' },
    production: false,
    signIn: vi.fn(async () => success({ userId: 'user-1', email: 'user@example.com' })),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    ...overrides,
  };
}
