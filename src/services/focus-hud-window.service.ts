import {
  ApplicationRef,
  ComponentRef,
  DestroyRef,
  EnvironmentInjector,
  Injectable,
  computed,
  createComponent,
  inject,
  signal,
} from '@angular/core';
import { LoggerService } from './logger.service';
import { PARKING_CONFIG } from '../config/parking.config';
import { DockStatusMachinePipComponent } from '../app/features/parking/components/dock-status-machine-pip.component';

interface DocumentPictureInPictureRequestOptions {
  width?: number;
  height?: number;
  disallowReturnToOpener?: boolean;
  preferInitialWindowPlacement?: boolean;
}

interface DocumentPictureInPictureController {
  requestWindow(options?: DocumentPictureInPictureRequestOptions): Promise<Window>;
  window?: Window | null;
}

interface WindowWithDocumentPictureInPicture extends Window {
  documentPictureInPicture?: DocumentPictureInPictureController;
}

@Injectable({
  providedIn: 'root',
})
export class FocusHudWindowService {
  private readonly logger = inject(LoggerService).category('FocusHudWindow');
  private readonly appRef = inject(ApplicationRef);
  private readonly environmentInjector = inject(EnvironmentInjector);
  private readonly destroyRef = inject(DestroyRef);

  private readonly active = signal(false);
  private componentRef: ComponentRef<DockStatusMachinePipComponent> | null = null;
  private pipWindow: Window | null = null;
  private pageHideHandler: ((event: PageTransitionEvent) => void) | null = null;

  readonly isActive = computed(() => this.active());
  readonly isSupported = computed(() => this.hasDocumentPictureInPictureSupport());

  constructor() {
    this.destroyRef.onDestroy(() => {
      void this.close();
    });
  }

  async open(): Promise<boolean> {
    if (!this.hasDocumentPictureInPictureSupport()) {
      return false;
    }

    if (this.pipWindow && !this.pipWindow.closed) {
      try {
        this.pipWindow.focus();
      } catch {
        // Ignore focus failures and keep the existing PiP session alive.
      }
      this.active.set(true);
      return true;
    }

    const controller = this.getController();
    if (!controller) return false;

    try {
      const pipWindow = await controller.requestWindow({
        width: PARKING_CONFIG.HUD_FULL_MAX_WIDTH_PX + 36,
        height: PARKING_CONFIG.HUD_FULL_MAX_HEIGHT_PX + 92,
        preferInitialWindowPlacement: true,
      });
      this.mountToWindow(pipWindow);
      this.active.set(true);
      return true;
    } catch (error) {
      this.logger.warn('打开 PiP HUD 失败', error);
      this.teardown();
      return false;
    }
  }

  async close(): Promise<void> {
    const windowRef = this.pipWindow;
    this.teardown();
    if (!windowRef || windowRef.closed) return;
    try {
      windowRef.close();
    } catch (error) {
      this.logger.warn('关闭 PiP HUD 窗口失败', error);
    }
  }

  async toggle(): Promise<void> {
    if (this.isActive()) {
      await this.close();
      return;
    }
    await this.open();
  }

  focusMainWindow(): void {
    if (typeof window === 'undefined') return;
    try {
      window.focus();
    } catch {
      // Ignore focus failures.
    }
  }

  private hasDocumentPictureInPictureSupport(): boolean {
    return !!this.getController();
  }

  private getController(): DocumentPictureInPictureController | null {
    if (typeof window === 'undefined') return null;
    const pipWindow = window as WindowWithDocumentPictureInPicture;
    const controller = pipWindow.documentPictureInPicture;
    if (!controller || typeof controller.requestWindow !== 'function') {
      return null;
    }
    return controller;
  }

  private mountToWindow(pipWindow: Window): void {
    this.teardown();
    this.pipWindow = pipWindow;

    const pipDocument = pipWindow.document;
    pipDocument.title = 'NanoFlow Focus HUD';
    this.copyStyleSheets(pipDocument);
    this.prepareDocumentShell(pipDocument);

    const mountPoint = pipDocument.createElement('div');
    mountPoint.id = 'nanoflow-focus-hud-root';
    pipDocument.body.appendChild(mountPoint);

    const componentRef = createComponent(DockStatusMachinePipComponent, {
      environmentInjector: this.environmentInjector,
      hostElement: mountPoint,
    });
    this.appRef.attachView(componentRef.hostView);
    componentRef.instance.returnRequested.subscribe(() => this.focusMainWindow());
    componentRef.instance.closeRequested.subscribe(() => {
      void this.close();
    });
    this.componentRef = componentRef;

    this.pageHideHandler = () => {
      this.teardown();
    };
    pipWindow.addEventListener('pagehide', this.pageHideHandler);
  }

  private prepareDocumentShell(targetDocument: Document): void {
    targetDocument.body.innerHTML = '';
    targetDocument.body.style.margin = '0';
    targetDocument.body.style.minHeight = '100vh';
    targetDocument.body.style.background =
      'linear-gradient(180deg, rgba(7, 11, 22, 0.96), rgba(15, 23, 42, 0.94))';
    targetDocument.body.style.color = 'rgba(241, 245, 249, 0.96)';
    targetDocument.body.style.fontFamily =
      'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    targetDocument.body.style.overflow = 'hidden';
  }

  private copyStyleSheets(targetDocument: Document): void {
    if (typeof document === 'undefined') return;
    for (const styleSheet of Array.from(document.styleSheets)) {
      try {
        const cssText = Array.from(styleSheet.cssRules).map(rule => rule.cssText).join('\n');
        if (!cssText) continue;
        const style = targetDocument.createElement('style');
        style.textContent = cssText;
        targetDocument.head.appendChild(style);
      } catch {
        if (!styleSheet.href) continue;
        const link = targetDocument.createElement('link');
        link.rel = 'stylesheet';
        link.href = styleSheet.href;
        targetDocument.head.appendChild(link);
      }
    }
  }

  private teardown(): void {
    const currentWindow = this.pipWindow;
    if (this.componentRef) {
      this.appRef.detachView(this.componentRef.hostView);
      this.componentRef.destroy();
      this.componentRef = null;
    }

    if (currentWindow && this.pageHideHandler) {
      currentWindow.removeEventListener('pagehide', this.pageHideHandler);
    }
    this.pageHideHandler = null;
    this.pipWindow = null;

    this.active.set(false);
  }
}
