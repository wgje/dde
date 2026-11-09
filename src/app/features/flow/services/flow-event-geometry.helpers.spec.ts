import { describe, expect, it, vi } from 'vitest';
import * as go from 'gojs';

import {
  convertFlowViewPointToWindowCoords,
  getFlowClickPositionFromEvent,
  getFlowLinkClickPosition,
  type FlowEventGeometryDiagram,
} from './flow-event-geometry.helpers';

function createDiagramDiv(left = 10, top = 20) {
  return {
    getBoundingClientRect: vi.fn(() => ({ left, top })),
  };
}

describe('flow event geometry helpers', () => {
  it('falls back to raw GoJS view coordinates without a diagram element', () => {
    expect(convertFlowViewPointToWindowCoords({
      diagramDiv: null,
      viewX: 7,
      viewY: 9,
    })).toEqual({ windowX: 7, windowY: 9 });
  });

  it('converts GoJS view coordinates into window coordinates', () => {
    expect(convertFlowViewPointToWindowCoords({
      diagramDiv: createDiagramDiv(100, 50),
      viewX: 7,
      viewY: 9,
    })).toEqual({ windowX: 107, windowY: 59 });
  });

  it('uses the actual last input position when available', () => {
    const link = new go.Link();
    const diagram: FlowEventGeometryDiagram = {
      lastInput: { viewPoint: { x: 30, y: 40 } },
      transformDocToView: vi.fn(),
    };

    expect(getFlowClickPositionFromEvent({
      diagram,
      diagramDiv: createDiagramDiv(5, 6),
      link,
    })).toEqual({ x: 35, y: 46 });
    expect(diagram.transformDocToView).not.toHaveBeenCalled();
  });

  it('falls back to a link midpoint when the click event has no view point', () => {
    const link = new go.Link();
    Object.defineProperty(link, 'midPoint', {
      configurable: true,
      value: new go.Point(10, 20),
    });
    const diagram: FlowEventGeometryDiagram = {
      lastInput: null,
      transformDocToView: vi.fn(() => ({ x: 15, y: 25 })),
    };

    expect(getFlowClickPositionFromEvent({
      diagram,
      diagramDiv: createDiagramDiv(5, 6),
      link,
    })).toEqual({ x: 20, y: 31 });
  });

  it('returns zero coordinates without diagram context', () => {
    expect(getFlowLinkClickPosition({
      diagram: null,
      diagramDiv: createDiagramDiv(),
      link: new go.Link(),
    })).toEqual({ x: 0, y: 0 });
  });
});
