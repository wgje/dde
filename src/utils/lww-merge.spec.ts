import { describe, expect, it } from 'vitest';
import {
  mergeByLww,
  mergeByLwwWithTombstone,
  shouldPreferIncoming,
  type LwwEntity,
  type TombstonableLwwEntity,
} from './lww-merge';

interface Entity extends LwwEntity {
  readonly name: string;
}

interface TEntity extends TombstonableLwwEntity {
  readonly name: string;
}

const entity = (id: string, updatedAt: string | null | undefined, name = id): Entity => ({
  id,
  updatedAt,
  name,
});

const tEntity = (
  id: string,
  updatedAt: string | null | undefined,
  deletedAt: string | null | undefined = null,
  name = id,
): TEntity => ({ id, updatedAt, deletedAt, name });

describe('lww-merge — shouldPreferIncoming', () => {
  it('current 不存在时总是采用 incoming', () => {
    expect(shouldPreferIncoming(entity('a', '2026-01-01T00:00:00Z'), null)).toBe(true);
    expect(shouldPreferIncoming(entity('a', '2026-01-01T00:00:00Z'), undefined)).toBe(true);
  });

  it('incoming.updatedAt 更晚应覆盖 current', () => {
    const current = entity('a', '2026-01-01T00:00:00Z');
    const incoming = entity('a', '2026-01-02T00:00:00Z');
    expect(shouldPreferIncoming(incoming, current)).toBe(true);
  });

  it('incoming.updatedAt 更早应保留 current', () => {
    const current = entity('a', '2026-01-02T00:00:00Z');
    const incoming = entity('a', '2026-01-01T00:00:00Z');
    expect(shouldPreferIncoming(incoming, current)).toBe(false);
  });

  it('两侧时间戳相同且无 tiebreaker 时保留 current', () => {
    const current = entity('a', '2026-01-01T00:00:00Z', 'current');
    const incoming = entity('a', '2026-01-01T00:00:00Z', 'incoming');
    expect(shouldPreferIncoming(incoming, current)).toBe(false);
  });

  it('时间戳相同时使用 tiebreaker 决断', () => {
    const current = entity('a', '2026-01-01T00:00:00Z');
    const incoming = entity('b', '2026-01-01T00:00:00Z');
    const prefer = shouldPreferIncoming(
      incoming,
      current,
      (a, b) => a.id.localeCompare(b.id),
    );
    expect(prefer).toBe(true);
  });

  it('tiebreaker 返回 <=0 时保留 current', () => {
    const current = entity('b', '2026-01-01T00:00:00Z');
    const incoming = entity('a', '2026-01-01T00:00:00Z');
    const prefer = shouldPreferIncoming(
      incoming,
      current,
      (a, b) => a.id.localeCompare(b.id),
    );
    expect(prefer).toBe(false);
  });

  it('非法时间戳按 0 处理，incoming 为 0 不会覆盖非 0 的 current', () => {
    const current = entity('a', '2026-01-01T00:00:00Z');
    const incoming = entity('a', 'not-a-date');
    expect(shouldPreferIncoming(incoming, current)).toBe(false);
  });

  it('两侧均无 updatedAt 时不覆盖', () => {
    const current = entity('a', null);
    const incoming = entity('a', undefined);
    expect(shouldPreferIncoming(incoming, current)).toBe(false);
  });
});

describe('lww-merge — mergeByLww', () => {
  it('云端优先作为合并基底', () => {
    const cloud = [entity('a', '2026-01-01T00:00:00Z', 'cloud-a')];
    const local: Entity[] = [];
    const merged = mergeByLww(local, cloud);
    expect(merged).toHaveLength(1);
    expect(merged[0].name).toBe('cloud-a');
  });

  it('本地独有项被保留', () => {
    const cloud = [entity('a', '2026-01-01T00:00:00Z')];
    const local = [entity('b', '2026-01-01T00:00:00Z')];
    const merged = mergeByLww(local, cloud);
    const ids = merged.map((m) => m.id).sort();
    expect(ids).toEqual(['a', 'b']);
  });

  it('同 id 时 updatedAt 更晚者胜', () => {
    const cloud = [entity('a', '2026-01-01T00:00:00Z', 'cloud')];
    const local = [entity('a', '2026-01-02T00:00:00Z', 'local')];
    const merged = mergeByLww(local, cloud);
    expect(merged).toHaveLength(1);
    expect(merged[0].name).toBe('local');
  });

  it('同 id 时本地更早不会覆盖云端', () => {
    const cloud = [entity('a', '2026-01-02T00:00:00Z', 'cloud')];
    const local = [entity('a', '2026-01-01T00:00:00Z', 'local')];
    const merged = mergeByLww(local, cloud);
    expect(merged).toHaveLength(1);
    expect(merged[0].name).toBe('cloud');
  });

  it('缺失 updatedAt 按 0 处理（云端非 0 会胜出）', () => {
    const cloud = [entity('a', '2026-01-01T00:00:00Z', 'cloud')];
    const local = [entity('a', undefined, 'local')];
    const merged = mergeByLww(local, cloud);
    expect(merged[0].name).toBe('cloud');
  });

  it('空数组合并返回空数组', () => {
    expect(mergeByLww<Entity>([], [])).toEqual([]);
  });
});

describe('lww-merge — mergeByLwwWithTombstone (Hard Rule §5.2 tombstone-wins)', () => {
  it('云端未删除、本地已删除 → 保留本地（删除意图胜出）', () => {
    const cloud = [tEntity('a', '2026-01-01T00:00:00Z')];
    const local = [tEntity('a', '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z', 'local-deleted')];
    const merged = mergeByLwwWithTombstone(local, cloud);
    expect(merged).toHaveLength(1);
    expect(merged[0].deletedAt).toBe('2026-01-02T00:00:00Z');
    expect(merged[0].name).toBe('local-deleted');
  });

  it('云端已删除、本地未删除 → 保留云端（删除不可逆）', () => {
    const cloud = [tEntity('a', '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z', 'cloud-deleted')];
    const local = [tEntity('a', '2026-02-01T00:00:00Z', null, 'local-alive')];
    const merged = mergeByLwwWithTombstone(local, cloud);
    expect(merged[0].name).toBe('cloud-deleted');
    expect(merged[0].deletedAt).toBe('2026-01-02T00:00:00Z');
  });

  it('两侧都删除 → 取 deletedAt 更早者（删除意图保守）', () => {
    const cloud = [tEntity('a', '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z', 'cloud')];
    const local = [tEntity('a', '2026-01-01T00:00:00Z', '2026-01-05T00:00:00Z', 'local')];
    const merged = mergeByLwwWithTombstone(local, cloud);
    expect(merged[0].name).toBe('cloud');
  });

  it('两侧都删除且时间相等 → 保留云端', () => {
    const cloud = [tEntity('a', '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z', 'cloud')];
    const local = [tEntity('a', '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z', 'local')];
    const merged = mergeByLwwWithTombstone(local, cloud);
    expect(merged[0].name).toBe('cloud');
  });

  it('两侧都未删除 → 回退到标准 LWW', () => {
    const cloud = [tEntity('a', '2026-01-01T00:00:00Z', null, 'cloud')];
    const local = [tEntity('a', '2026-01-02T00:00:00Z', null, 'local')];
    const merged = mergeByLwwWithTombstone(local, cloud);
    expect(merged[0].name).toBe('local');
  });

  it('本地独有（云端缺失）条目保留', () => {
    const cloud: TEntity[] = [];
    const local = [tEntity('a', '2026-01-01T00:00:00Z')];
    const merged = mergeByLwwWithTombstone(local, cloud);
    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe('a');
  });
});
