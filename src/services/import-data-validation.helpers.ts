import type { BackupData } from '../../supabase/functions/_shared/backup-utils';
import type { ExportData } from './export.service';
import { convertBackupDataToExportData } from './import-backup-conversion.helpers';

export const IMPORT_DATA_VERSION_LIMITS = {
  MIN_SUPPORTED_VERSION: '1.0',
  MAX_SUPPORTED_VERSION: '2.1',
} as const;

export interface ImportDataValidationResult {
  valid: boolean;
  error?: string;
  data?: ExportData;
}

export function validateImportDataStructure(data: unknown): ImportDataValidationResult {
  if (!data || typeof data !== 'object') {
    return { valid: false, error: '无效的数据格式' };
  }

  const obj = data as Record<string, unknown>;

  if (isImportBackupDataFormat(obj)) {
    const converted = convertBackupDataToExportData(obj as unknown as BackupData);
    if (!converted) {
      return { valid: false, error: '本地备份数据转换失败' };
    }
    return { valid: true, data: converted };
  }

  if (!obj['metadata'] || typeof obj['metadata'] !== 'object') {
    return { valid: false, error: '缺少元数据' };
  }

  if (!obj['projects'] || !Array.isArray(obj['projects'])) {
    return { valid: false, error: '缺少项目数据' };
  }

  const metadata = obj['metadata'] as Record<string, unknown>;
  if (!metadata['version']) {
    return { valid: false, error: '缺少版本信息' };
  }

  for (const project of obj['projects'] as unknown[]) {
    if (!project || typeof project !== 'object') {
      return { valid: false, error: '无效的项目数据' };
    }

    const proj = project as Record<string, unknown>;
    if (!proj['id'] || !proj['name']) {
      return { valid: false, error: '项目缺少必需字段 (id, name)' };
    }
  }

  return { valid: true, data: data as ExportData };
}

export function validateImportVersion(version: string): ImportDataValidationResult {
  const versionNum = parseFloat(version);
  const minVersion = parseFloat(IMPORT_DATA_VERSION_LIMITS.MIN_SUPPORTED_VERSION);
  const maxVersion = parseFloat(IMPORT_DATA_VERSION_LIMITS.MAX_SUPPORTED_VERSION);

  if (isNaN(versionNum)) {
    return { valid: false, error: '无效的版本号' };
  }

  if (versionNum < minVersion) {
    return {
      valid: false,
      error: `版本过低，最低支持 v${IMPORT_DATA_VERSION_LIMITS.MIN_SUPPORTED_VERSION}`,
    };
  }

  if (versionNum > maxVersion) {
    return {
      valid: false,
      error: `版本过高，最高支持 v${IMPORT_DATA_VERSION_LIMITS.MAX_SUPPORTED_VERSION}`,
    };
  }

  return { valid: true };
}

function isImportBackupDataFormat(obj: Record<string, unknown>): boolean {
  return (
    typeof obj['payloadVersion'] === 'string' &&
    Array.isArray(obj['projects']) &&
    Array.isArray(obj['tasks']) &&
    Array.isArray(obj['connections']) &&
    !obj['metadata']
  );
}
