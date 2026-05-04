const SIYUAN_BLOCK_ID_PATTERN = /^\d{14}-[a-z0-9]{7}$/;
const SIYUAN_URI_PATTERN = /^siyuan:\/\/blocks\/([0-9]{14}-[a-z0-9]{7})(?:\?[^\s]*)?$/;
const FORBIDDEN_PROTOCOL_PATTERN = /^(?:javascript|data|file|https?|vbscript|about):/i;

export interface ParsedSiyuanLink {
  blockId: string;
  uri: string;
}

export function isValidSiyuanBlockId(value: string): boolean {
  return SIYUAN_BLOCK_ID_PATTERN.test(value.trim());
}

export function normalizeSiyuanUri(blockId: string): string {
  return `siyuan://blocks/${blockId}?focus=1`;
}

export function parseSiyuanBlockLink(input: string): ParsedSiyuanLink | null {
  const trimmed = input.trim();
  if (!trimmed || /[\r\n]/.test(trimmed) || trimmed.includes('..')) return null;
  if (FORBIDDEN_PROTOCOL_PATTERN.test(trimmed)) return null;

  const uriMatch = SIYUAN_URI_PATTERN.exec(trimmed);
  const blockId = uriMatch?.[1] ?? trimmed;
  if (!isValidSiyuanBlockId(blockId)) return null;
  return { blockId, uri: normalizeSiyuanUri(blockId) };
}

export function shortenSiyuanBlockId(blockId: string): string {
  return blockId.length <= 8 ? blockId : `${blockId.slice(0, 4)}…${blockId.slice(-4)}`;
}
