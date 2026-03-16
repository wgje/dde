/**
 * 停泊坞共用的时间格式化与解析工具。
 * 消除 parking-dock / dock-console-stack / dock-radar-zone 中的重复实现。
 */

const MINUTES_PER_DAY = 1440;
const MINUTES_PER_HOUR = 60;

/** 将分钟数格式化为人可读的短字符串：`12m` / `2h30m` / `1d4h` */
export function formatDockMinutes(minutes: number): string {
  if (minutes >= MINUTES_PER_DAY) {
    const d = Math.floor(minutes / MINUTES_PER_DAY);
    const remainH = Math.floor((minutes % MINUTES_PER_DAY) / MINUTES_PER_HOUR);
    return remainH > 0 ? `${d}d${remainH}h` : `${d}d`;
  }
  if (minutes >= MINUTES_PER_HOUR) {
    const h = Math.floor(minutes / MINUTES_PER_HOUR);
    const m = minutes % MINUTES_PER_HOUR;
    return m > 0 ? `${h}h${m}m` : `${h}h`;
  }
  return `${minutes}m`;
}

/** 解析可选分钟数输入，无效值返回 null */
export function parseOptionalMinutes(raw: string | number | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const value = typeof raw === 'string' ? raw.trim() : String(raw).trim();
  if (!value) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  const floored = Math.floor(parsed);
  // 0.x 值通过 > 0 但 floor 后为 0，语义上无效
  if (floored <= 0) return null;
  return floored;
}
