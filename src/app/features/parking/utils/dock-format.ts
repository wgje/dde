/**
 * 停泊坞共用的时间格式化与解析工具。
 * 消除 parking-dock / dock-console-stack / dock-radar-zone 中的重复实现。
 */

/** 将分钟数格式化为人可读的短字符串：`12m` / `2h30m` / `1d4h` */
export function formatDockMinutes(minutes: number): string {
  if (minutes >= 1440) {
    const d = Math.floor(minutes / 1440);
    const remainH = Math.floor((minutes % 1440) / 60);
    return remainH > 0 ? `${d}d${remainH}h` : `${d}d`;
  }
  if (minutes >= 60) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
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
  return Math.floor(parsed);
}
