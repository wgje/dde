/**
 * GoJS 扩展类型定义
 * 
 * 从 flow-template.service.ts 提取的类型定义
 * 用于解决 GoJS 类型定义不完整的问题
 */

import * as go from 'gojs';

/** GoJS 事件回调类型 */
export type GojsClickHandler = (e: go.InputEvent, obj: go.GraphObject | null) => void;
export type GojsShapeBuilder = go.Shape;

/** GoJS Node 扩展属性（类型定义不完整的属性） */
export interface GojsNodeExt {
  data?: go.ObjectData;
  findObject?: (name: string) => go.GraphObject | null;
}

/** GoJS GraphObject 扩展属性 */
export interface GojsGraphObjectExt {
  part?: go.Part | null;
}

/** GoJS LinkingTool 扩展属性 */
export interface GojsLinkingToolExt {
  originalFromPort?: go.GraphObject | string | null;
  originalToPort?: go.GraphObject | string | null;
  originalFromNode?: go.Node | null;
  _tempMainPort?: go.GraphObject | null;
  _originNode?: go.Node | null;
  _savedFromLinkable?: boolean;
  _savedToLinkable?: boolean;
  startPort?: go.GraphObject | string | null;
  fromPort?: go.GraphObject | string | null;
  fromNode?: go.Node | null;
}

/** GoJS RelinkingTool 扩展属性 */
export interface GojsRelinkingToolExt {
  originalFromPort?: go.GraphObject | string | null;
  originalToPort?: go.GraphObject | string | null;
  adornedLink?: go.Link | null;
  adornedObject?: go.Link | null;
  originalLink?: go.Link | null;
  isForwards?: boolean;
}

/** GoJS 模板构建器函数类型 - 使用 typeof go.GraphObject.make */
export type GojsMake = typeof go.GraphObject.make;

/**
 * 节点端口配置
 */
export interface PortConfig {
  name: string;
  spot: go.Spot;
  size: number;
}

/**
 * 节点样式配置
 */
export interface NodeStyleConfig {
  portSize: number;
  assignedWidth: number;
  unassignedWidth: number;
  defaultFill: string;
  defaultStroke: string;
  selectedStroke: string;
  cornerRadius: number;
}

/**
 * 连接线样式配置
 */
export interface LinkStyleConfig {
  defaultStroke: string;
  parentChildStroke: string;
  selectedStroke: string;
  strokeWidth: number;
  captureRadius: number;
}

/**
 * 连接线标签点击事件数据
 */
export interface LinkLabelClickEventData {
  sourceId: string;
  targetId: string;
}

/**
 * 节点点击事件数据
 */
export interface NodeClickEventData {
  taskId: string;
  isCtrlClick: boolean;
}

/**
 * 节点选择事件数据
 */
export interface NodeSelectionEventData {
  taskId: string;
  selected: boolean;
  isMultiSelect: boolean;
}
