import * as go from 'gojs';
import { GojsLinkingToolExt, GojsMake } from './flow-template.types';

interface ConfigureLinkingToolInput {
  diagram: go.Diagram;
  allowedPortIds: string[];
  freeAngleLinkPoint: go.Link['getLinkPoint'];
  make: GojsMake;
}

type EdgePort = go.GraphObject & { portId?: string };

const configuredLinkingTools = new WeakSet<go.LinkingTool>();

export function configureLinkingTool(input: ConfigureLinkingToolInput): void {
  const linkingTool = input.diagram.toolManager.linkingTool;

  if (!configuredLinkingTools.has(linkingTool)) {
    installCanStartGuard(linkingTool, input.allowedPortIds);
    installMainPortActivation(linkingTool, input.allowedPortIds);
    installSelfLinkGuard(linkingTool);
    installDeactivateCleanup(linkingTool);
    configuredLinkingTools.add(linkingTool);
  }

  linkingTool.temporaryLink = createTemporaryLink(input.make, input.freeAngleLinkPoint);
  setTemporarySpots(linkingTool);
}

function installCanStartGuard(linkingTool: go.LinkingTool, allowedPortIds: string[]): void {
  const originalCanStart = linkingTool.canStart;
  linkingTool.canStart = function() {
    if (!originalCanStart.call(this)) return false;
    const port = findEdgePortAtPointer(this, allowedPortIds);
    return !!port?.portId && allowedPortIds.includes(port.portId);
  };
}

function installMainPortActivation(linkingTool: go.LinkingTool, allowedPortIds: string[]): void {
  const originalDoActivate = linkingTool.doActivate;
  linkingTool.doActivate = function() {
    originalDoActivate.call(this);

    const toolExt = this as go.LinkingTool & GojsLinkingToolExt;
    const pointerPort = findEdgePortAtPointer(this, allowedPortIds);
    const startPort = pointerPort ||
      toolExt.startPort ||
      toolExt.originalFromPort ||
      toolExt.fromPort;
    const edgePortObj = resolveEdgePortObject(startPort, pointerPort, toolExt, allowedPortIds);

    activateMainPortForLinking(this, toolExt, edgePortObj, allowedPortIds);
  };
}

function findEdgePortAtPointer(
  tool: go.LinkingTool,
  allowedPortIds: string[]
): EdgePort | null {
  const dia = tool.diagram;
  const input = dia?.lastInput;
  if (!dia || !input) return null;

  return dia.findObjectAt(input.documentPoint, (obj: go.GraphObject | null) => {
    const portId = readPortId(obj);
    return portId.length > 0 && allowedPortIds.includes(portId) ? obj : null;
  }, null) as EdgePort | null;
}

function resolveEdgePortObject(
  startPort: go.GraphObject | string | null | undefined,
  pointerPort: EdgePort | null,
  toolExt: go.LinkingTool & GojsLinkingToolExt,
  allowedPortIds: string[]
): EdgePort | null {
  if (pointerPort) {
    return pointerPort;
  }

  if (typeof startPort === 'object' && isAllowedEdgePort(startPort, allowedPortIds)) {
    return startPort;
  }

  if (typeof startPort !== 'string' || !allowedPortIds.includes(startPort)) {
    return null;
  }

  const originalNode = toolExt.originalFromNode || toolExt.fromNode;
  return originalNode instanceof go.Node
    ? originalNode.findPort(startPort) as EdgePort | null
    : null;
}

function activateMainPortForLinking(
  tool: go.LinkingTool,
  toolExt: go.LinkingTool & GojsLinkingToolExt,
  edgePortObj: EdgePort | null,
  allowedPortIds: string[]
): void {
  if (!edgePortObj?.portId || !allowedPortIds.includes(edgePortObj.portId)) {
    return;
  }

  const node = edgePortObj.part;
  if (!(node instanceof go.Node)) {
    return;
  }

  const mainPort = node.findPort('');
  if (!mainPort) {
    return;
  }

  prepareMainPort(toolExt, mainPort);
  retargetTemporaryLink(tool, node);
}

function prepareMainPort(
  toolExt: go.LinkingTool & GojsLinkingToolExt,
  mainPort: go.GraphObject
): void {
  toolExt._originNode = mainPort.part instanceof go.Node ? mainPort.part : null;
  toolExt._tempMainPort = mainPort;
  toolExt._savedFromLinkable = mainPort.fromLinkable ?? false;
  toolExt._savedToLinkable = mainPort.toLinkable ?? false;
  mainPort.fromLinkable = true;
  toolExt.startPort = mainPort;
  toolExt.originalFromPort = mainPort;
  toolExt.fromPort = mainPort;
}

function retargetTemporaryLink(tool: go.LinkingTool, node: go.Node): void {
  if (!tool.temporaryLink) {
    return;
  }

  (tool.temporaryLink as go.Link & { fromNode?: go.Node }).fromNode = node;
  tool.temporaryLink.fromPortId = '';
  tool.temporaryLink.fromSpot = go.Spot.AllSides;
  tool.temporaryLink.toSpot = go.Spot.AllSides;
  tool.temporaryLink.invalidateRoute();
}

function installSelfLinkGuard(linkingTool: go.LinkingTool): void {
  const originalIsValidLink = linkingTool.isValidLink;
  linkingTool.isValidLink = function(
    fromNode: go.Node,
    fromPort: go.GraphObject,
    toNode: go.Node,
    toPort: go.GraphObject
  ): boolean {
    if (fromNode === toNode) return false;
    return originalIsValidLink.call(this, fromNode, fromPort, toNode, toPort);
  };
}

function createTemporaryLink($: GojsMake, freeAngleLinkPoint: go.Link['getLinkPoint']): go.Link {
  return $(go.Link,
    {
      layerName: 'Tool',
      getLinkPoint: freeAngleLinkPoint,
      curve: go.Link.Bezier,
    },
    $(go.Shape, {
      stroke: '#78716C',
      strokeWidth: 6,
      strokeDashArray: [4, 4],
      strokeCap: 'round',
      strokeJoin: 'round',
    }),
    $(go.Shape, {
      toArrow: 'Standard',
      fill: '#78716C',
      stroke: '#78716C',
      strokeWidth: 7,
      strokeCap: 'round',
      strokeJoin: 'round',
      scale: 0.9,
      segmentOrientation: go.Orientation.Along,
      segmentIndex: -1,
      alignmentFocus: go.Spot.Right,
    })
  ) as go.Link;
}

function installDeactivateCleanup(linkingTool: go.LinkingTool): void {
  const originalDoDeactivate = linkingTool.doDeactivate;
  linkingTool.doDeactivate = function() {
    const toolExt = this as go.LinkingTool & GojsLinkingToolExt;
    restoreTemporaryMainPort(toolExt);
    originalDoDeactivate.call(this);
    resetLinkingToolState(toolExt);
  };
}

function restoreTemporaryMainPort(toolExt: go.LinkingTool & GojsLinkingToolExt): void {
  const mainPort = toolExt._tempMainPort;
  if (!mainPort) {
    return;
  }

  mainPort.fromLinkable = toolExt._savedFromLinkable ?? false;
  mainPort.toLinkable = toolExt._savedToLinkable ?? false;
  toolExt._tempMainPort = null;
}

function resetLinkingToolState(toolExt: go.LinkingTool & GojsLinkingToolExt): void {
  toolExt._originNode = null;
  toolExt.startPort = null;
  toolExt.fromPort = null;
  toolExt.originalFromPort = null;
  toolExt._savedFromLinkable = undefined;
  toolExt._savedToLinkable = undefined;
}

function setTemporarySpots(linkingTool: go.LinkingTool): void {
  (linkingTool as go.LinkingTool & { temporaryFromSpot?: go.Spot }).temporaryFromSpot =
    go.Spot.AllSides;
  (linkingTool as go.LinkingTool & { temporaryToSpot?: go.Spot }).temporaryToSpot =
    go.Spot.AllSides;
}

function readPortId(obj: go.GraphObject | null | undefined): string {
  const portId = (obj as EdgePort | null | undefined)?.portId;
  return typeof portId === 'string' ? portId : '';
}

function isAllowedEdgePort(
  obj: go.GraphObject | null | undefined,
  allowedPortIds: string[]
): obj is EdgePort {
  const portId = readPortId(obj);
  return portId.length > 0 && allowedPortIds.includes(portId);
}
