import { SIYUAN_CONFIG } from '../../../../config/siyuan.config';
import type { SiyuanBlockPreview, SiyuanChildBlockPreview, SiyuanPreviewErrorCode } from '../external-source.model';

const KRAMDOWN_ATTR_PATTERN = /\{:\s*[^}]+\}/g;
const BLOCK_REF_PATTERN = /\(\(([0-9]{14}-[a-z0-9]{7})(?:\s+"([^"]*)")?\)\)/gi;
const MARKDOWN_MARK_PATTERN = /[`*_>#\-\[\]()]/g;

export function kramdownToPlainText(kramdown: string): string {
  return kramdown
    .replace(KRAMDOWN_ATTR_PATTERN, '')
    .replace(BLOCK_REF_PATTERN, (_match, blockId: string, label?: string) => label || blockId)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '[图片]')
    .replace(/\[[^\]]+\]\([^)]*\)/g, text => text.replace(/^\[|\]\([^)]*\)$/g, ''))
    .replace(MARKDOWN_MARK_PATTERN, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function buildExcerpt(text: string): { excerpt: string; truncated: boolean } {
  if (text.length <= SIYUAN_CONFIG.MAX_PREVIEW_CHARS) return { excerpt: text, truncated: false };
  return { excerpt: `${text.slice(0, SIYUAN_CONFIG.MAX_PREVIEW_CHARS).trim()}…`, truncated: true };
}

export function normalizeChildBlocks(children: SiyuanChildBlockPreview[]): { children: SiyuanChildBlockPreview[]; truncated: boolean } {
  const normalized = children.slice(0, SIYUAN_CONFIG.MAX_PREVIEW_CHILDREN).map(child => ({
    id: child.id,
    type: child.type,
    content: kramdownToPlainText(child.content).slice(0, 240),
  }));
  return { children: normalized, truncated: children.length > SIYUAN_CONFIG.MAX_PREVIEW_CHILDREN };
}

export function normalizePreview(input: Omit<SiyuanBlockPreview, 'excerpt' | 'truncated'> & { truncated?: boolean }): SiyuanBlockPreview {
  const plainText = input.plainText ?? kramdownToPlainText(input.kramdown ?? '');
  const excerpt = buildExcerpt(plainText);
  const childBlocks = input.childBlocks ? normalizeChildBlocks(input.childBlocks) : { children: [], truncated: false };
  return {
    ...input,
    plainText,
    excerpt: excerpt.excerpt,
    childBlocks: childBlocks.children,
    truncated: Boolean(input.truncated || excerpt.truncated || childBlocks.truncated),
  };
}

export function mapSiyuanError(error: unknown): SiyuanPreviewErrorCode {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    if (message.includes('401') || message.includes('403') || message.includes('token')) return 'token-invalid';
    if (message.includes('not found') || message.includes('不存在')) return 'block-not-found';
    if (message.includes('abort')) return 'unknown';
    if (message.includes('fetch') || message.includes('network') || message.includes('timeout')) return 'kernel-unreachable';
  }
  return 'unknown';
}
