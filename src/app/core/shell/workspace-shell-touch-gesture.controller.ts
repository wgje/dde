import { UI_CONFIG } from '../../../config/ui.config';

export interface WorkspaceShellTouchGestureControllerOptions {
  isMobile: () => boolean;
  activeView: () => string | null;
  setSidebarOpen: (open: boolean) => void;
}

export class WorkspaceShellTouchGestureController {
  private static readonly SWIPE_THRESHOLD = 50;

  private mainTouchStartX = 0;
  private mainTouchStartY = 0;
  private mainSwiping = false;

  private sidebarTouchStartX = 0;
  private sidebarTouchStartY = 0;
  private sidebarSwiping = false;

  constructor(private readonly options: WorkspaceShellTouchGestureControllerOptions) {}

  onSidebarTouchStart(event: TouchEvent): void {
    if (!this.options.isMobile()) return;
    if (event.touches.length !== 1) return;

    this.sidebarTouchStartX = event.touches[0].clientX;
    this.sidebarTouchStartY = event.touches[0].clientY;
    this.sidebarSwiping = false;
  }

  onSidebarTouchMove(event: TouchEvent): void {
    if (!this.options.isMobile()) return;
    if (event.touches.length !== 1) return;

    const deltaX = event.touches[0].clientX - this.sidebarTouchStartX;
    const deltaY = Math.abs(event.touches[0].clientY - this.sidebarTouchStartY);
    if (this.isHorizontalSwipe(deltaX, deltaY) && deltaX < -UI_CONFIG.GESTURE_MIN_DISTANCE) {
      this.sidebarSwiping = true;
    }
  }

  onSidebarTouchEnd(event: TouchEvent): void {
    if (!this.options.isMobile()) return;
    if (!this.sidebarSwiping) return;

    const deltaX = event.changedTouches[0].clientX - this.sidebarTouchStartX;
    if (deltaX < -WorkspaceShellTouchGestureController.SWIPE_THRESHOLD) {
      this.options.setSidebarOpen(false);
    }

    this.sidebarSwiping = false;
  }

  onMainTouchStart(event: TouchEvent): void {
    if (!this.options.isMobile()) return;
    if (event.touches.length !== 1) return;

    this.mainTouchStartX = event.touches[0].clientX;
    this.mainTouchStartY = event.touches[0].clientY;
    this.mainSwiping = false;
  }

  onMainTouchMove(event: TouchEvent): void {
    if (!this.options.isMobile()) return;
    if (event.touches.length !== 1) return;

    const deltaX = event.touches[0].clientX - this.mainTouchStartX;
    const deltaY = Math.abs(event.touches[0].clientY - this.mainTouchStartY);
    if (this.isHorizontalSwipe(deltaX, deltaY)) {
      this.mainSwiping = true;
    }
  }

  onMainTouchEnd(event: TouchEvent): void {
    if (!this.options.isMobile()) return;
    if (!this.mainSwiping) return;

    const deltaX = event.changedTouches[0].clientX - this.mainTouchStartX;
    if (
      deltaX > WorkspaceShellTouchGestureController.SWIPE_THRESHOLD
      && this.options.activeView() !== 'flow'
    ) {
      this.options.setSidebarOpen(true);
    }

    this.mainSwiping = false;
  }

  private isHorizontalSwipe(deltaX: number, deltaY: number): boolean {
    return Math.abs(deltaX) > UI_CONFIG.GESTURE_MIN_DISTANCE
      && Math.abs(deltaX) > deltaY * UI_CONFIG.GESTURE_DIRECTION_RATIO;
  }
}
