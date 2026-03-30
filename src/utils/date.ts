/**
 * 统一日期处理工具
 * 解决日期格式不一致问题，提供时区安全的日期操作
 */

/**
 * Monotonic Wall Clock 实现
 * 确保生成的时间戳单调递增，即使系统时钟回调也能保证顺序
 * 
 * 【设计原则】来自高级顾问审查：
 * - 不实现复杂的 HLC (Hybrid Logical Clock)
 * - 使用简单的 Math.max() 确保单调递增
 * - 对于个人应用，时钟漂移是罕见且可忽略的情况
 */
let lastKnownTimestamp = 0;

/**
 * 获取当前时间的 ISO 字符串（UTC）
 * 使用 Monotonic Wall Clock 确保时间戳单调递增
 * 统一使用此方法代替 new Date().toISOString()
 * 
 * 【时钟漂移说明】
 * 当系统时钟回调时，会产生微小漂移（+1ms）直到真实时钟赶上
 * 对单用户场景影响可忽略，仅在极端时钟跳变时才可观察到
 */
export function nowISO(): string {
  const current = Date.now();
  // Monotonic Wall Clock: 确保时间戳永不回退
  lastKnownTimestamp = Math.max(current, lastKnownTimestamp + 1);
  return new Date(lastKnownTimestamp).toISOString();
}
