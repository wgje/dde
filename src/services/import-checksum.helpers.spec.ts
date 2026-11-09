import { describe, expect, it, vi } from 'vitest';

import type { ExportData } from './export.service';
import { verifyImportChecksum } from './import-checksum.helpers';

describe('verifyImportChecksum', () => {
  it('passes when checksum is absent', async () => {
    await expect(verifyImportChecksum(createExportData(''), vi.fn())).resolves.toBe(true);
  });

  it('fails SHA checksums when WebCrypto is unavailable', async () => {
    const originalCrypto = globalThis.crypto;
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: undefined,
    });
    const onDigestFailure = vi.fn();

    try {
      await expect(verifyImportChecksum(createExportData('abc123'), onDigestFailure)).resolves.toBe(false);
      expect(onDigestFailure).toHaveBeenCalled();
    } finally {
      Object.defineProperty(globalThis, 'crypto', {
        configurable: true,
        value: originalCrypto,
      });
    }
  });

  it('verifies legacy simple checksums without WebCrypto', async () => {
    const data = createExportData('');
    data.metadata.checksum = simpleHash(JSON.stringify({
      ...data,
      metadata: { ...data.metadata, checksum: '' },
    }));
    const originalCrypto = globalThis.crypto;
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: undefined,
    });

    try {
      await expect(verifyImportChecksum(data, vi.fn())).resolves.toBe(true);
    } finally {
      Object.defineProperty(globalThis, 'crypto', {
        configurable: true,
        value: originalCrypto,
      });
    }
  });
});

function createExportData(checksum: string): ExportData {
  return {
    metadata: {
      exportedAt: '2026-06-09T00:00:00.000Z',
      version: '2.0.0',
      appVersion: '1.0.0',
      projectCount: 0,
      taskCount: 0,
      connectionCount: 0,
      attachmentCount: 0,
      checksum,
      exportType: 'full',
    },
    projects: [],
  };
}

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i += 1) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash &= hash;
  }
  return `simple-${Math.abs(hash).toString(16)}`;
}
