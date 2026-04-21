// ============================================
// 布局配置
// 包含流程图布局、GoJS 配置、坐标系统相关常量
// ============================================

/**
 * 布局配置
 */
export const LAYOUT_CONFIG = {
  /** 阶段间水平间距 */
  STAGE_SPACING: 260,
  /** 任务行垂直间距 */
  ROW_SPACING: 140,
  /** 自动布局中家族之间的基础额外留白（按行高倍数） */
  AUTO_LAYOUT_FAMILY_GAP_ROWS: 0.12,
  /** 兄弟子树之间的基础额外留白（按行高倍数） */
  AUTO_LAYOUT_SIBLING_GAP_ROWS: 0.04,
  /** 跨树链接块对家族间距施加的额外压力（按行高倍数） */
  AUTO_LAYOUT_CROSS_TREE_LABEL_GAP_ROWS: 0.24,
  /** 兄弟子树存在外部联系时附加的留白系数（按行高倍数） */
  AUTO_LAYOUT_RELATED_SIBLING_GAP_ROWS: 0.06,
  /** 高密度家族相邻时额外增加的留白系数（按行高倍数） */
  AUTO_LAYOUT_DENSE_FAMILY_GAP_ROWS: 0.04,
  /** 多父/多来源子树相邻时的额外留白系数（按行高倍数） */
  AUTO_LAYOUT_MULTI_PARENT_SIBLING_GAP_ROWS: 0.05,
  /** 家族间额外间距硬上限（按行高倍数），防止大型复杂场景下间距失控 */
  AUTO_LAYOUT_MAX_EXTRA_GAP_ROWS: 0.35,
  /** 兄弟子树间额外留白硬上限（按行高倍数） */
  AUTO_LAYOUT_MAX_SIBLING_GAP_ROWS: 0.22,
  /** 高密度阶段边界的额外横向留白系数（相对 stage spacing） */
  AUTO_LAYOUT_STAGE_DENSITY_GAP_FACTOR: 0.03,
  /** 父子扇出较多时的额外横向留白系数（相对 stage spacing） */
  AUTO_LAYOUT_STAGE_LINK_GAP_FACTOR: 0.035,
  /** 跨树连接穿过阶段边界时的额外横向留白系数（相对 stage spacing） */
  AUTO_LAYOUT_STAGE_CROSS_TREE_GAP_FACTOR: 0.025,
  /**
   * 多父扇入（shared-grandchild 等）穿过阶段边界时的额外横向留白系数。
   * 场景：两个父候选 -> 同一子节点，视觉上表现为多对一合流；此时在
   * 父 stage -> 子 stage 之间的列距拉宽，能让合流连线获得呼吸感，
   * 避免被相邻的普通父子连线挤压成交叉黑块。
   */
  AUTO_LAYOUT_STAGE_MULTI_PARENT_GAP_FACTOR: 0.03,
  /** 阶段边界额外横向留白硬上限（相对 stage spacing） */
  AUTO_LAYOUT_MAX_STAGE_EXTRA_FACTOR: 0.18,
  /**
   * 家族重排 2-opt 的最大迭代次数（按家族数 n 的倍数）。
   * 每次 2-opt pass 是 O(n²)，总复杂度被 n * n² = n³ 上限锁住，避免极端
   * 大项目下的布局卡顿。实测 n ≤ 40 时 2-opt 用时 < 2ms。
   */
  AUTO_LAYOUT_TWO_OPT_MAX_PASSES: 4,
  /**
   * 2-opt 的改进容忍阈值：只有当候选排列的加权跨距至少减少这个值才接受。
   * 防止浮点噪声下的无限循环；单位与跨距权重一致（affinity * |Δpos|）。
   */
  AUTO_LAYOUT_TWO_OPT_IMPROVEMENT_EPSILON: 0.5,
  /** 根任务基础 rank 值 */
  RANK_ROOT_BASE: 10000,
  /** rank 步进值 */
  RANK_STEP: 500,
  /** rank 最小间隔 */
  RANK_MIN_GAP: 50,
  /** 默认任务 X 坐标 */
  DEFAULT_TASK_X: 300,
} as const;

/**
 * 浮动任务树配置
 * 支持待分配区构建任务树结构
 */
export const FLOATING_TREE_CONFIG = {
  /** 阶段缓冲区大小：允许的最大阶段 = 当前最大阶段 + STAGE_BUFFER */
  STAGE_BUFFER: 10,
  /** 子树最大深度（防止无限递归） */
  MAX_SUBTREE_DEPTH: 100,
} as const;

/**
 * GoJS 流程图配置
 */
export const GOJS_CONFIG = {
  /** 自动布局层间距 */
  LAYER_SPACING: 100,
  /** 自动布局列间距 */
  COLUMN_SPACING: 40,
  /** 滚动边距 */
  SCROLL_MARGIN: 100,
  /** 待分配节点宽度 */
  UNASSIGNED_NODE_WIDTH: 140,
  /** 已分配节点宽度 */
  ASSIGNED_NODE_WIDTH: 200,
  /** 连接线捕获阈值（像素） */
  LINK_CAPTURE_THRESHOLD: 120,
  /** 端口大小（已废弃，保留向后兼容） */
  PORT_SIZE: 10,
  /** 端口触控热区厚度 - 桌面端 */
  PORT_HITAREA_DESKTOP: 10,
  /** 端口触控热区厚度 - 移动端 */
  PORT_HITAREA_MOBILE: 16,
  /** 端口高亮条视觉厚度 */
  PORT_VISUAL_HIGHLIGHT: 4,
  /** 端口角落内缩距离（解决角落重叠） */
  PORT_CORNER_INSET: 2,
  /** 连接线端点最小线段长度 */
  LINK_END_SEGMENT_LENGTH: 22,
  /** 端口高亮颜色（主题色 indigo 半透明） */
  PORT_HIGHLIGHT_COLOR: 'rgba(99, 102, 241, 0.25)',
  /** 端口高亮动画过渡时间（毫秒） */
  PORT_HIGHLIGHT_TRANSITION_MS: 150,
  /** 位置保存防抖延迟（毫秒） */
  POSITION_SAVE_DEBOUNCE: 300,
  /** 详情面板默认右边距 */
  DETAIL_PANEL_RIGHT_MARGIN: 8,
  /** 详情面板宽度（w-64 = 256px） */
  DETAIL_PANEL_WIDTH: 256,
  /** SSR 默认窗口高度 */
  SSR_DEFAULT_HEIGHT: 800,
} as const;

/**
 * 字母表（用于 displayId 生成）
 */
export const LETTERS = 'abcdefghijklmnopqrstuvwxyz';

/**
 * 上标数字映射
 */
export const SUPERSCRIPT_DIGITS: Record<string, string> = {
  '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴',
  '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹'
};
