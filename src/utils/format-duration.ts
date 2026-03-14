/**
 * 格式化分钟数为可读时间字符串（英文单位 d/h/m，含向上取整）
 *
 * 示例：
 *   90     → '1h30m'
 *   1500   → '1d1h'（1440min = 1d，剩余 60min = 1h）
 */
export function formatDuration(minutes: number): string {
  const m = Math.ceil(minutes);
  if (m >= 1440) {
    const d = Math.floor(m / 1440);
    const remainH = Math.floor((m % 1440) / 60);
    return remainH > 0 ? `${d}d${remainH}h` : `${d}d`;
  }
  if (m >= 60) {
    const h = Math.floor(m / 60);
    const rem = m % 60;
    return rem > 0 ? `${h}h${rem}m` : `${h}h`;
  }
  return `${m}m`;
}
