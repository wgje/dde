import type { LocalBackupCompatibility } from '../config/local-backup.config';

export interface LocalBackupCompatibilityOptions {
  isDesktop: boolean;
  hasDirectoryPicker: boolean;
}

export function resolveLocalBackupCompatibility(
  options: LocalBackupCompatibilityOptions,
): LocalBackupCompatibility {
  if (!options.isDesktop) {
    return {
      isSupported: false,
      isDesktop: false,
      unsupportedReason: '移动设备不支持本地备份功能',
    };
  }

  if (!options.hasDirectoryPicker) {
    return {
      isSupported: false,
      isDesktop: true,
      unsupportedReason: '当前浏览器不支持 File System Access API，请使用 Chrome 浏览器',
    };
  }

  return {
    isSupported: true,
    isDesktop: true,
  };
}
