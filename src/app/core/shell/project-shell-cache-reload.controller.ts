type ForceClearCacheWindow = Window & {
  __NANOFLOW_FORCE_CLEAR_CACHE__?: () => Promise<void> | void;
};

export interface ProjectShellCacheReloadControllerOptions {
  logger: {
    warn(message: string): void;
    error(message: string, error: unknown): void;
  };
  windowRef?: Window;
  navigatorRef?: Navigator;
  cachesRef?: CacheStorage;
}

export class ProjectShellCacheReloadController {
  constructor(private readonly options: ProjectShellCacheReloadControllerOptions) {}

  reloadPage(): void {
    this.options.logger.warn('Triggering force cache clear due to @defer error');

    const forceClearCache = (this.windowRef as ForceClearCacheWindow)
      .__NANOFLOW_FORCE_CLEAR_CACHE__;

    if (typeof forceClearCache === 'function') {
      void Promise.resolve()
        .then(() => forceClearCache())
        .catch(() => {
          this.windowRef.location.reload();
        });
      return;
    }

    void this.forceClearCacheFallback();
  }

  private async forceClearCacheFallback(): Promise<void> {
    try {
      const cacheStorage = this.cacheStorage;
      if (cacheStorage) {
        const cacheNames = await cacheStorage.keys();
        await Promise.all(cacheNames.map(name => cacheStorage.delete(name)));
      }

      const serviceWorker = this.navigatorRef?.serviceWorker;
      if (serviceWorker) {
        const registrations = await serviceWorker.getRegistrations();
        await Promise.all(registrations.map(registration => registration.unregister()));
      }
    } catch (error) {
      this.options.logger.error('Force clear cache fallback failed', error);
    }

    this.windowRef.location.reload();
  }

  private get windowRef(): Window {
    return this.options.windowRef ?? window;
  }

  private get navigatorRef(): Navigator | undefined {
    return this.options.navigatorRef ?? (typeof navigator === 'undefined' ? undefined : navigator);
  }

  private get cacheStorage(): CacheStorage | undefined {
    return this.options.cachesRef ?? (typeof caches === 'undefined' ? undefined : caches);
  }
}
