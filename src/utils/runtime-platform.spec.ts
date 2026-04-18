import { describe, expect, it } from 'vitest';
import { extractAndroidHostPackage, resolveRuntimePlatformSnapshot } from './runtime-platform';

describe('runtime-platform', () => {
  it('should detect a plain Android browser tab', () => {
    const snapshot = resolveRuntimePlatformSnapshot({
      userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/123.0.0.0 Mobile Safari/537.36',
      displayModes: ['browser'],
      referrer: '',
    });

    expect(snapshot.os).toBe('android');
    expect(snapshot.surface).toBe('browser-tab');
    expect(snapshot.isStandalone).toBe(false);
    expect(snapshot.isTwa).toBe(false);
  });

  it('should detect Android standalone PWA without twa referrer', () => {
    const snapshot = resolveRuntimePlatformSnapshot({
      userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/123.0.0.0 Mobile Safari/537.36',
      displayModes: ['standalone'],
      referrer: '',
    });

    expect(snapshot.surface).toBe('pwa-standalone');
    expect(snapshot.isStandalone).toBe(true);
    expect(snapshot.isTwa).toBe(false);
  });

  it('should detect Android twa shell from android-app referrer', () => {
    const snapshot = resolveRuntimePlatformSnapshot({
      userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/123.0.0.0 Mobile Safari/537.36',
      displayModes: ['standalone'],
      referrer: 'android-app://app.nanoflow.twa/',
    });

    expect(snapshot.surface).toBe('twa-shell');
    expect(snapshot.isTwa).toBe(true);
    expect(snapshot.androidHostPackage).toBe('app.nanoflow.twa');
  });

  it('should detect iOS standalone from navigator.standalone', () => {
    const snapshot = resolveRuntimePlatformSnapshot({
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Version/17.4 Mobile/15E148 Safari/604.1',
      navigatorStandalone: true,
      referrer: '',
    });

    expect(snapshot.os).toBe('ios');
    expect(snapshot.surface).toBe('pwa-standalone');
    expect(snapshot.isStandalone).toBe(true);
  });

  it('should extract android host package only from valid android-app referrers', () => {
    expect(extractAndroidHostPackage('android-app://app.nanoflow.twa/some/path')).toBe('app.nanoflow.twa');
    expect(extractAndroidHostPackage('https://dde-eight.vercel.app')).toBeNull();
    expect(extractAndroidHostPackage('android-app://not a package')).toBeNull();
  });
});
