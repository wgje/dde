import { describe, expect, it, vi } from 'vitest';
import * as go from 'gojs';

import {
  createFlowNodeSidecarTemplateParts,
  readFlowNodeSidecarCount,
  type FlowNodeSidecarTemplateContext,
} from './flow-template-sidecar.helpers';

type MockGoObject = Record<string, unknown> & {
  mockArgs?: unknown[];
  mockChildren?: unknown[];
};

function makeContext(isMobile = false): FlowNodeSidecarTemplateContext {
  return {
    isMobile,
    sidecarTitleMaxSize: new go.Size(isMobile ? 96 : 150, NaN),
  };
}

function findMockObject(root: unknown, predicate: (value: MockGoObject) => boolean): MockGoObject | null {
  const stack: unknown[] = [root];
  const seen = new Set<unknown>();
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    const record = current as MockGoObject;
    if (predicate(record)) return record;
    if (Array.isArray(record)) {
      stack.push(...record);
      continue;
    }
    stack.push(...Object.values(record), ...(record.mockArgs ?? []), ...(record.mockChildren ?? []));
  }
  return null;
}

describe('flow-template-sidecar.helpers', () => {
  it('builds a toggle and four hoverable desktop sidecar wings', () => {
    const onToggle = vi.fn();

    const parts = createFlowNodeSidecarTemplateParts({
      context: makeContext(false),
      onToggle,
    });

    const sidecarToggle = findMockObject(parts, value => value['name'] === 'SIDECAR_TOGGLE');
    expect(sidecarToggle).not.toBeNull();
    expect(sidecarToggle?.['pickable']).toBe(true);
    expect(sidecarToggle?.['isActionable']).toBe(true);
    expect(sidecarToggle?.['toolTip']).toBeTruthy();

    for (const name of ['SIDECAR_WING_TOP', 'SIDECAR_WING_RIGHT', 'SIDECAR_WING_BOTTOM', 'SIDECAR_WING_LEFT']) {
      const sidecarWing = findMockObject(parts, value => value['name'] === name);
      expect(sidecarWing).not.toBeNull();
      expect(sidecarWing?.['itemTemplate']).toBeTruthy();
      expect(sidecarWing?.['pickable']).toBe(true);
      const itemTemplate = sidecarWing?.['itemTemplate'] as MockGoObject;
      expect(itemTemplate?.['pickable']).toBe(true);
      expect(itemTemplate?.['toolTip']).toBeTruthy();
    }
  });

  it('keeps sidecar tooltips disabled on mobile templates', () => {
    const parts = createFlowNodeSidecarTemplateParts({
      context: makeContext(true),
      onToggle: vi.fn(),
    });

    const sidecarToggle = findMockObject(parts, value => value['name'] === 'SIDECAR_TOGGLE');
    expect(sidecarToggle).not.toBeNull();
    expect(Object.prototype.hasOwnProperty.call(sidecarToggle, 'toolTip')).toBe(false);

    for (const name of ['SIDECAR_WING_TOP', 'SIDECAR_WING_RIGHT', 'SIDECAR_WING_BOTTOM', 'SIDECAR_WING_LEFT']) {
      const sidecarWing = findMockObject(parts, value => value['name'] === name);
      expect(sidecarWing).not.toBeNull();
      const itemTemplate = sidecarWing?.['itemTemplate'] as MockGoObject;
      expect(Object.prototype.hasOwnProperty.call(itemTemplate, 'toolTip')).toBe(false);
    }
  });

  it('passes the task id and owning part through the toggle callback', () => {
    const onToggle = vi.fn();
    const nodePart = {
      data: { key: 'task-1' },
    } as unknown as go.Part;
    const graphObject = {
      part: nodePart,
    } as unknown as go.GraphObject;
    const event = {
      handled: false,
    } as go.InputEvent;

    const parts = createFlowNodeSidecarTemplateParts({
      context: makeContext(false),
      onToggle,
    });
    const sidecarToggle = findMockObject(parts, value => value['name'] === 'SIDECAR_TOGGLE');
    const click = sidecarToggle?.['click'] as ((event: go.InputEvent, obj: go.GraphObject) => void) | undefined;

    expect(click).toBeTypeOf('function');
    click?.(event, graphObject);

    expect(event.handled).toBe(true);
    expect(onToggle).toHaveBeenCalledWith('task-1', nodePart);
  });

  it('formats sidecar badge counts defensively for GoJS bindings', () => {
    expect(readFlowNodeSidecarCount([{ id: 'a' }, { id: 'b' }])).toBe('2');
    expect(readFlowNodeSidecarCount(null)).toBe('0');
  });
});
