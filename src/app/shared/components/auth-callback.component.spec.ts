import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { AuthCallbackSessionService } from '../../../services/auth-callback-session.service';
import { AuthCallbackComponent } from './auth-callback.component';

describe('AuthCallbackComponent', () => {
  it('renders the truthful callback outcome and cancels stale work on destroy', async () => {
    const callback = {
      completeCapturedCallback: vi.fn().mockResolvedValue('conflict'),
      cancel: vi.fn(),
    };
    await TestBed.configureTestingModule({
      imports: [AuthCallbackComponent],
      providers: [{ provide: AuthCallbackSessionService, useValue: callback }],
    }).compileComponents();

    const fixture = TestBed.createComponent(AuthCallbackComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('当前登录会话已保留');
    fixture.destroy();
    expect(callback.cancel).toHaveBeenCalledTimes(1);
  });

  it('does not publish a late callback outcome after the component is destroyed', async () => {
    let resolve!: (value: 'authenticated') => void;
    const completion = new Promise<'authenticated'>(value => { resolve = value; });
    const callback = {
      completeCapturedCallback: vi.fn().mockReturnValue(completion),
      cancel: vi.fn(),
    };
    await TestBed.configureTestingModule({
      imports: [AuthCallbackComponent],
      providers: [{ provide: AuthCallbackSessionService, useValue: callback }],
    }).compileComponents();

    const fixture = TestBed.createComponent(AuthCallbackComponent);
    const component = fixture.componentInstance;
    fixture.detectChanges();
    fixture.destroy();
    resolve('authenticated');
    await completion;
    await Promise.resolve();

    expect(callback.cancel).toHaveBeenCalledTimes(1);
    expect(component.outcome()).toBe('loading');
  });
});
