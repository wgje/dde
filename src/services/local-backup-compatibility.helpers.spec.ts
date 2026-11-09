import { describe, expect, it } from 'vitest';
import { resolveLocalBackupCompatibility } from './local-backup-compatibility.helpers';

describe('resolveLocalBackupCompatibility', () => {
  it('returns a mobile unsupported reason when the device is not desktop', () => {
    expect(resolveLocalBackupCompatibility({
      isDesktop: false,
      hasDirectoryPicker: true,
    })).toEqual({
      isSupported: false,
      isDesktop: false,
      unsupportedReason: '移动设备不支持本地备份功能',
    });
  });

  it('returns a browser unsupported reason when directory picker is missing', () => {
    expect(resolveLocalBackupCompatibility({
      isDesktop: true,
      hasDirectoryPicker: false,
    })).toEqual({
      isSupported: false,
      isDesktop: true,
      unsupportedReason: '当前浏览器不支持 File System Access API，请使用 Chrome 浏览器',
    });
  });

  it('returns supported compatibility for desktop browsers with directory picker', () => {
    expect(resolveLocalBackupCompatibility({
      isDesktop: true,
      hasDirectoryPicker: true,
    })).toEqual({
      isSupported: true,
      isDesktop: true,
    });
  });
});
