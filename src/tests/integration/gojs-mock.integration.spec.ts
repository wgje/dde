import * as go from 'gojs';
import { describe, expect, it } from 'vitest';

describe('gojs mock', () => {
  it('supports nested diagram tool and template access', () => {
    const container = { id: 'diagram-host' };
    const diagram = new go.Diagram();
    const node = new go.Node();
    const rect = new go.Rect(10, 20, 30, 40);
    const model = new go.GraphLinksModel(
      [{ key: 'task-1', title: 'before' }],
      [{ key: 'link-1', from: 'task-1', to: 'task-2' }],
      { linkKeyProperty: 'key' },
    );
    const builtDiagram = go.GraphObject.make(go.Diagram, container, {
      'toolManager.hoverDelay': 200,
      'undoManager.isEnabled': false,
    });
    const overview = new go.Overview(container as unknown as HTMLDivElement, {
      observed: diagram,
      'animationManager.isEnabled': false,
    });

    expect(diagram.toolManager.draggingTool.isActive).toBe(false);
    expect(diagram.toolManager.linkingTool.isActive).toBe(false);
    expect(diagram.lastInput.handled).toBe(false);
    expect(node.isSelected).toBe(false);

    expect(() => diagram.linkTemplateMap.add('crossTree', new go.Link())).not.toThrow();

    diagram.toolManager.dragSelectingTool.isEnabled = false;
    diagram.toolManager.panningTool.isEnabled = true;
    diagram.model = model;

    model.mergeNodeDataArray([
      { key: 'task-1', title: 'after' },
      { key: 'task-2', title: 'added' },
    ]);
    model.mergeLinkDataArray([
      { key: 'link-1', from: 'task-1', to: 'task-2' },
      { key: 'link-2', from: 'task-2', to: 'task-1' },
    ]);

    expect(diagram.toolManager.dragSelectingTool.isEnabled).toBe(false);
    expect(diagram.toolManager.panningTool.isEnabled).toBe(true);
    expect((diagram.model as typeof model).nodeDataArray).toHaveLength(2);
    expect((diagram.model as typeof model).linkDataArray).toHaveLength(2);
    expect((diagram.model as typeof model).findNodeDataForKey('task-1')).toMatchObject({ title: 'after' });
    expect(builtDiagram.div).toBe(container);
    expect(builtDiagram.toolManager.hoverDelay).toBe(200);
    expect(builtDiagram.undoManager.isEnabled).toBe(false);
    expect(overview.div).toBe(container);
    expect(overview.observed).toBe(diagram);
    expect(overview.animationManager.isEnabled).toBe(false);
    expect(rect.right).toBe(40);
    expect(rect.bottom).toBe(60);
    expect(rect.copy().inflate(5, 10).containsPoint(new go.Point(10, 20))).toBe(true);
    expect(new go.Point(10, 20).equals(new go.Point(10, 20))).toBe(true);
    expect(new go.Point(10, 20).equals(new go.Point(20, 10))).toBe(false);
  });

  it('can fail fast on unknown api in strict mode', () => {
    const strictGlobal = globalThis as typeof globalThis & { __GOJS_MOCK_STRICT__?: boolean };
    const previousValue = strictGlobal.__GOJS_MOCK_STRICT__;
    expect((go.Link as unknown as Record<string, unknown>).Bezirr).toBeUndefined();
    strictGlobal.__GOJS_MOCK_STRICT__ = true;

    try {
      const diagram = new go.Diagram();
      expect(() => diagram.selection.each(() => undefined)).not.toThrow();
      expect(() => diagram.linkTemplateMap.add('strict-link', new go.Link())).not.toThrow();
      expect(() => (diagram.toolManager as unknown as Record<string, unknown>).typoSelectingTool).toThrow(/unknown property access/);
      expect(() => (diagram.toolManager.draggingTool as unknown as Record<string, unknown>).isActve).toThrow(/unknown property access/);
      expect(() => (go.Link as unknown as Record<string, unknown>).Bezirr).toThrow(/unknown property access/);
      expect(() => (go.Orientation as unknown as Record<string, unknown>).Alogn).toThrow(/unknown property access/);
    } finally {
      strictGlobal.__GOJS_MOCK_STRICT__ = previousValue;
    }
  });
});