import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Component, ElementRef, type Type, ViewChild } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { WorkspaceSidebarPanelComponent } from './workspace-sidebar-panel.component';
import {
  createWorkspaceShellViewTemplateSurfaceFake,
  setShellViewTemplateInput,
} from './workspace-shell-view-components.spec-helpers';

@Component({
  standalone: true,
  template: '<button #primary data-testid="focus-primary">Primary</button>',
})
class FocusPrimaryFixture {
  static focusCalls = 0;
  @ViewChild('primary', { static: true })
  private primary!: ElementRef<HTMLButtonElement>;

  focusPrimaryAction(): boolean {
    FocusPrimaryFixture.focusCalls += 1;
    this.primary.nativeElement.focus();
    return document.activeElement === this.primary.nativeElement;
  }
}

@Component({
  standalone: true,
  template: '<button data-testid="focus-primary">No focus API</button>',
})
class MissingFocusApiFixture {}

@Component({
  standalone: true,
  template: '<button data-testid="focus-primary">False focus API</button>',
})
class FalseFocusApiFixture {
  focusPrimaryAction(): boolean {
    return false;
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

describe('WorkspaceSidebarPanelComponent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    FocusPrimaryFixture.focusCalls = 0;
  });

  function createFixture() {
    const { surface, raw, panelToolsIntent } = createWorkspaceShellViewTemplateSurfaceFake();
    const fixture = TestBed.createComponent(WorkspaceSidebarPanelComponent);
    setShellViewTemplateInput(fixture.componentInstance, surface);
    fixture.detectChanges();
    return { fixture, panelToolsIntent, raw };
  }

  async function settle(fixture: ReturnType<typeof createFixture>['fixture']) {
    for (let index = 0; index < 4; index += 1) {
      await Promise.resolve();
    }
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  function focusFallback(fixture: ReturnType<typeof createFixture>['fixture']) {
    const fallback = fixture.nativeElement.querySelector(
      '[data-testid="focus-tool-fallback"]',
    ) as HTMLButtonElement;
    fallback.focus();
    return fallback;
  }

  function focusRecorderFallback(fixture: ReturnType<typeof createFixture>['fixture']) {
    const fallback = fixture.nativeElement.querySelector(
      '[data-testid="recorder-tool-fallback"]',
    ) as HTMLButtonElement;
    fallback.focus();
    return fallback;
  }

  it('渲染项目列表与侧栏骨架', () => {
    const { fixture } = createFixture();
    const host = fixture.nativeElement as HTMLElement;

    expect(host.querySelector('[data-testid="project-selector"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="project-item"]')).not.toBeNull();
    expect(host.textContent).toContain('示例项目');
  });

  it('新建项目按钮转发到 interaction.actions.createNewProject', () => {
    const { fixture, raw } = createFixture();
    const host = fixture.nativeElement as HTMLElement;

    (host.querySelector('[data-testid="create-project-btn"]') as HTMLButtonElement).click();

    expect(raw.interaction.actions.createNewProject).toHaveBeenCalledTimes(1);
  });

  it('点击项目转发 selectProject 并携带项目 id', () => {
    const { fixture, raw } = createFixture();
    const host = fixture.nativeElement as HTMLElement;

    (host.querySelector('[data-testid="project-item"]') as HTMLElement).click();

    expect(raw.interaction.actions.selectProject).toHaveBeenCalledWith('p-1');
  });

  it('会话过期时展示重新登录入口', () => {
    const { fixture, raw } = createFixture();
    raw.state.sessionExpired.set(true);
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;

    expect(host.textContent).toContain('登录已过期');
  });

  it('移动端背景遮罩点击后收起侧栏', () => {
    const { fixture, raw } = createFixture();
    raw.state.focusChrome.mobileSidebarBackdropVisible.set(true);
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;

    (host.querySelector('[data-testid="project-selector-backdrop"]') as HTMLElement).click();

    expect(raw.state.isSidebarOpen()).toBe(false);
  });

  it('keeps the focused fallback mounted and truthful through loading and failure', async () => {
    const load = deferred<Type<unknown> | null>();
    const { fixture, raw } = createFixture();
    raw.tools.sidebar.loadFocusSessionTriggerComponent.mockReturnValue(load.promise);
    const fallback = focusFallback(fixture);

    fallback.click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="focus-tool-fallback"]'))
      .toBe(fallback);
    expect(fallback.getAttribute('aria-busy')).toBe('true');
    expect(fallback.getAttribute('aria-disabled')).toBe('true');
    expect(fallback.disabled).toBe(false);
    expect(fixture.nativeElement.textContent).toContain('正在加载专注模式工具');

    load.reject(new Error('chunk failed'));
    await settle(fixture);

    const retry = fixture.nativeElement.querySelector(
      '[data-testid="focus-tool-fallback"]',
    ) as HTMLButtonElement;
    expect(retry).not.toBeNull();
    expect(retry.textContent).toContain('重试');
    expect(fixture.nativeElement.querySelector('[data-testid="focus-tool-status"]'))
      .toHaveProperty('textContent', '专注模式工具加载失败');
  });

 it('preloads on hover without acquiring focus', async () => {
    const load = deferred<Type<unknown> | null>();
    const { fixture, raw } = createFixture();
    raw.tools.sidebar.loadFocusSessionTriggerComponent.mockReturnValue(load.promise);
    const tools = fixture.nativeElement.querySelector('[data-testid="focus-tools"]');

    tools.dispatchEvent(new Event('pointerenter'));
    raw.tools.bindings.focusSessionTriggerComponent.set(FocusPrimaryFixture);
    load.resolve(FocusPrimaryFixture);
    await settle(fixture);

    expect(raw.tools.sidebar.onToolsIntent).toHaveBeenCalledOnce();
    expect(fixture.nativeElement.querySelector('[data-testid="focus-primary"]'))
      .not.toBe(document.activeElement);
   expect(FocusPrimaryFixture.focusCalls).toBe(0);
 });


  it('hands an enabled recorder fallback to its primary action only after render', async () => {
    const load = deferred<Type<unknown> | null>();
    const { fixture, raw } = createFixture();
    raw.state.focusPrefs.isBlackBoxEnabled.set(true);
    fixture.detectChanges();
    raw.tools.sidebar.loadBlackBoxRecorderComponent.mockReturnValue(load.promise);
    const fallback = focusRecorderFallback(fixture);
    fallback.click();
    raw.tools.bindings.blackBoxRecorderComponent.set(FocusPrimaryFixture);
    load.resolve(FocusPrimaryFixture);
    await load.promise;
    await Promise.resolve();
    Object.defineProperty(fallback, 'isConnected', { configurable: true, value: false });
    const blur = new FocusEvent('blur', { relatedTarget: document.body });
    Object.defineProperty(blur, 'currentTarget', { value: fallback });
    fixture.componentInstance.setFallbackBlurred(
      fixture.componentInstance.recorderTool,
      blur,
      fallback,
    );

    expect(FocusPrimaryFixture.focusCalls).toBe(0);
    await settle(fixture);

    const primary = fixture.nativeElement.querySelector(
      '[data-testid="focus-primary"]',
    );
    expect(FocusPrimaryFixture.focusCalls).toBe(1);
    expect(document.activeElement).toBe(primary);
  });

  it('does not steal focus after the user leaves before settlement', async () => {
    const load = deferred<Type<unknown> | null>();
    const { fixture, raw } = createFixture();
    raw.tools.sidebar.loadFocusSessionTriggerComponent.mockReturnValue(load.promise);
    focusFallback(fixture).click();
    const outside = document.createElement('button');
    document.body.append(outside);
    outside.focus();

    raw.tools.bindings.focusSessionTriggerComponent.set(FocusPrimaryFixture);
    load.resolve(FocusPrimaryFixture);
    await settle(fixture);

    expect(document.activeElement).toBe(outside);
    expect(FocusPrimaryFixture.focusCalls).toBe(0);
    outside.remove();
  });

  it('does not steal focus after the user leaves between settlement and render', async () => {
    const load = deferred<Type<unknown> | null>();
    const { fixture, raw } = createFixture();
    raw.tools.sidebar.loadFocusSessionTriggerComponent.mockReturnValue(load.promise);
    focusFallback(fixture).click();
    raw.tools.bindings.focusSessionTriggerComponent.set(FocusPrimaryFixture);
    load.resolve(FocusPrimaryFixture);
    await Promise.resolve();
    const outside = document.createElement('button');
    document.body.append(outside);
    outside.focus();

    await settle(fixture);

    expect(document.activeElement).toBe(outside);
    expect(FocusPrimaryFixture.focusCalls).toBe(0);
    outside.remove();
  });

  it('retires a null-destination blur while the fallback remains connected', async () => {
    const load = deferred<Type<unknown> | null>();
    const { fixture, raw } = createFixture();
    raw.tools.sidebar.loadFocusSessionTriggerComponent.mockReturnValue(load.promise);
    const fallback = focusFallback(fixture);
    let relatedTarget: EventTarget | null | undefined;
    fallback.addEventListener('blur', event => relatedTarget = event.relatedTarget);
    raw.tools.bindings.focusSessionTriggerComponent.set(FocusPrimaryFixture);
    load.resolve(FocusPrimaryFixture);
    await Promise.resolve();

    expect(fallback.isConnected).toBe(true);
    fallback.blur();
    expect(relatedTarget).toBeNull();
    await settle(fixture);

    expect(FocusPrimaryFixture.focusCalls).toBe(0);
  });


  it('registers and unregisters the panel tools intent holder before teardown', () => {
    const { fixture, panelToolsIntent } = createFixture();
    const registerSpy = panelToolsIntent.register as ReturnType<typeof vi.fn>;
    expect(registerSpy).toHaveBeenCalledTimes(1);
    const subscription = registerSpy.mock.results[0].value;

    fixture.destroy();

    expect(subscription.unregister).toHaveBeenCalledTimes(1);
  });

  it('transfers a focused failed retry to its new attempt', async () => {
    const { fixture, raw } = createFixture();
    raw.tools.sidebar.loadFocusSessionTriggerComponent.mockResolvedValueOnce(null);
    focusFallback(fixture).click();
    await settle(fixture);
    const retryLoad = deferred<Type<unknown> | null>();
    raw.tools.sidebar.loadFocusSessionTriggerComponent.mockReturnValueOnce(
      retryLoad.promise,
    );
    focusFallback(fixture).click();

    raw.tools.bindings.focusSessionTriggerComponent.set(FocusPrimaryFixture);
    retryLoad.resolve(FocusPrimaryFixture);
    await settle(fixture);

    expect(document.activeElement).toBe(
      fixture.nativeElement.querySelector('[data-testid="focus-primary"]'),
    );
  });

  it.each([
    ['missing', MissingFocusApiFixture],
    ['false', FalseFocusApiFixture],
  ])('uses the permanent slot when the focus API is %s', async (_name, component) => {
    const { fixture, raw } = createFixture();
    raw.tools.sidebar.loadFocusSessionTriggerComponent.mockImplementation(async () => {
      raw.tools.bindings.focusSessionTriggerComponent.set(component as Type<unknown>);
      return component;
    });
    focusFallback(fixture).click();

    await settle(fixture);

    expect(document.activeElement).toBe(
      fixture.nativeElement.querySelector('[data-testid="focus-tool-slot"]'),
    );
  });

  it('never loads the recorder while the preference is disabled', async () => {
    const { fixture, raw } = createFixture();

    fixture.nativeElement.querySelector('[data-testid="focus-tools"]')
      .dispatchEvent(new Event('pointerenter'));
    await settle(fixture);

    expect(raw.tools.sidebar.loadBlackBoxRecorderComponent).not.toHaveBeenCalled();
    expect(fixture.nativeElement.querySelector('[data-testid="recorder-tool-slot"]'))
      .toBeNull();
  });

  it('retires recorder focus when the preference disables during loading', async () => {
    const load = deferred<Type<unknown> | null>();
    const { fixture, raw } = createFixture();
    raw.state.focusPrefs.isBlackBoxEnabled.set(true);
    fixture.detectChanges();
    raw.tools.sidebar.loadBlackBoxRecorderComponent.mockReturnValue(load.promise);
    focusRecorderFallback(fixture).click();

    raw.state.focusPrefs.isBlackBoxEnabled.set(false);
    fixture.detectChanges();
    raw.tools.bindings.blackBoxRecorderComponent.set(FocusPrimaryFixture);
    load.resolve(FocusPrimaryFixture);
    await settle(fixture);
    raw.state.focusPrefs.isBlackBoxEnabled.set(true);
    await settle(fixture);

    expect(FocusPrimaryFixture.focusCalls).toBe(0);
  });

  it('retires recorder focus when disabled after readiness but before render', async () => {
    const load = deferred<Type<unknown> | null>();
    const { fixture, raw } = createFixture();
    raw.state.focusPrefs.isBlackBoxEnabled.set(true);
    fixture.detectChanges();
    raw.tools.sidebar.loadBlackBoxRecorderComponent.mockReturnValue(load.promise);
    const fallback = focusRecorderFallback(fixture);
    fallback.click();
    raw.tools.bindings.blackBoxRecorderComponent.set(FocusPrimaryFixture);
    load.resolve(FocusPrimaryFixture);
    await load.promise;
    await Promise.resolve();

    expect(fixture.componentInstance.recorderToolState().phase).toBe('ready');
    expect(FocusPrimaryFixture.focusCalls).toBe(0);
    raw.state.focusPrefs.isBlackBoxEnabled.set(false);
    Object.defineProperty(fallback, 'isConnected', { configurable: true, value: false });
    const blur = new FocusEvent('blur', { relatedTarget: document.body });
    Object.defineProperty(blur, 'currentTarget', { value: fallback });
    fixture.componentInstance.setFallbackBlurred(
      fixture.componentInstance.recorderTool,
      blur,
      fallback,
    );
    raw.state.focusPrefs.isBlackBoxEnabled.set(true);
    await settle(fixture);

    expect(FocusPrimaryFixture.focusCalls).toBe(0);
  });
});
