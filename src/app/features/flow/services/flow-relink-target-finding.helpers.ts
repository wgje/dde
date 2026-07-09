import * as go from 'gojs';
import { GojsLinkingToolExt, GojsNodeExt, LinkStyleConfig } from './flow-template.types';
import {
  distanceToBoundsSquared,
  expandBounds,
  isPointInsideBounds,
} from './flow-relink-tool-geometry.helpers';

type LinkToolWithRelinkState = go.LinkingTool & GojsLinkingToolExt & {
  toNode?: go.Node | null;
  originalToNode?: go.Node | null;
  originalFromNode?: go.Node | null;
  temporaryLink?: go.Link | null;
};

export interface RelinkTargetFindingOptions {
  allowedPortIds: string[];
  linkStyleConfig: LinkStyleConfig;
  pointerTolerance: number;
}

interface RelinkTargetFindingState {
  original: go.LinkingTool['findTargetPort'];
  options: RelinkTargetFindingOptions;
}

const enhancedRelinkTargetFinders = new WeakMap<go.LinkingTool, RelinkTargetFindingState>();

export function enhanceRelinkTargetFinding(
  tool: go.LinkingTool,
  original: go.LinkingTool['findTargetPort'],
  options: RelinkTargetFindingOptions,
): void {
  const existing = enhancedRelinkTargetFinders.get(tool);
  if (existing) {
    existing.options = options;
    return;
  }

  const state: RelinkTargetFindingState = { original, options };
  enhancedRelinkTargetFinders.set(tool, state);

  tool.findTargetPort = function(fromEnd: boolean) {
    const finder = new RelinkTargetFinder(state.options);
    const node = finder.findNodeNearPointer(this, fromEnd);
    const directPort = finder.getMainPort(node);
    const toolExt = this as LinkToolWithRelinkState;
    const originNode = toolExt.fromNode
      || toolExt.originalFromNode
      || toolExt.temporaryLink?.fromNode
      || toolExt._originNode;

    if (node && originNode && node === originNode) {
      return null;
    }

    if (directPort) {
      return directPort;
    }

    return finder.normalizePort(state.original.call(this, fromEnd));
  };
}

class RelinkTargetFinder {
  private readonly radiusSquared: number;

  constructor(private readonly options: RelinkTargetFindingOptions) {
    this.radiusSquared = options.linkStyleConfig.captureRadius * options.linkStyleConfig.captureRadius;
  }

  findNodeNearPointer(tool: go.LinkingTool, fromEnd: boolean): go.Node | null {
    const dia = tool.diagram;
    const pointer = dia?.lastInput?.documentPoint;
    if (!dia || !pointer) {
      return null;
    }

    const excludeNode = this.resolveExcludeNode(tool as LinkToolWithRelinkState, fromEnd);
    return this.findDirectNode(dia, pointer, excludeNode)
      ?? this.findClosestNodeInCaptureRect(dia, pointer, excludeNode)
      ?? this.findClosestNodeInDiagram(dia, pointer, excludeNode);
  }

  getMainPort(node: go.Node | null): go.GraphObject | null {
    if (!node) {
      return null;
    }

    const mainPort = node.findPort('');
    return mainPort?.toLinkable ? mainPort : null;
  }

  normalizePort(port: go.GraphObject | null): go.GraphObject | null {
    if (!port) {
      return null;
    }

    const node = port.part;
    if (node instanceof go.Node) {
      const portId = port.portId || '';
      if (portId === '') {
        return port.toLinkable ? port : this.getMainPort(node);
      }
      if (this.options.allowedPortIds.includes(portId)) {
        return this.getMainPort(node) || port;
      }
    }

    return port;
  }

  private resolveExcludeNode(tool: LinkToolWithRelinkState, fromEnd: boolean): go.Node | null | undefined {
    return fromEnd
      ? (tool.toNode || tool.originalToNode)
      : (tool.fromNode || tool.originalFromNode || tool.temporaryLink?.fromNode || tool._originNode);
  }

  private findDirectNode(
    dia: go.Diagram,
    pointer: go.Point,
    excludeNode: go.Node | null | undefined,
  ): go.Node | null {
    let found: go.Node | null = null;
    dia.findPartsAt(pointer, true).each((part: go.Part) => {
      if (
        !found
        && part instanceof go.Node
        && this.isRealNode(part, excludeNode ?? null)
        && this.isPointerNearBody(part, pointer)
      ) {
        found = part;
      }
    });
    return found;
  }

  private findClosestNodeInCaptureRect(
    dia: go.Diagram,
    pointer: go.Point,
    excludeNode: go.Node | null | undefined,
  ): go.Node | null {
    const captureRadius = this.options.linkStyleConfig.captureRadius;
    const searchRect = new go.Rect(
      pointer.x - captureRadius,
      pointer.y - captureRadius,
      captureRadius * 2,
      captureRadius * 2,
    );
    return this.findClosestNode(dia.findPartsIn(searchRect, true, true), pointer, excludeNode);
  }

  private findClosestNodeInDiagram(
    dia: go.Diagram,
    pointer: go.Point,
    excludeNode: go.Node | null | undefined,
  ): go.Node | null {
    return this.findClosestNode(dia.nodes, pointer, excludeNode);
  }

  private findClosestNode(
    parts: go.Iterable<go.Part>,
    pointer: go.Point,
    excludeNode: go.Node | null | undefined,
  ): go.Node | null {
    let closest: go.Node | null = null;
    let closestDist = Number.POSITIVE_INFINITY;
    const iterator = parts.iterator;
    while (iterator.next()) {
      const part = iterator.value;
      if (!(part instanceof go.Node) || !this.isRealNode(part, excludeNode ?? null)) {
        continue;
      }
      if (!this.isPointerNearBody(part, pointer)) {
        continue;
      }
      const dist = this.distanceToBodySquared(part, pointer);
      if (dist <= this.radiusSquared && dist < closestDist) {
        closestDist = dist;
        closest = part;
      }
    }
    return closest;
  }

  private isRealNode(node: go.Node | null, excludeNode: go.Node | null): node is go.Node {
    if (!node || node === excludeNode) {
      return false;
    }

    const nodeExt = node as go.Node & GojsNodeExt;
    const hasData = !!nodeExt.data;
    const hasBody = !!node.findObject?.('BODY');
    if (!hasData && !hasBody) {
      return false;
    }

    return Boolean(this.getMainPort(node));
  }

  private isPointerNearBody(node: go.Node, pointer: go.Point): boolean {
    const bounds = this.getNodeBodyBounds(node);
    return Boolean(bounds && isPointInsideBounds(pointer, expandBounds(bounds, this.options.pointerTolerance)));
  }

  private distanceToBodySquared(node: go.Node, pointer: go.Point): number {
    const bounds = this.getNodeBodyBounds(node);
    return bounds ? distanceToBoundsSquared(pointer, bounds) : Number.POSITIVE_INFINITY;
  }

  private getNodeBodyBounds(node: go.Node): go.Rect | null {
    const bodyPanel = node.findObject('BODY') as go.Panel;
    if (bodyPanel) {
      const panelBounds = bodyPanel.getDocumentBounds();
      if (panelBounds.isReal()) {
        return panelBounds;
      }
    }

    const bounds = node.actualBounds;
    return bounds.isReal() ? bounds : null;
  }
}
