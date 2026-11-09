export interface AttachmentStoragePathInput {
  userId: string;
  projectId: string;
  taskId: string;
  attachmentId: string;
  fileName: string;
}

export function sanitizeAttachmentPathSegment(segment: string): string {
  return segment
    .replace(/\.\.+/g, '')
    .replace(/[\/\\]/g, '')
    .replace(/[<>:"|?*\x00-\x1f]/g, '')
    .trim();
}

export function isValidAttachmentPathSegment(segment: string): boolean {
  if (!segment || segment.length === 0) return false;
  if (segment.length > 255) return false;
  if (segment.includes('..')) return false;
  if (segment.includes('/') || segment.includes('\\')) return false;
  return /^[a-zA-Z0-9_-]+$/.test(segment);
}

export function buildAttachmentStoragePath(input: AttachmentStoragePathInput): string {
  const fileExt = sanitizeAttachmentPathSegment(input.fileName.split('.').pop() || 'bin');
  return `${input.userId}/${input.projectId}/${input.taskId}/${input.attachmentId}.${fileExt}`;
}
