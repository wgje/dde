import * as go from 'gojs';
import { flowTemplateEventHandlers } from './flow-template-events';
import { GojsClickHandler, GojsMake, LinkStyleConfig } from './flow-template.types';
import { createConnectionLabelPanel } from './flow-link-template-panel.helpers';
import { FlowDiagramConfigService } from './flow-diagram-config.service';
import { FlowRelinkToolService } from './flow-relink-tool.service';

interface LinkTemplateSetupInput {
  diagram: go.Diagram;
  isMobile: boolean;
  allowedPortIds: string[];
  linkStyleConfig: LinkStyleConfig;
  freeAngleLinkPoint: go.Link['getLinkPoint'];
  pointerTolerance: number;
  make: GojsMake;
  configService: FlowDiagramConfigService;
  relinkToolService: FlowRelinkToolService;
  configureLinkingTool: (
    diagram: go.Diagram,
    allowedPortIds: string[],
    freeAngleLinkPoint: go.Link['getLinkPoint'],
    make: GojsMake
  ) => void;
}

export function setupLinkTemplates(input: LinkTemplateSetupInput): void {
  input.configureLinkingTool(
    input.diagram,
    input.allowedPortIds,
    input.freeAngleLinkPoint,
    input.make
  );
  input.relinkToolService.configureRelinkingTool(
    input.diagram,
    input.allowedPortIds,
    input.linkStyleConfig,
    input.freeAngleLinkPoint,
    input.pointerTolerance,
    input.make
  );

  input.diagram.linkTemplate = createBaseLinkTemplate(input);
  input.diagram.linkTemplateMap.add('crossTree', createCrossTreeLinkTemplate(input));
}

function createBaseLinkTemplate(input: LinkTemplateSetupInput): go.Link {
  const $ = input.make;
  return $(go.Link,
    createLinkTemplateConfig(input),
    new go.Binding('curviness', 'curviness'),
    new go.Binding('points').makeTwoWay(),
    ...input.configService.getLinkMainShapesConfig($, input.isMobile)
  ) as go.Link;
}

function createCrossTreeLinkTemplate(input: LinkTemplateSetupInput): go.Link {
  const $ = input.make;
  return $(go.Link,
    createLinkTemplateConfig(input),
    new go.Binding('curviness', 'curviness'),
    new go.Binding('points').makeTwoWay(),
    ...input.configService.getLinkMainShapesConfig($, input.isMobile),
    createConnectionLabelPanel($, input.isMobile)
  ) as go.Link;
}

function createLinkTemplateConfig(input: LinkTemplateSetupInput): go.ObjectData {
  return {
    layerName: 'Links',
    routing: go.Link.Normal,
    curve: go.Link.Bezier,
    adjusting: go.Link.End,
    getLinkPoint: input.freeAngleLinkPoint,
    toShortLength: input.configService.linkConfig.toShortLength,
    fromEndSegmentLength: 22,
    toEndSegmentLength: 22,
    selectable: true,
    selectionAdorned: true,
    relinkableFrom: true,
    relinkableTo: true,
    reshapable: true,
    resegmentable: false,
    ...createDesktopLinkClickConfig(input.isMobile),
    contextMenu: createLinkContextMenu(input.make),
  };
}

function createDesktopLinkClickConfig(isMobile: boolean): go.ObjectData {
  if (isMobile) {
    return {};
  }

  return {
    click: ((e: go.InputEvent, link: go.GraphObject) => {
      if (e.handled) return;
      e.handled = true;
      flowTemplateEventHandlers.onLinkClick?.(link as go.Link);
    }) as GojsClickHandler,
  };
}

function createLinkContextMenu($: GojsMake): go.Adornment {
  return $(go.Adornment, 'Vertical',
    $('ContextMenuButton',
      $(go.TextBlock, '删除连接', { margin: 5 }),
      {
        click: ((e: go.InputEvent, obj: go.GraphObject) => {
          const link = (obj.part as go.Adornment)?.adornedPart;
          if ((link as go.Link)?.data) {
            flowTemplateEventHandlers.onLinkDeleteRequest?.(link as go.Link);
          }
        }) as GojsClickHandler,
      }
    )
  );
}
