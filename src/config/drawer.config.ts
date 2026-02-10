// ============================================
// 移动端抽屉配置
// 双向抽屉交互相关常量
// ============================================

/** 吸附点配置类型 */
interface SnapPointsConfig {
  COLLAPSED: number;
  HALF: number;
  EXPANDED: number;
}

/**
 * 抽屉配置
 */
export const DRAWER_CONFIG = {
  /** 边缘检测区域大小（像素）- 把手区域可触发拖拽 */
  EDGE_ZONE_SIZE: 48,
  
  /** 最小拖拽距离（像素）- 超过此距离才开始响应 */
  DRAG_THRESHOLD: 10,
  
  /** 快速滑动速度阈值（像素/毫秒）- 超过此速度视为快速滑动 */
  VELOCITY_THRESHOLD: 0.5,
  
  /** 吸附点阈值比例 - 超过两个吸附点距离的 40% 则吸附到下一个点 */
  SNAP_THRESHOLD_RATIO: 0.4,
  
  /** 把手区域高度（像素） */
  HANDLE_HEIGHT: 20,
  
  /** 顶部面板高度范围（视口百分比） */
  TOP_SNAP_POINTS: {
    COLLAPSED: 3,    // 仅显示把手 (~24px)
    HALF: 35,        // 半开（用于点击切换）
    EXPANDED: 70,    // 全开
  },
  
  /** 底部面板高度范围（视口百分比） */
  BOTTOM_SNAP_POINTS: {
    COLLAPSED: 3,    // 仅显示把手
    HALF: 30,        // 半开（用于点击切换）
    EXPANDED: 55,    // 全开
  },
  
  /** 动画持续时间（毫秒） */
  ANIMATION_DURATION: 250,
  
  /** 弹簧动画配置 */
  SPRING: {
    /** 刚度 */
    STIFFNESS: 300,
    /** 阻尼 */
    DAMPING: 30,
    /** 质量 */
    MASS: 1,
  },
  
  /** 首次使用提示自动消失时间（毫秒） */
  GESTURE_HINT_DURATION: 5000,
  
  /** 首次使用提示的 localStorage 键 */
  GESTURE_HINT_SHOWN_KEY: 'nanoflow_drawer_hint_shown',
};

/** 吸附点名称 */
export type SnapPointName = 'collapsed' | 'half' | 'expanded';

/** 抽屉层类型 */
export type DrawerLayer = 'top' | 'middle' | 'bottom';

/** 抽屉状态变化事件 */
export interface DrawerStateChangeEvent {
  previousLayer: DrawerLayer;
  currentLayer: DrawerLayer;
  triggeredBy: 'gesture' | 'programmatic';
}

/** 拖拽进度事件 */
export interface DrawerDragEvent {
  direction: 'up' | 'down';
  progress: number; // 0-1
  velocity: number;
}
