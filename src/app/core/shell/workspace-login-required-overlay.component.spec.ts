import { describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';

import { WorkspaceLoginRequiredOverlayComponent } from './workspace-login-required-overlay.component';
import {
  createWorkspaceShellViewTemplateSurfaceFake,
  setShellViewTemplateInput,
} from './workspace-shell-view-components.spec-helpers';

describe('WorkspaceLoginRequiredOverlayComponent', () => {
  function createFixture() {
    const { surface, raw } = createWorkspaceShellViewTemplateSurfaceFake();
    const fixture = TestBed.createComponent(WorkspaceLoginRequiredOverlayComponent);
    setShellViewTemplateInput(fixture.componentInstance, surface);
    fixture.detectChanges();
    return { fixture, raw };
  }

  it('showLoginRequired 为 true 时渲染登录提示', () => {
    const { fixture } = createFixture();

    expect((fixture.nativeElement as HTMLElement).textContent).toContain('请先登录');
  });

  it('showLoginRequired 为 false 时不渲染任何内容', () => {
    const { fixture, raw } = createFixture();
    raw.state.derivedUiState.showLoginRequired.set(false);
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).textContent?.trim()).toBe('');
  });

  it('登录按钮转发 openLoginModal', () => {
    const { fixture, raw } = createFixture();
    const buttons = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('button'),
    );
    const loginButton = buttons.find(button => button.textContent?.includes('登录账号'));

    loginButton?.click();

    expect(raw.interaction.actions.openLoginModal).toHaveBeenCalledTimes(1);
  });
});
