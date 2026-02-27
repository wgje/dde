import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UserPreferencesSyncService } from './user-preferences-sync.service';
import { SupabaseClientService } from '../../../../services/supabase-client.service';
import { LoggerService } from '../../../../services/logger.service';
import { DockSnapshot } from '../../../../models/parking-dock';

describe('UserPreferencesSyncService', () => {
  const dockSnapshotV3: DockSnapshot = {
    version: 3,
    entries: [],
    focusMode: false,
    isDockExpanded: true,
    muteWaitTone: false,
    session: {
      firstDragIntervened: true,
      focusBlurOn: false,
      mainTaskId: null,
      strongZoneIds: [],
      weakZoneIds: [],
    },
    firstDragDone: true,
    dailySlots: [],
    suspendChainRootTaskId: null,
    suspendRecommendationLocked: false,
    pendingDecision: null,
    dailyResetDate: '2026-02-25',
    savedAt: '2026-02-25T00:00:00.000Z',
  };

  const maybeSingle = vi.fn();
  const eq = vi.fn(() => ({ maybeSingle }));
  const select = vi.fn(() => ({ eq }));
  const upsert = vi.fn();
  const from = vi.fn(() => ({ select, upsert }));

  beforeEach(() => {
    vi.clearAllMocks();
    maybeSingle.mockResolvedValue({ data: null, error: null });
    upsert.mockResolvedValue({ error: null });

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
      ],
    });
  });

  it('loadUserPreferences should parse dock_snapshot v3', async () => {
    maybeSingle.mockResolvedValue({
      data: {
        theme: 'default',
        layout_direction: 'ltr',
        floating_window_pref: 'auto',
        color_mode: 'system',
        auto_resolve_conflicts: true,
        local_backup_enabled: false,
        local_backup_interval_ms: 3600000,
        focus_preferences: null,
        dock_snapshot: dockSnapshotV3,
      },
      error: null,
    });

    const service = TestBed.inject(UserPreferencesSyncService);
    const prefs = await service.loadUserPreferences('user-1');

    expect(select).toHaveBeenCalled();
    expect(select.mock.calls[0][0]).toContain('dock_snapshot');
    expect(prefs?.dockSnapshot?.version).toBe(3);
  });

  it('loadUserPreferences should accept dock_snapshot v2 for migration', async () => {
    const legacySnapshot = { ...dockSnapshotV3, version: 2 } as unknown;

    maybeSingle.mockResolvedValue({
      data: {
        theme: 'default',
        layout_direction: 'ltr',
        floating_window_pref: 'auto',
        color_mode: 'system',
        auto_resolve_conflicts: true,
        local_backup_enabled: false,
        local_backup_interval_ms: 3600000,
        focus_preferences: null,
        dock_snapshot: legacySnapshot,
      },
      error: null,
    });

    const service = TestBed.inject(UserPreferencesSyncService);
    const prefs = await service.loadUserPreferences('user-1');

    expect(prefs?.dockSnapshot).toBeTruthy();
    expect((prefs?.dockSnapshot as unknown as { version: number }).version).toBe(2);
  });

  it('saveUserPreferences should persist dock_snapshot v3', async () => {
    const service = TestBed.inject(UserPreferencesSyncService);
    const ok = await service.saveUserPreferences('user-1', { dockSnapshot: dockSnapshotV3 });

    expect(ok).toBe(true);
    expect(upsert).toHaveBeenCalledTimes(1);
    const [payload] = upsert.mock.calls[0];
    expect(payload.user_id).toBe('user-1');
    expect(payload.dock_snapshot).toEqual(dockSnapshotV3);
  });
});
