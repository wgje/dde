import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UserPreferencesSyncService } from './user-preferences-sync.service';
import { SupabaseClientService } from '../../../../services/supabase-client.service';
import { LoggerService } from '../../../../services/logger.service';
import { SyncRpcClientService } from '../../../../services/sync-rpc-client.service';
import { DataSafetyAuditPersistence } from '../../../../services/data-safety-audit-persistence';
import { resetBrowserNetworkSuspensionTrackingForTests } from '../../../../utils/browser-network-suspension';
import { UserPreferencesBaselineStore } from '../../../../services/user-preferences-baseline.store';

function setVisibilityState(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: state,
  });
}

describe('UserPreferencesSyncService', () => {
  const maybeSingle = vi.fn();
  const eq = vi.fn(() => ({ maybeSingle }));
  const select = vi.fn(() => ({ eq }));
  const upsert = vi.fn();
  const from = vi.fn(() => ({ select, upsert }));
  const syncRpc = {
    isFeatureEnabled: vi.fn(() => true),
    isClientRejected: vi.fn(() => false),
    upsertUserPreferences: vi.fn().mockResolvedValue({
      status: 'applied',
      raw: {},
    }),
  };
  const baselineStore = {
    read: vi.fn().mockResolvedValue(null),
    save: vi.fn().mockResolvedValue(undefined),
  };

  function createReplayContext(isCurrent = vi.fn(() => true)) {
    return {
      leaseSignal: new AbortController().signal,
      isCurrent,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    resetBrowserNetworkSuspensionTrackingForTests();
    setVisibilityState('visible');
    maybeSingle.mockResolvedValue({ data: null, error: null });
    upsert.mockResolvedValue({ error: null });
    syncRpc.isFeatureEnabled.mockReturnValue(true);
    syncRpc.isClientRejected.mockReturnValue(false);
    syncRpc.upsertUserPreferences.mockResolvedValue({
      status: 'applied',
      raw: {},
    });
    baselineStore.read.mockResolvedValue(null);
    baselineStore.save.mockResolvedValue(undefined);
    new DataSafetyAuditPersistence().save('user-1', { replayLog: [], lastWriteExplain: null });

    TestBed.configureTestingModule({
      providers: [
        UserPreferencesSyncService,
        {
          provide: SupabaseClientService,
          useValue: {
            isConfigured: true,
            client: () => ({ from }),
          },
        },
        {
          provide: LoggerService,
          useValue: {
            category: () => ({
              error: vi.fn(),
              warn: vi.fn(),
              info: vi.fn(),
              debug: vi.fn(),
            }),
          },
        },
        { provide: SyncRpcClientService, useValue: syncRpc },
        { provide: UserPreferencesBaselineStore, useValue: baselineStore },
      ],
    });
  });

  it('loadUserPreferences should not use dock_snapshot runtime path', async () => {
    maybeSingle.mockResolvedValue({
      data: {
        theme: 'default',
        layout_direction: 'ltr',
        floating_window_pref: 'auto',
        color_mode: 'system',
        auto_resolve_conflicts: true,
        local_backup_enabled: false,
        local_backup_interval_ms: 3600000,
        last_backup_proof_at: '2026-04-23T10:00:00.000Z',
        focus_preferences: {
          gateEnabled: true,
          strataEnabled: true,
          blackBoxEnabled: true,
          maxSnoozePerDay: 3,
          routineResetHourLocal: 5,
          restReminderHighLoadMinutes: 120,
          restReminderLowLoadMinutes: 20,
        },
        updated_at: '2026-04-23T10:05:00.000Z',
        dock_snapshot: { version: 4 },
      },
      error: null,
    });

    const service = TestBed.inject(UserPreferencesSyncService);
    const prefs = await service.loadUserPreferences('user-1');

    expect(select).toHaveBeenCalled();
    expect((select.mock.calls[0] as unknown[])[0]).not.toContain('dock_snapshot');
    expect(prefs?.dockSnapshot).toBeUndefined();
    expect(prefs?.lastBackupProofAt).toBe('2026-04-23T10:00:00.000Z');
    expect(prefs?.focusPreferences?.routineResetHourLocal).toBe(5);
    expect(prefs?.focusPreferences?.restReminderHighLoadMinutes).toBe(120);
    expect(prefs?.focusPreferences?.restReminderLowLoadMinutes).toBe(20);
    expect(baselineStore.save).toHaveBeenCalledWith('user-1', '2026-04-23T10:05:00.000Z');
  });

  it('loadUserPreferences should preserve focus preference updatedAt for LWW merge checks', async () => {
    maybeSingle.mockResolvedValue({
      data: {
        theme: 'default',
        layout_direction: 'ltr',
        floating_window_pref: 'auto',
        color_mode: 'system',
        auto_resolve_conflicts: true,
        local_backup_enabled: false,
        local_backup_interval_ms: 3600000,
        last_backup_proof_at: null,
        focus_preferences: {
          gateEnabled: true,
          strataEnabled: true,
          blackBoxEnabled: false,
          maxSnoozePerDay: 2,
          routineResetHourLocal: 4,
          restReminderHighLoadMinutes: 90,
          restReminderLowLoadMinutes: 15,
          updatedAt: '2026-04-23T10:00:00.000Z',
        },
      },
      error: null,
    });

    const service = TestBed.inject(UserPreferencesSyncService);
    const prefs = await service.loadUserPreferences('user-1');

    expect(prefs?.focusPreferences).toMatchObject({
      gateEnabled: true,
      blackBoxEnabled: false,
      updatedAt: '2026-04-23T10:00:00.000Z',
    });
  });

  it('saveUserPreferences should not persist dock_snapshot runtime field', async () => {
    const service = TestBed.inject(UserPreferencesSyncService);
    const ok = await service.saveUserPreferences(
      'user-1',
      {
        lastBackupProofAt: '2026-04-23T11:00:00.000Z',
        dockSnapshot: {
          version: 5,
          entries: [],
          focusMode: false,
          isDockExpanded: true,
          muteWaitTone: false,
          session: {
            firstDragIntervened: false,
            focusBlurOn: false,
            focusScrimOn: true,
            mainTaskId: null,
            comboSelectIds: [],
            backupIds: [],
          },
          dailySlots: [],
          suspendChainRootTaskId: null,
          suspendRecommendationLocked: false,
          pendingDecision: null,
          dailyResetDate: '2026-03-03',
          savedAt: '2026-03-03T00:00:00.000Z',
        },
      },
      'op-preference-runtime-field',
      '2026-04-23T10:30:00.000Z',
    );

    expect(ok).toBe(true);
    expect(upsert).not.toHaveBeenCalled();
    expect(syncRpc.upsertUserPreferences).toHaveBeenCalledWith({
      operationId: 'op-preference-runtime-field',
      userId: 'user-1',
      baseUpdatedAt: '2026-04-23T10:30:00.000Z',
      preferences: {
        lastBackupProofAt: '2026-04-23T11:00:00.000Z',
      },
    });
  });

  it('saveUserPreferences should use Sync RPC when operationId is provided', async () => {
    const service = TestBed.inject(UserPreferencesSyncService);
    const ok = await service.saveUserPreferences(
      'user-1',
      {
        theme: 'ocean',
        colorMode: 'dark',
        dockSnapshot: {
          version: 5,
          entries: [],
          focusMode: false,
          isDockExpanded: true,
          muteWaitTone: false,
          session: {
            firstDragIntervened: false,
            focusBlurOn: false,
            focusScrimOn: true,
            mainTaskId: null,
            comboSelectIds: [],
            backupIds: [],
          },
          dailySlots: [],
          suspendChainRootTaskId: null,
          suspendRecommendationLocked: false,
          pendingDecision: null,
          dailyResetDate: '2026-03-03',
          savedAt: '2026-03-03T00:00:00.000Z',
        },
      },
      'op-preference',
      '2026-04-23T10:00:00.000Z',
    );

    expect(ok).toBe(true);
    expect(upsert).not.toHaveBeenCalled();
    expect(syncRpc.upsertUserPreferences).toHaveBeenCalledWith({
      operationId: 'op-preference',
      userId: 'user-1',
      baseUpdatedAt: '2026-04-23T10:00:00.000Z',
      preferences: {
        theme: 'ocean',
        colorMode: 'dark',
      },
    });
  });

  it('saveUserPreferences should use the explicit durable row baseline instead of focus field timestamps', async () => {
    const service = TestBed.inject(UserPreferencesSyncService);
    const ok = await service.saveUserPreferences(
      'user-1',
      {
        focusPreferences: {
          gateEnabled: true,
          strataEnabled: true,
          blackBoxEnabled: false,
          maxSnoozePerDay: 2,
          routineResetHourLocal: 4,
          restReminderHighLoadMinutes: 90,
          restReminderLowLoadMinutes: 15,
          updatedAt: '2026-06-15T01:59:00.000Z',
        },
      },
      'op-preference-lww',
      '2026-06-15T01:30:00.000Z',
    );

    expect(ok).toBe(true);
    expect(syncRpc.upsertUserPreferences).toHaveBeenCalledWith(expect.objectContaining({
      operationId: 'op-preference-lww',
      userId: 'user-1',
      baseUpdatedAt: '2026-06-15T01:30:00.000Z',
    }));
  });

  it('saveUserPreferences should persist write explain and replay entry after Sync RPC applies', async () => {
    syncRpc.upsertUserPreferences.mockResolvedValueOnce({
      status: 'applied',
      serverUpdatedAt: '2026-06-15T02:00:00.000Z',
      raw: {},
    });
    const service = TestBed.inject(UserPreferencesSyncService);

    const ok = await service.saveUserPreferences(
      'user-1',
      {
        theme: 'ocean',
        focusPreferences: {
          gateEnabled: true,
          strataEnabled: true,
          blackBoxEnabled: true,
          maxSnoozePerDay: 3,
          routineResetHourLocal: 5,
          restReminderHighLoadMinutes: 120,
          restReminderLowLoadMinutes: 20,
          updatedAt: '2026-06-15T01:59:00.000Z',
        },
      },
      'op-preference-audit',
      '2026-06-15T01:30:00.000Z',
    );

    expect(ok).toBe(true);
    const audit = new DataSafetyAuditPersistence().load('user-1');
    expect(audit.lastWriteExplain).toMatchObject({
      operationId: 'op-preference-audit',
      actor: { sourceUserId: 'user-1' },
      entity: { type: 'preference', id: 'user-1' },
      operation: 'upsert',
      updatedAtBaseline: '2026-06-15T01:30:00.000Z',
      beforeVersion: '2026-06-15T01:30:00.000Z',
      afterVersion: '2026-06-15T02:00:00.000Z',
      queueResult: { enteredRetryQueue: false, retryCount: 0 },
      rpcResult: { status: 'applied', serverUpdatedAt: '2026-06-15T02:00:00.000Z' },
      lwwDecision: { decision: 'local-applied', reason: 'applied' },
      lastSyncTime: { before: null, after: null, advanced: false },
    });
    expect(audit.replayLog[0]).toMatchObject({
      operationId: 'op-preference-audit',
      entityType: 'preference',
      entityId: 'user-1',
      operation: 'upsert',
      baseUpdatedAt: '2026-06-15T01:30:00.000Z',
      queue: { enteredRetryQueue: false, retryCount: 0 },
      rpc: { status: 'applied', serverUpdatedAt: '2026-06-15T02:00:00.000Z' },
      lww: { decision: 'local-applied', reason: 'applied' },
    });
    expect(baselineStore.save).toHaveBeenCalledWith('user-1', '2026-06-15T02:00:00.000Z');
  });

  it('saveUserPreferences should stop after baseline read when the replay fence drifts', async () => {
    let current = true;
    const context = createReplayContext(vi.fn(() => current));
    baselineStore.read.mockImplementationOnce(async () => {
      current = false;
      return '2026-06-15T01:30:00.000Z';
    });
    const service = TestBed.inject(UserPreferencesSyncService);

    const ok = await service.saveUserPreferences(
      'user-1',
      { theme: 'ocean' },
      'op-preference-baseline-drift',
      undefined,
      context,
    );

    expect(ok).toBe(false);
    expect(syncRpc.upsertUserPreferences).not.toHaveBeenCalled();
    expect(new DataSafetyAuditPersistence().load('user-1').lastWriteExplain).toBeNull();
  });

  it('saveUserPreferences should suppress audit and baseline mutation after RPC fence drift', async () => {
    let current = true;
    const context = createReplayContext(vi.fn(() => current));
    syncRpc.upsertUserPreferences.mockImplementationOnce(async () => {
      current = false;
      return {
        status: 'applied',
        serverUpdatedAt: '2026-06-15T02:00:00.000Z',
        raw: {},
      };
    });
    const service = TestBed.inject(UserPreferencesSyncService);

    const ok = await service.saveUserPreferences(
      'user-1',
      { theme: 'ocean' },
      'op-preference-rpc-drift',
      '2026-06-15T01:30:00.000Z',
      context,
    );

    expect(ok).toBe(false);
    expect(baselineStore.save).not.toHaveBeenCalled();
    expect(new DataSafetyAuditPersistence().load('user-1').lastWriteExplain).toBeNull();
  });

  it('saveUserPreferences should suppress audit when the fence drifts across baseline save', async () => {
    let current = true;
    const context = createReplayContext(vi.fn(() => current));
    syncRpc.upsertUserPreferences.mockResolvedValueOnce({
      status: 'applied',
      serverUpdatedAt: '2026-06-15T02:00:00.000Z',
      raw: {},
    });
    baselineStore.save.mockImplementationOnce(async () => {
      current = false;
    });
    const service = TestBed.inject(UserPreferencesSyncService);

    const ok = await service.saveUserPreferences(
      'user-1',
      { theme: 'ocean' },
      'op-preference-baseline-save-drift',
      '2026-06-15T01:30:00.000Z',
      context,
    );

    expect(ok).toBe(false);
    expect(new DataSafetyAuditPersistence().load('user-1').lastWriteExplain).toBeNull();
  });

  it('saveUserPreferences should pass the exact lease signal into the preference RPC', async () => {
    const context = createReplayContext();
    const service = TestBed.inject(UserPreferencesSyncService);

    const ok = await service.saveUserPreferences(
      'user-1',
      { theme: 'ocean' },
      'op-preference-abort-signal',
      '2026-06-15T01:30:00.000Z',
      context,
    );

    expect(ok).toBe(true);
    expect(syncRpc.upsertUserPreferences).toHaveBeenCalledWith(expect.objectContaining({
      abortSignal: context.leaseSignal,
      isCurrent: context.isCurrent,
    }));
  });

  it('saveUserPreferences should reject missing operationId before legacy upsert', async () => {
    const service = TestBed.inject(UserPreferencesSyncService);
    const ok = await service.saveUserPreferences('user-1', { theme: 'default' });

    expect(ok).toBe(false);
    expect(syncRpc.upsertUserPreferences).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it('saveUserPreferences should not run legacy freshness/read path when operationId is missing', async () => {
    maybeSingle.mockResolvedValueOnce({
      data: {
        updated_at: '2026-06-15T02:01:00.000Z',
        focus_preferences: {
          updatedAt: '2026-06-15T02:01:00.000Z',
        },
        last_backup_proof_at: null,
      },
      error: null,
    });
    const service = TestBed.inject(UserPreferencesSyncService);

    const ok = await service.saveUserPreferences('user-1', {
      focusPreferences: {
        gateEnabled: true,
        strataEnabled: true,
        blackBoxEnabled: false,
        maxSnoozePerDay: 2,
        routineResetHourLocal: 4,
        restReminderHighLoadMinutes: 90,
        restReminderLowLoadMinutes: 15,
        updatedAt: '2026-06-15T02:00:00.000Z',
      },
    });

    expect(ok).toBe(false);
    expect(select).not.toHaveBeenCalled();
    expect(eq).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it('saveUserPreferences should not legacy-upsert queued preference writes when Sync RPC is unavailable', async () => {
    syncRpc.isFeatureEnabled.mockReturnValue(false);
    const service = TestBed.inject(UserPreferencesSyncService);

    const ok = await service.saveUserPreferences('user-1', { theme: 'ocean' }, 'op-preference-no-rpc');

    expect(ok).toBe(false);
    expect(syncRpc.upsertUserPreferences).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it('saveUserPreferences should defer quietly during browser network suspension', async () => {
    setVisibilityState('hidden');

    const service = TestBed.inject(UserPreferencesSyncService);
    const ok = await service.saveUserPreferences('user-1', { theme: 'default' });

    expect(ok).toBe(false);
    expect(upsert).not.toHaveBeenCalled();
  });
});
