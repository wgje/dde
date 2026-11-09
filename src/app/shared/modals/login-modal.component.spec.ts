/**
 * LoginModalComponent 单元测试
 * 覆盖加载中重复提交守卫：按钮 disabled 挡不住回车提交表单，入口必须 early-return
 *
 * 说明：组件使用 signal `input()`；handler 用注入上下文做类级测试，模板禁用态用 TestBed 渲染。
 */

import { ApplicationRef, ElementRef, Injector, runInInjectionContext } from '@angular/core';
import { ConfigurableFocusTrapFactory } from '@angular/cdk/a11y';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DynamicModalService } from '../../../services/dynamic-modal.service';
import { LoginModalComponent } from './login-modal.component';

type LoginFocusTrap = {
  enabled: boolean;
  destroy: ReturnType<typeof vi.fn>;
  focusInitialElement: ReturnType<typeof vi.fn>;
};

describe('LoginModalComponent', () => {
  let component: LoginModalComponent;

  function setLoading(isLoading: boolean): void {
    Object.assign(component, { isLoading: () => isLoading });
  }

  function render(setup?: (instance: LoginModalComponent) => void): ComponentFixture<LoginModalComponent> {
    TestBed.configureTestingModule({ imports: [LoginModalComponent] });
    const fixture = TestBed.createComponent(LoginModalComponent);
    setup?.(fixture.componentInstance);
    fixture.detectChanges();
    return fixture;
  }

  function flushRender(fixture: ComponentFixture<LoginModalComponent>): void {
    fixture.detectChanges();
    TestBed.inject(ApplicationRef).tick();
  }

  function createModalService(traps: LoginFocusTrap[]): DynamicModalService {
    TestBed.configureTestingModule({
      imports: [LoginModalComponent],
      providers: [
        DynamicModalService,
        { provide: ConfigurableFocusTrapFactory, useValue: { create: () => {
          const trap = { enabled: true, destroy: vi.fn(), focusInitialElement: vi.fn(() => true) };
          traps.push(trap);
          return trap;
        } } },
      ],
    });
    return TestBed.inject(DynamicModalService);
  }

  beforeEach(() => {
    const injector = Injector.create({
      providers: [{ provide: ElementRef, useValue: new ElementRef(document.createElement('div')) }],
    });
    component = runInInjectionContext(injector, () => new LoginModalComponent());
    component.email.set('user@example.com');
    component.password.set('password123');
    component.confirmPassword.set('password123');
  });

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  describe('handleLogin 加载守卫', () => {
    it('未加载时提交应发出 login 事件并阻止默认表单行为', () => {
      const loginSpy = vi.fn();
      component.login.subscribe(loginSpy);
      const event = new Event('submit', { cancelable: true });

      component.handleLogin(event);

      expect(event.defaultPrevented).toBe(true);
      expect(loginSpy).toHaveBeenCalledTimes(1);
      expect(loginSpy).toHaveBeenCalledWith({
        email: 'user@example.com',
        password: 'password123',
      });
    });

    it('isLoading 时提交不应发出 login 事件', () => {
      const loginSpy = vi.fn();
      component.login.subscribe(loginSpy);
      setLoading(true);

      component.handleLogin(new Event('submit', { cancelable: true }));

      expect(loginSpy).not.toHaveBeenCalled();
    });
  });

  describe('handleSignup 加载守卫', () => {
    it('未加载时提交应发出 signup 事件', () => {
      const signupSpy = vi.fn();
      component.signup.subscribe(signupSpy);

      component.handleSignup(new Event('submit', { cancelable: true }));

      expect(signupSpy).toHaveBeenCalledTimes(1);
      expect(signupSpy).toHaveBeenCalledWith({
        email: 'user@example.com',
        password: 'password123',
        confirmPassword: 'password123',
      });
    });

    it('isLoading 时提交不应发出 signup 事件', () => {
      const signupSpy = vi.fn();
      component.signup.subscribe(signupSpy);
      setLoading(true);

      component.handleSignup(new Event('submit', { cancelable: true }));

      expect(signupSpy).not.toHaveBeenCalled();
    });
  });

  describe('加载结束后守卫释放', () => {
    it('isLoading 复位后提交应重新发出 login 事件', () => {
      const loginSpy = vi.fn();
      component.login.subscribe(loginSpy);

      setLoading(true);
      component.handleLogin(new Event('submit', { cancelable: true }));
      expect(loginSpy).not.toHaveBeenCalled();

      setLoading(false);
      component.handleLogin(new Event('submit', { cancelable: true }));
      expect(loginSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('其他认证动作加载守卫', () => {
    it('isLoading 时重置密码提交不应发出 resetPassword 事件', () => {
      const resetPasswordSpy = vi.fn();
      component.resetPassword.subscribe(resetPasswordSpy);
      setLoading(true);
      const event = new Event('submit', { cancelable: true });

      component.handleResetPassword(event);

      expect(event.defaultPrevented).toBe(true);
      expect(resetPasswordSpy).not.toHaveBeenCalled();
    });

    it('isLoading 时点击本地模式不应发出 localMode 事件', () => {
      const localModeSpy = vi.fn();
      component.localMode.subscribe(localModeSpy);
      setLoading(true);

      component.handleLocalMode();

      expect(localModeSpy).not.toHaveBeenCalled();
    });

    it('isLoading 时禁用登录提交和本地模式按钮', () => {
      TestBed.configureTestingModule({
        imports: [LoginModalComponent],
      });
      const fixture = TestBed.createComponent(LoginModalComponent);
      Object.assign(fixture.componentInstance, { isLoading: () => true });
      fixture.detectChanges();

      const submitButton = fixture.nativeElement.querySelector(
        '[data-testid="submit-login"]',
      ) as HTMLButtonElement;
      const localModeButton = fixture.nativeElement.querySelector(
        '[data-testid="local-mode-btn"]',
      ) as HTMLButtonElement;

      expect(submitButton.disabled).toBe(true);
      expect(localModeButton.disabled).toBe(true);

      fixture.destroy();
    });
  });

  describe('dialog semantics and focus lifecycle', () => {
    it('exposes only the top nested Login dialog and restores the lower shell', () => {
      const traps: LoginFocusTrap[] = [];
      const service = createModalService(traps);
      const lower = service.open(LoginModalComponent);
      const upper = service.open(LoginModalComponent);
      lower.componentRef.changeDetectorRef.detectChanges();
      upper.componentRef.changeDetectorRef.detectChanges();
      const containers = Array.from(document.querySelectorAll<HTMLElement>('.dynamic-modal-container'));
      const dialogs = containers.map(container => container.querySelector<HTMLElement>('[role="dialog"]'));

      expect(containers[0].inert).toBe(true);
      expect(containers[0].getAttribute('aria-hidden')).toBe('true');
      expect(dialogs[0]?.closest('[aria-hidden="true"]')).toBe(containers[0]);
      expect(traps[0].enabled).toBe(false);
      expect(containers[1].inert).toBe(false);
      expect(containers[1].hasAttribute('aria-hidden')).toBe(false);
      expect(containers.filter(container => !container.inert).map(container =>
        container.querySelector('[role="dialog"]'))).toEqual([dialogs[1]]);
      upper.close();
      expect(containers[0].inert).toBe(false);
      expect(containers[0].hasAttribute('aria-hidden')).toBe(false);
      expect(dialogs[0]?.closest('[aria-hidden="true"]')).toBeNull();
      expect(traps[0].enabled).toBe(true);
      lower.close();
    });

    it('restores external focus when lower Login cleanup closes the top modal', async () => {
      const traps: LoginFocusTrap[] = [];
      const service = createModalService(traps);
      const externalOpener = document.body.appendChild(document.createElement('button'));
      externalOpener.focus();
      const externalFocus = vi.spyOn(externalOpener, 'focus');
      const lower = service.open<LoginModalComponent, unknown, string>(LoginModalComponent);
      lower.componentRef.changeDetectorRef.detectChanges();
      const nestedOpener = lower.componentRef.location.nativeElement.querySelector('button') as HTMLButtonElement;
      nestedOpener.focus();
      const nestedFocus = vi.spyOn(nestedOpener, 'focus');
      const upper = service.open<LoginModalComponent, unknown, string>(LoginModalComponent);
      const destroyLower = lower.componentRef.destroy.bind(lower.componentRef);
      vi.spyOn(lower.componentRef, 'destroy').mockImplementation(() => {
        upper.close('upper-close');
        destroyLower();
      });

      lower.close('lower-close');
      await expect(lower.result).resolves.toBe('lower-close');
      await expect(upper.result).resolves.toBe('upper-close');
      expect(traps.every(trap => trap.destroy.mock.calls.length === 1)).toBe(true);
      expect(nestedFocus).not.toHaveBeenCalled();
      expect(externalFocus).toHaveBeenCalledOnce();
      expect(document.activeElement).toBe(externalOpener);
      externalOpener.remove();
    });

    it('gives simultaneous dialogs stable unique labels with no spurious live regions', () => {
      const fixtures = [render(), TestBed.createComponent(LoginModalComponent)];
      fixtures[1].detectChanges();
      const dialogs = fixtures.map(fixture => fixture.nativeElement.querySelector('[role="dialog"]') as HTMLElement);
      const titleIds = dialogs.map(dialog => dialog.getAttribute('aria-labelledby'));

      expect(dialogs.every(dialog => dialog.getAttribute('aria-modal') === 'true')).toBe(true);
      expect(new Set(titleIds).size).toBe(2);
      fixtures.forEach((fixture, index) => {
        expect(fixture.nativeElement.querySelector(`#${titleIds[index]}`)?.textContent.trim()).toBe('登录');
        expect(fixture.nativeElement.querySelectorAll('[role="alert"], [role="status"]')).toHaveLength(0);
      });
      fixtures[0].detectChanges();
      expect(dialogs[0].getAttribute('aria-labelledby')).toBe(titleIds[0]);
    });

    it('moves focus to the current mode field after each rendered mode switch', () => {
      const fixture = render();
      const instance = fixture.componentInstance;

      instance.switchToSignup();
      flushRender(fixture);
      expect((document.activeElement as HTMLElement).id).toBe('signup-email');

      instance.switchToResetPassword();
      flushRender(fixture);
      expect((document.activeElement as HTMLElement).id).toBe('reset-email');

      instance.switchToLogin();
      flushRender(fixture);
      expect((document.activeElement as HTMLElement).id).toBe('login-email');
    });

    it('suppresses stale mode-focus callbacks after a newer switch or destroy', () => {
      const fixture = render();
      const instance = fixture.componentInstance;
      instance.switchToSignup();
      instance.switchToResetPassword();
      flushRender(fixture);
      expect((document.activeElement as HTMLElement).id).toBe('reset-email');

      const focus = vi.spyOn(HTMLElement.prototype, 'focus');
      instance.switchToSignup();
      fixture.destroy();
      TestBed.inject(ApplicationRef).tick();
      expect(focus).not.toHaveBeenCalled();
    });

    it('uses alert only for errors and status only for reset-mail confirmation', () => {
      const fixture = render(instance => Object.assign(instance, { authError: () => '登录失败' }));
      expect(fixture.nativeElement.querySelector('[role="alert"]')?.textContent).toContain('登录失败');
      fixture.destroy();

      const resetFixture = TestBed.createComponent(LoginModalComponent);
      Object.assign(resetFixture.componentInstance, { resetPasswordSentInput: () => true });
      resetFixture.componentInstance.isResetPasswordMode.set(true);
      resetFixture.detectChanges();
      expect(resetFixture.nativeElement.querySelector('[role="alert"]')).toBeNull();
      expect(resetFixture.nativeElement.querySelector('[role="status"]')?.textContent).toContain('重置邮件已发送');
    });
  });
});
