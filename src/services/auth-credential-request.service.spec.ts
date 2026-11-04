import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthCredentialRequestService } from './auth-credential-request.service';
import { AuthPasswordRecoveryService } from './auth-password-recovery.service';
import { SupabaseClientService } from './supabase-client.service';
import { environment } from '../environments/environment';

describe('AuthCredentialRequestService', () => {
  const env = environment as unknown as {
    production: boolean;
    canonicalOrigin: string;
    deploymentTarget: string;
  };
  const originalEnvironment = { ...env };

  afterEach(() => {
    Object.assign(env, originalEnvironment);
    TestBed.resetTestingModule();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function createService(): {
    service: AuthCredentialRequestService;
    clientAsync: ReturnType<typeof vi.fn>;
    requestPasswordReset: ReturnType<typeof vi.fn>;
    signUpIsolated: ReturnType<typeof vi.fn>;
    signInWithPassword: ReturnType<typeof vi.fn>;
  } {
    const signInWithPassword = vi.fn().mockResolvedValue({
      data: {
        session: {
          user: {
            id: 'user-1',
            email: 'user@example.com',
          },
        },
      },
      error: null,
    });
    const signUpIsolated = vi.fn().mockResolvedValue({
      data: {
        user: { id: 'signup-user', email: 'signup@example.com' },
        session: null,
      },
      error: null,
    });
    const clientAsync = vi.fn().mockResolvedValue(null);
    const requestPasswordReset = vi.fn().mockResolvedValue(undefined);

    TestBed.configureTestingModule({
      providers: [
        AuthCredentialRequestService,
        {
          provide: SupabaseClientService,
          useValue: {
            clientAsync,
            signUpIsolated,
            signInWithPassword,
          },
        },
        {
          provide: AuthPasswordRecoveryService,
          useValue: { requestPasswordReset },
        },
      ],
    });

    return {
      service: TestBed.inject(AuthCredentialRequestService),
      clientAsync,
      requestPasswordReset,
      signUpIsolated,
      signInWithPassword,
    };
  }

  function useProductionRedirectEnvironment(): void {
    Object.assign(env, {
      production: true,
      canonicalOrigin: 'https://nanoflow.pages.dev',
      deploymentTarget: 'production',
    });
  }

  it('clears request timeout handle 0 after a successful sign-in response', async () => {
    const { service, signInWithPassword } = createService();
    vi.spyOn(globalThis, 'setTimeout')
      .mockImplementation(() => 0 as unknown as ReturnType<typeof setTimeout>);
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout')
      .mockImplementation(() => undefined);

    const result = await service.signIn('user@example.com', 'password');

    expect(result).toEqual({
      ok: true,
      value: {
        userId: 'user-1',
        email: 'user@example.com',
      },
    });
    expect(signInWithPassword).toHaveBeenCalledWith('user@example.com', 'password');
    expect(clearTimeoutSpy).toHaveBeenCalledWith(0);
  });

  it('forwards the opaque credential request id without deriving causality from identity fields', async () => {
    const { service, signInWithPassword } = createService();

    await service.signIn('same-user@example.com', 'password', 'credential-request-a');

    expect(signInWithPassword).toHaveBeenCalledWith(
      'same-user@example.com',
      'password',
      'credential-request-a',
    );
  });

  it('returns a timeout while leaving the identified Supabase request lifecycle independent', async () => {
    vi.useFakeTimers();
    const { service, signInWithPassword } = createService();
    let resolveRequest!: (value: unknown) => void;
    signInWithPassword.mockReturnValue(new Promise(resolve => {
      resolveRequest = resolve;
    }));

    const resultPromise = service.signIn(
      'same-user@example.com',
      'password',
      'credential-request-timeout',
    );
    await vi.advanceTimersByTimeAsync(15000);

    await expect(resultPromise).resolves.toMatchObject({
      ok: false,
      error: { message: '登录请求超时，请检查网络连接后重试' },
    });
    expect(signInWithPassword).toHaveBeenCalledWith(
      'same-user@example.com',
      'password',
      'credential-request-timeout',
    );

    resolveRequest({ data: { session: null }, error: null });
    await Promise.resolve();
  });

  it('issues signup through the isolated request client and forwards both commit fences', async () => {
    useProductionRedirectEnvironment();
    const { clientAsync, service, signUpIsolated } = createService();
    const canCommit = vi.fn().mockReturnValue(true);
    const afterCommit = vi.fn().mockResolvedValue(true);

    await expect(service.signUp(
      'signup@example.com',
      'password-123',
      canCommit,
      afterCommit,
    )).resolves.toEqual({ ok: true, value: { needsConfirmation: true } });

    expect(signUpIsolated).toHaveBeenCalledWith(
      'signup@example.com',
      'password-123',
      'https://nanoflow.pages.dev/auth/callback',
      canCommit,
      afterCommit,
    );
    expect(clientAsync).not.toHaveBeenCalled();
  });

  it('issues password recovery through an isolated request client without touching primary auth', async () => {
    useProductionRedirectEnvironment();
    const { clientAsync, requestPasswordReset, service } = createService();

    await expect(service.resetPassword('recovery@example.com')).resolves.toEqual({
      ok: true,
      value: undefined,
    });

    expect(requestPasswordReset).toHaveBeenCalledWith(
      'recovery@example.com',
      'https://nanoflow.pages.dev',
    );
    expect(clientAsync).not.toHaveBeenCalled();
  });

  it('rejects an insecure production redirect instead of falling back to window origin', async () => {
    const previous = { ...env };
    const { service, signUpIsolated } = createService();
    env.production = true;
    env.deploymentTarget = 'local';
    env.canonicalOrigin = 'http://insecure.example.com';

    try {
      await expect(service.signUp('signup@example.com', 'password-123')).resolves.toMatchObject({
        ok: false,
      });
      expect(signUpIsolated).not.toHaveBeenCalled();
    } finally {
      Object.assign(env, previous);
    }
  });

  it('fails closed without touching primary auth when isolated recovery is unavailable', async () => {
    const clientAsync = vi.fn();
    const injector = TestBed.configureTestingModule({
      providers: [
        AuthCredentialRequestService,
        { provide: AuthPasswordRecoveryService, useValue: null },
        { provide: SupabaseClientService, useValue: { clientAsync, signInWithPassword: vi.fn() } },
      ],
    });

    const service = injector.inject(AuthCredentialRequestService);
    await expect(service.resetPassword('recovery@example.com')).resolves.toMatchObject({
      ok: false,
      error: { message: '密码恢复服务未就绪，请稍后重试' },
    });
    expect(clientAsync).not.toHaveBeenCalled();
  });
});
