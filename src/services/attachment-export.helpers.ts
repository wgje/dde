import { Attachment } from '../models';

export const ATTACHMENT_EXPORT_CONFIG = {
  /** 批次大小（每批下载多少个附件） */
  BATCH_SIZE: 5,

  /** 单个附件最大大小（字节）- 100MB */
  MAX_SINGLE_FILE_SIZE: 100 * 1024 * 1024,

  /** 总导出最大大小（字节）- 500MB */
  MAX_TOTAL_SIZE: 500 * 1024 * 1024,

  /** 下载超时（毫秒） */
  DOWNLOAD_TIMEOUT: 60 * 1000,

  /** 重试次数 */
  RETRY_COUNT: 3,

  /** 重试延迟（毫秒） */
  RETRY_DELAY: 1000,

  /** ZIP 文件名前缀 */
  FILENAME_PREFIX: 'nanoflow-attachments',

  /** 附件目录名 */
  ATTACHMENTS_DIR: 'attachments',

  /** Manifest 文件名 */
  MANIFEST_FILENAME: 'manifest.json',
} as const;

export interface AttachmentManifest {
  id: string;
  taskIds: string[];
  projectIds: string[];
  name: string;
  mimeType: string;
  size: number;
  checksum?: string;
  /** 扫描服务文件 ID，用于导出下载前复查 */
  scanFileId?: string;
  /** 上传扫描时的 SHA-256，用于 TOCTOU 校验 */
  fileHash?: string;
  /** ZIP 内相对路径 */
  bundlePath: string;
  /** 原始 URL（可能已过期） */
  originalUrl?: string;
  /** 下载状态 */
  downloadStatus?: 'pending' | 'success' | 'failed' | 'skipped';
  /** 失败原因 */
  failureReason?: string;
}

export interface ExportManifest {
  version: string;
  exportedAt: string;
  totalAttachments: number;
  totalSize: number;
  successCount: number;
  failedCount: number;
  skippedCount: number;
  attachments: AttachmentManifest[];
}

export interface DownloadResult {
  attachment: AttachmentManifest;
  data?: Blob;
  success: boolean;
  error?: string;
}

export interface AttachmentDownloadSummary {
  successCount: number;
  failedCount: number;
  skippedCount: number;
}

export interface ZipFileEntry {
  path: string;
  data: Blob | string;
}

export function calculateAttachmentTotalSize(attachments: AttachmentManifest[]): number {
  return attachments.reduce((sum, attachment) => sum + attachment.size, 0);
}

export function appendAttachmentManifestReference(
  manifest: AttachmentManifest,
  taskId: string,
  projectId: string,
): void {
  const hasReference = manifest.taskIds.some((existingTaskId, index) =>
    existingTaskId === taskId && manifest.projectIds[index] === projectId
  );
  if (hasReference) {
    return;
  }

  manifest.taskIds.push(taskId);
  manifest.projectIds.push(projectId);
}

export function buildSkippedAttachmentDownloadResult(
  attachment: AttachmentManifest,
  reason: string,
  error = reason,
): DownloadResult {
  attachment.downloadStatus = 'skipped';
  attachment.failureReason = reason;
  return {
    attachment,
    success: false,
    error,
  };
}

export function summarizeAttachmentDownloadResults(
  results: DownloadResult[],
): AttachmentDownloadSummary {
  return results.reduce<AttachmentDownloadSummary>(
    (summary, result) => {
      if (result.success) {
        return { ...summary, successCount: summary.successCount + 1 };
      }
      if (result.attachment.downloadStatus === 'skipped') {
        return { ...summary, skippedCount: summary.skippedCount + 1 };
      }
      return { ...summary, failedCount: summary.failedCount + 1 };
    },
    { successCount: 0, failedCount: 0, skippedCount: 0 },
  );
}

export function generateAttachmentBundlePath(attachment: Attachment): string {
  const ext = getFileExtension(attachment.name);
  const safeId = attachment.id.replace(/[^a-zA-Z0-9-]/g, '');
  return `${ATTACHMENT_EXPORT_CONFIG.ATTACHMENTS_DIR}/${safeId}${ext}`;
}

export function createAttachmentExportManifest(
  attachments: AttachmentManifest[],
  successCount: number,
  failedCount: number,
  skippedCount: number,
): ExportManifest {
  return {
    version: '1.0',
    exportedAt: new Date().toISOString(),
    totalAttachments: attachments.length,
    totalSize: calculateAttachmentTotalSize(attachments),
    successCount,
    failedCount,
    skippedCount,
    attachments,
  };
}

export async function createSimpleZip(files: ZipFileEntry[]): Promise<Blob> {
  const parts: BlobPart[] = [];
  const centralDirectory: Uint8Array[] = [];
  let offset = 0;

  for (const file of files) {
    const pathBytes = new TextEncoder().encode(file.path);
    const fileData = await readZipFileData(file.data);
    const crc = crc32(fileData);
    const localHeader = createLocalFileHeader(pathBytes, fileData.length, crc);
    const centralHeader = createCentralDirectoryHeader(pathBytes, fileData.length, crc, offset);

    parts.push(toArrayBuffer(localHeader));
    parts.push(toArrayBuffer(fileData));
    centralDirectory.push(centralHeader);

    offset += localHeader.length + fileData.length;
  }

  appendCentralDirectory(parts, centralDirectory);
  parts.push(toArrayBuffer(createEndOfCentralDirectory(files.length, centralDirectory, offset)));

  return new Blob(parts, { type: 'application/zip' });
}

function getFileExtension(filename: string): string {
  const lastDot = filename.lastIndexOf('.');
  return lastDot > 0 ? filename.substring(lastDot) : '';
}

async function readZipFileData(data: Blob | string): Promise<Uint8Array> {
  if (typeof data === 'string') {
    return new TextEncoder().encode(data);
  }

  return new Uint8Array(await data.arrayBuffer());
}

function appendCentralDirectory(
  parts: BlobPart[],
  centralDirectory: Uint8Array[],
): void {
  for (const header of centralDirectory) {
    parts.push(toArrayBuffer(header));
  }
}

function createLocalFileHeader(
  filename: Uint8Array,
  size: number,
  crc: number,
): Uint8Array {
  const header = new Uint8Array(30 + filename.length);
  const view = new DataView(header.buffer);

  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, 0, true);
  view.setUint16(8, 0, true);
  view.setUint16(10, 0, true);
  view.setUint16(12, 0, true);
  view.setUint32(14, crc, true);
  view.setUint32(18, size, true);
  view.setUint32(22, size, true);
  view.setUint16(26, filename.length, true);
  view.setUint16(28, 0, true);
  header.set(filename, 30);

  return header;
}

function createCentralDirectoryHeader(
  filename: Uint8Array,
  size: number,
  crc: number,
  localHeaderOffset: number,
): Uint8Array {
  const header = new Uint8Array(46 + filename.length);
  const view = new DataView(header.buffer);

  view.setUint32(0, 0x02014b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, 20, true);
  view.setUint16(8, 0, true);
  view.setUint16(10, 0, true);
  view.setUint16(12, 0, true);
  view.setUint16(14, 0, true);
  view.setUint32(16, crc, true);
  view.setUint32(20, size, true);
  view.setUint32(24, size, true);
  view.setUint16(28, filename.length, true);
  view.setUint16(30, 0, true);
  view.setUint16(32, 0, true);
  view.setUint16(34, 0, true);
  view.setUint16(36, 0, true);
  view.setUint32(38, 0, true);
  view.setUint32(42, localHeaderOffset, true);
  header.set(filename, 46);

  return header;
}

function createEndOfCentralDirectory(
  entryCount: number,
  centralDirectory: Uint8Array[],
  centralDirOffset: number,
): Uint8Array {
  const centralDirSize = centralDirectory.reduce((sum, header) => sum + header.length, 0);
  const eocd = new Uint8Array(22);
  const view = new DataView(eocd.buffer);

  view.setUint32(0, 0x06054b50, true);
  view.setUint16(4, 0, true);
  view.setUint16(6, 0, true);
  view.setUint16(8, entryCount, true);
  view.setUint16(10, entryCount, true);
  view.setUint32(12, centralDirSize, true);
  view.setUint32(16, centralDirOffset, true);
  view.setUint16(20, 0, true);

  return eocd;
}

function crc32(data: Uint8Array): number {
  let crc = 0xFFFFFFFF;

  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
    }
  }

  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
