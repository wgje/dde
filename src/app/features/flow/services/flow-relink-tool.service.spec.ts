import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as go from 'gojs';

import { LoggerService } from '../../../../services/logger.service';
import { UiStateService } from '../../../../services/ui-state.service';
import { FlowDiagramConfigService } from './flow-diagram-config.service';
import { enhanceRelinkTargetFinding } from './flow-relink-target-finding.helpers';
import { FlowRelinkToolService } from './flow-relink-tool.service';
import { LinkStyleConfig } from './flow-template.types';

const linkStyleConfig: LinkStyleConfig = {
  defaultStroke: '#78716c',
  parentChildStroke: '#78716c',
  selectedStroke: '#8b5cf6',
  strokeWidth: 2,
  captureRadius: 24,
};

describe('FlowRelinkToolService', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        FlowRelinkToolService,
        { provide: UiStateService, useValue: {} },
        { provide: FlowDiagramConfigService, useValue: {} },
        {
          provide: LoggerService,
          useValue: {
            category: () => ({
              debug: vi.fn(),
              info: vi.fn(),
              warn: vi.fn(),
              error: vi.fn(),
            }),
          },
        },
      ],
    });
  });

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it('重复配置 RelinkingTool 不应叠加目标查找和自连接校验包装链', () => {
    const service = TestBed.inject(FlowRelinkToolService);
    const diagram = new go.Diagram();
    const linkingTool = diagram.toolManager.linkingTool;
    const relinkingTool = diagram.toolManager.relinkingTool;
    const relinkingAsLinkingTool = relinkingTool as unknown as go.LinkingTool;
    const freeAngleLinkPoint = (() => new go.Point(0, 0)) as go.Link['getLinkPoint'];
    const make = go.GraphObject.make;

    service.configureRelinkingTool(
      diagram,
      ['T', 'B', 'L', 'R'],
      linkStyleConfig,
      freeAngleLinkPoint,
      3,
      make
    );
    const firstLinkingFindTargetPort = linkingTool.findTargetPort;
    const firstRelinkingFindTargetPort = relinkingAsLinkingTool.findTargetPort;
    const firstRelinkingIsValidLink = relinkingTool.isValidLink;

    service.configureRelinkingTool(
      diagram,
      ['T', 'B', 'L', 'R'],
      linkStyleConfig,
      freeAngleLinkPoint,
      6,
      make
    );

    expect(linkingTool.findTargetPort).toBe(firstLinkingFindTargetPort);
    expect(relinkingAsLinkingTool.findTargetPort).toBe(firstRelinkingFindTargetPort);
    expect(relinkingTool.isValidLink).toBe(firstRelinkingIsValidLink);
  });
});

describe('enhanceRelinkTargetFinding', () => {
  it('重复增强同一 LinkingTool 时复用同一 wrapper 并保留原始 fallback', () => {
    const tool = {
      diagram: null,
    } as unknown as go.LinkingTool;
    let originalCalls = 0;
    tool.findTargetPort = function() {
      originalCalls += 1;
      return null;
    };

    enhanceRelinkTargetFinding(tool, tool.findTargetPort, {
      allowedPortIds: ['T', 'B', 'L', 'R'],
      linkStyleConfig,
      pointerTolerance: 3,
    });
    const firstFindTargetPort = tool.findTargetPort;

    enhanceRelinkTargetFinding(tool, tool.findTargetPort, {
      allowedPortIds: ['T', 'B', 'L', 'R'],
      linkStyleConfig,
      pointerTolerance: 6,
    });

    expect(tool.findTargetPort).toBe(firstFindTargetPort);

    tool.findTargetPort(false);
    expect(originalCalls).toBe(1);
  });
});
