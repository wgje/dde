import { signal } from '@angular/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FlowLinkEditorDragController } from './flow-link-editor-drag.controller';
import type { PanelPosition } from '../../../../models/flow-view-state';

describe('FlowLinkEditorDragController', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('registers document listeners and updates the editor position while dragging', () => {
    const position = signal<PanelPosition>({ x: 420, y: 180 });
    const zone = createZoneMock();
    const controller = new FlowLinkEditorDragController({
      connectionEditorPos: position,
      zone,
    });
    const shellRoot = mountElement('project-shell-main-content', {
      left: 200,
      top: 100,
      right: 1400,
      bottom: 900,
      width: 1200,
      height: 800,
    });
    const diagram = mountElement('flow-diagram', {
      left: 520,
      top: 220,
      right: 1220,
      bottom: 860,
      width: 700,
      height: 640,
    });

    try {
      const addSpy = vi.spyOn(document, 'addEventListener');
      const removeSpy = vi.spyOn(document, 'removeEventListener');
      const event = new MouseEvent('mousedown', { clientX: 760, clientY: 420 });
      vi.spyOn(event, 'preventDefault');

      controller.start(event);
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: 120, clientY: 420 }));

      expect(event.preventDefault).toHaveBeenCalled();
      expect(addSpy).toHaveBeenCalledWith('mousemove', expect.any(Function));
      expect(addSpy).toHaveBeenCalledWith('mouseup', expect.any(Function));
      expect(position()).toEqual({ x: 328, y: 180 });
      expect(zone.run).toHaveBeenCalledTimes(1);

      document.dispatchEvent(new MouseEvent('mouseup'));

      expect(removeSpy).toHaveBeenCalledWith('mousemove', expect.any(Function));
      expect(removeSpy).toHaveBeenCalledWith('mouseup', expect.any(Function));
    } finally {
      shellRoot.remove();
      diagram.remove();
      controller.dispose();
    }
  });

  it('disposes active drag listeners and resets fallback bounds', () => {
    const position = signal<PanelPosition>({ x: 20, y: 30 });
    const zone = createZoneMock();
    const controller = new FlowLinkEditorDragController({
      connectionEditorPos: position,
      zone,
    });
    const removeSpy = vi.spyOn(document, 'removeEventListener');

    controller.start(new MouseEvent('mousedown', { clientX: 10, clientY: 10 }));
    controller.dispose();
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 50, clientY: 60 }));

    expect(position()).toEqual({ x: 20, y: 30 });
    expect(removeSpy).toHaveBeenCalledWith('touchmove', expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith('touchend', expect.any(Function));
    expect(zone.run).not.toHaveBeenCalled();
  });

  it('continues dispose cleanup and resets drag state when one document listener removal fails', () => {
    const position = signal<PanelPosition>({ x: 20, y: 30 });
    const zone = createZoneMock();
    const controller = new FlowLinkEditorDragController({
      connectionEditorPos: position,
      zone,
    });
    const registeredListeners = new Map<string, EventListener>();
    const originalAddEventListener = document.addEventListener.bind(document);
    const originalRemoveEventListener = document.removeEventListener.bind(document);
    const addSpy = vi
      .spyOn(document, 'addEventListener')
      .mockImplementation((eventName, listener, options) => {
        if (typeof eventName === 'string') {
          registeredListeners.set(eventName, listener as EventListener);
        }
        return originalAddEventListener(eventName, listener, options);
      });

    controller.start(new MouseEvent('mousedown', { clientX: 10, clientY: 10 }));

    const removeSpy = vi
      .spyOn(document, 'removeEventListener')
      .mockImplementation((eventName, listener, options) => {
        if (eventName === 'mousemove') {
          throw new Error('remove mousemove failed');
        }
        return originalRemoveEventListener(eventName, listener, options);
      });

    try {
      expect(() => controller.dispose()).not.toThrow();

      expect(removeSpy).toHaveBeenCalledWith('mouseup', expect.any(Function));
      expect(removeSpy).toHaveBeenCalledWith('touchmove', expect.any(Function));
      expect(removeSpy).toHaveBeenCalledWith('touchend', expect.any(Function));

      document.dispatchEvent(new MouseEvent('mousemove', { clientX: 50, clientY: 60 }));

      expect(position()).toEqual({ x: 20, y: 30 });
      expect(zone.run).not.toHaveBeenCalled();
    } finally {
      removeSpy.mockRestore();
      addSpy.mockRestore();
      for (const [eventName, listener] of registeredListeners) {
        originalRemoveEventListener(eventName, listener);
      }
    }
  });

  it('restarts a drag session cleanly when start is called again before stop', () => {
    const position = signal<PanelPosition>({ x: 20, y: 30 });
    const zone = createZoneMock();
    const controller = new FlowLinkEditorDragController({
      connectionEditorPos: position,
      zone,
    });
    const addSpy = vi.spyOn(document, 'addEventListener');
    const removeSpy = vi.spyOn(document, 'removeEventListener');

    try {
      controller.start(new MouseEvent('mousedown', { clientX: 10, clientY: 10 }));
      controller.start(new MouseEvent('mousedown', { clientX: 15, clientY: 15 }));

      expect(removeSpy).toHaveBeenCalledWith('mousemove', expect.any(Function));
      expect(removeSpy).toHaveBeenCalledWith('mouseup', expect.any(Function));
      expect(addSpy).toHaveBeenCalledWith('mousemove', expect.any(Function));
      expect(addSpy).toHaveBeenCalledWith('mouseup', expect.any(Function));

      document.dispatchEvent(new MouseEvent('mousemove', { clientX: 30, clientY: 40 }));

      expect(position()).not.toEqual({ x: 20, y: 30 });
      expect(zone.run).toHaveBeenCalledTimes(1);
    } finally {
      controller.dispose();
    }
  });
});

function createZoneMock(): { run: ReturnType<typeof vi.fn> & (<T>(callback: () => T) => T) } {
  return {
    run: vi.fn(<T>(callback: () => T): T => callback()) as ReturnType<typeof vi.fn> & (<T>(callback: () => T) => T),
  };
}

function mountElement(
  testId: string,
  rect: Pick<DOMRect, 'left' | 'top' | 'right' | 'bottom' | 'width' | 'height'>
): HTMLDivElement {
  const element = document.createElement('div');
  element.setAttribute('data-testid', testId);
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(rect as DOMRect);
  document.body.appendChild(element);
  return element;
}
