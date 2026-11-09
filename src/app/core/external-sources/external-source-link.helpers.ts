import { SIYUAN_CONFIG } from '../../../config/siyuan.config';
import { isBrowserNetworkSuspendedError } from '../../../utils/browser-network-suspension';
import type { ExternalSourceLink, ExternalSourceRole } from './external-source.model';
import {
  normalizeSiyuanUri,
  parseSiyuanBlockLink,
} from './siyuan/siyuan-link-parser';

export interface ExternalSourceLinkRow {
  id: string;
  user_id: string;
  task_id: string;
  source_type: 'siyuan-block';
  target_id: string;
  uri: string;
  label: string | null;
  hpath: string | null;
  role: ExternalSourceRole | null;
  sort_order: number;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
  operation_id?: string | null;
}

export function normalizeExternalSourceLink(
  link: ExternalSourceLink,
): ExternalSourceLink {
  const parsed =
    parseSiyuanBlockLink(link.targetId) ?? parseSiyuanBlockLink(link.uri);
  const targetId = parsed?.blockId ?? link.targetId;
  return {
    ...link,
    id: truncate(link.id, SIYUAN_CONFIG.MAX_LINK_ID_LENGTH),
    sourceType: 'siyuan-block',
    targetId,
    uri: normalizeSiyuanUri(targetId),
    label: optionalTruncate(link.label, SIYUAN_CONFIG.MAX_LABEL_LENGTH),
    hpath: optionalTruncate(link.hpath, SIYUAN_CONFIG.MAX_HPATH_LENGTH),
    sortOrder: Number.isFinite(link.sortOrder) ? link.sortOrder : 0,
    deletedAt: link.deletedAt ?? null,
  };
}

export function externalSourceLinkToRow(
  link: ExternalSourceLink,
  userId: string,
  operationId?: string,
): ExternalSourceLinkRow {
  const normalized = normalizeExternalSourceLink(link);
  const row: ExternalSourceLinkRow = {
    id: normalized.id,
    user_id: userId,
    task_id: normalized.taskId,
    source_type: normalized.sourceType,
    target_id: normalized.targetId,
    uri: truncate(normalized.uri, SIYUAN_CONFIG.MAX_URI_LENGTH),
    label: normalized.label ?? null,
    hpath: normalized.hpath ?? null,
    role: normalized.role ?? null,
    sort_order: normalized.sortOrder,
    deleted_at: normalized.deletedAt ?? null,
    created_at: normalized.createdAt,
    updated_at: normalized.updatedAt,
  };
  if (operationId) {
    row.operation_id = operationId;
  }
  return row;
}

export function rowToExternalSourceLink(row: ExternalSourceLinkRow): ExternalSourceLink {
  return normalizeExternalSourceLink({
    id: row.id,
    taskId: row.task_id,
    sourceType: row.source_type,
    targetId: row.target_id,
    uri: row.uri,
    label: row.label ?? undefined,
    hpath: row.hpath ?? undefined,
    role: row.role ?? undefined,
    sortOrder: row.sort_order,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

export function mergeExternalSourceLinks(
  localLinks: ExternalSourceLink[],
  remoteLinks: ExternalSourceLink[],
): ExternalSourceLink[] {
  const byId = new Map<string, ExternalSourceLink>();
  for (const rawLink of [...localLinks, ...remoteLinks]) {
    const link = normalizeExternalSourceLink(rawLink);
    const existing = byId.get(link.id);
    if (!existing || existing.updatedAt < link.updatedAt) {
      byId.set(link.id, link);
    }
  }
  return collapseActiveExternalSourceDuplicates(
    dropExpiredExternalSourceTombstones(Array.from(byId.values())),
  );
}

export function buildExternalSourceUniqueConflictTombstone(
  link: ExternalSourceLink,
  now = new Date().toISOString(),
): ExternalSourceLink {
  return normalizeExternalSourceLink({
    ...link,
    deletedAt: now,
    updatedAt: now,
  });
}

export function classifyExternalSourcePushError(error: unknown): string {
  if (isBrowserNetworkSuspendedError(error)) {
    return 'browser-network-suspended';
  }

  if (error && typeof error === 'object') {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code.length > 0) return code;
    const status = (error as { status?: unknown }).status;
    if (status === 401 || status === 403) return 'auth';
  }
  return 'unknown';
}

export function dropExpiredExternalSourceTombstones(
  links: ExternalSourceLink[],
  retentionMs = SIYUAN_CONFIG.TOMBSTONE_RETENTION_MS,
  nowMs = Date.now(),
): ExternalSourceLink[] {
  const cutoff = nowMs - retentionMs;
  return links.filter((link) => {
    if (!link.deletedAt) return true;
    const deletedMs = Date.parse(link.deletedAt);
    if (!Number.isFinite(deletedMs)) return true;
    return deletedMs >= cutoff;
  });
}

export function collapseActiveExternalSourceDuplicates(
  links: ExternalSourceLink[],
  now = new Date().toISOString(),
): ExternalSourceLink[] {
  const activeByNaturalKey = new Map<string, ExternalSourceLink>();
  const next = new Map(links.map((link) => [link.id, link]));
  const sorted = links.slice().sort(compareExternalSourceLinksForCollapse);

  for (const link of sorted) {
    if (link.deletedAt) continue;
    const key = `${link.taskId}|${link.sourceType}|${link.targetId}`;
    const existing = activeByNaturalKey.get(key);
    if (!existing) {
      activeByNaturalKey.set(key, link);
      continue;
    }

    const winner = pickExternalSourceCollapseWinner(existing, link);
    const loser = winner.id === existing.id ? link : existing;
    activeByNaturalKey.set(key, winner);
    next.set(loser.id, {
      ...loser,
      deletedAt: loser.deletedAt ?? now,
      updatedAt: loser.updatedAt > now ? loser.updatedAt : now,
    });
  }

  return Array.from(next.values());
}

export function safeExternalSourceId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 8)}…` : value;
}

function pickExternalSourceCollapseWinner(
  a: ExternalSourceLink,
  b: ExternalSourceLink,
): ExternalSourceLink {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? a : b;
  return a.id <= b.id ? a : b;
}

function compareExternalSourceLinksForCollapse(
  a: ExternalSourceLink,
  b: ExternalSourceLink,
): number {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function optionalTruncate(
  value: string | undefined,
  maxLength: number,
): string | undefined {
  if (!value) return undefined;
  return truncate(value, maxLength);
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}
