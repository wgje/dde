import { describe, expect, it, vi } from 'vitest';
import {
  ATTACHMENT_IMPORT_CONFIG,
  type AttachmentImportService,
} from './attachment-import.service';
import {
  parseZipEntries,
  type AttachmentImportZipLogger,
  type ParseZipEntriesOptions,
} from './attachment-import-zip.helpers';

interface AttachmentImportZipIntegritySpecContext {
  getService: () => AttachmentImportService;
  getLogger: () => AttachmentImportZipLogger;
}

export function registerAttachmentImportZipIntegritySpecs(
  context: AttachmentImportZipIntegritySpecContext,
): void {
  describe('extractAttachmentsFromZip', () => {
    it('应从 manifest + ZIP 中提取附件数据', async () => {
      const zipData = createStoredZip([
        { path: 'manifest.json', text: JSON.stringify(manifestWith([manifestAttachment()])) },
        { path: 'attachments/att-1.txt', text: 'demo' },
      ]);

      const items = await context.getService().extractAttachmentsFromZip(zipData, new Map());

      expect(items).toHaveLength(1);
      expect(items[0]?.projectId).toBe('project-1');
      expect(items[0]?.taskId).toBe('task-1');
      expect(items[0]?.metadata.name).toBe('a.txt');
      expect(await items[0]!.data!.text()).toBe('demo');
    });

    it('应按 manifest 中 taskIds 与 projectIds 的位置保留跨项目引用', async () => {
      const zipData = createStoredZip([
        {
          path: 'manifest.json',
          text: JSON.stringify(manifestWith([
            manifestAttachment({
              id: 'att-shared',
              taskIds: ['task-a', 'task-b'],
              projectIds: ['project-a', 'project-b'],
              name: 'shared.txt',
              bundlePath: 'attachments/att-shared.txt',
            }),
          ])),
        },
        { path: 'attachments/att-shared.txt', text: 'demo' },
      ]);

      const items = await context.getService().extractAttachmentsFromZip(zipData, new Map());

      expect(items).toHaveLength(2);
      expect(items.map(({ projectId, taskId }) => ({ projectId, taskId }))).toEqual([
        { projectId: 'project-a', taskId: 'task-a' },
        { projectId: 'project-b', taskId: 'task-b' },
      ]);
    });

    it('无 manifest 时应回退 taskAttachmentMap 路径匹配', async () => {
      const zipData = createStoredZip([
        { path: 'attachments/task-1/att-1.txt', text: 'fallback' },
      ]);

      const items = await context.getService().extractAttachmentsFromZip(
        zipData,
        taskAttachmentMap(),
      );

      expect(items).toHaveLength(1);
      expect(items[0]?.taskId).toBe('task-1');
      expect(items[0]?.zipPath).toBe('attachments/task-1/att-1.txt');
    });

    it('present empty manifest is authoritative and does not use legacy task matching', async () => {
      const zipData = createStoredZip([
        { path: 'manifest.json', text: JSON.stringify(manifestWith([])) },
        { path: 'attachments/task-1/att-1.txt', text: 'fallback' },
      ]);

      const items = await context.getService().extractAttachmentsFromZip(
        zipData,
        taskAttachmentMap(),
      );

      expect(items).toEqual([]);
    });

    it('rejects the whole manifest when a later successful attachment has no bytes', async () => {
      const zipData = createStoredZip([
        {
          path: 'manifest.json',
          text: JSON.stringify(manifestWith([
            manifestAttachment(),
            manifestAttachment({
              id: 'att-missing',
              taskIds: ['task-2'],
              projectIds: ['project-1'],
              name: 'missing.txt',
              bundlePath: 'attachments/att-missing.txt',
            }),
          ])),
        },
        { path: 'attachments/att-1.txt', text: 'demo' },
      ]);

      await expect(context.getService().extractAttachmentsFromZip(zipData, new Map()))
        .rejects.toThrow('附件 manifest 引用的文件缺失');
    });

    it('rejects malformed present manifest instead of falling back to current task state', async () => {
      const zipData = createStoredZip([
        { path: 'manifest.json', text: '{invalid-json' },
        { path: 'attachments/task-1/att-1.txt', text: 'fallback' },
      ]);

      await expect(context.getService().extractAttachmentsFromZip(zipData, taskAttachmentMap()))
        .rejects.toThrow('附件 manifest JSON 无效');
    });

    it('rejects present manifest with an invalid attachments schema', async () => {
      const zipData = createStoredZip([
        { path: 'manifest.json', text: JSON.stringify({ attachments: 'invalid' }) },
        { path: 'attachments/task-1/att-1.txt', text: 'fallback' },
      ]);

      await expect(context.getService().extractAttachmentsFromZip(zipData, taskAttachmentMap()))
        .rejects.toThrow('附件 manifest 结构无效');
    });

    it.each(['pending', 'failed', 'skipped'] as const)(
      'rejects manifest attachment status %s instead of silently omitting it',
      async downloadStatus => {
        const zipData = createStoredZip([
          {
            path: 'manifest.json',
            text: JSON.stringify(manifestWith([
              manifestAttachment({ downloadStatus }),
            ])),
          },
          { path: 'attachments/att-1.txt', text: 'demo' },
        ]);

        await expect(context.getService().extractAttachmentsFromZip(zipData, new Map()))
          .rejects.toThrow('附件 manifest 下载状态无效');
      },
    );

    it('rejects task and project arrays that do not describe the same bindings', async () => {
      const zipData = createStoredZip([
        {
          path: 'manifest.json',
          text: JSON.stringify(manifestWith([
            manifestAttachment({ projectIds: [] }),
          ])),
        },
        { path: 'attachments/att-1.txt', text: 'demo' },
      ]);

      await expect(context.getService().extractAttachmentsFromZip(zipData, new Map()))
        .rejects.toThrow('附件 manifest 任务与项目绑定无效');
    });

    it('rejects nonzero declared size that differs from the restored bytes', async () => {
      const zipData = createStoredZip([
        {
          path: 'manifest.json',
          text: JSON.stringify(manifestWith([
            manifestAttachment({ size: 5 }),
          ])),
        },
        { path: 'attachments/att-1.txt', text: 'demo' },
      ]);

      await expect(context.getService().extractAttachmentsFromZip(zipData, new Map()))
        .rejects.toThrow('附件 manifest 声明大小与实际字节不一致');
    });

    it('rejects manifest content digest mismatches before import', async () => {
      const zipData = createStoredZip([
        {
          path: 'manifest.json',
          text: JSON.stringify(manifestWith([
            manifestAttachment({ checksum: '0'.repeat(64) }),
          ])),
        },
        { path: 'attachments/att-1.txt', text: 'demo' },
      ]);

      await expect(context.getService().extractAttachmentsFromZip(zipData, new Map()))
        .rejects.toThrow('附件 manifest 校验和与实际字节不一致');
    });

    it('preserves size zero as unspecified-size compatibility', async () => {
      const zipData = createStoredZip([
        {
          path: 'manifest.json',
          text: JSON.stringify(manifestWith([
            manifestAttachment({ size: 0 }),
          ])),
        },
        { path: 'attachments/att-1.txt', text: 'demo' },
      ]);

      const items = await context.getService().extractAttachmentsFromZip(zipData, new Map());

      expect(items[0]?.metadata.size).toBe(4);
    });

    it('应拒绝声明解压尺寸超过限制的 ZIP 条目', async () => {
      const oversize = ATTACHMENT_IMPORT_CONFIG.MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES + 1;
      const zipData = createStoredZip([
        {
          path: 'manifest.json',
          text: JSON.stringify(manifestWith([
            manifestAttachment({
              id: 'att-oversize',
              name: 'oversize.txt',
              size: oversize,
              bundlePath: 'attachments/att-oversize.txt',
            }),
          ])),
        },
        { path: 'attachments/att-oversize.txt', text: 'x', declaredSize: oversize },
      ]);

      await expect(context.getService().extractAttachmentsFromZip(zipData, new Map()))
        .rejects.toThrow('ZIP 条目解压后大小超过限制');
    });

    it('应拒绝实际解压总大小超过限制的 ZIP，即使中心目录低报尺寸', async () => {
      const zipData = createStoredZip(
        Array.from({ length: 11 }, (_, index) => ({
          path: `attachments/att-${index}.txt`,
          text: 'x',
          declaredSize: 1,
        })),
      );
      const readZipEntryData = vi.fn().mockResolvedValue({
        data: { byteLength: ATTACHMENT_IMPORT_CONFIG.MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES } as Uint8Array,
        uncompressedSize: 1,
        compressionMethod: 0,
      });
      const options: ParseZipEntriesOptions = {
        limits: createZipLimits(),
        logger: context.getLogger(),
        readZipEntryData,
      };

      await expect(parseZipEntries(zipData, options))
        .rejects.toThrow('ZIP 解压后总大小超过限制');
    });

    it('manifest 引用不安全 ZIP 路径时应整体拒绝', async () => {
      const zipData = createStoredZip([
        {
          path: 'manifest.json',
          text: JSON.stringify(manifestWith([
            manifestAttachment({ bundlePath: '../escape.txt' }),
          ])),
        },
        { path: '../escape.txt', text: 'demo' },
      ]);

      await expect(context.getService().extractAttachmentsFromZip(zipData, new Map()))
        .rejects.toThrow('附件 manifest 路径无效');
    });
  });
}

function manifestWith(attachments: Array<Record<string, unknown>>): Record<string, unknown> {
  return {
    version: '1.0',
    exportedAt: '2026-01-01T00:00:00.000Z',
    totalAttachments: attachments.length,
    totalSize: attachments.reduce(
      (sum, attachment) => sum + (typeof attachment['size'] === 'number' ? attachment['size'] : 0),
      0,
    ),
    successCount: attachments.length,
    failedCount: 0,
    skippedCount: 0,
    attachments,
  };
}

function manifestAttachment(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 'att-1',
    taskIds: ['task-1'],
    projectIds: ['project-1'],
    name: 'a.txt',
    mimeType: 'text/plain',
    size: 4,
    bundlePath: 'attachments/att-1.txt',
    downloadStatus: 'success',
    ...overrides,
  };
}

function taskAttachmentMap(): Map<
  string,
  Array<{ id: string; name: string; size: number; mimeType: string }>
> {
  return new Map([
    ['task-1', [{ id: 'att-1', name: 'att-1.txt', size: 8, mimeType: 'text/plain' }]],
  ]);
}

function createZipLimits() {
  return {
    maxEntries: ATTACHMENT_IMPORT_CONFIG.MAX_ZIP_ENTRIES,
    maxEntryUncompressedBytes: ATTACHMENT_IMPORT_CONFIG.MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES,
    maxTotalUncompressedBytes: ATTACHMENT_IMPORT_CONFIG.MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES,
  };
}

function createStoredZip(files: Array<{ path: string; text: string; declaredSize?: number }>): ArrayBuffer {
  const encoder = new TextEncoder();
  const fileRecords: Array<{
    nameBytes: Uint8Array;
    dataBytes: Uint8Array;
    localHeader: Uint8Array;
    centralHeader: Uint8Array;
  }> = [];
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = encoder.encode(file.path);
    const dataBytes = encoder.encode(file.text);
    const declaredSize = file.declaredSize ?? dataBytes.length;
    const crc = crc32(dataBytes);
    const localHeader = createLocalHeader(nameBytes, dataBytes, declaredSize, crc);
    const centralHeader = createCentralHeader(nameBytes, dataBytes, declaredSize, crc, offset);

    localParts.push(localHeader, dataBytes);
    centralParts.push(centralHeader);
    fileRecords.push({ nameBytes, dataBytes, localHeader, centralHeader });
    offset += localHeader.length + dataBytes.length;
  }

  const centralOffset = offset;
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const eocd = createEndOfCentralDirectory(fileRecords.length, centralSize, centralOffset);
  const totalLength = localParts.reduce((sum, part) => sum + part.length, 0) + centralSize + eocd.length;
  const output = new Uint8Array(totalLength);
  let cursor = 0;

  for (const part of [...localParts, ...centralParts, eocd]) {
    output.set(part, cursor);
    cursor += part.length;
  }

  return output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength);
}

function createLocalHeader(
  nameBytes: Uint8Array,
  dataBytes: Uint8Array,
  declaredSize: number,
  crc: number,
): Uint8Array {
  const header = new Uint8Array(30 + nameBytes.length);
  const view = new DataView(header.buffer);
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, 0, true);
  view.setUint16(8, 0, true);
  view.setUint32(14, crc, true);
  view.setUint32(18, dataBytes.length, true);
  view.setUint32(22, declaredSize, true);
  view.setUint16(26, nameBytes.length, true);
  view.setUint16(28, 0, true);
  header.set(nameBytes, 30);
  return header;
}

function createCentralHeader(
  nameBytes: Uint8Array,
  dataBytes: Uint8Array,
  declaredSize: number,
  crc: number,
  offset: number,
): Uint8Array {
  const header = new Uint8Array(46 + nameBytes.length);
  const view = new DataView(header.buffer);
  view.setUint32(0, 0x02014b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, 20, true);
  view.setUint16(8, 0, true);
  view.setUint16(10, 0, true);
  view.setUint32(16, crc, true);
  view.setUint32(20, dataBytes.length, true);
  view.setUint32(24, declaredSize, true);
  view.setUint16(28, nameBytes.length, true);
  view.setUint16(30, 0, true);
  view.setUint16(32, 0, true);
  view.setUint16(34, 0, true);
  view.setUint16(36, 0, true);
  view.setUint32(38, 0, true);
  view.setUint32(42, offset, true);
  header.set(nameBytes, 46);
  return header;
}

function createEndOfCentralDirectory(
  fileCount: number,
  centralSize: number,
  centralOffset: number,
): Uint8Array {
  const eocd = new Uint8Array(22);
  const view = new DataView(eocd.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(4, 0, true);
  view.setUint16(6, 0, true);
  view.setUint16(8, fileCount, true);
  view.setUint16(10, fileCount, true);
  view.setUint32(12, centralSize, true);
  view.setUint32(16, centralOffset, true);
  view.setUint16(20, 0, true);
  return eocd;
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
