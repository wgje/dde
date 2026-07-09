import { SCAN_STATUS, VIRUS_SCAN_CONFIG } from '../config';
import type { Attachment } from '../models';
import type { ScanResponse } from './virus-scan.service';

export interface EnsureAttachmentSafeForDownloadOptions {
  attachment: Attachment;
  checkBeforeDownload: (fileId: string, storedHash?: string) => Promise<ScanResponse>;
  warn: (message: string, details: Record<string, unknown>) => void;
}

export function isLocallySkippedSafeAttachment(attachment: Attachment): boolean {
  return attachment.scanMetadata?.scanStatus === SCAN_STATUS.SKIPPED
    && attachment.scanMetadata.scanHistory?.some(entry =>
      entry.status === SCAN_STATUS.SKIPPED && entry.scanner === 'local'
    ) === true
    && typeof attachment.mimeType === 'string'
    && VIRUS_SCAN_CONFIG.UPLOAD_SCAN.SKIP_MIME_TYPES.some(type => type === attachment.mimeType);
}

export async function ensureAttachmentSafeForDownload(
  options: EnsureAttachmentSafeForDownloadOptions,
): Promise<boolean> {
  const { attachment, checkBeforeDownload, warn } = options;
  if (isLocallySkippedSafeAttachment(attachment)) {
    return true;
  }

  const scanFileId = attachment.scanMetadata?.fileId;
  if (!scanFileId) {
    warn('附件缺少扫描 fileId，拒绝下载', { attachmentId: attachment.id });
    return false;
  }

  const result = await checkBeforeDownload(scanFileId, attachment.scanMetadata?.fileHash);
  if (result.success) {
    return true;
  }

  warn('附件下载前安全检查失败', {
    attachmentId: attachment.id,
    scanFileId,
    error: result.error,
    errorCode: result.errorCode,
  });
  return false;
}
