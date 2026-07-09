import { describe, expect, it } from 'vitest';

import { SIYUAN_CONFIG } from '../../../config/siyuan.config';
import { createBrowserNetworkSuspendedError } from '../../../utils/browser-network-suspension';
import {
  buildExternalSourceUniqueConflictTombstone,
  classifyExternalSourcePushError,
  collapseActiveExternalSourceDuplicates,
  dropExpiredExternalSourceTombstones,
  externalSourceLinkToRow,
  mergeExternalSourceLinks,
  normalizeExternalSourceLink,
  rowToExternalSourceLink,
  safeExternalSourceId,
} from './external-source-link.helpers';
import type { ExternalSourceLink } from './external-source.model';

function link(overrides: Partial<ExternalSourceLink> = {}): ExternalSourceLink {
  return {
    id: overrides.id ?? 'link-a',
    taskId: overrides.taskId ?? 'task-1',
    sourceType: overrides.sourceType ?? 'siyuan-block',
    targetId: overrides.targetId ?? '20260426123456-abc1234',
    uri: overrides.uri ?? 'siyuan://blocks/20260426123456-abc1234',
    label: overrides.label,
    hpath: overrides.hpath,
    role: overrides.role,
    sortOrder: overrides.sortOrder ?? 0,
    deletedAt: overrides.deletedAt ?? null,
    createdAt: overrides.createdAt ?? '2026-04-26T00:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-04-26T00:00:00.000Z',
  };
}

describe('external-source-link.helpers', () => {
  it('normalizes SiYuan links and truncates storage-bound text fields', () => {
    const normalized = normalizeExternalSourceLink(link({
      id: 'x'.repeat(80),
      targetId: 'siyuan://blocks/20260426123456-def5678',
      uri: 'ignored',
      label: 'l'.repeat(SIYUAN_CONFIG.MAX_LABEL_LENGTH + 20),
      hpath: 'h'.repeat(SIYUAN_CONFIG.MAX_HPATH_LENGTH + 20),
      sortOrder: Number.NaN,
      deletedAt: undefined,
    }));

    expect(normalized.id).toHaveLength(64);
    expect(normalized.sourceType).toBe('siyuan-block');
    expect(normalized.targetId).toBe('20260426123456-def5678');
    expect(normalized.uri).toBe('siyuan://blocks/20260426123456-def5678?focus=1');
    expect(normalized.label).toHaveLength(SIYUAN_CONFIG.MAX_LABEL_LENGTH);
    expect(normalized.hpath).toHaveLength(SIYUAN_CONFIG.MAX_HPATH_LENGTH);
    expect(normalized.sortOrder).toBe(0);
    expect(normalized.deletedAt).toBeNull();
  });

  it('maps links to Supabase rows and back without preview body fields', () => {
    const source = link({
      label: '思源 2026…1234',
      hpath: '/项目/计划',
      role: 'reference',
      sortOrder: 7,
    });
    const operationId = '00000000-0000-4000-8000-000000000222';
    const row = externalSourceLinkToRow(source, 'user-1', operationId);

    expect(row).toMatchObject({
      id: source.id,
      user_id: 'user-1',
      task_id: 'task-1',
      source_type: 'siyuan-block',
      target_id: '20260426123456-abc1234',
      uri: 'siyuan://blocks/20260426123456-abc1234?focus=1',
      label: '思源 2026…1234',
      hpath: '/项目/计划',
      role: 'reference',
      sort_order: 7,
      deleted_at: null,
      operation_id: operationId,
    });
    expect(row).not.toHaveProperty('content');
    expect(rowToExternalSourceLink(row)).toMatchObject({
      id: source.id,
      taskId: 'task-1',
      targetId: '20260426123456-abc1234',
      role: 'reference',
      sortOrder: 7,
    });
  });

  it('drops only expired tombstones with parseable timestamps', () => {
    const now = Date.parse('2026-06-10T00:00:00.000Z');
    const retainedActive = link({ id: 'active', deletedAt: null });
    const retainedInvalid = link({ id: 'invalid', deletedAt: 'not-a-date' });
    const retainedRecent = link({ id: 'recent', deletedAt: '2026-06-09T23:00:00.000Z' });
    const expired = link({ id: 'expired', deletedAt: '2026-05-01T00:00:00.000Z' });

    expect(dropExpiredExternalSourceTombstones(
      [retainedActive, retainedInvalid, retainedRecent, expired],
      24 * 60 * 60 * 1000,
      now,
    ).map(item => item.id)).toEqual(['active', 'invalid', 'recent']);
  });

  it('collapses active duplicates deterministically by updatedAt and id', () => {
    const older = link({ id: 'older', updatedAt: '2026-04-26T00:00:00.000Z' });
    const newer = link({ id: 'newer', updatedAt: '2026-04-27T00:00:00.000Z' });
    const tieWinner = link({ id: 'aaa', taskId: 'task-2', updatedAt: '2026-04-28T00:00:00.000Z' });
    const tieLoser = link({ id: 'bbb', taskId: 'task-2', updatedAt: '2026-04-28T00:00:00.000Z' });

    const collapsed = collapseActiveExternalSourceDuplicates(
      [newer, older, tieLoser, tieWinner],
      '2026-04-30T00:00:00.000Z',
    );

    const byId = new Map(collapsed.map(item => [item.id, item]));
    expect(byId.get('newer')?.deletedAt).toBeNull();
    expect(byId.get('older')?.deletedAt).toBe('2026-04-30T00:00:00.000Z');
    expect(byId.get('aaa')?.deletedAt).toBeNull();
    expect(byId.get('bbb')?.deletedAt).toBe('2026-04-30T00:00:00.000Z');
  });

  it('merges local and remote links by newest updatedAt before duplicate collapse', () => {
    const localOlder = link({
      id: 'same-id',
      label: 'local older',
      updatedAt: '2026-04-26T00:00:00.000Z',
    });
    const remoteNewer = link({
      id: 'same-id',
      label: 'remote newer',
      updatedAt: '2026-04-27T00:00:00.000Z',
    });
    const duplicateLoser = link({
      id: 'duplicate-loser',
      targetId: remoteNewer.targetId,
      updatedAt: '2026-04-25T00:00:00.000Z',
    });

    const merged = mergeExternalSourceLinks([localOlder, duplicateLoser], [remoteNewer]);
    const byId = new Map(merged.map(item => [item.id, item]));

    expect(byId.get('same-id')?.label).toBe('remote newer');
    expect(byId.get('same-id')?.deletedAt).toBeNull();
    expect(byId.get('duplicate-loser')?.deletedAt).toBeTruthy();
  });

  it('builds normalized tombstones for unique-conflict convergence', () => {
    const tombstone = buildExternalSourceUniqueConflictTombstone(
      link({ deletedAt: null, updatedAt: '2026-04-26T00:00:00.000Z' }),
      '2026-04-30T00:00:00.000Z',
    );

    expect(tombstone.deletedAt).toBe('2026-04-30T00:00:00.000Z');
    expect(tombstone.updatedAt).toBe('2026-04-30T00:00:00.000Z');
    expect(tombstone.uri).toBe('siyuan://blocks/20260426123456-abc1234?focus=1');
  });

  it('classifies push errors into retry buckets', () => {
    expect(classifyExternalSourcePushError(createBrowserNetworkSuspendedError())).toBe(
      'browser-network-suspended',
    );
    expect(classifyExternalSourcePushError({ code: '23505' })).toBe('23505');
    expect(classifyExternalSourcePushError({ status: 403 })).toBe('auth');
    expect(classifyExternalSourcePushError(new Error('offline'))).toBe('unknown');
  });

  it('shortens ids only for log output', () => {
    expect(safeExternalSourceId('short-id')).toBe('short-id');
    expect(safeExternalSourceId('1234567890abcdef')).toBe('12345678…');
  });
});
