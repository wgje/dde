import { describe, expect, it, vi } from 'vitest';
import type { Project, Task } from '../../../models';
import type {
  AttachmentImportItem,
  AttachmentImportResult,
} from '../../../services/attachment-import.service';
import {
  buildAttachmentImportTaskProjectIndex,
  extractAttachmentImportItems,
  formatAttachmentImportSummary,
  formatUnmatchedAttachmentImportWarning,
  groupAttachmentImportItems,
  importAttachmentGroups,
} from './settings-modal-attachment-import.helpers';

describe('settings-modal-attachment-import.helpers', () => {
  it('extracts ZIP data with the current project task attachment map', async () => {
    const zipData = new ArrayBuffer(8);
    const file = {
      arrayBuffer: vi.fn().mockResolvedValue(zipData),
    } as unknown as File;
    const expectedItem = attachmentImportItem('task-a', 'task-a-file.txt');
    const extractItems = vi.fn().mockResolvedValue([expectedItem]);

    const items = await extractAttachmentImportItems(
      file,
      [project('project-a', [
        task('task-a', [
          { id: 'attachment-a', name: 'task-a-file.txt', size: 12, mimeType: 'text/plain' },
        ]),
      ])],
      extractItems,
    );

    expect(items).toEqual([expectedItem]);
    expect(file.arrayBuffer).toHaveBeenCalledTimes(1);
    expect(extractItems).toHaveBeenCalledTimes(1);
    const [passedZipData, taskAttachmentMap] = extractItems.mock.calls[0];
    expect(passedZipData).toBe(zipData);
    expect(taskAttachmentMap.get('task-a')).toEqual([
      { id: 'attachment-a', name: 'task-a-file.txt', size: 12, mimeType: 'text/plain' },
    ]);
  });

  it('groups import items by explicit project id or task project index', () => {
    const indexedItem = attachmentImportItem('task-a', 'indexed-file.txt');
    const explicitItem = attachmentImportItem('missing-task', 'explicit-file.txt', 'project-explicit');
    const unmatchedItem = attachmentImportItem('unknown-task', 'unknown-file.txt');
    const taskProjectIndex = new Map([['task-a', 'project-a']]);

    const grouped = groupAttachmentImportItems(
      [indexedItem, explicitItem, unmatchedItem],
      taskProjectIndex,
    );

    expect(grouped.unmatchedCount).toBe(1);
    expect(grouped.groupedByProject.get('project-a')).toEqual([indexedItem]);
    expect(grouped.groupedByProject.get('project-explicit')).toEqual([explicitItem]);
  });

  it('imports grouped projects and accumulates skipped, failed, and error messages', async () => {
    const itemA = attachmentImportItem('task-a', 'task-a-file.txt');
    const itemB = attachmentImportItem('task-b', 'task-b-file.txt');
    const importer = vi.fn<(
      projectId: string,
      items: AttachmentImportItem[],
    ) => Promise<AttachmentImportResult>>()
       .mockResolvedValueOnce({
         success: true,
         imported: 1,
         queued: 1,
         failed: 0,
         skipped: 0,
         errors: [],
      })
      .mockResolvedValueOnce({
         success: false,
         imported: 0,
         queued: 0,
         failed: 1,
         skipped: 2,
        errors: [{ taskId: 'task-b', attachmentName: 'task-b-file.txt', error: 'upload failed' }],
      });

    const summary = await importAttachmentGroups(
      new Map([
        ['project-a', [itemA]],
        ['project-b', [itemB]],
      ]),
      1,
      importer,
    );

    expect(importer).toHaveBeenNthCalledWith(1, 'project-a', [itemA]);
    expect(importer).toHaveBeenNthCalledWith(2, 'project-b', [itemB]);
     expect(summary).toEqual({
       imported: 1,
       queued: 1,
       failed: 1,
       skipped: 3,
       errorMessages: ['task-b-file.txt: upload failed'],
    });
  });

  it('formats queued-only imports as local and waiting without claiming success or completion', () => {
    const message = formatAttachmentImportSummary({
      imported: 2,
      queued: 2,
      failed: 0,
      skipped: 1,
      errorMessages: [],
    });

    expect(message).toBe('附件已在本地导入，等待同步。\n本地导入: 2\n待同步: 2\n跳过: 1');
    expect(message).not.toContain('成功');
    expect(message).not.toContain('完成');
  });

  it('formats queued and failed imports as partial with both counts', () => {
    expect(formatAttachmentImportSummary({
      imported: 1,
      queued: 1,
      failed: 1,
      skipped: 3,
      errorMessages: ['task-b-file.txt: upload failed'],
    })).toBe('附件导入部分失败，已保存项等待同步。\n本地导入: 1\n待同步: 1\n失败: 1\n跳过: 3\n首个错误: task-b-file.txt: upload failed');
  });

  it('formats unmatched warning text for the modal', () => {
    expect(formatUnmatchedAttachmentImportWarning(0)).toBeNull();
    expect(formatUnmatchedAttachmentImportWarning(2)).toBe('部分附件未匹配到项目，已跳过: 2');
  });

  it('builds task project indexes for attachment imports', () => {
    const index = buildAttachmentImportTaskProjectIndex([
      project('project-a', [task('task-a')]),
      project('project-b', [task('task-b')]),
    ]);

    expect(index).toEqual(new Map([
      ['task-a', 'project-a'],
      ['task-b', 'project-b'],
    ]));
  });
});

function project(id: string, tasks: Task[]): Project {
  return {
    id,
    name: id,
    description: '',
    createdDate: '2026-01-01T00:00:00.000Z',
    tasks,
    connections: [],
  };
}

function task(
  id: string,
  attachments: Array<{ id: string; name: string; size: number; mimeType: string }> = [],
): Task {
  return {
    id,
    title: id,
    content: '',
    stage: null,
    parentId: null,
    order: 0,
    rank: 0,
    status: 'active',
    x: 0,
    y: 0,
    createdDate: '2026-01-01T00:00:00.000Z',
    displayId: id,
    attachments,
  } as Task;
}

function attachmentImportItem(
  taskId: string,
  name: string,
  projectId?: string,
): AttachmentImportItem {
  return {
    taskId,
    projectId,
    metadata: {
      id: `${taskId}-attachment`,
      name,
      size: 12,
      mimeType: 'text/plain',
    },
    data: new Blob(['attachment'], { type: 'text/plain' }),
  };
}
