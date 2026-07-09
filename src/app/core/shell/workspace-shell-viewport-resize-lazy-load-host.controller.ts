import type { WorkspaceShellViewportResizeControllerOptions } from './workspace-shell-viewport-resize.controller';
import {
  createWorkspaceShellViewportResizeControllerLoader,
} from './workspace-shell-viewport-resize-controller-loader.factory';

export interface WorkspaceShellViewportResizeHostDelegate {
  cleanup(): void;
  handleResize(): void;
}

export interface WorkspaceShellViewportResizeLazyLoadHostOptions
  extends Partial<WorkspaceShellViewportResizeControllerOptions> {
  createViewportResizeController?: () => Promise<WorkspaceShellViewportResizeHostDelegate>;
  listenToWindow?: (eventName: string, listener: EventListener) => () => void;
  warn: (message: string, error: unknown) => void;
}

export class WorkspaceShellViewportResizeLazyLoadHostController {
  private resizePromise: Promise<WorkspaceShellViewportResizeHostDelegate> | null = null;
  private readonly loadViewportResizeController: () => Promise<WorkspaceShellViewportResizeHostDelegate>;
  private removeResizeListener: (() => void) | null = null;
  private isCleanedUp = false;

  constructor(private readonly options: WorkspaceShellViewportResizeLazyLoadHostOptions) {
    this.loadViewportResizeController = createWorkspaceShellViewportResizeControllerLoader(options);
  }

  setup(): void {
    if (this.isCleanedUp) return;
    if (!this.options.listenToWindow) return;

    this.removeWindowResizeListener();
    try {
      this.removeResizeListener = this.options.listenToWindow('resize', () => {
        this.handleResize();
      });
    } catch (error) {
      this.removeResizeListener = null;
      this.warn('视口 resize 监听注册失败，已跳过本次安装并允许重试', error);
    }
  }

  handleResize(): void {
    if (this.isCleanedUp) return;

    void this.resolveController()
      .then(controller => {
        if (!this.isCleanedUp) {
          controller.handleResize();
        }
      })
      .catch(error => this.warn('视口 resize 控制器懒加载失败，已跳过本次窗口变化', error));
  }

  cleanup(): void {
    if (this.isCleanedUp) return;

    this.isCleanedUp = true;
    this.removeWindowResizeListener();
    void this.resizePromise
      ?.then(controller => controller.cleanup())
      .catch(error => this.warn('视口 resize 控制器清理失败，已跳过', error));
  }

  private removeWindowResizeListener(): void {
    const removeResizeListener = this.removeResizeListener;
    this.removeResizeListener = null;
    if (!removeResizeListener) return;

    try {
      removeResizeListener();
    } catch (error) {
      this.warn('视口 resize 监听清理失败，已继续清理控制器', error);
    }
  }

  private resolveController(): Promise<WorkspaceShellViewportResizeHostDelegate> {
    return (this.resizePromise ??= this.createViewportResizeControllerSafely()
      .catch(error => {
        this.resizePromise = null;
        throw error;
      }));
  }

  private createViewportResizeControllerSafely(): Promise<WorkspaceShellViewportResizeHostDelegate> {
    try {
      return Promise.resolve(this.loadViewportResizeController());
    } catch (error) {
      return Promise.reject(error);
    }
  }

  private warn(message: string, error: unknown): void {
    try {
      this.options.warn(message, error);
    } catch {
      // Warning sinks must not interrupt resize lazy-load fallback or cleanup.
    }
  }
}
