import type * as go from 'gojs';
import type { GoJSDiagramData, GoJSLinkData } from './flow-diagram-config.service';

export interface DiagramDataMaps {
  currentNodeMap: Map<string, go.ObjectData>;
  currentLinkMap: Map<string, go.ObjectData>;
}

type FlowLinkDataWithPorts = GoJSLinkData & {
  fromPortId: string;
  toPortId: string;
  points?: unknown;
};
export function collectCurrentDiagramMaps(model: go.GraphLinksModel): DiagramDataMaps {
  const currentNodeMap = new Map<string, go.ObjectData>();
  (model.nodeDataArray || []).forEach((node: go.ObjectData) => {
    if (node.key) currentNodeMap.set(node.key as string, node);
  });
  const currentLinkMap = new Map<string, go.ObjectData>();
  (model.linkDataArray || []).forEach((link: go.ObjectData) => {
    if (link.key) currentLinkMap.set(link.key as string, link);
  });
  return { currentNodeMap, currentLinkMap };
}

export function applyDiagramData(
  diagram: go.Diagram,
  model: go.GraphLinksModel,
  diagramData: GoJSDiagramData,
  maps: DiagramDataMaps,
): void {
  const mutate = prepareDiagramMutation(model, diagramData, maps);
  const undoManager = model.undoManager;
  assertIdleMergeBoundary(diagram, model);
  const previousIsEnabled = undoManager.isEnabled;
  const previousMaxHistoryLength = undoManager.maxHistoryLength;
  const previousDiagramSkip = diagram.skipsUndoManager;
  const previousModelSkip = model.skipsUndoManager;
  try {
    undoManager.maxHistoryLength = 0;
    undoManager.isEnabled = true;
    if (!model.startTransaction('flow-data-update')) {
      throw new Error('Flow data merge could not start an isolated transaction');
    }
    try {
      mutate();
      model.commitTransaction('flow-data-update');
    } catch (error) {
      try {
        model.rollbackTransaction();
      } finally {
        throw error;
      }
    }
  } finally {
    undoManager.isEnabled = previousIsEnabled;
    undoManager.maxHistoryLength = previousMaxHistoryLength;
    diagram.skipsUndoManager = previousDiagramSkip;
    model.skipsUndoManager = previousModelSkip;
  }
}

function prepareDiagramMutation(
  model: go.GraphLinksModel,
  diagramData: GoJSDiagramData,
  maps: DiagramDataMaps,
): () => void {
  const nextNodeMap = new Map<string, go.ObjectData>();
  diagramData.nodeDataArray.forEach(node => nextNodeMap.set(node.key, node as go.ObjectData));
  const linkDataWithPorts = diagramData.linkDataArray.map(link =>
    buildLinkDataWithPorts(link, maps.currentLinkMap, maps.currentNodeMap, nextNodeMap)
  );
  const nodeKeys = new Set(diagramData.nodeDataArray.map(node => node.key));
  const linkKeys = new Set(diagramData.linkDataArray.map(link => link.key));
  const staleNodes = model.nodeDataArray.filter(node => !nodeKeys.has(node.key as string));
  const staleLinks = model.linkDataArray.filter(link => !linkKeys.has(link.key as string));
  return () => {
    model.mergeNodeDataArray(diagramData.nodeDataArray);
    model.mergeLinkDataArray(linkDataWithPorts);
    clearDiscardedLinkPoints(model, linkDataWithPorts);
    staleNodes.forEach(node => model.removeNodeData(node));
    staleLinks.forEach(link => model.removeLinkData(link));
  };
}

function assertIdleMergeBoundary(diagram: go.Diagram, model: go.GraphLinksModel): void {
  const undoManager = model.undoManager;
  if (
    diagram.model !== model
    || undoManager.isEnabled
    || undoManager.history.count !== 0
    || undoManager.historyIndex !== -1
    || undoManager.transactionLevel !== 0
    || undoManager.currentTransaction !== null
    || diagram.skipsUndoManager
    || model.skipsUndoManager
  ) {
    throw new Error('Flow data merge requires an idle, empty undo boundary');
  }
}

function clearDiscardedLinkPoints(
  model: go.GraphLinksModel,
  links: readonly FlowLinkDataWithPorts[],
): void {
  for (const link of links) {
    if (link.points !== undefined) continue;
    const mergedLink = model.linkDataArray.find(candidate => candidate.key === link.key);
    if (mergedLink?.points !== undefined) {
      model.setDataProperty(mergedLink, 'points', undefined);
    }
  }
}

function buildLinkDataWithPorts(
  link: GoJSLinkData,
  currentLinkMap: ReadonlyMap<string, go.ObjectData>,
  currentNodeMap: ReadonlyMap<string, go.ObjectData>,
  nextNodeMap: ReadonlyMap<string, go.ObjectData>,
): FlowLinkDataWithPorts {
  const existingLink = currentLinkMap.get(link.key);
  const points = shouldPreserveLinkPoints(link, existingLink, currentNodeMap, nextNodeMap)
    ? existingLink?.points
    : undefined;

  return {
    ...link,
    points,
    fromPortId: '',
    toPortId: '',
  };
}

function shouldPreserveLinkPoints(
  nextLink: GoJSLinkData,
  currentLink: go.ObjectData | undefined,
  currentNodeMap: ReadonlyMap<string, go.ObjectData>,
  nextNodeMap: ReadonlyMap<string, go.ObjectData>,
): boolean {
  if (currentLink?.points === undefined || currentLink.points === null) return false;
  if (currentLink.from !== nextLink.from || currentLink.to !== nextLink.to) return false;
  if (currentLink.category !== nextLink.category || currentLink.curviness !== nextLink.curviness) return false;
  return hasStableNodeLoc(currentNodeMap, nextNodeMap, nextLink.from)
    && hasStableNodeLoc(currentNodeMap, nextNodeMap, nextLink.to);
}

function hasStableNodeLoc(
  currentNodeMap: ReadonlyMap<string, go.ObjectData>,
  nextNodeMap: ReadonlyMap<string, go.ObjectData>,
  key: string,
): boolean {
  const currentLoc = currentNodeMap.get(key)?.loc;
  const nextLoc = nextNodeMap.get(key)?.loc;
  return currentLoc !== undefined && nextLoc !== undefined && currentLoc === nextLoc;
}
