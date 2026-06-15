import { describe, expect, it, vi } from 'vitest';

const diagramConstructorSpy = vi.hoisted(() => vi.fn());

vi.mock('gojs', async importOriginal => {
  const actual = await importOriginal<typeof import('gojs')>();
  const DiagramWithSpy = new Proxy(actual.Diagram, {
    construct(target, args, newTarget) {
      diagramConstructorSpy(...args);
      return Reflect.construct(target, args, newTarget);
    },
  });

  return {
    ...actual,
    Diagram: DiagramWithSpy,
    default: {
      ...actual.default,
      Diagram: DiagramWithSpy,
    },
  };
});

import { prewarmFlowFeature } from './flow-prewarm';

const EXPECTED_WARMED_SERVICES = [
  'FlowViewComponent',
  'FlowDiagramService',
  'FlowDiagramDataService',
  'FlowLayoutService',
  'FlowTemplateService',
  'FlowLinkTemplateService',
  'FlowOverviewService',
];

function isHiddenElement(element: Element): boolean {
  if (!(element instanceof HTMLElement)) {
    return false;
  }

  return element.hidden
    || element.getAttribute('aria-hidden') === 'true'
    || element.style.visibility === 'hidden'
    || element.style.display === 'none';
}

describe('prewarmFlowFeature', () => {
  it('loads Flow feature modules without creating a hidden diagram', async () => {
    diagramConstructorSpy.mockClear();
    const bodyChildCount = document.body.children.length;
    const bodyHtml = document.body.innerHTML;
    const hiddenElementsBefore = Array.from(document.body.querySelectorAll('*'))
      .filter(isHiddenElement)
      .map(element => element.outerHTML);
    const appendedBodyElements: string[] = [];
    const appendChildSpy = vi.spyOn(document.body, 'appendChild')
      .mockImplementation(function appendChild(node) {
        if (node instanceof Element) {
          appendedBodyElements.push(node.outerHTML);
        }
        return Node.prototype.appendChild.call(this, node);
      });
    const insertBeforeSpy = vi.spyOn(document.body, 'insertBefore')
      .mockImplementation(function insertBefore(node, child) {
        if (node instanceof Element) {
          appendedBodyElements.push(node.outerHTML);
        }
        return Node.prototype.insertBefore.call(this, node, child);
      });

    let result;
    try {
      result = await prewarmFlowFeature();
    } finally {
      appendChildSpy.mockRestore();
      insertBeforeSpy.mockRestore();
    }

    expect(result.warmed).toBe(true);
    expect(result.warmedServices).toEqual(EXPECTED_WARMED_SERVICES);
    expect(result.createdDiagram).toBe(false);
    expect(diagramConstructorSpy).not.toHaveBeenCalled();
    expect(document.body.children.length).toBe(bodyChildCount);
    expect(document.body.innerHTML).toBe(bodyHtml);
    expect(appendedBodyElements).toEqual([]);
    expect(Array.from(document.body.querySelectorAll('*'))
      .filter(isHiddenElement)
      .map(element => element.outerHTML)).toEqual(hiddenElementsBefore);
  }, 10_000);
});
