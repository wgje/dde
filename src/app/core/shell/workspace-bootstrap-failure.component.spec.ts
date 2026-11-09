import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import { AppAuthCoordinatorService } from '../services/app-auth-coordinator.service';
import { WorkspaceBootstrapFailureComponent } from './workspace-bootstrap-failure.component';

describe('WorkspaceBootstrapFailureComponent', () => {
  let fixture: ComponentFixture<WorkspaceBootstrapFailureComponent>;
  let retryBootstrapCalls: number;
  let authCoord: Pick<
    AppAuthCoordinatorService,
    'bootstrapErrorMessage' | 'bootstrapFailed' | 'isCheckingSession' | 'retryBootstrap'
  >;

  beforeEach(async () => {
    retryBootstrapCalls = 0;
    authCoord = {
      bootstrapErrorMessage: signal('session timeout'),
      bootstrapFailed: signal(true),
      isCheckingSession: signal(false),
      retryBootstrap: () => {
        retryBootstrapCalls += 1;
      },
    };

    await TestBed.configureTestingModule({
      imports: [WorkspaceBootstrapFailureComponent],
      providers: [
        { provide: AppAuthCoordinatorService, useValue: authCoord },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(WorkspaceBootstrapFailureComponent);
    fixture.detectChanges();
  });

  it('renders the bootstrap failure message and retries through auth coordinator', () => {
    const root = fixture.nativeElement as HTMLElement;
    const retry = root.querySelector<HTMLButtonElement>('[data-testid="workspace-bootstrap-retry"]');

    expect(root.textContent).toContain('启动失败');
    expect(root.textContent).toContain('session timeout');

    retry?.click();

    expect(retryBootstrapCalls).toBe(1);
  });

  it('clears bootstrapFailed when the user continues in offline mode', () => {
    const root = fixture.nativeElement as HTMLElement;
    const offline = root.querySelector<HTMLButtonElement>('[data-testid="workspace-bootstrap-offline"]');

    offline?.click();

    expect(authCoord.bootstrapFailed()).toBe(false);
  });
});
