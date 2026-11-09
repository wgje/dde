import type { AttachmentType, Task } from '../models';
import type { TaskParkingMeta } from '../models/parking';
import type { ExportTask } from './export.service';

export interface ConvertExportTaskOptions {
  idMap?: ReadonlyMap<string, string>;
  now?: string;
}

export function convertExportTaskToTask(
  exportTask: ExportTask,
  options: ConvertExportTaskOptions = {}
): Task {
  const now = options.now ?? new Date().toISOString();
  const newId = options.idMap?.get(exportTask.id) ?? exportTask.id;
  const newParentId = exportTask.parentId
    ? (options.idMap?.get(exportTask.parentId) ?? exportTask.parentId)
    : null;

  return {
    id: newId,
    title: exportTask.title,
    content: exportTask.content ?? '',
    stage: exportTask.stage,
    parentId: newParentId,
    order: exportTask.order ?? 0,
    rank: exportTask.rank ?? 10000,
    status: (exportTask.status as Task['status']) ?? 'active',
    x: exportTask.x ?? 0,
    y: exportTask.y ?? 0,
    displayId: exportTask.displayId ?? '',
    shortId: exportTask.shortId,
    createdDate: exportTask.createdAt ?? now,
    updatedAt: now,
    completedAt: buildImportedCompletedAt(exportTask, now),
    tags: exportTask.tags,
    priority: exportTask.priority,
    dueDate: exportTask.dueDate,
    expected_minutes: normalizeNullableNumber(exportTask.expected_minutes),
    cognitive_load: normalizeCognitiveLoad(exportTask.cognitive_load),
    wait_minutes: normalizeNullableNumber(exportTask.wait_minutes),
    hasIncompleteTask: exportTask.hasIncompleteTask,
    deletedAt: exportTask.deletedAt,
    parkingMeta: normalizeImportedParkingMeta(exportTask.parkingMeta, now),
    attentionMeta: exportTask.attentionMeta ?? null,
    attachments: exportTask.attachments?.map(attachment => ({
      id: attachment.id,
      name: attachment.name,
      size: attachment.size ?? 0,
      mimeType: attachment.mimeType ?? 'application/octet-stream',
      type: attachment.type ?? inferAttachmentType(attachment.mimeType ?? 'application/octet-stream'),
      url: '',
      thumbnailUrl: attachment.thumbnailUrl,
      createdAt: attachment.createdAt ?? now,
    })),
  };
}

function buildImportedCompletedAt(exportTask: ExportTask, now: string): string | null {
  if (exportTask.status !== 'completed') {
    return null;
  }

  return exportTask.completedAt ?? exportTask.updatedAt ?? exportTask.createdAt ?? now;
}

function normalizeNullableNumber(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

function normalizeCognitiveLoad(value: unknown): 'high' | 'low' | null {
  return value === 'high' || value === 'low' ? value : null;
}

function normalizeImportedParkingMeta(
  meta: TaskParkingMeta | null | undefined,
  now: string
): TaskParkingMeta | null {
  if (!meta) {
    return null;
  }

  return {
    ...meta,
    lastVisitedAt: now,
    contextSnapshot: null,
    reminder: meta.reminder && new Date(meta.reminder.reminderAt).getTime() > new Date(now).getTime()
      ? meta.reminder
      : null,
  };
}

function inferAttachmentType(mimeType: string): AttachmentType {
  if (mimeType.startsWith('image/')) {
    return 'image';
  }
  if (
    mimeType === 'application/pdf' ||
    mimeType.includes('document') ||
    mimeType.includes('text/')
  ) {
    return 'document';
  }
  return 'file';
}
