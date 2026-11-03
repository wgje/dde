import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthPasswordRecoveryService } from '../../../services/auth-password-recovery.service';
import { LoggerService } from '../../../services/logger.service';
import { ToastService } from '../../../services/toast.service';
import { ResetPasswordComponent } from './reset-password.component';

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

describe('ResetPasswordComponent', () => {
  let completePasswordReset: ReturnType<typeof vi.fn>;
  let dispose: ReturnType<typeof vi.fn>;
  let logError: ReturnType<typeof vi.fn>;
  let navigate: ReturnType<typeof vi.fn>;
  let prepareFromCurrentUrl: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    completePasswordReset = vi.fn().mockResolvedValue({ cleanupPending: false });
    dispose = vi.fn().mockResolvedValue(undefined);
    logError = vi.fn();
    navigate = vi.fn().mockResolvedValue(true);
    prepareFromCurrentUrl = vi.fn().mockResolvedValue(true);

    TestBed.configureTestingModule({
      imports: [ResetPasswordComponent],
      providers: [
        {
          provide: AuthPasswordRecoveryService,
          useValue: {
            completePasswordReset,
            dispose,
            prepareFromCurrentUrl,
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
            error: logError,
          },
        },
      ],
    });
  });

  it('prepares only the isolated recovery attempt on initialization', async () => {
    const fixture = TestBed.createComponent(ResetPasswordComponent);

    fixture.detectChanges();
    await fixture.whenStable();

    expect(prepareFromCurrentUrl).toHaveBeenCalledTimes(1);
    expect(fixture.componentInstance.isValid()).toBe(true);
  });

  it('renders the recovery preparation error on the invalid-link screen', async () => {
    const preparationError = new Error('AUTH_RECOVERY_LOCK_UNAVAILABLE');
    prepareFromCurrentUrl.mockRejectedValueOnce(preparationError);
    const fixture = TestBed.createComponent(ResetPasswordComponent);

    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.componentInstance.isValid()).toBe(false);
    expect(fixture.nativeElement.textContent).toContain(preparationError.message);
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    vi.restoreAllMocks();
    vi.useRealTimers();
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

    expect(completePasswordReset).toHaveBeenCalledWith('new-password');
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('ignores duplicate submit attempts while a password reset is already in flight', async () => {
    const fixture = TestBed.createComponent(ResetPasswordComponent);
    const component = fixture.componentInstance;
    const updateUser = createDeferred<{ cleanupPending: false }>();
    completePasswordReset.mockReturnValueOnce(updateUser.promise);
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

    expect(completePasswordReset).toHaveBeenCalledTimes(1);

    updateUser.resolve({ cleanupPending: false });
    await firstSubmit;
    await duplicateSubmit;

    expect(completePasswordReset).toHaveBeenCalledTimes(1);
  });

  it('renders an indeterminate update outcome without claiming success or definitive failure', async () => {
    completePasswordReset.mockRejectedValue(new Error('AUTH_RECOVERY_UPDATE_OUTCOME_UNKNOWN'));
    const fixture = TestBed.createComponent(ResetPasswordComponent);
    const component = fixture.componentInstance;
    component.newPassword = 'new-password';
    component.confirmPassword = 'new-password';

    await component.handleSubmit({ preventDefault: vi.fn() } as unknown as Event);

    expect(component.isSuccess()).toBe(false);
    expect(component.error()).toContain('结果尚未确认');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('handles and logs recovery cleanup failures after destruction', async () => {
    const cleanupError = new Error('cleanup failed');
    dispose.mockRejectedValueOnce(cleanupError);
    const fixture = TestBed.createComponent(ResetPasswordComponent);

    fixture.destroy();
    await Promise.resolve();

    expect(logError).toHaveBeenCalledWith(
      'ResetPassword',
      'Recovery session cleanup failed',
      cleanupError,
    );
  });
});
