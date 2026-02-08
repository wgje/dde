/**
 * GoJS 运行时转换函数
 * 
 * 【性能优化 2026-02-07】从 models/gojs-boundary.ts 迁移而来
 * 这些函数依赖 GoJS 运行时（go.Part, go.Link, go.Diagram），
 * 必须保持在 flow 懒加载区域内，避免污染 main bundle。
 * 
 * 纯类型接口仍保留在 models/gojs-boundary.ts（无 GoJS 依赖）
 */

import * as go from 'gojs';
import type { Task, Connection } from '../../../../models/core-types';
import type { 
  GojsNodeData, 
  GojsLinkData, 
  GojsNodeMoveData,
  GojsLinkCreateData,
  GojsSelectionData 
} from '../../../../models/gojs-boundary';

// 重新导出纯类型，便于 flow 服务引用
export type { 
  GojsNodeData, 
  GojsLinkData, 
  GojsDiagramData, 
  GojsNodeMoveData, 
  GojsLinkCreateData,
  GojsSelectionData 
} from '../../../../models/gojs-boundary';

/**
 * 将业务 Task 转换为 GoJS 节点数据
 * 这是"边境检查站"的入口函数
 */
export function taskToGojsNode(
  task: Task,
  config: {
    existingLoc?: string;
    styles: {
      nodeBackground: string;
      borderColor: string;
      borderWidth: number;
      titleColor: string;
      displayIdColor: string;
      selectedBorderColor: string;
    };
    isSearchMatch: boolean;
    compressDisplayId: (id: string) => string;
  }
): GojsNodeData {
  let loc: string;
  if (config.existingLoc) {
    loc = config.existingLoc;
  } else if (task.x !== 0 || task.y !== 0) {
    loc = `${task.x} ${task.y}`;
  } else {
    const stageX = ((task.stage || 1) - 1) * 150;
    loc = `${stageX} 0`;
  }

  return {
    key: task.id,
    title: task.title || '未命名任务',
    displayId: config.compressDisplayId(task.displayId),
    stage: task.stage,
    loc,
    color: config.styles.nodeBackground,
    borderColor: config.styles.borderColor,
    borderWidth: config.styles.borderWidth,
    titleColor: config.styles.titleColor,
    displayIdColor: config.styles.displayIdColor,
    selectedBorderColor: config.styles.selectedBorderColor,
    isUnassigned: task.stage === null,
    isSearchMatch: config.isSearchMatch,
    isSelected: false
  };
}

/**
 * 将业务 Connection 转换为 GoJS 连接线数据
 */
export function connectionToGojsLink(
  conn: Connection,
  isCrossTree: boolean
): GojsLinkData {
  return {
    key: isCrossTree ? `cross-${conn.source}-${conn.target}` : `${conn.source}-${conn.target}`,
    from: conn.source,
    to: conn.target,
    isCrossTree,
    description: conn.description || ''
  };
}

/**
 * 从父子关系创建 GoJS 连接线数据
 */
export function parentChildToGojsLink(
  parentId: string,
  childId: string
): GojsLinkData {
  return {
    key: `${parentId}-${childId}`,
    from: parentId,
    to: childId,
    isCrossTree: false
  };
}

/**
 * 从 GoJS Part 提取移动数据
 * 这是"边境检查站"的出口函数
 */
export function extractNodeMoveData(part: go.Part): GojsNodeMoveData | null {
  if (!part?.data?.key || !part.location) {
    return null;
  }
  
  const loc = part.location;
  return {
    taskId: part.data.key,
    x: loc.x,
    y: loc.y
  };
}

/**
 * 从 GoJS Link 提取连接数据
 */
export function extractLinkCreateData(link: go.Link): GojsLinkCreateData | null {
  const fromNode = link?.fromNode;
  const toNode = link?.toNode;
  const sourceId = fromNode?.data?.key;
  const targetId = toNode?.data?.key;
  
  if (!sourceId || !targetId || sourceId === targetId) {
    return null;
  }
  
  const midPoint = link.midPoint;
  
  return {
    sourceId,
    targetId,
    midPoint: midPoint ? { x: midPoint.x, y: midPoint.y } : undefined
  };
}

/**
 * 从 GoJS Diagram 提取选择数据
 */
export function extractSelectionData(diagram: go.Diagram): GojsSelectionData {
  const selectedNodeIds: string[] = [];
  const selectedLinkKeys: string[] = [];
  
  if (diagram?.selection) {
    const iterator = diagram.selection.iterator;
    while (iterator.next()) {
      const part = iterator.value;
      if (part.data?.key) {
        if (part instanceof go.Link) {
          selectedLinkKeys.push(part.data.key);
        } else {
          selectedNodeIds.push(part.data.key);
        }
      }
    }
  }
  
  return { selectedNodeIds, selectedLinkKeys };
}
