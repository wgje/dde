import type { AttachmentImportItem } from './attachment-import.service';

export interface AttachmentImportZipLimits {
  maxEntries: number;
  maxEntryUncompressedBytes: number;
  maxTotalUncompressedBytes: number;
}

export interface AttachmentImportZipLogger {
  warn(message: string, value?: unknown): void;
}

export interface ZipEntryData {
  data: Uint8Array;
  uncompressedSize: number;
  compressionMethod: number;
}

export interface ZipCentralEntryHeader {
  filename: string;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  nextCentralOffset: number;
}

export interface ParseZipEntriesOptions {
  limits: AttachmentImportZipLimits;
  logger: AttachmentImportZipLogger;
  readZipEntryData?: (
    bytes: Uint8Array,
    view: DataView,
    header: ZipCentralEntryHeader,
    limits: AttachmentImportZipLimits,
    logger: AttachmentImportZipLogger,
  ) => Promise<ZipEntryData | null>;
}

interface AttachmentBundleManifestItem {
  id: string;
  taskIds: string[];
  projectIds: string[];
  name: string;
  mimeType: string;
  size: number;
  bundlePath: string;
}

interface ManifestAttachmentPreflight {
  attachment: AttachmentBundleManifestItem;
  fileEntry: ZipEntryData;
}

const MANIFEST_FILENAME = 'manifest.json';

export async function extractAttachmentItemsFromZip(
  zipData: ArrayBuffer,
  taskAttachmentMap: Map<string, Array<{ id: string; name: string; size: number; mimeType: string }>>,
  options: ParseZipEntriesOptions,
): Promise<AttachmentImportItem[]> {
  const entries = await parseZipEntries(zipData, options);
  if (entries.size === 0) {
    return [];
  }

  const manifestItems = buildItemsFromManifest(entries, options.logger);
  if (manifestItems !== null) {
    return manifestItems;
  }

  return buildItemsFromTaskMap(entries, taskAttachmentMap);
}

export async function parseZipEntries(
  zipData: ArrayBuffer,
  options: ParseZipEntriesOptions,
): Promise<Map<string, ZipEntryData>> {
  const bytes = new Uint8Array(zipData);
  const view = new DataView(zipData);
  const entries = new Map<string, ZipEntryData>();
  let totalUncompressedSize = 0;

  const eocdOffset = findEndOfCentralDirectory(bytes, view);
  if (eocdOffset < 0) {
    options.logger.warn('ZIP 解析失败：未找到 EOCD');
    return entries;
  }

  const totalEntries = view.getUint16(eocdOffset + 10, true);
  if (totalEntries > options.limits.maxEntries) {
    throw new Error('ZIP 条目数量超过限制');
  }
  let centralOffset = view.getUint32(eocdOffset + 16, true);
  const readEntryData = options.readZipEntryData ?? readZipEntryDataFromLocalHeader;

  for (let i = 0; i < totalEntries; i++) {
    const header = readZipCentralEntryHeader(bytes, view, centralOffset);
    if (!header) break;

    if (!isSafeZipEntryPath(header.filename)) {
      options.logger.warn('跳过不安全的 ZIP 条目路径', { filename: header.filename });
      centralOffset = header.nextCentralOffset;
      continue;
    }
    if (header.uncompressedSize > options.limits.maxEntryUncompressedBytes) {
      throw new Error('ZIP 条目解压后大小超过限制');
    }

    const entry = await readEntryData(bytes, view, header, options.limits, options.logger);
    if (!entry) break;

    totalUncompressedSize += entry.data.byteLength;
    if (totalUncompressedSize > options.limits.maxTotalUncompressedBytes) {
      throw new Error('ZIP 解压后总大小超过限制');
    }

    entries.set(header.filename, entry);
    centralOffset = header.nextCentralOffset;
  }

  return entries;
}

function buildItemsFromManifest(
  entries: Map<string, ZipEntryData>,
  logger: AttachmentImportZipLogger,
): AttachmentImportItem[] | null {
  const manifestEntry = entries.get(MANIFEST_FILENAME);
  if (!manifestEntry) return null;

  const attachments = parseManifestAttachments(manifestEntry, logger);
  const preflight = preflightManifestAttachments(attachments, entries);
  return buildItemsFromManifestPreflight(preflight);
}

function parseManifestAttachments(
  manifestEntry: ZipEntryData,
  logger: AttachmentImportZipLogger,
): AttachmentBundleManifestItem[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(manifestEntry.data));
  } catch (error) {
    logger.warn('解析附件 manifest JSON 失败', { error });
    throw new Error('附件 manifest JSON 无效');
  }

  if (!isRecord(parsed) || !Array.isArray(parsed['attachments'])) {
    throw new Error('附件 manifest 结构无效');
  }

  return parsed['attachments'].map((value, index) => parseManifestAttachment(value, index));
}

function parseManifestAttachment(
  value: unknown,
  index: number,
): AttachmentBundleManifestItem {
  if (!isRecord(value)) {
    throw new Error(`附件 manifest 结构无效: attachments[${index}]`);
  }

  const taskIds = readBindingIds(value['taskIds']);
  const projectIds = readBindingIds(value['projectIds']);
  if (taskIds.length === 0 || taskIds.length !== projectIds.length) {
    throw new Error(`附件 manifest 任务与项目绑定无效: attachments[${index}]`);
  }

  const downloadStatus = value['downloadStatus'];
  if (downloadStatus !== undefined && downloadStatus !== 'success') {
    throw new Error(`附件 manifest 下载状态无效: attachments[${index}]`);
  }

  return {
    id: readRequiredString(value, 'id', index),
    taskIds,
    projectIds,
    name: readRequiredString(value, 'name', index),
    mimeType: readString(value, 'mimeType', index),
    size: readAttachmentSize(value['size'], index),
    bundlePath: readRequiredString(value, 'bundlePath', index),
  };
}

function preflightManifestAttachments(
  attachments: AttachmentBundleManifestItem[],
  entries: Map<string, ZipEntryData>,
): ManifestAttachmentPreflight[] {
  return attachments.map((attachment, index) => {
    if (!isSafeZipEntryPath(attachment.bundlePath)) {
      throw new Error(`附件 manifest 路径无效: attachments[${index}]`);
    }

    const fileEntry = entries.get(attachment.bundlePath);
    if (!fileEntry) {
      throw new Error(`附件 manifest 引用的文件缺失: ${attachment.bundlePath}`);
    }
    if (attachment.size > 0 && attachment.size !== fileEntry.data.byteLength) {
      throw new Error(`附件 manifest 声明大小与实际字节不一致: ${attachment.bundlePath}`);
    }

    return { attachment, fileEntry };
  });
}

function buildItemsFromManifestPreflight(
  preflight: ManifestAttachmentPreflight[],
): AttachmentImportItem[] {
  return preflight.flatMap(({ attachment, fileEntry }) => {
    const mimeType = attachment.mimeType || 'application/octet-stream';
    const blob = new Blob([fileEntry.data], { type: mimeType });
    return attachment.taskIds.map((taskId, index) => ({
      projectId: attachment.projectIds[index],
      taskId,
      metadata: {
        id: attachment.id,
        name: attachment.name,
        size: attachment.size || fileEntry.data.byteLength,
        mimeType,
      },
      data: blob,
      zipPath: attachment.bundlePath,
    }));
  });
}

function readBindingIds(value: unknown): string[] {
  return Array.isArray(value) && value.every(isNonEmptyString) ? value : [];
}

function readRequiredString(
  record: Record<string, unknown>,
  key: string,
  index: number,
): string {
  const value = record[key];
  if (!isNonEmptyString(value)) {
    throw new Error(`附件 manifest 结构无效: attachments[${index}].${key}`);
  }
  return value;
}

function readString(
  record: Record<string, unknown>,
  key: string,
  index: number,
): string {
  const value = record[key];
  if (typeof value !== 'string') {
    throw new Error(`附件 manifest 结构无效: attachments[${index}].${key}`);
  }
  return value;
}

function readAttachmentSize(value: unknown, index: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`附件 manifest 结构无效: attachments[${index}].size`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function buildItemsFromTaskMap(
  entries: Map<string, ZipEntryData>,
  taskAttachmentMap: Map<string, Array<{ id: string; name: string; size: number; mimeType: string }>>,
): AttachmentImportItem[] {
  const items: AttachmentImportItem[] = [];

  for (const [taskId, attachments] of taskAttachmentMap) {
    for (const att of attachments) {
      const ext = getFileExtension(att.name);
      const candidatePaths = [
        `attachments/${att.id}${ext}`,
        `attachments/${att.id}`,
        `attachments/${taskId}/${att.id}${ext}`,
        `attachments/${taskId}/${att.id}`,
      ];

      const matchedPath = candidatePaths.find(path => entries.has(path));
      if (!matchedPath) continue;

      const entry = entries.get(matchedPath);
      if (!entry) continue;

      const mimeType = att.mimeType || 'application/octet-stream';
      items.push({
        taskId,
        metadata: {
          id: att.id,
          name: att.name,
          size: att.size || entry.uncompressedSize,
          mimeType,
        },
        data: new Blob([entry.data], { type: mimeType }),
        zipPath: matchedPath,
      });
    }
  }

  return items;
}

function readZipCentralEntryHeader(
  bytes: Uint8Array,
  view: DataView,
  centralOffset: number,
): ZipCentralEntryHeader | null {
  if (centralOffset + 46 > bytes.length) return null;
  if (view.getUint32(centralOffset, true) !== 0x02014b50) return null;

  const fileNameLength = view.getUint16(centralOffset + 28, true);
  const extraLength = view.getUint16(centralOffset + 30, true);
  const commentLength = view.getUint16(centralOffset + 32, true);
  const nameStart = centralOffset + 46;
  const nameEnd = nameStart + fileNameLength;
  if (nameEnd > bytes.length) return null;

  return {
    filename: new TextDecoder().decode(bytes.slice(nameStart, nameEnd)),
    compressionMethod: view.getUint16(centralOffset + 10, true),
    compressedSize: view.getUint32(centralOffset + 20, true),
    uncompressedSize: view.getUint32(centralOffset + 24, true),
    localHeaderOffset: view.getUint32(centralOffset + 42, true),
    nextCentralOffset: centralOffset + 46 + fileNameLength + extraLength + commentLength,
  };
}

async function readZipEntryDataFromLocalHeader(
  bytes: Uint8Array,
  view: DataView,
  header: ZipCentralEntryHeader,
  limits: AttachmentImportZipLimits,
  logger: AttachmentImportZipLogger,
): Promise<ZipEntryData | null> {
  if (header.localHeaderOffset + 30 > bytes.length) return null;
  if (view.getUint32(header.localHeaderOffset, true) !== 0x04034b50) return null;

  const localNameLength = view.getUint16(header.localHeaderOffset + 26, true);
  const localExtraLength = view.getUint16(header.localHeaderOffset + 28, true);
  const dataStart = header.localHeaderOffset + 30 + localNameLength + localExtraLength;
  const dataEnd = dataStart + header.compressedSize;
  if (dataEnd > bytes.length) return null;

  const compressedData = bytes.slice(dataStart, dataEnd);
  const data = await decompressZipEntry(
    header.compressionMethod,
    compressedData,
    header.uncompressedSize,
    logger,
  );
  if (data.byteLength > limits.maxEntryUncompressedBytes) {
    throw new Error('ZIP 条目实际解压大小超过限制');
  }

  return {
    data,
    uncompressedSize: data.byteLength,
    compressionMethod: header.compressionMethod,
  };
}

function isSafeZipEntryPath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/') || normalized.includes('\0')) {
    return false;
  }
  return normalized
    .split('/')
    .every(segment => segment.length > 0 && segment !== '.' && segment !== '..');
}

function findEndOfCentralDirectory(bytes: Uint8Array, view: DataView): number {
  const minEocdSize = 22;
  const maxCommentLength = 0xffff;
  const searchStart = Math.max(0, bytes.length - minEocdSize - maxCommentLength);

  for (let i = bytes.length - minEocdSize; i >= searchStart; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      return i;
    }
  }

  return -1;
}

async function decompressZipEntry(
  compressionMethod: number,
  compressedData: Uint8Array,
  expectedSize: number,
  logger: AttachmentImportZipLogger,
): Promise<Uint8Array> {
  if (compressionMethod === 0) {
    return compressedData;
  }

  if (compressionMethod === 8 && typeof DecompressionStream !== 'undefined') {
    const stream = new Blob([compressedData]).stream()
      .pipeThrough(new DecompressionStream('deflate-raw'));
    const buffer = await new Response(stream).arrayBuffer();
    const inflated = new Uint8Array(buffer);
    if (expectedSize > 0 && inflated.byteLength !== expectedSize) {
      logger.warn('ZIP 解压后大小与预期不一致', {
        expectedSize,
        actualSize: inflated.byteLength,
      });
    }
    return inflated;
  }

  throw new Error(`不支持的 ZIP 压缩方式: ${compressionMethod}`);
}

function getFileExtension(filename: string): string {
  const index = filename.lastIndexOf('.');
  if (index <= 0) return '';
  return filename.slice(index);
}
