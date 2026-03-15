import { describe, it, expect, vi, afterEach } from 'vitest';
import { reloadViaForceClearCache } from './force-clear-cache';

type ForceClearCacheWindow = Window & {
  __NANOFLOW_FORCE_CLEAR_CACHE__?: () => Promise<void> | void;
};

describe('reloadViaForceClearCache', () => {
  const reloadSpy = vi.fn();

  afterEach(() => {
    vi.restoreAllMocks();
    // Clean up the window property
    delete (window as ForceClearCacheWindow).__NANOFLOW_FORCE_CLEAR_CACHE__;
  });

  function stubReload(): void {
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, reload: reloadSpy },
    });
  }

  // ── Happy path: __NANOFLOW_FORCE_CLEAR_CACHE__ defined ─────

  it('should call __NANOFLOW_FORCE_CLEAR_CACHE__ when defined', () => {
    const cacheFn = vi.fn();
    (window as ForceClearCacheWindow).__NANOFLOW_FORCE_CLEAR_CACHE__ = cacheFn;

    reloadViaForceClearCache();

    expect(cacheFn).toHaveBeenCalledOnce();
  });

  it('should NOT call fallback when __NANOFLOW_FORCE_CLEAR_CACHE__ succeeds synchronously', () => {
    (window as ForceClearCacheWindow).__NANOFLOW_FORCE_CLEAR_CACHE__ = vi.fn();
    const fallback = vi.fn();

    reloadViaForceClearCache(fallback);

    expect(fallback).not.toHaveBeenCalled();
  });

  it('should NOT call fallback when __NANOFLOW_FORCE_CLEAR_CACHE__ returns a resolved promise', async () => {
    (window as ForceClearCacheWindow).__NANOFLOW_FORCE_CLEAR_CACHE__ = vi.fn(() => Promise.resolve());
    const fallback = vi.fn();

    reloadViaForceClearCache(fallback);

    // Let microtask queue flush
    await Promise.resolve();

    expect(fallback).not.toHaveBeenCalled();
  });

  // ── Fallback paths ─────────────────────────────────────────

  it('should fall back to window.location.reload() when no function defined', () => {
    stubReload();

    reloadViaForceClearCache();

    expect(reloadSpy).toHaveBeenCalledOnce();
  });

  it('should fall back to custom fallback when provided and no function defined', () => {
    const fallback = vi.fn();

    reloadViaForceClearCache(fallback);

    expect(fallback).toHaveBeenCalledOnce();
  });

  // ── Error handling ─────────────────────────────────────────

  it('should catch sync exceptions and call fallback', () => {
    (window as ForceClearCacheWindow).__NANOFLOW_FORCE_CLEAR_CACHE__ = () => {
      throw new Error('boom');
    };
    const fallback = vi.fn();

    reloadViaForceClearCache(fallback);

    expect(fallback).toHaveBeenCalledOnce();
  });

  it('should catch async rejection and call fallback', async () => {
    (window as ForceClearCacheWindow).__NANOFLOW_FORCE_CLEAR_CACHE__ = () =>
      Promise.reject(new Error('async boom'));
    const fallback = vi.fn();

    reloadViaForceClearCache(fallback);

    // Flush microtask queue so the .catch() handler runs
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(fallback).toHaveBeenCalledOnce();
  });
});
