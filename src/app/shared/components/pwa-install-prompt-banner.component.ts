import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, input, output } from '@angular/core';
import { FEATURE_FLAGS } from '../../../config/feature-flags.config';
import { IDLE_SCHEDULE_CONFIG } from '../../../config/timeout.config';
import { PwaInstallPromptService } from '../../../services/pwa-install-prompt.service';
import { ToastService } from '../../../services/toast.service';

@Component({
  selector: 'app-pwa-install-prompt-banner',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (showPrompt()) {
      <div class="fixed left-1/2 z-30 -translate-x-1/2 px-3 py-2 rounded-xl border border-stone-200/80 dark:border-stone-700/80 bg-white/90 dark:bg-stone-900/90 backdrop-blur-md shadow-sm max-w-[92vw]"
           [style.top]="top()">
        <div class="flex items-center gap-2">
          <div class="text-[11px] text-stone-600 dark:text-stone-300">
            {{ installHint() }}
          </div>
          @if (pwaInstall.canInstall()) {
            <button
              (click)="installPwaApp()"
              class="px-2 py-1 text-[11px] rounded-md bg-indigo-500 text-white hover:bg-indigo-600 transition-colors whitespace-nowrap">
              安装应用
            </button>
          }
          <button
            (click)="dismissPwaInstallPrompt()"
            class="w-5 h-5 text-stone-400 hover:text-stone-600 dark:hover:text-stone-300 transition-colors"
            aria-label="关闭安装提示">
            ×
          </button>
        </div>
      </div>
    }
  `,
})
export class PwaInstallPromptBannerComponent {
  readonly top = input.required<string>();
  readonly visibleChange = output<boolean>();

  readonly pwaInstall = inject(PwaInstallPromptService);
  private readonly toast = inject(ToastService);
  private readonly destroyRef = inject(DestroyRef);

  readonly showPrompt = computed(() =>
    FEATURE_FLAGS.PWA_INSTALL_PROMPT_V1 && this.pwaInstall.canShowInstallPrompt()
  );
  readonly installHint = computed(() => this.pwaInstall.installHint());

  private promptInitScheduled = false;

  constructor() {
    effect(() => {
      const visible = this.showPrompt();
      queueMicrotask(() => this.visibleChange.emit(visible));
    });

    this.schedulePromptInitialization();
  }

  async installPwaApp(): Promise<void> {
    const installed = await this.pwaInstall.promptInstall();
    if (installed) {
      this.toast.success('安装已开始', '安装完成后可在主屏/桌面直接启动');
      return;
    }

    if (!this.pwaInstall.canInstall()) {
      this.toast.info('安装提示', this.pwaInstall.installHint());
    }
  }

  dismissPwaInstallPrompt(): void {
    this.pwaInstall.dismissPrompt();
  }

  private schedulePromptInitialization(): void {
    if (this.promptInitScheduled) {
      return;
    }

    this.promptInitScheduled = true;

    if (!FEATURE_FLAGS.PWA_PROMPT_DEFER_V2) {
      this.pwaInstall.initialize();
      return;
    }

    const init = () => this.pwaInstall.initialize();

    if (typeof window === 'undefined') {
      init();
      return;
    }

    let initialized = false;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const cleanup = () => {
      window.removeEventListener('pointerdown', onFirstIntent);
      window.removeEventListener('keydown', onFirstIntent);
      window.removeEventListener('touchstart', onFirstIntent);
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
    };
    const initOnce = () => {
      if (initialized) {
        return;
      }

      initialized = true;
      cleanup();
      init();
    };
    const onFirstIntent = () => initOnce();

    this.destroyRef.onDestroy(() => {
      cleanup();
      this.visibleChange.emit(false);
    });

    window.addEventListener('pointerdown', onFirstIntent, { once: true, passive: true });
    window.addEventListener('keydown', onFirstIntent, { once: true });
    window.addEventListener('touchstart', onFirstIntent, { once: true, passive: true });

    if ('requestIdleCallback' in window) {
      (
        window as Window & {
          requestIdleCallback: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number;
        }
      ).requestIdleCallback(() => initOnce(), { timeout: 2500 });
      return;
    }

    idleTimer = setTimeout(initOnce, IDLE_SCHEDULE_CONFIG.SHORT_MS);
  }
}