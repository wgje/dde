import { describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';

import { WorkspaceStartupHintOverlaysComponent } from './workspace-startup-hint-overlays.component';
import {
  createWorkspaceShellViewTemplateSurfaceFake,
  setShellViewTemplateInput,
} from './workspace-shell-view-components.spec-helpers';

describe('WorkspaceStartupHintOverlaysComponent', () => {
  function createFixture() {
    const { surface, raw } = createWorkspaceShellViewTemplateSurfaceFake();
    const fixture = TestBed.createComponent(WorkspaceStartupHintOverlaysComponent);
    setShellViewTemplateInput(fixture.componentInstance, surface);
    fixture.detectChanges();
    return { fixture, raw };
  }

  it('默认不渲染任何启动提示', () => {
    const { fixture } = createFixture();
    const host = fixture.nativeElement as HTMLElement;

    expect(host.querySelector('[data-testid="startup-hint-overlay"]')).toBeNull();
    expect(host.querySelector('[data-testid="startup-hint-banner"]')).toBeNull();
    expect(host.querySelector('[data-testid="android-widget-callback-overlay"]')).toBeNull();
  });

  it('阻塞式会话确认遮罩跟随信号显隐', () => {
    const { fixture, raw } = createFixture();
    raw.state.floatingNoticeChrome.blockingStartupHintOverlayVisible.set(true);
    fixture.detectChanges();

    expect(
      (fixture.nativeElement as HTMLElement).querySelector('[data-testid="startup-hint-overlay"]'),
    ).not.toBeNull();
  });

  it('Android 小组件回跳卡片按钮转发 lazy-load 控制器', () => {
    const { fixture, raw } = createFixture();
    raw.startup.pendingAndroidWidgetManualCallback.set(true);
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    const buttons = Array.from(host.querySelectorAll('button'));

    buttons.find(button => button.textContent?.includes('返回小组件'))?.click();
    buttons.find(button => button.textContent?.includes('兼容模式回跳'))?.click();
    buttons.find(button => button.textContent?.includes('暂时留在当前页面'))?.click();

    expect(raw.startup.androidWidgetLazyLoad.continueManualCallback).toHaveBeenCalledTimes(1);
    expect(raw.startup.androidWidgetLazyLoad.useIntentFallback).toHaveBeenCalledTimes(1);
    expect(raw.startup.androidWidgetLazyLoad.dismissManualCallback).toHaveBeenCalledTimes(1);
  });
});
