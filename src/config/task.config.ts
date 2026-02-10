// ============================================
// 任务配置
// 包含任务管理、回收站、撤销/重做相关常量
// ============================================

/**
 * 回收站配置
 */
export const TRASH_CONFIG = {
  /** 自动清理天数 */
  AUTO_CLEANUP_DAYS: 30,
  /** 清理检查间隔（毫秒）- 1小时 */
  CLEANUP_INTERVAL: 60 * 60 * 1000,
} as const;

/**
 * 撤销/重做配置
 */
export const UNDO_CONFIG = {
  /** 桌面端最大撤销/重做历史数（从50增加到150，避免频繁触发截断提示） */
  DESKTOP_HISTORY_SIZE: 150,
  /** 移动端最大撤销/重做历史数（保持原有上限） */
  MOBILE_HISTORY_SIZE: 50,
  /** 版本容差：当远程版本超过记录版本这么多时，拒绝撤销 */
  VERSION_TOLERANCE: 5,
  /** 持久化配置 */
  PERSISTENCE: {
    /** 是否启用 sessionStorage 持久化 */
    ENABLED: true,
    /** sessionStorage key */
    STORAGE_KEY: 'nanoflow.undo-history',
    /** 持久化防抖延迟（毫秒） */
    DEBOUNCE_DELAY: 500,
    /** 最大持久化条目数
     * 【P2-36 说明】故意少于桌面端 150 条：
     *   1. sessionStorage 容量有限（50 条约占 100-200KB）
     *   2. 刷新后恢复更早的撤销历史价值低
     *   3. 内存中的 150 条是当前会话的完整撤销链
     */
    MAX_PERSISTED_ITEMS: 50,
  },
} as const;
