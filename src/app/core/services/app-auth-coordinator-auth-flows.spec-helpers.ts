import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { AppAuthCoordinatorService } from './app-auth-coordinator.service';

type SpecMock = Mock<(...args: unknown[]) => unknown>;

interface AppAuthCoordinatorAuthFlowHarness {
  service: AppAuthCoordinatorService;
  authMock: {
    signUp: SpecMock;
    resetPassword: SpecMock;
  };
  userSessionMock: {
    setCurrentUser: SpecMock;
  };
  toastMock: {
    success: SpecMock;
  };
  modalMock: {
    closeByType: SpecMock;
  };
  logger: {
    warn: SpecMock;
  };
}

interface AppAuthCoordinatorAuthFlowSpecContext {
  setup: () => AppAuthCoordinatorAuthFlowHarness;
  disableLocalMode: (...args: unknown[]) => unknown;
}

export function registerAppAuthCoordinatorAuthFlowSpecs(context: AppAuthCoordinatorAuthFlowSpecContext): void {
  describe('handleSignup timeout protection', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should complete normally when setCurrentUser resolves before the 8s timeout', async () => {
      const { service, authMock, userSessionMock, toastMock, modalMock } = context.setup();
      authMock.signUp.mockResolvedValue({
        ok: true,
        value: { needsConfirmation: false, userId: 'signup-user-1' },
      });
      userSessionMock.setCurrentUser.mockResolvedValue(undefined);

      service.authEmail.set('test@example.com');
      service.authPassword.set('password123');
      service.authConfirmPassword.set('password123');

      await service.handleSignup();

      expect(context.disableLocalMode).toHaveBeenCalled();
      expect(userSessionMock.setCurrentUser).toHaveBeenCalledWith('signup-user-1', {
        forceLoad: true,
        previousUserIdHint: null,
      });
      expect(toastMock.success).toHaveBeenCalled();
      expect(modalMock.closeByType).toHaveBeenCalledWith('login', {
        success: true,
        userId: 'signup-user-1',
      });
      expect(service.isAuthLoading()).toBe(false);
      expect(service.isSignupMode()).toBe(false);
    });

    it('should log warning and continue when setCurrentUser exceeds the 8s timeout', async () => {
      vi.useFakeTimers();
      const { service, authMock, userSessionMock, logger, toastMock } = context.setup();
      authMock.signUp.mockResolvedValue({
        ok: true,
        value: { needsConfirmation: false, userId: 'signup-user-2' },
      });
      // setCurrentUser returns a promise that never resolves (simulates very slow load)
      userSessionMock.setCurrentUser.mockReturnValue(new Promise(() => {}));

      service.authEmail.set('test@example.com');
      service.authPassword.set('password123');
      service.authConfirmPassword.set('password123');

      const signupPromise = service.handleSignup();

      // Advance past the 8000ms timeout
      await vi.advanceTimersByTimeAsync(8000);

      await signupPromise;

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('[Signup]'),
        expect.objectContaining({ timeoutMs: 8000 }),
      );
      // Should still complete the signup flow despite timeout
      expect(toastMock.success).toHaveBeenCalled();
      expect(service.isAuthLoading()).toBe(false);
    });

    it('should use signUp result userId even when auth currentUserId signal is not prefilled', async () => {
      const { service, authMock, userSessionMock, modalMock } = context.setup();
      authMock.signUp.mockResolvedValue({
        ok: true,
        value: { needsConfirmation: false, userId: 'signup-user-direct' },
      });
      userSessionMock.setCurrentUser.mockResolvedValue(undefined);

      service.authEmail.set('test@example.com');
      service.authPassword.set('password123');
      service.authConfirmPassword.set('password123');

      await service.handleSignup();

      expect(userSessionMock.setCurrentUser).toHaveBeenCalledWith('signup-user-direct', {
        forceLoad: true,
        previousUserIdHint: null,
      });
      expect(modalMock.closeByType).toHaveBeenCalledWith('login', {
        success: true,
        userId: 'signup-user-direct',
      });
    });

    it('should not reach data load path when signup requires email confirmation', async () => {
      const { service, authMock, userSessionMock } = context.setup();
      authMock.signUp.mockResolvedValue({ ok: true, value: { needsConfirmation: true } });

      service.authEmail.set('test@example.com');
      service.authPassword.set('password123');
      service.authConfirmPassword.set('password123');

      await service.handleSignup();

      expect(userSessionMock.setCurrentUser).not.toHaveBeenCalled();
      expect(service.authError()).toBe('注册成功！请查收邮件并点击验证链接完成注册。');
      expect(service.isAuthLoading()).toBe(false);
    });

    it('should reject signup when passwords do not match', async () => {
      const { service, authMock } = context.setup();

      service.authEmail.set('test@example.com');
      service.authPassword.set('password123');
      service.authConfirmPassword.set('different456');

      await service.handleSignup();

      expect(authMock.signUp).not.toHaveBeenCalled();
      expect(service.authError()).toBe('两次输入的密码不一致');
    });

    it('should reject signup when password is shorter than 8 characters', async () => {
      const { service, authMock } = context.setup();

      service.authEmail.set('test@example.com');
      service.authPassword.set('short');
      service.authConfirmPassword.set('short');

      await service.handleSignup();

      expect(authMock.signUp).not.toHaveBeenCalled();
      expect(service.authError()).toBe('密码长度至少8位');
    });

    it('should preserve the auth service signup error message', async () => {
      const { service, authMock } = context.setup();
      authMock.signUp.mockResolvedValue({
        ok: false,
        error: { code: 'UNKNOWN', message: '该邮箱已被注册' },
      });

      service.authEmail.set('existing@example.com');
      service.authPassword.set('password123');
      service.authConfirmPassword.set('password123');

      await service.handleSignup();

      expect(service.authError()).toBe('该邮箱已被注册');
    });
  });

  describe('handleResetPassword error propagation', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('should preserve the auth service reset password error message', async () => {
      const { service, authMock } = context.setup();
      authMock.resetPassword.mockResolvedValue({
        ok: false,
        error: { code: 'UNKNOWN', message: '邮箱格式不正确或未验证' },
      });

      service.authEmail.set('invalid-email');

      await service.handleResetPassword();

      expect(service.authError()).toBe('邮箱格式不正确或未验证');
    });
  });
}
