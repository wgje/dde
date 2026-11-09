import { describe, expect, it } from 'vitest';
import { validateImportFilePreflight } from './import-file-validation.helpers';

describe('validateImportFilePreflight', () => {
  const config = {
    maxFileSize: 1024,
    allowedMimeTypes: ['application/json', 'text/plain'] as readonly string[],
  };

  it('rejects files larger than the configured import limit', () => {
    const result = validateImportFilePreflight(
      { name: 'backup.json', size: 1025, type: 'application/json' },
      config
    );

    expect(result).toEqual({
      valid: false,
      error: '文件过大，最大支持 0.0009765625MB',
    });
  });

  it('rejects non-json files outside the allowed MIME type list', () => {
    const result = validateImportFilePreflight(
      { name: 'backup.csv', size: 10, type: 'text/csv' },
      config
    );

    expect(result).toEqual({
      valid: false,
      error: '不支持的文件类型，请选择 JSON 文件',
    });
  });

  it('allows extension-based json files when the browser does not provide a MIME type', () => {
    const result = validateImportFilePreflight(
      { name: 'backup.json', size: 10, type: '' },
      config
    );

    expect(result).toBeNull();
  });
});
