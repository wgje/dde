import { describe, expect, it, vi } from 'vitest';
import type { Attachment } from '../models';
import { SCAN_STATUS } from '../config/virus-scan.config';
import {
  ensureAttachmentSafeForDownload,
  isLocallySkippedSafeAttachment,
} from './attachment-download-safety.helpers';

function attachment(overrides: Partial<Attachment> = {}): Attachment {
  return {
    id: overrides.id ?? 'attachment-1',
    type: overrides.type ?? 'image',
    name: overrides.name ?? 'safe.png',
    url: overrides.url ?? 'https://example.com/safe.png',
    mimeType: overrides.mimeType ?? 'image/png',
    createdAt: overrides.createdAt ?? '2026-06-13T00:00:00.000Z',
    scanMetadata: overrides.scanMetadata,
  };
}

describe('attachment-download-safety.helpers', () => {
  it('只允许本地安全 MIME 校验跳过扫描的附件绕过下载前服务端复查', () => {
    const locallySkippedImage = attachment({
      scanMetadata: {
        scanStatus: SCAN_STATUS.SKIPPED,
        scanHistory: [
          {
            scannedAt: '2026-06-13T00:00:00.000Z',
            status: SCAN_STATUS.SKIPPED,
            scanner: 'local',
          },
        ],
      },
    });

    expect(isLocallySkippedSafeAttachment(locallySkippedImage)).toBe(true);
    expect(isLocallySkippedSafeAttachment(attachment({
      mimeType: 'application/pdf',
      scanMetadata: locallySkippedImage.scanMetadata,
    }))).toBe(false);
    expect(isLocallySkippedSafeAttachment(attachment({
      scanMetadata: {
        scanStatus: SCAN_STATUS.SKIPPED,
        scanHistory: [
          {
            scannedAt: '2026-06-13T00:00:00.000Z',
            status: SCAN_STATUS.SKIPPED,
            scanner: 'remote',
          },
        ],
      },
    }))).toBe(false);
    expect(isLocallySkippedSafeAttachment(attachment({
      scanMetadata: {
        scanStatus: SCAN_STATUS.CLEAN,
      },
    }))).toBe(false);
  });

  it('集中处理下载前安全检查和拒绝日志', async () => {
    const warn = vi.fn();
    const checkBeforeDownload = vi.fn().mockResolvedValue({ success: true });

    await expect(ensureAttachmentSafeForDownload({
      attachment: attachment({
        scanMetadata: {
          fileId: 'scan-file-1',
          fileHash: 'hash-1',
          scanStatus: SCAN_STATUS.CLEAN,
        },
      }),
      checkBeforeDownload,
      warn,
    })).resolves.toBe(true);
    expect(checkBeforeDownload).toHaveBeenCalledWith('scan-file-1', 'hash-1');
    expect(warn).not.toHaveBeenCalled();

    checkBeforeDownload.mockClear();
    await expect(ensureAttachmentSafeForDownload({
      attachment: attachment({
        scanMetadata: {
          scanStatus: SCAN_STATUS.SKIPPED,
          scanHistory: [{ scannedAt: '2026-06-13T00:00:00.000Z', status: SCAN_STATUS.SKIPPED, scanner: 'local' }],
        },
      }),
      checkBeforeDownload,
      warn,
    })).resolves.toBe(true);
    expect(checkBeforeDownload).not.toHaveBeenCalled();

    await expect(ensureAttachmentSafeForDownload({
      attachment: attachment({ id: 'missing-file-id' }),
      checkBeforeDownload,
      warn,
    })).resolves.toBe(false);
    expect(warn).toHaveBeenCalledWith('附件缺少扫描 fileId，拒绝下载', { attachmentId: 'missing-file-id' });

    checkBeforeDownload.mockResolvedValueOnce({
      success: false,
      error: 'scan failed',
      errorCode: 'CHECK_FAILED',
    });
    await expect(ensureAttachmentSafeForDownload({
      attachment: attachment({
        id: 'unsafe-attachment',
        scanMetadata: {
          fileId: 'scan-file-2',
          fileHash: 'hash-2',
          scanStatus: SCAN_STATUS.CLEAN,
        },
      }),
      checkBeforeDownload,
      warn,
    })).resolves.toBe(false);
    expect(warn).toHaveBeenCalledWith('附件下载前安全检查失败', {
      attachmentId: 'unsafe-attachment',
      scanFileId: 'scan-file-2',
      error: 'scan failed',
      errorCode: 'CHECK_FAILED',
    });
  });
});
