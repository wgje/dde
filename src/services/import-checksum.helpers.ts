import {
  calculateChecksum,
  type BackupData,
} from '../../supabase/functions/_shared/backup-utils';
import type { ExportData } from './export.service';

export async function verifyBackupDataChecksum(
  data: unknown,
  onDigestFailure: (error: unknown) => void,
): Promise<boolean> {
  if (!isBackupDataChecksumCandidate(data)) {
    return true;
  }

  if (!Object.prototype.hasOwnProperty.call(data, 'checksum')) {
    return true;
  }

  const originalChecksum = data.checksum;
  if (typeof originalChecksum !== 'string' || originalChecksum.length === 0) {
    return false;
  }

  try {
    const calculatedChecksum = await calculateChecksum(JSON.stringify({
      ...data,
      checksum: '',
    }));
    return calculatedChecksum === originalChecksum;
  } catch (error) {
    onDigestFailure(error);
    return false;
  }
}

export async function verifyImportChecksum(
  data: ExportData,
  onDigestFailure: (error: unknown) => void,
): Promise<boolean> {
  const originalChecksum = data.metadata.checksum;
  if (!originalChecksum) {
    return true;
  }

  const dataForChecksum = {
    ...data,
    metadata: { ...data.metadata, checksum: '' },
  };
  const jsonString = JSON.stringify(dataForChecksum);

  try {
    if (typeof crypto !== 'undefined' && crypto.subtle) {
      const encoder = new TextEncoder();
      const dataBuffer = encoder.encode(jsonString);
      const hashBuffer = await crypto.subtle.digest('SHA-256', dataBuffer);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      const calculatedChecksum = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

      return calculatedChecksum === originalChecksum;
    }
  } catch (error) {
    onDigestFailure(error);
    return false;
  }

  if (originalChecksum.startsWith('simple-')) {
    return simpleHash(jsonString) === originalChecksum;
  }

  onDigestFailure(new Error('WebCrypto SHA-256 digest is unavailable'));
  return false;
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

function isBackupDataChecksumCandidate(data: unknown): data is BackupData {
  if (!data || typeof data !== 'object') {
    return false;
  }

  const candidate = data as Record<string, unknown>;
  return (
    typeof candidate['payloadVersion'] === 'string'
    && Array.isArray(candidate['projects'])
    && Array.isArray(candidate['tasks'])
    && Array.isArray(candidate['connections'])
    && !candidate['metadata']
  );
}
