import { vi, describe, it, expect } from 'vitest';
import { SidebarResizeService } from './sidebar-resize.service';

type SidebarResizePrivate = {
  isResizingSidebar: boolean;
  isResizingContent: boolean;
  resizeRafId: number;
  isResizingAny: () => boolean;
  startSidebar: (e: MouseEvent) => void;
  onMouseUp: () => void;
  uiState: {
    isResizing: { set: ReturnType<typeof vi.fn> };
    sidebarWidth: () => number;
    textColumnRatio: () => number;
  };
};

function createContext(): SidebarResizePrivate {
  const context = Object.create(SidebarResizeService.prototype) as SidebarResizePrivate;
  context.isResizingSidebar = false;
  context.isResizingContent = false;
  context.resizeRafId = 0;
  context.uiState = {
    isResizing: { set: vi.fn() },
    sidebarWidth: () => 300,
    textColumnRatio: () => 50,
  };
  return context;
}

function makeMouseEvent(clientX: number): MouseEvent {
  return { clientX, preventDefault: vi.fn() } as unknown as MouseEvent;
}

describe('SidebarResizeService', () => {
  it('isResizingAny 反映拖拽状态', () => {
    const context = createContext();
    expect(context.isResizingAny()).toBe(false);
    context.isResizingSidebar = true;
    expect(context.isResizingAny()).toBe(true);
  });

  it('startSidebar 置位拖拽并通知 UiState', () => {
    const context = createContext();
    context.startSidebar(makeMouseEvent(120));
    expect(context.isResizingSidebar).toBe(true);
    expect(context.uiState.isResizing.set).toHaveBeenCalledWith(true);
  });

  it('onMouseUp 清除拖拽态并复位 UiState', () => {
    const context = createContext();
    context.isResizingSidebar = true;
    context.onMouseUp();
    expect(context.isResizingSidebar).toBe(false);
    expect(context.isResizingContent).toBe(false);
    expect(context.uiState.isResizing.set).toHaveBeenCalledWith(false);
  });
});
