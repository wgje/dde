/**
 * GoJS 扩展类型定义
 * 
 * GoJS 的官方 TypeScript 类型定义不完整，特别是事件回调和模板配置。
 * 此文件补充常用类型，减少 any 使用。
 * 
 * 【P2-34 注意】本文件中的 GoJSNodeData / GoJSLinkData 用于 GoJS 图表内部操作。
 *
 * 使用方式：
 * - 在需要的文件中导入：import type { GoJSNodeData, GoJSLinkData } from '../../types/gojs-extended';
 */

import * as go from 'gojs';

// ========== GoJS 内部 API 类型扩展 ==========

/**
 * 扩展 Diagram 静态属性（licenseKey）
 * GoJS 的 licenseKey 是静态属性，官方类型定义未暴露
 */
declare module 'gojs' {
  interface DiagramStatic {
    licenseKey: string;
  }
  
  /**
   * 扩展 Overview 类型（fixedBounds 属性）
   * fixedBounds 用于限制概览图的显示范围
   */
  interface Overview {
    fixedBounds?: go.Rect;
  }
  
  /**
   * 扩展 ClickSelectingTool 类型
   * standardMouseSelect 和 standardTouchSelect 是内部方法
   */
  interface ClickSelectingTool {
    standardMouseSelect?(e?: go.InputEvent, obj?: go.GraphObject | null): void;
    standardTouchSelect?(e?: go.InputEvent, obj?: go.GraphObject | null): void;
  }
}


// ========== 节点数据类型 ==========

/**
 * GoJS 节点数据对象（存储在 Model 中）
 */
export interface GoJSNodeData {
  /** 节点唯一标识（对应 Task.id） */
  key: string;
  /** 任务标题 */
  title: string;
  /** 显示 ID（如 "1", "1,a"） */
  displayId: string;
  /** 短 ID（如 "NF-A1B2"） */
  shortId?: string;
  /** 阶段编号 */
  stage: number | null;
  /** 父节点 ID */
  parentId: string | null;
  /** 任务状态 */
  status: 'active' | 'completed' | 'archived';
  /** X 坐标 */
  x: number;
  /** Y 坐标 */
  y: number;
  /** 排序权重 */
  rank: number;
  /** 是否有未完成的子任务 */
  hasIncompleteTask?: boolean;
  /** 是否在未分配区 */
  isUnassigned?: boolean;
  /** 节点宽度（布局计算用） */
  width?: number;
  /** 节点高度（布局计算用） */
  height?: number;
}

/**
 * GoJS 连接线数据对象（存储在 Model 中）
 */
export interface GoJSLinkData {
  /** 连接线唯一标识 */
  key: string;
  /** 源节点 ID */
  from: string;
  /** 目标节点 ID */
  to: string;
  /** 连接类型 */
  category?: 'parent-child' | 'cross-tree';
  /** 连接描述（用于联系块） */
  description?: string;
  /** 是否已删除 */
  deletedAt?: string | null;
  /** 是否为跨树连接（运行时计算） */
  isCrossTree?: boolean;
  /** 连接标题（运行时使用） */
  title?: string;
  /** 允许额外属性 */
  [key: string]: unknown;
}

// ========== Model 扩展类型 ==========

/**
 * GoJS GraphLinksModel 扩展（带类型的节点和连接数据）
 */
interface TypedGraphLinksModel extends go.GraphLinksModel {
  nodeDataArray: GoJSNodeData[];
  linkDataArray: GoJSLinkData[];
}
