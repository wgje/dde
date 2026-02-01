/**
 * 小地图数学计算相关类型定义
 * 从 minimap-math.service.ts 提取
 */

/**
 * 世界空间坐标点
 */
export interface WorldPoint {
  x: number;
  y: number;
}

/**
 * 小地图空间坐标点
 */
export interface MinimapPoint {
  x: number;
  y: number;
}

/**
 * 矩形边界（世界空间）
 */
export interface WorldBounds {
  x: number;      // 左上角 x
  y: number;      // 左上角 y
  width: number;
  height: number;
}

/**
 * 小地图状态
 */
export interface MinimapState {
  /** 缩放比例：世界坐标 -> 小地图坐标 */
  scaleRatio: number;
  /** 小地图中内容的偏移量（用于居中） */
  offsetX: number;
  offsetY: number;
  /** 视口指示器（红框）在小地图中的位置和尺寸 */
  indicator: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  /** 内容边界框在小地图中的位置和尺寸 */
  contentBounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

/**
 * 拖拽会话接口 - 用于优化实时拖拽性能
 * 
 * 通过缓存基础边界和被拖拽节点的初始位置，
 * 避免每帧都遍历所有节点来计算边界框
 */
export interface DragSession {
  /** 被拖拽节点的ID列表 */
  draggedNodeIds: Set<string>;
  /** 被拖拽节点的原始边界（拖拽开始时） */
  draggedNodesBounds: WorldBounds;
  /** 除被拖拽节点外的其他节点边界 */
  staticNodesBounds: WorldBounds;
  /** 上一帧的总边界（用于插值） */
  lastTotalBounds: WorldBounds;
  /** 上一帧的缩放比例（用于插值） */
  lastScaleRatio: number;
  /** 拖拽开始时间戳（用于平滑过渡） */
  startTimestamp: number;
  /** 缩放插值因子（0-1, 越小越平滑） */
  smoothFactor: number;
}

/**
 * 实时缩放结果
 */
export interface RealTimeScaleResult {
  /** 新的缩放比例 */
  scaleRatio: number;
  /** 新的总边界 */
  totalBounds: WorldBounds;
  /** 是否边界发生了扩展 */
  boundsExpanded: boolean;
}

/**
 * 虚拟边界计算结果 - 用于硬实时连续自适应系统
 * 
 * "Virtual Bounds" 是预测性边界：在节点状态更新之前，
 * 基于鼠标增量计算出节点将要到达的位置边界
 */
export interface VirtualBoundsResult {
  /** 虚拟边界（包含预测位置的并集边界） */
  virtualBounds: WorldBounds;
  /** 目标缩放比例（精确值，无插值） */
  targetScale: number;
  /** 锚定变换参数 */
  anchoredTransform: {
    /** 锚定点 X（用于变换原点）*/
    anchorX: number;
    /** 锚定点 Y */
    anchorY: number;
    /** 拖拽方向 (1=正向, -1=负向, 0=无) */
    dragDirectionX: number;
    dragDirectionY: number;
  };
  /** 是否边界发生扩展 */
  boundsExpanded: boolean;
  /** 扩展方向 */
  expansionDirection: {
    left: boolean;
    right: boolean;
    top: boolean;
    bottom: boolean;
  };
}
