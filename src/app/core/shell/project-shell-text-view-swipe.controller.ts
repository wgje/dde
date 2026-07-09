export interface ProjectShellTextViewSwipeControllerOptions {
  isMobile: () => boolean;
  switchToFlow: () => void;
}

export class ProjectShellTextViewSwipeController {
  private startX = 0;
  private startY = 0;
  private isSwiping = false;
  private isDestroyed = false;

  constructor(private readonly options: ProjectShellTextViewSwipeControllerOptions) {}

  onTouchStart(event: TouchEvent): void {
    if (!this.options.isMobile()) return;
    if (event.touches.length !== 1) return;

    this.startX = event.touches[0].clientX;
    this.startY = event.touches[0].clientY;
    this.isSwiping = false;
  }

  onTouchMove(event: TouchEvent): void {
    if (!this.options.isMobile()) return;
    if (event.touches.length !== 1) return;

    const deltaX = event.touches[0].clientX - this.startX;
    const deltaY = Math.abs(event.touches[0].clientY - this.startY);

    if (deltaX < -30 && Math.abs(deltaX) > deltaY * 1.5) {
      this.isSwiping = true;

      if (event.cancelable) {
        event.preventDefault();
      }
      event.stopPropagation();
    }
  }

  onTouchEnd(event: TouchEvent): void {
    if (!this.options.isMobile()) return;
    if (!this.isSwiping) return;

    const deltaX = event.changedTouches[0].clientX - this.startX;

    if (deltaX < -50) {
      if (event.cancelable) {
        event.preventDefault();
      }
      event.stopPropagation();

      setTimeout(() => {
        if (this.isDestroyed) return;
        this.options.switchToFlow();
      }, 0);
    }

    this.isSwiping = false;
  }

  destroy(): void {
    this.isDestroyed = true;
  }
}
