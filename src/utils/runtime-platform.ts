export type RuntimePlatformOs = 'android' | 'ios' | 'desktop' | 'unknown';
export type RuntimePlatformSurface = 'browser-tab' | 'pwa-standalone' | 'twa-shell';

export interface RuntimePlatformInput {
  userAgent?: string | null;
  referrer?: string | null;
  displayModes?: string[];
  navigatorStandalone?: boolean | null;
}

export interface RuntimePlatformSnapshot {
  os: RuntimePlatformOs;
  surface: RuntimePlatformSurface;
  isAndroid: boolean;
  isStandalone: boolean;
  isTwa: boolean;
  androidHostPackage: string | null;
  displayModes: string[];
}

const ANDROID_APP_REFERRER_PREFIX = 'android-app://';
const STANDALONE_DISPLAY_MODES = new Set(['standalone', 'fullscreen', 'minimal-ui', 'window-controls-overlay']);

function normalizeDisplayModes(value: string[] | undefined): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return [...new Set(value
    .map(mode => mode.trim().toLowerCase())
    .filter(mode => mode.length > 0))];
}

export function extractAndroidHostPackage(referrer: string | null | undefined): string | null {
  if (typeof referrer !== 'string') {
    return null;
  }

  const trimmed = referrer.trim();
  if (!trimmed.startsWith(ANDROID_APP_REFERRER_PREFIX)) {
    return null;
  }

  const packageName = trimmed.slice(ANDROID_APP_REFERRER_PREFIX.length).split(/[/?#]/, 1)[0] ?? '';
  return /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(packageName)
    ? packageName
    : null;
}

export function resolveRuntimePlatformSnapshot(input: RuntimePlatformInput): RuntimePlatformSnapshot {
  const userAgent = typeof input.userAgent === 'string' ? input.userAgent : '';
  const displayModes = normalizeDisplayModes(input.displayModes);
  const isIos = /iPhone|iPad|iPod/i.test(userAgent);
  const isStandalone = input.navigatorStandalone === true
    || displayModes.some(mode => STANDALONE_DISPLAY_MODES.has(mode));
  const androidHostPackage = extractAndroidHostPackage(input.referrer);
  // 2026-04-19: Chrome 147+ 在 TWA/CCT 内默认返回桌面 UA (User-Agent Reduction)，不再包含 "Android"。
  // 使用 android-app:// referrer 作为补充 Android 判定信号，避免 widget bootstrap 信任门误判。
  const isAndroid = /Android/i.test(userAgent) || androidHostPackage !== null;
  const isTwa = isAndroid && isStandalone && androidHostPackage !== null;

  return {
    os: isAndroid ? 'android' : isIos ? 'ios' : userAgent ? 'desktop' : 'unknown',
    surface: isTwa ? 'twa-shell' : isStandalone ? 'pwa-standalone' : 'browser-tab',
    isAndroid,
    isStandalone,
    isTwa,
    androidHostPackage,
    displayModes,
  };
}

export function readRuntimePlatformSnapshot(): RuntimePlatformSnapshot {
  if (typeof navigator === 'undefined' || typeof document === 'undefined' || typeof window === 'undefined') {
    return resolveRuntimePlatformSnapshot({});
  }

  const displayModes = [
    'browser',
    'standalone',
    'fullscreen',
    'minimal-ui',
    'window-controls-overlay',
  ].filter(mode => {
    if (typeof window.matchMedia !== 'function') {
      return false;
    }
    return window.matchMedia(`(display-mode: ${mode})`).matches;
  });

  return resolveRuntimePlatformSnapshot({
    userAgent: navigator.userAgent,
    referrer: document.referrer,
    displayModes,
    navigatorStandalone: 'standalone' in navigator
      ? Boolean((navigator as Navigator & { standalone?: boolean }).standalone)
      : null,
  });
}
