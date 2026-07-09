import type { Attachment } from '../models';

export function markAttachmentAsDeleted(attachment: Attachment, deletedAt: string): Attachment {
  return {
    ...attachment,
    deletedAt,
  };
}

export function isDeletedAttachment(attachment: Attachment): boolean {
  return !!attachment.deletedAt;
}

export function restoreDeletedAttachment(attachment: Attachment): Attachment {
  const { deletedAt: _deletedAt, ...rest } = attachment as Attachment & { deletedAt?: string };
  return rest as Attachment;
}

export function filterActiveAttachments(attachments: Attachment[]): Attachment[] {
  return attachments.filter(attachment => !isDeletedAttachment(attachment));
}
