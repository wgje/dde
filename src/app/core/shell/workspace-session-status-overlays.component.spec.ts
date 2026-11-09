import { describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';

import { WorkspaceSessionStatusOverlaysComponent } from './workspace-session-status-overlays.component';
import {
  createWorkspaceShellViewTemplateSurfaceFake,
  setShellViewTemplateInput,
} from './workspace-shell-view-components.spec-helpers';

describe('WorkspaceSessionStatusOverlaysComponent', () => {
  function createFixture() {
    const { surface, raw } = createWorkspaceShellViewTemplateSurfaceFake();
    const fixture = TestBed.createComponent(WorkspaceSessionStatusOverlaysComponent);
    setShellViewTemplateInput(fixture.componentInstance, surface);
    fixture.detectChanges();
    return { fixture, raw };
  }

  it('默认（无检测/无失败）不渲染覆盖层', () => {
    const { fixture } = createFixture();

    expect((fixture.nativeElement as HTMLElement).textContent?.trim()).toBe('');
  });

  it('会话检测中显示右上角胶囊', () => {
    const { fixture, raw } = createFixture();
    raw.state.authCoord.isCheckingSession.set(true);
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).textContent).toContain('会话检测中');
  });

  it('bootstrap 失败且检测结束时进入失败覆盖层分支（defer 占位可见）', () => {
    const { fixture, raw } = createFixture();
    raw.state.authCoord.bootstrapFailed.set(true);
    raw.state.authCoord.isCheckingSession.set(false);
    fixture.detectChanges();

    // 测试环境下 @defer 停留在 placeholder：验证失败分支已激活（渲染了全屏占位背景）
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('div.fixed.inset-0')).not.toBeNull();
  });
});
