import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { AUTH_CONFIG } from '../../../config/auth.config';
import type { AppAuthCoordinatorService } from './app-auth-coordinator.service';

type SpecMock = Mock<(...args: unknown[]) => unknown>;

interface AppAuthCoordinatorAuthFlowHarness {
  service: AppAuthCoordinatorService;
  authMock: {
    signIn: SpecMock;
    signOut: SpecMock;
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
    getData: SpecMock;
  };
  logger: {
    warn: SpecMock;
  };
  routerMock: {
    navigateByUrl: SpecMock;
  };
  userId: {
    (): string | null;
    set(value: string | null): void;
  };
  eventBus: {
    publishSessionInvalidated: (source: string, userId: string) => void;
  };
  injector: unknown;
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

  describe('auth submission in-flight guard', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    function createDeferred<T>() {
      let resolve!: (value: T) => void;
      const promise = new Promise<T>(promiseResolve => {
        resolve = promiseResolve;
      });
      return { promise, resolve };
    }

    it('登录进行中时并发第二次 handleLogin 不应触发第二次 signIn', async () => {
      const { service, authMock } = context.setup();
      const signIn = createDeferred<unknown>();
      authMock.signIn.mockReturnValue(signIn.promise);
      service.authEmail.set('test@example.com');
      service.authPassword.set('password123');

      const first = service.handleLogin();
      await service.handleLogin();

      expect(authMock.signIn).toHaveBeenCalledTimes(1);

      signIn.resolve({ ok: true, value: { userId: 'user-1' } });
      await first;

      // 完成后守卫释放：再次提交应重新触发 signIn
      expect(service.isAuthLoading()).toBe(false);
      authMock.signIn.mockResolvedValue({ ok: true, value: { userId: 'user-1' } });
      await service.handleLogin();
      expect(authMock.signIn).toHaveBeenCalledTimes(2);
    });

    it('注册进行中时并发第二次 handleSignup 不应触发第二次 signUp', async () => {
      const { service, authMock } = context.setup();
      const signUp = createDeferred<unknown>();
      authMock.signUp.mockReturnValue(signUp.promise);
      service.authEmail.set('test@example.com');
      service.authPassword.set('password123');
      service.authConfirmPassword.set('password123');

      const first = service.handleSignup();
      await service.handleSignup();

      expect(authMock.signUp).toHaveBeenCalledTimes(1);

      signUp.resolve({ ok: true, value: { needsConfirmation: true } });
      await first;
      expect(service.isAuthLoading()).toBe(false);
    });

    it('重置进行中时并发第二次 handleResetPassword 不应触发第二次 resetPassword', async () => {
      const { service, authMock } = context.setup();
      const reset = createDeferred<unknown>();
      authMock.resetPassword.mockReturnValue(reset.promise);
      service.authEmail.set('test@example.com');

      const first = service.handleResetPassword();
      await service.handleResetPassword();

      expect(authMock.resetPassword).toHaveBeenCalledTimes(1);

      reset.resolve({ ok: true, value: undefined });
      await first;
      expect(service.isAuthLoading()).toBe(false);
    });

    it('登录失败后守卫应释放并允许重试', async () => {
      const { service, authMock } = context.setup();
      authMock.signIn.mockResolvedValue({
        ok: false,
        error: { code: 'SYNC_AUTH_EXPIRED', message: '用户名或密码错误' },
      });
      service.authEmail.set('test@example.com');
      service.authPassword.set('password123');

      await service.handleLogin();
      await service.handleLogin();

      expect(authMock.signIn).toHaveBeenCalledTimes(2);
    });

    it('session invalidation 不应错误释放仍在进行的 signup 重复提交守卫', async () => {
      const { service, authMock, eventBus } = context.setup();
      const signUp = createDeferred<unknown>();
      authMock.signUp.mockReturnValue(signUp.promise);
      service.authEmail.set('test@example.com');
      service.authPassword.set('password123');
      service.authConfirmPassword.set('password123');

      const first = service.handleSignup();
      await Promise.resolve();
      eventBus.publishSessionInvalidated('test', 'owner-before-signup');
      await Promise.resolve();
      const second = service.handleSignup();

      signUp.resolve({ ok: true, value: { needsConfirmation: true } });
      await Promise.all([first, second]);

      expect(authMock.signUp).toHaveBeenCalledTimes(1);
    });
  });

  describe('login submission generation', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    function createDeferred<T>() {
      let resolve!: (value: T) => void;
      let reject!: (reason?: unknown) => void;
      const promise = new Promise<T>((promiseResolve, promiseReject) => {
        resolve = promiseResolve;
        reject = promiseReject;
      });
      return { promise, reject, resolve };
    }

    function startDeferredLogin() {
      const harness = context.setup();
      const signIn = createDeferred<unknown>();
      harness.authMock.signIn.mockReturnValue(signIn.promise);
      harness.modalMock.getData.mockReturnValue({ returnUrl: '/dashboard' });
      harness.service.authEmail.set('a@example.com');
      harness.service.authPassword.set('password123');
      const loginPromise = harness.service.handleLogin();
      const credentialCommitPredicate = () => {
        expect(harness.authMock.signIn).toHaveBeenCalledWith(
          'a@example.com',
          'password123',
          expect.any(Function),
        );
        return harness.authMock.signIn.mock.calls[0]?.[2] as (
          identity?: { userId?: string | null; email?: string | null },
        ) => boolean;
      };
      return { ...harness, signIn, loginPromise, credentialCommitPredicate };
    }

    it('当前登录提交的 credential commit predicate 应允许响应身份', async () => {
      const { signIn, loginPromise, credentialCommitPredicate } = startDeferredLogin();

      expect(credentialCommitPredicate()({
        userId: 'owner-a',
        email: 'a@example.com',
      })).toBe(true);

      signIn.resolve({ ok: true, value: { userId: 'owner-a' } });
      await loginPromise;
    });

    it('modal login returns true only for its current successful submission', async () => {
      const { service, authMock, modalMock } = context.setup();
      authMock.signIn.mockResolvedValue({ ok: true, value: { userId: 'owner-a' } });

      await expect(service.handleLoginFromModal({
        email: 'a@example.com', password: 'password123',
      })).resolves.toBe(true);

      expect(modalMock.closeByType).toHaveBeenCalledTimes(1);
      expect(modalMock.closeByType).toHaveBeenCalledWith('login', {
        success: true, userId: 'owner-a',
      });
    });

    it('modal login returns false when different-owner B makes pending A stale', async () => {
      const { service, authMock, userId, modalMock } = context.setup();
      const signIn = createDeferred<unknown>();
      authMock.signIn.mockReturnValue(signIn.promise);
      const login = service.handleLoginFromModal({
        email: 'a@example.com', password: 'password123',
      });
      await vi.waitFor(() => expect(authMock.signIn).toHaveBeenCalledOnce());

      userId.set('owner-b');
      signIn.resolve({ ok: true, value: { userId: 'owner-a' } });

      await expect(login).resolves.toBe(false);
      expect(service.authError()).toBeNull();
      expect(modalMock.closeByType).not.toHaveBeenCalled();
    });

    it('modal login returns false without an auth error when A rejects after sign-out', async () => {
      const { service, authMock, modalMock } = context.setup();
      const signIn = createDeferred<unknown>();
      authMock.signIn.mockReturnValue(signIn.promise);
      const login = service.handleLoginFromModal({
        email: 'a@example.com', password: 'password123',
      });
      await vi.waitFor(() => expect(authMock.signIn).toHaveBeenCalledOnce());

      await service.signOut();
      signIn.reject(new Error('late A rejected'));

      await expect(login).resolves.toBe(false);
      expect(service.authError()).toBeNull();
      expect(modalMock.closeByType).not.toHaveBeenCalled();
    });

    it('signOut 开始后应丢弃迟到的登录 A，不得切回 A 或提交 UI 副作用', async () => {
      const {
        service,
        signIn,
        loginPromise,
        userId,
        userSessionMock,
        modalMock,
        routerMock,
        credentialCommitPredicate,
      } = startDeferredLogin();
      userId.set('owner-before-login');
      await Promise.resolve();

      await service.signOut();
      expect(credentialCommitPredicate()({ userId: 'owner-a' })).toBe(false);
      signIn.resolve({ ok: true, value: { userId: 'owner-a' } });
      await loginPromise;

      expect(userSessionMock.setCurrentUser).not.toHaveBeenCalledWith('owner-a', expect.anything());
      expect(modalMock.closeByType).not.toHaveBeenCalledWith('login', {
        success: true,
        userId: 'owner-a',
      });
      expect(routerMock.navigateByUrl).not.toHaveBeenCalledWith('/dashboard');
    });

    it('进入 local mode 后应丢弃迟到的登录 A', async () => {
      const {
        service,
        signIn,
        loginPromise,
        userId,
        userSessionMock,
        modalMock,
        credentialCommitPredicate,
      } = startDeferredLogin();
      userId.set('owner-before-login');
      await Promise.resolve();

      await service.handleLocalModeFromModal();
      expect(credentialCommitPredicate()({ userId: 'owner-a' })).toBe(false);
      signIn.resolve({ ok: true, value: { userId: 'owner-a' } });
      await loginPromise;

      expect(userSessionMock.setCurrentUser).toHaveBeenCalledWith(AUTH_CONFIG.LOCAL_MODE_USER_ID, {
        forceLoad: true,
        previousUserIdHint: 'owner-before-login',
        preserveOfflineSnapshot: true,
      });
      expect(userSessionMock.setCurrentUser).not.toHaveBeenCalledWith('owner-a', expect.anything());
      expect(modalMock.closeByType).not.toHaveBeenCalledWith('login', {
        success: true,
        userId: 'owner-a',
      });
    });

    it('owner 已切换为 B 时应丢弃迟到的登录 A', async () => {
      const {
        signIn,
        loginPromise,
        userId,
        userSessionMock,
        modalMock,
        routerMock,
      } = startDeferredLogin();
      userId.set('owner-before-login');
      await Promise.resolve();

      userId.set('owner-b');
      signIn.resolve({ ok: true, value: { userId: 'owner-a' } });
      await loginPromise;

      expect(userSessionMock.setCurrentUser).not.toHaveBeenCalledWith('owner-a', expect.anything());
      expect(modalMock.closeByType).not.toHaveBeenCalledWith('login', expect.anything());
      expect(routerMock.navigateByUrl).not.toHaveBeenCalledWith('/dashboard');
    });

    it('session invalidation 后应丢弃迟到的登录 A', async () => {
      const {
        signIn,
        loginPromise,
        userId,
        eventBus,
        userSessionMock,
        modalMock,
      } = startDeferredLogin();
      userId.set('owner-before-login');
      await Promise.resolve();

      eventBus.publishSessionInvalidated('test', 'owner-before-login');
      await Promise.resolve();
      signIn.resolve({ ok: true, value: { userId: 'owner-a' } });
      await loginPromise;

      expect(userSessionMock.setCurrentUser).not.toHaveBeenCalledWith('owner-a', expect.anything());
      expect(modalMock.closeByType).not.toHaveBeenCalledWith('login', {
        success: true,
        userId: 'owner-a',
      });
    });

    it('coordinator destroy 后应丢弃迟到的登录 A', async () => {
      const {
        signIn,
        loginPromise,
        injector,
        userSessionMock,
        modalMock,
      } = startDeferredLogin();
      await Promise.resolve();

      (injector as { destroy: () => void }).destroy();
      signIn.resolve({ ok: true, value: { userId: 'owner-a' } });
      await loginPromise;

      expect(userSessionMock.setCurrentUser).not.toHaveBeenCalledWith('owner-a', expect.anything());
      expect(modalMock.closeByType).not.toHaveBeenCalledWith('login', expect.anything());
    });

    it('signOut 后 signup submission fence 应拒绝迟到 A 及全部 UI 副作用', async () => {
      const {
        service,
        authMock,
        userSessionMock,
        modalMock,
        toastMock,
      } = context.setup();
      const signUp = createDeferred<unknown>();
      authMock.signUp.mockReturnValue(signUp.promise);
      service.authEmail.set('signup-a@example.com');
      service.authPassword.set('password123');
      service.authConfirmPassword.set('password123');

      const signupPromise = service.handleSignup();
      await Promise.resolve();
      expect(authMock.signUp).toHaveBeenCalledWith(
        'signup-a@example.com',
        'password123',
        expect.any(Function),
      );
      const canCommit = authMock.signUp.mock.calls[0]?.[2] as (
        identity: { userId: string; email: string | null },
      ) => boolean;

      await service.signOut();
      expect(canCommit({ userId: 'signup-owner-a', email: 'signup-a@example.com' })).toBe(false);
      signUp.resolve({ ok: true, value: { userId: 'signup-owner-a' } });
      await signupPromise;

      expect(userSessionMock.setCurrentUser).not.toHaveBeenCalledWith('signup-owner-a', expect.anything());
      expect(modalMock.closeByType).not.toHaveBeenCalledWith('login', expect.anything());
      expect(toastMock.success).not.toHaveBeenCalledWith('注册成功', expect.anything());
    });

    it('replacement modal fence 应在响应前阻止 signup A 提交与成功副作用', async () => {
      const { service, authMock, userSessionMock, modalMock, toastMock } = context.setup();
      const signUp = createDeferred<unknown>();
      const modalFence = vi.fn().mockReturnValue(true);
      authMock.signUp.mockReturnValue(signUp.promise);
      const signupPromise = service.handleSignupFromModal({
        email: 'owner-a@example.com',
        password: 'password123',
        confirmPassword: 'password123',
      }, modalFence);
      await vi.waitFor(() => expect(authMock.signUp).toHaveBeenCalledOnce());
      const canCommit = authMock.signUp.mock.calls[0]?.[2] as (
        identity: { userId: string; email: string | null },
      ) => boolean;

      modalFence.mockReturnValue(false);
      expect(canCommit({ userId: 'owner-a', email: 'owner-a@example.com' })).toBe(false);
      signUp.resolve({ ok: true, value: { userId: 'owner-a' } });
      await expect(signupPromise).resolves.toBe(false);

      expect(userSessionMock.setCurrentUser).not.toHaveBeenCalledWith('owner-a', expect.anything());
      expect(modalMock.closeByType).not.toHaveBeenCalledWith('login', expect.anything());
      expect(toastMock.success).not.toHaveBeenCalledWith('注册成功', expect.anything());
    });

    it('signup A 的用户加载 await 中 signOut 后不得发布成功 UI', async () => {
      const {
        service,
        authMock,
        userSessionMock,
        modalMock,
        toastMock,
      } = context.setup();
      const userLoad = createDeferred<void>();
      authMock.signUp.mockResolvedValue({
        ok: true,
        value: { userId: 'signup-owner-a', email: 'owner-a@example.com' },
      });
      userSessionMock.setCurrentUser
        .mockImplementationOnce(() => userLoad.promise)
        .mockResolvedValue(undefined);
      service.authEmail.set('owner-a@example.com');
      service.authPassword.set('password123');
      service.authConfirmPassword.set('password123');

      const signupPromise = service.handleSignup();
      await vi.waitFor(() => expect(userSessionMock.setCurrentUser).toHaveBeenCalledWith(
        'signup-owner-a',
        { forceLoad: true, previousUserIdHint: null },
      ));

      await service.signOut();
      userLoad.resolve();
      await signupPromise;

      expect(toastMock.success).not.toHaveBeenCalledWith('注册成功', expect.anything());
      expect(modalMock.closeByType).not.toHaveBeenCalledWith('login', {
        success: true,
        userId: 'signup-owner-a',
      });
    });

    it('登录 A 的用户加载 await 中 signOut 后不得再导航或关闭登录 modal', async () => {
      const {
        service,
        authMock,
        userId,
        userSessionMock,
        modalMock,
        routerMock,
        toastMock,
      } = context.setup();
      const userLoad = createDeferred<void>();
      authMock.signIn.mockResolvedValue({ ok: true, value: { userId: 'owner-a' } });
      userSessionMock.setCurrentUser
        .mockImplementationOnce(() => userLoad.promise)
        .mockImplementation(async (nextUserId: unknown) => {
          userId.set(typeof nextUserId === 'string' ? nextUserId : null);
        });
      modalMock.getData.mockReturnValue({ returnUrl: '/dashboard' });
      service.authEmail.set('a@example.com');
      service.authPassword.set('password123');

      const loginPromise = service.handleLogin();
      await Promise.resolve();
      await Promise.resolve();
      expect(userSessionMock.setCurrentUser).toHaveBeenCalledWith('owner-a', {
        forceLoad: true,
        previousUserIdHint: null,
      });

      await service.signOut();
      userLoad.resolve();
      await loginPromise;

      expect(toastMock.success).not.toHaveBeenCalledWith('登录成功', expect.anything());
      expect(modalMock.closeByType).not.toHaveBeenCalledWith('login', {
        success: true,
        userId: 'owner-a',
      });
      expect(routerMock.navigateByUrl).not.toHaveBeenCalledWith('/dashboard');
    });
  });
}
