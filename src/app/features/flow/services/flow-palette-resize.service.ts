import { Injectable, WritableSignal } from '@angular/core';

/**
 * 调色板拖动调整大小服务
 * 处理调色板（待分配区域）的拖拽调整大小逻辑
 */
@Injectable({ providedIn: 'root' })
export class FlowPaletteResizeService {
  private isResizing = false;
  private startY = 0;
  private startHeight = 0;
  private heightSignal: WritableSignal<number> | null = null;

  // 桌面端的高度限制
  private readonly DESKTOP_MIN_HEIGHT = 100;
  private readonly DESKTOP_MAX_HEIGHT = 600;

  // 移动端的高度限制
  private readonly MOBILE_MIN_HEIGHT = 80;
  private readonly MOBILE_MAX_HEIGHT = 500;

  /**
   * 绑定高度信号
   * @param heightSignal 调色板高度信号
   */
  bindHeightSignal(heightSignal: WritableSignal<number>): void {
    this.heightSignal = heightSignal;
  }

  /**
   * 开始鼠标拖动调整
   */
  startMouseResize(e: MouseEvent): void {
    if (!this.heightSignal) return;
    
    e.preventDefault();
    this.isResizing = true;
    this.startY = e.clientY;
    this.startHeight = this.heightSignal();
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';

    const onMove = (ev: MouseEvent) => {
      if (!this.isResizing || !this.heightSignal) return;
      const delta = ev.clientY - this.startY;
      const newHeight = Math.max(
        this.DESKTOP_MIN_HEIGHT,
        Math.min(this.DESKTOP_MAX_HEIGHT, this.startHeight + delta)
      );
      this.heightSignal.set(newHeight);
    };

    const onUp = () => {
      this.isResizing = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  /**
   * 开始触摸拖动调整
   */
  startTouchResize(e: TouchEvent): void {
    if (!this.heightSignal) return;
    if (e.touches.length !== 1) return;
    
    e.preventDefault();
    this.isResizing = true;
    this.startY = e.touches[0].clientY;
    this.startHeight = this.heightSignal();

    const onMove = (ev: TouchEvent) => {
      if (!this.isResizing || !this.heightSignal || ev.touches.length !== 1) return;
      ev.preventDefault();
      const delta = ev.touches[0].clientY - this.startY;
      const newHeight = Math.max(
        this.MOBILE_MIN_HEIGHT,
        Math.min(this.MOBILE_MAX_HEIGHT, this.startHeight + delta)
      );
      this.heightSignal.set(newHeight);
    };

    const onEnd = () => {
      this.isResizing = false;
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onEnd);
      window.removeEventListener('touchcancel', onEnd);
    };

    window.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('touchend', onEnd);
    window.addEventListener('touchcancel', onEnd);
  }

  /**
   * 是否正在调整大小
   */
  get isResizingPalette(): boolean {
    return this.isResizing;
  }
}
