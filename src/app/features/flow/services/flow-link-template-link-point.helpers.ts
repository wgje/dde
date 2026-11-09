import * as go from 'gojs';
import {
  GojsGraphObjectExt,
  GojsLinkingToolExt,
  GojsNodeExt,
  GojsRelinkingToolExt,
} from './flow-template.types';

type ComputeNodeEdgePoint = (node: go.Node, targetPoint: go.Point) => go.Point;

export function createFreeAngleLinkPoint(
  computeNodeEdgePoint: ComputeNodeEdgePoint
): go.Link['getLinkPoint'] {
  return function(this: go.Link, node, port, _spot, from, _ortho, otherNode, otherPort) {
    const actualNode = resolveActualLinkPointNode(this, node, port, from);
    if (!actualNode) {
      return getFallbackDocumentPoint(this);
    }

    return computeNodeEdgePoint(
      actualNode,
      resolveTargetPoint(this, actualNode, otherNode, otherPort)
    );
  };
}

function resolveActualLinkPointNode(
  link: go.Link,
  node: go.Node | null,
  port: go.GraphObject | null,
  from: boolean
): go.Node | null {
  return resolveBoundLinkNode(link, from) ??
    resolveArgumentNode(node) ??
    resolvePortPartNode(port) ??
    resolveToolStateNode(link, from);
}

function resolveBoundLinkNode(link: go.Link, from: boolean): go.Node | null {
  if (from) {
    return link.fromNode?.data ? link.fromNode : null;
  }

  return link.toNode?.data ? link.toNode : null;
}

function resolveArgumentNode(node: go.Node | null): go.Node | null {
  return node instanceof go.Node && isUsableNode(node) ? node : null;
}

function resolvePortPartNode(port: go.GraphObject | null): go.Node | null {
  const portExt = port as (go.GraphObject & GojsGraphObjectExt) | null;
  return portExt?.part instanceof go.Node && isUsableNode(portExt.part)
    ? portExt.part
    : null;
}

function resolveToolStateNode(link: go.Link, from: boolean): go.Node | null {
  const diagram = link.diagram;
  if (!diagram) {
    return null;
  }

  return resolveLinkingToolNode(diagram, from) ??
    resolveRelinkingToolNode(diagram, from);
}

function resolveLinkingToolNode(diagram: go.Diagram, from: boolean): go.Node | null {
  const linkingTool = diagram.toolManager.linkingTool;
  if (!linkingTool.isActive) {
    return null;
  }

  const linkToolExt = linkingTool as go.LinkingTool & GojsLinkingToolExt;
  const originalPort = from
    ? (linkToolExt.originalFromPort || linkToolExt._tempMainPort)
    : linkToolExt.originalToPort;

  return resolvePortReference(diagram, originalPort);
}

function resolveRelinkingToolNode(diagram: go.Diagram, from: boolean): go.Node | null {
  const relinkingTool = diagram.toolManager.relinkingTool;
  if (!relinkingTool.isActive) {
    return null;
  }

  const relinkToolExt = relinkingTool as go.RelinkingTool & GojsRelinkingToolExt;
  const adornedLink = findRelinkingAdornedLink(diagram, relinkToolExt);
  if (!(adornedLink instanceof go.Link)) {
    return null;
  }

  const isRelinkingFrom = relinkToolExt.isForwards === false;
  const isRelinkingTo = relinkToolExt.isForwards === true;
  if (from) {
    return isRelinkingFrom ? null : adornedLink.fromNode;
  }

  return isRelinkingTo ? null : adornedLink.toNode;
}

function findRelinkingAdornedLink(
  diagram: go.Diagram,
  relinkToolExt: go.RelinkingTool & GojsRelinkingToolExt
): go.Link | null {
  let adornedLink = relinkToolExt.adornedLink ||
    relinkToolExt.adornedObject ||
    relinkToolExt.originalLink;

  if (!adornedLink && diagram.selection) {
    diagram.selection.each((part: go.Part) => {
      if (part instanceof go.Link && !adornedLink) {
        adornedLink = part;
      }
    });
  }

  return adornedLink instanceof go.Link ? adornedLink : null;
}

function resolvePortReference(
  diagram: go.Diagram,
  port: go.GraphObject | string | null | undefined
): go.Node | null {
  if (typeof port === 'string') {
    return diagram.findNodeForKey(port);
  }

  return port?.part instanceof go.Node ? port.part : null;
}

function isUsableNode(node: go.Node): boolean {
  const nodeExt = node as go.Node & GojsNodeExt;
  return !!nodeExt.data || !!nodeExt.findObject?.('BODY');
}

function resolveTargetPoint(
  link: go.Link,
  actualNode: go.Node,
  otherNode: go.Node | null,
  otherPort: go.GraphObject | null
): go.Point {
  const doc = actualNode.diagram;
  return otherPort?.getDocumentPoint(go.Spot.Center)
    || otherNode?.getDocumentPoint(go.Spot.Center)
    || doc?.lastInput?.documentPoint
    || link.diagram?.lastInput?.documentPoint
    || actualNode.getDocumentPoint(go.Spot.Center);
}

function getFallbackDocumentPoint(link: go.Link): go.Point {
  return link.diagram?.lastInput?.documentPoint ?? new go.Point();
}
