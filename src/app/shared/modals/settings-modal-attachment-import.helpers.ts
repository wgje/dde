import type { Project } from '../../../models';
import type {
  AttachmentImportItem,
  AttachmentImportResult,
} from '../../../services/attachment-import.service';
import {
  buildTaskAttachmentMap,
  buildTaskProjectIndex,
  type TaskAttachmentMetadata,
} from './settings-modal-task-index';

export interface AttachmentImportGroups {
  groupedByProject: Map<string, AttachmentImportItem[]>;
  unmatchedCount: number;
}

export interface AttachmentImportSummary {
  imported: number;
  queued: number;
  failed: number;
  skipped: number;
  errorMessages: string[];
}

export interface AttachmentImportWorkflowResult {
  message: string;
  warning: string | null;
}

type ExtractAttachmentItems = (
  zipData: ArrayBuffer,
  taskAttachmentMap: Map<string, TaskAttachmentMetadata[]>,
) => Promise<AttachmentImportItem[]>;

type ImportProjectAttachments = (
  projectId: string,
  items: AttachmentImportItem[],
) => Promise<AttachmentImportResult>;

export async function extractAttachmentImportItems(
  file: File,
  projects: Project[],
  extractItems: ExtractAttachmentItems,
): Promise<AttachmentImportItem[]> {
  const zipData = await file.arrayBuffer();
  return extractItems(zipData, buildTaskAttachmentMap(projects));
}

export function groupAttachmentImportItems(
  extractedItems: AttachmentImportItem[],
  taskProjectIndex: Map<string, string>,
): AttachmentImportGroups {
  const groupedByProject = new Map<string, AttachmentImportItem[]>();
  let unmatchedCount = 0;

  for (const item of extractedItems) {
    const projectId = item.projectId ?? taskProjectIndex.get(item.taskId);
    if (!projectId) {
      unmatchedCount++;
      continue;
    }

    const existingGroup = groupedByProject.get(projectId);
    if (existingGroup) {
      existingGroup.push(item);
    } else {
      groupedByProject.set(projectId, [item]);
    }
  }

  return { groupedByProject, unmatchedCount };
}

export async function importAttachmentGroups(
  groupedByProject: Map<string, AttachmentImportItem[]>,
  unmatchedCount: number,
  importProjectAttachments: ImportProjectAttachments,
): Promise<AttachmentImportSummary> {
  const summary: AttachmentImportSummary = {
    imported: 0,
    queued: 0,
    failed: 0,
    skipped: unmatchedCount,
    errorMessages: [],
  };

  for (const [projectId, items] of groupedByProject) {
    const importResult = await importProjectAttachments(projectId, items);
    summary.imported += importResult.imported;
    summary.queued += importResult.queued;
    summary.failed += importResult.failed;
    summary.skipped += importResult.skipped;
    summary.errorMessages.push(
      ...importResult.errors.map(error => `${error.attachmentName || '未知附件'}: ${error.error}`),
    );
  }

  return summary;
}

export async function runAttachmentImportWorkflow(
  file: File,
  projects: Project[],
  extractItems: ExtractAttachmentItems,
  importProjectAttachments: ImportProjectAttachments,
): Promise<AttachmentImportWorkflowResult> {
  const taskProjectIndex = buildAttachmentImportTaskProjectIndex(projects);
  const extractedItems = await extractAttachmentImportItems(file, projects, extractItems);

  if (extractedItems.length === 0) {
    return { message: '附件包中未找到可导入的附件', warning: null };
  }

  const { groupedByProject, unmatchedCount } = groupAttachmentImportItems(
    extractedItems,
    taskProjectIndex,
  );
  if (groupedByProject.size === 0) {
    return { message: '附件包中的任务与当前项目不匹配，无法导入', warning: null };
  }

  const summary = await importAttachmentGroups(groupedByProject, unmatchedCount, importProjectAttachments);
  return {
    message: formatAttachmentImportSummary(summary),
    warning: formatUnmatchedAttachmentImportWarning(unmatchedCount),
  };
}

export function formatAttachmentImportSummary(summary: AttachmentImportSummary): string {
  if (summary.failed === 0 && summary.queued > 0) {
    return `附件已在本地导入，等待同步。\n本地导入: ${summary.imported}\n待同步: ${summary.queued}\n跳过: ${summary.skipped}`;
  }

  if (summary.failed === 0) {
    return `附件导入完成！\n成功: ${summary.imported}\n跳过: ${summary.skipped}`;
  }

  const topError = summary.errorMessages[0] ?? '未知错误';
  if (summary.queued > 0) {
    return `附件导入部分失败，已保存项等待同步。\n本地导入: ${summary.imported}\n待同步: ${summary.queued}\n失败: ${summary.failed}\n跳过: ${summary.skipped}\n首个错误: ${topError}`;
  }

  return `附件导入部分失败。\n成功: ${summary.imported}\n失败: ${summary.failed}\n跳过: ${summary.skipped}\n首个错误: ${topError}`;
}

export function formatUnmatchedAttachmentImportWarning(unmatchedCount: number): string | null {
  return unmatchedCount > 0
    ? `部分附件未匹配到项目，已跳过: ${unmatchedCount}`
    : null;
}

export function buildAttachmentImportTaskProjectIndex(projects: Project[]): Map<string, string> {
  return buildTaskProjectIndex(projects);
}
