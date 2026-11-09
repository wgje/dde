import { ATTACHMENT_CONFIG } from '../config';
import type { AttachmentType } from '../models';

export function resolveAttachmentType(mimeType: string): AttachmentType {
  if (ATTACHMENT_CONFIG.IMAGE_TYPES.includes(mimeType)) {
    return 'image';
  }
  if (ATTACHMENT_CONFIG.DOCUMENT_TYPES.includes(mimeType)) {
    return 'document';
  }
  return 'file';
}

export function isAttachmentImageMimeType(mimeType: string): boolean {
  return ATTACHMENT_CONFIG.IMAGE_TYPES.includes(mimeType);
}
