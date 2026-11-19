import {
  DisabledShadowSyncAdapter,
  EnabledShadowSyncAdapter,
  createShadowSyncAdapter,
  type ShadowComparisonRecord,
  type ShadowOutcome,
} from './shadow-sync-adapter';

const command = {
  operationId: 'operation-1',
  ownerUserId: 'owner-1',
  installationId: 'installation-1',
  deviceId: 'device-1',
  schemaVersion: 1,
  entityType: 'task',
  entityId: 'task-1',
} as const;

const outcome = (overrides: Partial<ShadowOutcome> = {}): ShadowOutcome => ({
  status: 'applied',
  decision: 'accepted',
  changedFields: ['content', 'title'],
  entityId: 'task-1',
  payloadDigest: 'digest-1',
  remoteUpdatedAt: '2026-11-13T00:00:00.000Z',
  ...overrides,
});

describe('shadow-sync-adapter', () => {
  it('does nothing when shadow mode is disabled', () => {
    const adapter = createShadowSyncAdapter({ enabled: false });

    expect(adapter).toBeInstanceOf(DisabledShadowSyncAdapter);
    expect(adapter.compare({
      command,
      newOutcome: outcome(),
      legacyOutcome: outcome(),
      comparedAt: '2026-11-13T00:00:00.000Z',
    })).toBeNull();
  });

  it('normalizes field order before comparing equivalent outcomes', () => {
    const adapter = new EnabledShadowSyncAdapter();

    const comparison = adapter.compare({
      command,
      newOutcome: outcome({ changedFields: ['title', 'content', 'title'] }),
      legacyOutcome: outcome({ changedFields: ['content', 'title'] }),
      comparedAt: '2026-11-13T00:00:00.000Z',
    });

    expect(comparison.equivalent).toBe(true);
    expect(comparison.differences).toEqual([]);
  });

  it('records differences without changing either outcome', () => {
    const records: ShadowComparisonRecord[] = [];
    const adapter = createShadowSyncAdapter({
      enabled: true,
      sink: { record: (record) => records.push(record) },
    });

    const comparison = adapter.compare({
      command,
      newOutcome: outcome({ status: 'remote-newer', decision: 'preserve-remote' }),
      legacyOutcome: outcome({ status: 'applied', decision: 'accepted' }),
      comparedAt: '2026-11-13T00:00:00.000Z',
    });

    expect(comparison).not.toBeNull();
    if (!comparison) return;
    expect(comparison.equivalent).toBe(false);
    expect(comparison.differences).toEqual(['status', 'decision']);
    expect(records).toEqual([comparison]);
  });

  it('does not let a diagnostic sink failure escape', () => {
    const adapter = createShadowSyncAdapter({
      enabled: true,
      sink: { record: () => { throw new Error('sink unavailable'); } },
    });

    expect(() => adapter.compare({
      command,
      newOutcome: outcome(),
      legacyOutcome: outcome(),
      comparedAt: '2026-11-13T00:00:00.000Z',
    })).not.toThrow();
  });
});
