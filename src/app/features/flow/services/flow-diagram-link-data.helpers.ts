import { LAYOUT_CONFIG } from '../../../../config/layout.config';
import type { Project, Task } from '../../../../models';
import type { FlowRelationDisplayOptions, GoJSLinkData } from './flow-diagram-config.service';

export interface FlowLinkDataSeedInput {
  tasks: readonly Task[];
  project: Pick<Project, 'connections'>;
  tasksToShow: readonly Task[];
  relationDisplay: FlowRelationDisplayOptions;
}

export interface FlowLinkDataSeed {
  linkDataArray: GoJSLinkData[];
  crossTreeLinksToStagger: GoJSLinkData[];
  taskStageMap: Map<string, number | null>;
  stageNodeCount: Map<number, number>;
}

export function buildFlowLinkDataSeed(input: FlowLinkDataSeedInput): FlowLinkDataSeed {
  const linkDataArray = createParentChildLinks(input.tasksToShow);
  const parentChildPairs = createParentChildPairKeys(input.tasks);
  const taskIdSet = new Set(input.tasksToShow.map(task => task.id));
  const taskStageMap = createTaskStageMap(input.tasksToShow);
  const stageNodeCount = createStageNodeCount(input.tasksToShow);
  const crossTreeLinksToStagger: GoJSLinkData[] = [];

  for (const connection of input.project.connections) {
    if (connection.deletedAt) continue;

    const pairKey = `${connection.source}->${connection.target}`;
    if (
      parentChildPairs.has(pairKey)
      || !taskIdSet.has(connection.source)
      || !taskIdSet.has(connection.target)
      || !shouldShowCrossTreeLink(connection, input.relationDisplay)
    ) {
      continue;
    }

    const linkData = createCrossTreeLinkData(connection);
    linkDataArray.push(linkData);
    crossTreeLinksToStagger.push(linkData);
  }

  return {
    linkDataArray,
    crossTreeLinksToStagger,
    taskStageMap,
    stageNodeCount,
  };
}

export function createParentChildPairKeys(tasks: readonly Task[]): Set<string> {
  const parentChildPairs = new Set<string>();
  for (const task of tasks) {
    if (task.parentId) {
      parentChildPairs.add(`${task.parentId}->${task.id}`);
    }
  }
  return parentChildPairs;
}

export function createTaskStageMap(tasksToShow: readonly Task[]): Map<string, number | null> {
  return new Map(tasksToShow.map(task => [task.id, task.stage]));
}

export function createStageNodeCount(tasksToShow: readonly Task[]): Map<number, number> {
  const stageNodeCount = new Map<number, number>();
  for (const task of tasksToShow) {
    if (task.stage === null) continue;
    stageNodeCount.set(task.stage, (stageNodeCount.get(task.stage) ?? 0) + 1);
  }
  return stageNodeCount;
}

function createParentChildLinks(tasksToShow: readonly Task[]): GoJSLinkData[] {
  return tasksToShow
    .filter(task => task.parentId)
    .map(task => ({
      key: `${task.parentId}-${task.id}`,
      from: task.parentId!,
      to: task.id,
      isCrossTree: false,
    }));
}

function createCrossTreeLinkData(connection: Project['connections'][number]): GoJSLinkData {
  return {
    key: `cross-${connection.source}-${connection.target}`,
    from: connection.source,
    to: connection.target,
    isCrossTree: true,
    category: 'crossTree',
    title: connection.title || '',
    description: connection.description || '',
    labelSegmentFraction: LAYOUT_CONFIG.AUTO_LAYOUT_CROSS_TREE_LABEL_TARGET_SIDE_FRACTION,
    labelSegmentOffsetY: 0,
  };
}

function shouldShowCrossTreeLink(
  connection: Project['connections'][number],
  relationDisplay: FlowRelationDisplayOptions,
): boolean {
  if (relationDisplay.relationDisplayMode === 'all') return true;
  if (relationDisplay.relationDisplayMode === 'hidden') return false;

  const focusedTaskId = relationDisplay.focusedTaskId;
  if (!focusedTaskId) return false;
  return connection.source === focusedTaskId || connection.target === focusedTaskId;
}
