type ForceClearCacheWindow = Window & {
  __NANOFLOW_FORCE_CLEAR_CACHE__?: () => Promise<void> | void;
};

export function reloadViaForceClearCache(fallback?: () => void): void {
  const reloadFallback = fallback ?? (() => window.location.reload());
  const forceClearCache = (window as ForceClearCacheWindow).__NANOFLOW_FORCE_CLEAR_CACHE__;

  if (typeof forceClearCache === 'function') {
    try {
      const result = forceClearCache();
      void Promise.resolve(result).catch(() => {
        reloadFallback();
      });
    } catch {
      reloadFallback();
    }
    return;
  }

  reloadFallback();
}
