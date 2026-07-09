import { LAYOUT_CONFIG } from '../../../../config';
import { flowTemplateEventHandlers } from './flow-template-events';
import { AvoidsLinksRouter } from '../vendor/AvoidsLinksRouter';
import * as go from 'gojs';

interface FlowDiagramSetupLogger {
  debug(message: string, context?: unknown): void;
  info(message: string, context?: unknown): void;
}

export function createFlowDiagram(container: HTMLDivElement): go.Diagram {
  const $ = go.GraphObject.make;

  return $(go.Diagram, container, {
    "undoManager.isEnabled": false,
    "animationManager.isEnabled": false,
    "allowDrop": true,
    layout: $(go.Layout),
    "autoScale": go.Diagram.None,
    "initialAutoScale": go.Diagram.None,
    "scrollMode": go.Diagram.InfiniteScroll,
    "scrollMargin": new go.Margin(Infinity, Infinity, Infinity, Infinity),
    "draggingTool.isGridSnapEnabled": false,
    "fixedBounds": new go.Rect(NaN, NaN, NaN, NaN),
    "computePixelRatio": () => window.devicePixelRatio || 1,
    "toolManager.hoverDelay": 200,
  });
}

export function initializeFlowDiagramModel(diagram: go.Diagram): void {
  diagram.model = new go.GraphLinksModel([], [], {
    linkKeyProperty: 'key',
    nodeKeyProperty: 'key',
    linkFromPortIdProperty: 'fromPortId',
    linkToPortIdProperty: 'toPortId',
    linkCategoryProperty: 'category',
  });
}

export function installFlowDiagramRouters(diagram: go.Diagram, logger: FlowDiagramSetupLogger): void {
  if (!LAYOUT_CONFIG.AUTO_LAYOUT_ENABLE_AVOIDS_LINKS_ROUTER) {
    return;
  }

  diagram.routers.add(new AvoidsLinksRouter({
    linkSpacing: LAYOUT_CONFIG.AUTO_LAYOUT_ROUTER_LINK_SPACING_PX,
    avoidsNodes: true,
  }));
  logger.info('AvoidsLinksRouter 已装配', {
    linkSpacing: LAYOUT_CONFIG.AUTO_LAYOUT_ROUTER_LINK_SPACING_PX,
  });
}

export function setupFlowDiagramCommandInterception(
  diagram: go.Diagram,
  logger: FlowDiagramSetupLogger,
): void {
  const originalDoKeyDown = diagram.commandHandler.doKeyDown.bind(diagram.commandHandler);

  diagram.commandHandler.canDeleteSelection = () => false;
  diagram.commandHandler.canCopySelection = () => false;
  diagram.commandHandler.canPasteSelection = () => false;

  diagram.commandHandler.doKeyDown = () => {
    const e = diagram.lastInput;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      logger.debug('拦截 Delete 键，触发自定义删除事件');
      flowTemplateEventHandlers.onDeleteKeyPressed?.();
      return;
    }
    originalDoKeyDown();
  };

  logger.info('GoJS 命令拦截已配置：删除/复制/粘贴行为已禁用');
}
