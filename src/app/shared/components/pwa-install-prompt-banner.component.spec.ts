import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Component, signal } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FEATURE_FLAGS } from '../../../config/feature-flags.config';
import { PwaInstallPromptService } from '../../../services/pwa-install-prompt.service';
import { ToastService } from '../../../services/toast.service';
import { PwaInstallPromptBannerComponent } from './pwa-install-prompt-banner.component';

type WindowWithIdleCallback = Window & {
  requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number;
  cancelIdleCallback?: (handle: number) => void;
};

@Component({
  standalone: true,
  imports: [PwaInstallPromptBannerComponent],
  template: `<app-pwa-install-prompt-banner top="12px" (visibleChange)="onVisibleChange($event)" />`,
})
class PwaInstallPromptBannerHostComponent {
  readonly visibleChanges: boolean[] = [];

  onVisibleChange(visible: boolean): void {
    this.visibleChanges.push(visible);
  }
}

describe('PwaInstallPromptBannerComponent', () => {
  let fixture: ComponentFixture<PwaInstallPromptBannerHostComponent>;
  let pwaInstall: {
    canShowInstallPrompt: ReturnType<typeof signal<boolean>>;
    installHint: ReturnType<typeof signal<string>>;
    canInstall: ReturnType<typeof signal<boolean>>;
    initialize: ReturnType<typeof vi.fn>;
    promptInstall: ReturnType<typeof vi.fn>;
    dismissPrompt: ReturnType<typeof vi.fn>;
  };
  let originalDeferFlag: boolean;
  let originalRequestIdleCallback: WindowWithIdleCallback['requestIdleCallback'];
  let originalCancelIdleCallback: WindowWithIdleCallback['cancelIdleCallback'];

  beforeEach(() => {
    originalDeferFlag = FEATURE_FLAGS.PWA_PROMPT_DEFER_V2;
    originalRequestIdleCallback = (window as WindowWithIdleCallback).requestIdleCallback;
    originalCancelIdleCallback = (window as WindowWithIdleCallback).cancelIdleCallback;

    pwaInstall = {
      canShowInstallPrompt: signal(false),
      installHint: signal('install hint'),
      canInstall: signal(false),
      initialize: vi.fn(),
      promptInstall: vi.fn().mockResolvedValue(false),
      dismissPrompt: vi.fn(),
    };

    (FEATURE_FLAGS as unknown as Record<string, boolean>).PWA_PROMPT_DEFER_V2 = true;

    TestBed.configureTestingModule({
      imports: [PwaInstallPromptBannerHostComponent],
      providers: [
        { provide: PwaInstallPromptService, useValue: pwaInstall },
        {
          provide: ToastService,
          useValue: {
            info: vi.fn(),
            success: vi.fn(),
          },
        },
      ],
    });
  });

  afterEach(() => {
    fixture?.destroy();
    (FEATURE_FLAGS as unknown as Record<string, boolean>).PWA_PROMPT_DEFER_V2 = originalDeferFlag;
    if (originalRequestIdleCallback) {
      (window as WindowWithIdleCallback).requestIdleCallback = originalRequestIdleCallback;
    } else {
      Reflect.deleteProperty(window, 'requestIdleCallback');
    }
    if (originalCancelIdleCallback) {
      (window as WindowWithIdleCallback).cancelIdleCallback = originalCancelIdleCallback;
    } else {
      Reflect.deleteProperty(window, 'cancelIdleCallback');
    }
    TestBed.resetTestingModule();
  });

  function createComponent(): void {
    fixture = TestBed.createComponent(PwaInstallPromptBannerHostComponent);
    fixture.detectChanges();
  }

  it('destroy 后 late requestIdleCallback 不应初始化 PWA 安装服务', () => {
    let idleCallback: IdleRequestCallback | undefined;
    (window as WindowWithIdleCallback).requestIdleCallback = vi.fn((callback: IdleRequestCallback) => {
      idleCallback = callback;
      return 42;
    });

    createComponent();
    expect(idleCallback).toEqual(expect.any(Function));

    fixture.destroy();
    idleCallback?.({ didTimeout: false, timeRemaining: () => 10 });

    expect(pwaInstall.initialize).not.toHaveBeenCalled();
  });

  it('destroy 后 queued visibleChange microtask 不应再发出旧可见状态', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    createComponent();

    fixture.destroy();
    await Promise.resolve();

    expect(fixture.componentInstance.visibleChanges).toEqual([]);
    expect(
      [...warnSpy.mock.calls, ...errorSpy.mock.calls].some((call) =>
        call.some((item) => String(item).includes('NG0953')),
      ),
    ).toBe(false);
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
