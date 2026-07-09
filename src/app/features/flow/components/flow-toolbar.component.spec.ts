import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProjectStateService } from '../../../../services/project-state.service';
import { ToastService } from '../../../../services/toast.service';
import { UiStateService } from '../../../../services/ui-state.service';
import { UserSessionService } from '../../../../services/user-session.service';
import { FlowToolbarComponent } from './flow-toolbar.component';

describe('FlowToolbarComponent', () => {
  const mockUiState = {
    isMobile: vi.fn(() => false),
    isFlowDetailOpen: vi.fn(() => false),
  };

  const mockToast = {
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();

    TestBed.configureTestingModule({
      imports: [FlowToolbarComponent],
      providers: [
        { provide: UiStateService, useValue: mockUiState },
        { provide: ProjectStateService, useValue: {} },
        { provide: UserSessionService, useValue: {} },
        { provide: ToastService, useValue: mockToast },
      ],
    });
  });

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  function createComponent(): FlowToolbarComponent {
    const fixture = TestBed.createComponent(FlowToolbarComponent);
    fixture.detectChanges();
    return fixture.componentInstance;
  }

  it('setUploadComplete 应复位上传状态', () => {
    const component = createComponent();
    component.isUploading = true;

    component.setUploadComplete();

    expect(component.isUploading).toBe(false);
  });

  it('setUploadComplete 应清理 handle 为 0 的超时定时器，避免旧定时器强制复位后续上传', () => {
    const component = createComponent();
    const zeroTimer = 0 as unknown as ReturnType<typeof setTimeout>;
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => undefined);
    (component as unknown as { uploadTimeoutId: ReturnType<typeof setTimeout> | null }).uploadTimeoutId = zeroTimer;
    component.isUploading = true;

    try {
      component.setUploadComplete();

      expect(clearTimeoutSpy).toHaveBeenCalledWith(zeroTimer);
      expect(
        (component as unknown as { uploadTimeoutId: ReturnType<typeof setTimeout> | null }).uploadTimeoutId
      ).toBeNull();
    } finally {
      clearTimeoutSpy.mockRestore();
    }
  });
});
