/**
 * 功能开关配置
 * 
 * 用于控制半实现功能的 UI 显示
 * 数据模型中保留这些字段以便未来扩展，但在 UI 层隐藏入口
 * 
 * 使用方式：
 * 1. 在组件模板中使用 @if (FEATURE_FLAGS.ENABLE_TAGS) { ... }
 * 2. 在 TypeScript 中导入并检查：if (FEATURE_FLAGS.ENABLE_PRIORITY) { ... }
 * 
 * 发布新功能时：
 * 1. 先实现完整的 UI 和逻辑
 * 2. 将对应的 flag 设为 true
 * 3. 进行完整测试后发布
 */
export const FEATURE_FLAGS = {
  /**
   * 标签功能
   * 状态：数据模型已就绪，UI 部分实现
   * 待完成：标签管理面板、标签筛选器、批量标签操作
   */
  ENABLE_TAGS: false,
  
  /**
   * 优先级功能
   * 状态：数据模型已就绪，选择器 UI 存在但功能不完整
   * 待完成：优先级排序、优先级筛选、优先级可视化
   */
  ENABLE_PRIORITY: false,
  
  /**
   * 截止日期功能
   * 状态：数据模型已就绪，日期选择器存在
   * 待完成：到期提醒、截止日期排序、日历视图
   */
  ENABLE_DUE_DATE: false,
  
  /**
   * 高级搜索功能
   * 状态：基础搜索已实现
   * 待完成：搜索语法（标签:xxx, 状态:完成）、搜索历史
   */
  ENABLE_ADVANCED_SEARCH: false,
  
  /**
   * 团队协作功能（预留）
   * 状态：未开始
   * 待完成：项目共享、多用户编辑、评论
   */
  ENABLE_COLLABORATION: false,
} as const;

/**
 * 检查功能是否启用
 * @param flag 功能标识
 * @returns 是否启用
 */
export function isFeatureEnabled(flag: keyof typeof FEATURE_FLAGS): boolean {
  return FEATURE_FLAGS[flag];
}

/**
 * 获取所有启用的功能列表
 */
export function getEnabledFeatures(): string[] {
  return Object.entries(FEATURE_FLAGS)
    .filter(([_, enabled]) => enabled)
    .map(([name]) => name);
}
