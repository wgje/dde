export function resolveOverviewBackgroundColor(isDark: boolean, fallbackTitleColor: string | null | undefined): string {
  if (isDark) return '#1f1f1f';
  return readCssColorVar('--theme-text-dark') ?? fallbackTitleColor ?? '#292524';
}

function readCssColorVar(varName: string): string | null {
  try {
    if (typeof window === 'undefined' || typeof document === 'undefined') return null;
    const value = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
    return value || null;
  } catch {
    // eslint-disable-next-line no-restricted-syntax -- CSS 变量不可读时由调用方 fallback 颜色接管
    return null;
  }
}
