import { describe, expect, it } from 'vitest';

import {
  getConnectionEditorCoordinateRootBounds,
  resolveConnectionEditorDragPosition,
  resolveConnectionEditorPosition,
} from './flow-link-editor-position.helpers';

describe('flow-link-editor-position.helpers', () => {
  it('anchors mobile editor above the tap and falls back below when top space is insufficient', () => {
    const coordinateRoot = { left: 0, top: 0, width: 390, height: 844 };

    expect(resolveConnectionEditorPosition({
      tapX: 200,
      tapY: 300,
      isMobile: true,
      coordinateRoot,
      diagramBounds: null,
    })).toEqual({ x: 96, y: 110 });

    expect(resolveConnectionEditorPosition({
      tapX: 40,
      tapY: 80,
      isMobile: true,
      coordinateRoot,
      diagramBounds: null,
    })).toEqual({ x: 12, y: 90 });
  });

  it('positions desktop editor in the shell coordinate root and clamps to diagram bounds', () => {
    expect(resolveConnectionEditorPosition({
      tapX: 700,
      tapY: 400,
      isMobile: false,
      coordinateRoot: { left: 200, top: 100, width: 1200, height: 800 },
      diagramBounds: { left: 320, top: 120, right: 1020, bottom: 760 },
    })).toEqual({ x: 396, y: 132 });
  });

  it('resolves drag deltas and clamps them to diagram bounds', () => {
    expect(resolveConnectionEditorDragPosition({
      dragStartX: 760,
      dragStartY: 420,
      dragOffsetX: 420,
      dragOffsetY: 180,
      pointerX: 120,
      pointerY: 420,
      diagramBounds: { left: 320, top: 120, right: 1020, bottom: 760 },
    })).toEqual({ x: 328, y: 180 });

    expect(resolveConnectionEditorDragPosition({
      dragStartX: 100,
      dragStartY: 100,
      dragOffsetX: 10,
      dragOffsetY: 20,
      pointerX: 0,
      pointerY: 0,
      diagramBounds: null,
    })).toEqual({ x: 0, y: 0 });
  });

  it('reads the project shell coordinate root when it is mounted', () => {
    const root = document.createElement('div');
    root.setAttribute('data-testid', 'project-shell-main-content');
    vi.spyOn(root, 'getBoundingClientRect').mockReturnValue({
      left: 200,
      top: 100,
      width: 1200,
      height: 800,
    } as DOMRect);
    document.body.appendChild(root);

    try {
      expect(getConnectionEditorCoordinateRootBounds()).toEqual({
        left: 200,
        top: 100,
        width: 1200,
        height: 800,
      });
    } finally {
      root.remove();
    }
  });
});
