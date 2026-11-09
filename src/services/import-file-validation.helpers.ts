import type { FileValidationResult } from './import.service';

export interface ImportFilePreflightInput {
  name: string;
  size: number;
  type: string;
}

export interface ImportFilePreflightConfig {
  maxFileSize: number;
  allowedMimeTypes: readonly string[];
}

export function validateImportFilePreflight(
  file: ImportFilePreflightInput,
  config: ImportFilePreflightConfig
): FileValidationResult | null {
  if (file.size > config.maxFileSize) {
    return {
      valid: false,
      error: `文件过大，最大支持 ${config.maxFileSize / 1024 / 1024}MB`,
    };
  }

  const mimeType = file.type || 'text/plain';
  if (config.allowedMimeTypes.includes(mimeType) || file.name.endsWith('.json')) {
    return null;
  }

  return {
    valid: false,
    error: '不支持的文件类型，请选择 JSON 文件',
  };
}
