import { SUPERSCRIPT_DIGITS } from '../../../../config';
import type { FlowStyleConfig } from '../../../../config/flow-styles';
import type { Task } from '../../../../models';
import type { GoJSNodeData } from './flow-diagram-config.service';

export interface FlowNodeColors {
  nodeColor: string;
  borderColor: string;
  borderWidth: number;
  titleColor: string;
}

export function computeFlowNodeLocation(
  task: Pick<Task, 'id' | 'stage' | 'parentId' | 'x' | 'y'>,
  existingNodeMap: ReadonlyMap<string, {
    loc?: unknown;
    stage?: unknown;
    parentId?: unknown;
  }>,
  newNodeIndex: number,
): string {
  const existingNode = existingNodeMap.get(task.id);
  const topologyChanged = existingNode !== undefined && (
    'stage' in existingNode && existingNode.stage !== task.stage
    || 'parentId' in existingNode && existingNode.parentId !== task.parentId
  );

  if (!topologyChanged && typeof existingNode?.loc === 'string' && existingNode.loc.length > 0) {
    return existingNode.loc;
  }
  if (task.x !== 0 || task.y !== 0) {
    return `${task.x} ${task.y}`;
  }

  const stageX = ((task.stage || 1) - 1) * 150;
  const indexY = newNodeIndex * 100;
  return `${stageX} ${indexY}`;
}

export function isFlowTaskSearchMatch(
  task: Pick<Task, 'title' | 'content' | 'displayId' | 'attachments' | 'tags'>,
  searchLower: string,
): boolean {
  if (!searchLower) return false;

  return (
    task.title.toLowerCase().includes(searchLower) ||
    task.content.toLowerCase().includes(searchLower) ||
    task.displayId.toLowerCase().includes(searchLower) ||
    (task.attachments?.some(attachment => attachment.name.toLowerCase().includes(searchLower)) ?? false) ||
    (task.tags?.some(tag => tag.toLowerCase().includes(searchLower)) ?? false)
  );
}

export function computeFlowNodeColors(
  task: Pick<Task, 'stage' | 'status'>,
  isSearchMatch: boolean,
  styles: FlowStyleConfig,
): FlowNodeColors {
  if (isSearchMatch) {
    return {
      nodeColor: styles.node.searchHighlightBackground,
      borderColor: styles.node.searchHighlightBorder,
      borderWidth: 2,
      titleColor: styles.text.titleColor,
    };
  }
  if (task.stage === null) {
    return {
      nodeColor: styles.node.unassignedBackground,
      borderColor: styles.node.unassignedBorder,
      borderWidth: 2,
      titleColor: styles.text.unassignedTitleColor,
    };
  }
  if (task.status === 'completed') {
    return {
      nodeColor: styles.node.completedBackground,
      borderColor: styles.node.defaultBorder,
      borderWidth: 1,
      titleColor: styles.text.titleColor,
    };
  }

  return {
    nodeColor: styles.node.background,
    borderColor: styles.node.defaultBorder,
    borderWidth: 1,
    titleColor: styles.text.titleColor,
  };
}

export function needsFlowDisplayIdRenumbering(task: Pick<Task, 'stage' | 'displayId'>): boolean {
  if (task.stage === null) {
    return false;
  }

  const displayId = (task.displayId ?? '').trim();
  return displayId === '' || displayId === '?';
}

export function resolveFlowDisplayId(
  task: Pick<Task, 'id' | 'displayId'>,
  resolvedDisplayIds: ReadonlyMap<string, string>,
): string {
  return resolvedDisplayIds.get(task.id) ?? task.displayId;
}

export function compressFlowDisplayId(displayId: string): string {
  if (!displayId || displayId === '?') return displayId;

  const parts = displayId.split(',');
  const result: string[] = [];
  let index = 0;

  while (index < parts.length) {
    const current = parts[index];
    let count = 1;

    while (index + count < parts.length && parts[index + count] === current) {
      count++;
    }

    if (count >= 5) {
      const superscript = String(count).split('').map(digit => SUPERSCRIPT_DIGITS[digit] || digit).join('');
      result.push(current + superscript);
    } else {
      for (let repeat = 0; repeat < count; repeat += 1) {
        result.push(current);
      }
    }

    index += count;
  }

  return result.join(',');
}

export function applyFlowLineageDisplayColors(
  nodeDataArray: GoJSNodeData[],
  getDarkerFamilyColor: (familyColor: string) => string,
): GoJSNodeData[] {
  return nodeDataArray.map(node => {
    if (node.stage === null || node.isSearchMatch || !node.familyColor) {
      return node;
    }

    return {
      ...node,
      displayIdColor: getDarkerFamilyColor(node.familyColor),
    };
  });
}
