import { Injector } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as go from 'gojs';
import { LoggerService } from '../../../../services/logger.service';
import { ThemeService } from '../../../../services/theme.service';
import { UiStateService } from '../../../../services/ui-state.service';
import type { ExternalSourceLink } from '../../../core/external-sources/external-source.model';
import { KnowledgeAnchorPopoverService } from '../../../shared/components/knowledge-anchor/knowledge-anchor-popover.service';
import { FlowDiagramConfigService } from './flow-diagram-config.service';
import { FlowTemplateService } from './flow-template.service';
import { flowTemplateEventHandlers } from './flow-template-events';

type MockGoObject = Record<string, unknown> & {
  mockArgs?: unknown[];
  mockChildren?: unknown[];
};

function findMockObject(root: unknown, predicate: (value: MockGoObject) => boolean): MockGoObject | null {
  const stack: unknown[] = [root];
  const seen = new Set<unknown>();
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    const record = current as MockGoObject;
    if (predicate(record)) return record;
    stack.push(...(record.mockArgs ?? []), ...(record.mockChildren ?? []));
  }
  return null;
}

describe('FlowTemplateService sidecar template', () => {
  let isMobile = false;
  let service: FlowTemplateService;
  let siyuanPopover: {
    scheduleOpen: ReturnType<typeof vi.fn>;
    scheduleClose: ReturnType<typeof vi.fn>;
    openNow: ReturnType<typeof vi.fn>;
    closeForOwner: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    flowTemplateEventHandlers.onSidecarToggle = undefined;
    isMobile = false;
    siyuanPopover = {
      scheduleOpen: vi.fn(),
      scheduleClose: vi.fn(),
      openNow: vi.fn(),
      closeForOwner: vi.fn(),
    };
    const injector = Injector.create({
      providers: [
        FlowTemplateService,
        { provide: UiStateService, useValue: { isMobile: () => isMobile } },
        { provide: FlowDiagramConfigService, useValue: {} },
        {
          provide: LoggerService,
          useValue: {
            category: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
          },
        },
        { provide: ThemeService, useValue: { theme: () => 'default', isDark: () => false } },
        { provide: KnowledgeAnchorPopoverService, useValue: siyuanPopover },
      ],
    });
    service = injector.get(FlowTemplateService);
  });

  afterEach(() => {
    flowTemplateEventHandlers.onSidecarToggle = undefined;
  });

  it('adds hoverable non-topological external sidecar wings with per-item desktop tooltips', () => {
    const diagram = new go.Diagram();

    service.setupNodeTemplate(diagram);

    const nodeTemplate = diagram.nodeTemplate as unknown as MockGoObject;
    const sidecarToggle = findMockObject(nodeTemplate, value => value['name'] === 'SIDECAR_TOGGLE');
    expect(sidecarToggle).not.toBeNull();
    expect(sidecarToggle?.['pickable']).toBe(true);
    expect(sidecarToggle?.['isActionable']).toBe(true);
    for (const name of ['SIDECAR_WING_TOP', 'SIDECAR_WING_RIGHT', 'SIDECAR_WING_BOTTOM', 'SIDECAR_WING_LEFT']) {
      const sidecarWing = findMockObject(nodeTemplate, value => value['name'] === name);
      expect(sidecarWing).not.toBeNull();
      expect(sidecarWing?.['itemTemplate']).toBeTruthy();
      expect(sidecarWing?.['pickable']).toBe(true);
      const itemTemplate = sidecarWing?.['itemTemplate'] as MockGoObject;
      expect(itemTemplate?.['pickable']).toBe(true);
      expect(itemTemplate?.['toolTip']).toBeTruthy();
    }
    const sidecarChip = findMockObject(nodeTemplate, value => Boolean(value['toolTip']) && value['pickable'] === true);
    expect(sidecarChip).not.toBeNull();
  });

  it('keeps node sidecar tooltip disabled on mobile templates', () => {
    isMobile = true;
    const diagram = new go.Diagram();

    service.setupNodeTemplate(diagram);

    const nodeTemplate = diagram.nodeTemplate as unknown as MockGoObject;
    const sidecarToggle = findMockObject(nodeTemplate, value => value['name'] === 'SIDECAR_TOGGLE');
    expect(sidecarToggle).not.toBeNull();
    expect(sidecarToggle?.['pickable']).toBe(true);
    for (const name of ['SIDECAR_WING_TOP', 'SIDECAR_WING_RIGHT', 'SIDECAR_WING_BOTTOM', 'SIDECAR_WING_LEFT']) {
      const sidecarWing = findMockObject(nodeTemplate, value => value['name'] === name);
      expect(sidecarWing).not.toBeNull();
      expect(sidecarWing?.['itemTemplate']).toBeTruthy();
      expect(sidecarWing?.['pickable']).toBe(true);
      const itemTemplate = sidecarWing?.['itemTemplate'] as MockGoObject;
      expect(itemTemplate?.['pickable']).toBe(true);
      expect(Object.prototype.hasOwnProperty.call(itemTemplate, 'toolTip')).toBe(false);
    }
    expect(Object.prototype.hasOwnProperty.call(nodeTemplate, 'toolTip')).toBe(false);
  });

  it('passes the owning GoJS part when sidecar toggle is clicked', () => {
    const diagram = new go.Diagram();
    const sidecarToggleHandler = vi.fn();
    const nodePart = {
      data: { key: 'task-1' },
    } as unknown as go.Part;
    const graphObject = {
      part: nodePart,
    } as unknown as go.GraphObject;
    const event = {
      handled: false,
    } as go.InputEvent;
    flowTemplateEventHandlers.onSidecarToggle = sidecarToggleHandler;

    service.setupNodeTemplate(diagram);
    const nodeTemplate = diagram.nodeTemplate as unknown as MockGoObject;
    const sidecarToggle = findMockObject(nodeTemplate, value => value['name'] === 'SIDECAR_TOGGLE');
    const click = sidecarToggle?.['click'] as ((event: go.InputEvent, obj: go.GraphObject) => void) | undefined;

    expect(click).toBeTypeOf('function');
    click?.(event, graphObject);

    expect(event.handled).toBe(true);
    expect(sidecarToggleHandler).toHaveBeenCalledWith('task-1', nodePart);
  });

  it('passes diagram div ownership separately from the virtual GoJS popover origin', () => {
    const link: ExternalSourceLink = {
      id: 'link-1',
      taskId: 'task-1',
      sourceType: 'siyuan-block',
      targetId: '20260426123456-abc1234',
      uri: 'siyuan://blocks/20260426123456-abc1234',
      sortOrder: 0,
      deletedAt: null,
      createdAt: '2026-05-18T00:00:00.000Z',
      updatedAt: '2026-05-18T00:00:00.000Z',
    };
    const diagramDiv = document.createElement('div');
    const diagram = {
      div: diagramDiv,
      scale: 2,
      transformDocToView: () => ({ x: 10, y: 20 }),
    };
    const event = { diagram, event: {}, handled: false } as unknown as go.InputEvent;
    const shape = { fill: '', stroke: '' };
    const object = {
      part: { data: { siyuanLink: link } },
      getDocumentBounds: () => ({ isReal: () => true, x: 1, y: 2, width: 4, height: 5 }),
      findObject: () => shape,
    } as unknown as go.GraphObject;
    const handlers = service as unknown as {
      handleSiyuanBadgeMouseEnter(event: go.InputEvent, object: go.GraphObject): void;
      handleSiyuanBadgeMouseLeave(event: go.InputEvent, object: go.GraphObject): void;
      handleSiyuanBadgeClick(event: go.InputEvent, object: go.GraphObject): void;
    };

    handlers.handleSiyuanBadgeMouseEnter(event, object);
    handlers.handleSiyuanBadgeMouseLeave(event, object);
    handlers.handleSiyuanBadgeClick(event, object);
    service.closeSiyuanPopover(diagramDiv);

    const [, virtualOrigin, openOwner] = siyuanPopover.scheduleOpen.mock.calls[0] ?? [];
    expect(virtualOrigin).toEqual(expect.objectContaining({ x: 10, y: 20, width: 8, height: 10 }));
    expect(virtualOrigin).not.toBe(diagramDiv);
    expect(openOwner).toBe(diagramDiv);
    expect(siyuanPopover.scheduleClose).toHaveBeenCalledWith(diagramDiv);
    expect(siyuanPopover.openNow).toHaveBeenCalledWith(link, virtualOrigin, diagramDiv);
    expect(siyuanPopover.closeForOwner).toHaveBeenCalledWith(diagramDiv);
  });

  it('does not globally close a popover when a flow diagram owner closes', () => {
    const owner = document.createElement('div');

    service.closeSiyuanPopover(owner);

    expect(siyuanPopover.closeForOwner).toHaveBeenCalledWith(owner);
  });
});
