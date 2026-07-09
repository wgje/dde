import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthCredentialRequestService } from './auth-credential-request.service';
import { SupabaseClientService } from './supabase-client.service';

describe('AuthCredentialRequestService', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.restoreAllMocks();
  });

  function createService(): {
    service: AuthCredentialRequestService;
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

    TestBed.configureTestingModule({
      providers: [
        AuthCredentialRequestService,
        {
          provide: SupabaseClientService,
          useValue: {
            signInWithPassword,
          },
        },
      ],
    });

    return {
      service: TestBed.inject(AuthCredentialRequestService),
      signInWithPassword,
    };
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
});
