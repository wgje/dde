import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SupabaseClientService } from '../../../services/supabase-client.service';
import { LoggerService } from '../../../services/logger.service';
import { ToastService } from '../../../services/toast.service';
import { ResetPasswordComponent } from './reset-password.component';

function createResetPasswordClient() {
  return {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: null } }),
      setSession: vi.fn().mockResolvedValue({ error: null }),
      signOut: vi.fn().mockResolvedValue({ error: null }),
      updateUser: vi.fn().mockResolvedValue({ error: null }),
    },
  };
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

describe('ResetPasswordComponent', () => {
  let client: ReturnType<typeof createResetPasswordClient>;
  let navigate: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    client = createResetPasswordClient();
    navigate = vi.fn().mockResolvedValue(true);

    TestBed.configureTestingModule({
      imports: [ResetPasswordComponent],
      providers: [
        {
          provide: SupabaseClientService,
          useValue: {
            isConfigured: true,
            clientAsync: vi.fn().mockResolvedValue(client),
          },
        },
        {
          provide: Router,
          useValue: { navigate },
        },
        {
          provide: ToastService,
          useValue: {
            success: vi.fn(),
          },
        },
        {
          provide: LoggerService,
          useValue: {
            error: vi.fn(),
          },
        },
      ],
    });
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('clears the delayed login navigation when destroyed after a successful reset', async () => {
    const fixture = TestBed.createComponent(ResetPasswordComponent);
    const component = fixture.componentInstance;
    component.newPassword = 'new-password';
    component.confirmPassword = 'new-password';

    await component.handleSubmit({
      preventDefault: vi.fn(),
    } as unknown as Event);

    fixture.destroy();
    await vi.advanceTimersByTimeAsync(2000);

    expect(client.auth.updateUser).toHaveBeenCalledWith({
      password: 'new-password',
    });
    expect(client.auth.signOut).toHaveBeenCalledTimes(1);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('ignores duplicate submit attempts while a password reset is already in flight', async () => {
    const fixture = TestBed.createComponent(ResetPasswordComponent);
    const component = fixture.componentInstance;
    const updateUser = createDeferred<{ error: null }>();
    client.auth.updateUser.mockReturnValueOnce(updateUser.promise);
    component.newPassword = 'new-password';
    component.confirmPassword = 'new-password';

    const firstSubmit = component.handleSubmit({
      preventDefault: vi.fn(),
    } as unknown as Event);
    await Promise.resolve();

    const duplicateSubmit = component.handleSubmit({
      preventDefault: vi.fn(),
    } as unknown as Event);
    await Promise.resolve();

    expect(client.auth.updateUser).toHaveBeenCalledTimes(1);
    expect(client.auth.signOut).not.toHaveBeenCalled();

    updateUser.resolve({ error: null });
    await firstSubmit;
    await duplicateSubmit;

    expect(client.auth.signOut).toHaveBeenCalledTimes(1);
  });
});
