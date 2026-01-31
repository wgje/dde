/**
 * 滑动手势工具函数
 * 
 * 用于在移动端检测水平滑动手势
 */

/**
 * 滑动手势状态
 */
export interface SwipeGestureState {
  /** 触摸起始 X 坐标 */
  startX: number;
  /** 触摸起始 Y 坐标 */
  startY: number;
  /** 触摸起始时间戳 */
  startTime: number;
  /** 手势是否激活 */
  isActive: boolean;
}

/**
 * 创建初始滑动手势状态
 */
export function createSwipeGestureState(): SwipeGestureState {
  return { 
    startX: 0, 
    startY: 0, 
    startTime: 0,
    isActive: false 
  };
}

/**
 * 滑动方向
 */
export type SwipeDirection = 'left' | 'right';

/**
 * 滑动手势配置
 */
export interface SwipeGestureConfig {
  /** 触发滑动的最小水平距离（像素） */
  threshold: number;
  /** 水平/垂直滑动比例阈值（水平必须大于垂直的 N 倍） */
  horizontalRatio: number;
  /** 滑动最大时间（毫秒），超过则不触发 */
  maxDuration: number;
}

/**
 * 默认滑动手势配置
 */
export const DEFAULT_SWIPE_CONFIG: SwipeGestureConfig = {
  threshold: 50,
  horizontalRatio: 1.5,
  maxDuration: 500,
};

/**
 * 检测水平滑动方向
 * 
 * @param state 滑动状态
 * @param endX 结束 X 坐标
 * @param endY 结束 Y 坐标
 * @param config 滑动配置
 * @returns 滑动方向，或 null（未达到阈值）
 */
export function detectHorizontalSwipe(
  state: SwipeGestureState,
  endX: number,
  endY: number,
  config: SwipeGestureConfig = DEFAULT_SWIPE_CONFIG
): SwipeDirection | null {
  if (!state.isActive) return null;
  
  const deltaX = endX - state.startX;
  const deltaY = Math.abs(endY - state.startY);
  const duration = Date.now() - state.startTime;
  
  // 超时不触发
  if (duration > config.maxDuration) {
    return null;
  }
  
  // 水平滑动距离必须足够
  if (Math.abs(deltaX) < config.threshold) {
    return null;
  }
  
  // 水平滑动必须大于垂直滑动的 N 倍（避免垂直滚动误触）
  if (Math.abs(deltaX) < deltaY * config.horizontalRatio) {
    return null;
  }
  
  return deltaX > 0 ? 'right' : 'left';
}

/**
 * 开始跟踪滑动手势
 * 
 * @param touch TouchEvent 或 Touch 对象
 * @returns 初始化后的滑动状态
 */
export function startSwipeTracking(touch: Touch | { clientX: number; clientY: number }): SwipeGestureState {
  return {
    startX: touch.clientX,
    startY: touch.clientY,
    startTime: Date.now(),
    isActive: true,
  };
}
