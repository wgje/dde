import { TestBed } from '@angular/core/testing';
import { expect, it, vi } from 'vitest';

import type { BlackBoxEntry } from '../models/focus';
import { TIMEOUT_CONFIG } from '../config/timeout.config';
import { BlackBoxSyncService } from './black-box-sync.service';
import { createEntry, setVisibilityState } from './black-box-sync.spec-helpers';
import { DockDirectWidgetNotifyOutboxService } from './dock-direct-widget-notify-outbox.service';
import { SupabaseClientService } from './supabase-client.service';

interface BlackBoxSyncDirectWidgetNotifySpecContext {
  getService: () => BlackBoxSyncService;
}

type DirectNotifyAction = 'read' | 'complete';

type DirectWidgetNotifyService = BlackBoxSyncService & {
  sendDirectWidgetBlackBoxNotify: (
    entry: BlackBoxEntry,
    action: DirectNotifyAction,
  ) => Promise<void>;
};

export function registerBlackBoxSyncDirectWidgetNotifySpecs(
  context: BlackBoxSyncDirectWidgetNotifySpecContext,
): void {
  const service = (): DirectWidgetNotifyService =>
    context.getService() as DirectWidgetNotifyService;

  it('direct black-box widget notify should skip while browser network is suspended', async () => {
    const supabase = TestBed.inject(SupabaseClientService) as unknown as {
      clientAsync: ReturnType<typeof vi.fn>;
    };
    supabase.clientAsync.mockClear();
    setVisibilityState('hidden');

    await service().sendDirectWidgetBlackBoxNotify(createEntry({ id: 'entry-1' }), 'read');

    expect(supabase.clientAsync).not.toHaveBeenCalled();
  });

  it('direct black-box widget notify should include a short timeout for foreground calls', async () => {
    const invoke = vi.fn().mockResolvedValue({ data: null, error: null });
    const supabase = TestBed.inject(SupabaseClientService) as unknown as {
      clientAsync: ReturnType<typeof vi.fn>;
    };
    supabase.clientAsync.mockResolvedValue({ functions: { invoke } });

    await service().sendDirectWidgetBlackBoxNotify(createEntry({ id: 'entry-2' }), 'complete');

    expect(invoke).toHaveBeenCalledWith(
      'widget-notify',
      expect.objectContaining({
        timeout: TIMEOUT_CONFIG.QUICK,
        body: expect.objectContaining({
          directNotify: true,
          table: 'black_box_entries',
          entryId: 'entry-2',
          blackBoxAction: 'complete',
        }),
      }),
    );
  });

  it('direct black-box widget notify should persist before invoking and remove only after success', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000501');
    const outbox = TestBed.inject(DockDirectWidgetNotifyOutboxService);
    const removeRecord = vi.spyOn(outbox, 'removeRecord');
    const entry = createEntry({
      id: 'entry-durable-direct',
      updatedAt: '2026-06-29T00:00:00.000Z',
    });
    const invoke = vi.fn().mockImplementation(async () => {
      expect(await outbox.listPendingNotifications()).toEqual([
        expect.objectContaining({
          kind: 'black-box',
          operationId: '00000000-0000-4000-8000-000000000501',
          entryId: 'entry-durable-direct',
          blackBoxAction: 'complete',
          updatedAt: '2026-06-29T00:00:00.000Z',
          attemptCount: 0,
        }),
      ]);
      return { data: null, error: null };
    });
    const supabase = TestBed.inject(SupabaseClientService) as unknown as {
      clientAsync: ReturnType<typeof vi.fn>;
    };
    supabase.clientAsync.mockResolvedValue({ functions: { invoke } });

    await service().sendDirectWidgetBlackBoxNotify(entry, 'complete');

    expect(invoke).toHaveBeenCalledWith(
      'widget-notify',
      expect.objectContaining({
        timeout: TIMEOUT_CONFIG.QUICK,
        body: expect.objectContaining({
          directNotify: true,
          webhookId: 'pwa-blackbox-00000000-0000-4000-8000-000000000501',
          table: 'black_box_entries',
          entryId: 'entry-durable-direct',
          blackBoxAction: 'complete',
        }),
      }),
    );
    expect(removeRecord).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'black-box',
      entryId: 'entry-durable-direct',
      blackBoxAction: 'complete',
    }));
    expect(await outbox.listPendingNotifications()).toEqual([]);
  });

  it('direct black-box widget notify should keep a durable pending notification when invoke fails', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000502');
    const outbox = TestBed.inject(DockDirectWidgetNotifyOutboxService);
    const removeRecord = vi.spyOn(outbox, 'removeRecord');
    const invoke = vi.fn().mockResolvedValue({
      data: null,
      error: { message: 'edge timeout' },
    });
    const supabase = TestBed.inject(SupabaseClientService) as unknown as {
      clientAsync: ReturnType<typeof vi.fn>;
    };
    supabase.clientAsync.mockResolvedValue({ functions: { invoke } });

    await service().sendDirectWidgetBlackBoxNotify(
      createEntry({
        id: 'entry-durable-failed',
        updatedAt: '2026-06-29T00:00:00.000Z',
      }),
      'read',
    );

    expect(removeRecord).not.toHaveBeenCalled();
    expect(await outbox.listPendingNotifications()).toEqual([
      expect.objectContaining({
        kind: 'black-box',
        operationId: '00000000-0000-4000-8000-000000000502',
        entryId: 'entry-durable-failed',
        blackBoxAction: 'read',
        updatedAt: '2026-06-29T00:00:00.000Z',
        attemptCount: 0,
      }),
    ]);
  });

  it('direct black-box widget notify should skip without an active session', async () => {
    const supabase = TestBed.inject(SupabaseClientService) as unknown as {
      clientAsync: ReturnType<typeof vi.fn>;
      getSession: ReturnType<typeof vi.fn>;
    };
    supabase.clientAsync.mockClear();
    supabase.getSession.mockResolvedValue({ data: { session: null }, error: null });

    await service().sendDirectWidgetBlackBoxNotify(
      createEntry({ id: 'entry-no-session' }),
      'read',
    );

    expect(supabase.getSession).toHaveBeenCalledTimes(1);
    expect(supabase.clientAsync).not.toHaveBeenCalled();
  });

  it('direct black-box widget notify should still run with an expired but refreshable session', async () => {
    const invoke = vi.fn().mockResolvedValue({ data: null, error: null });
    const supabase = TestBed.inject(SupabaseClientService) as unknown as {
      clientAsync: ReturnType<typeof vi.fn>;
      getSession: ReturnType<typeof vi.fn>;
    };
    supabase.clientAsync.mockResolvedValue({ functions: { invoke } });
    supabase.getSession.mockResolvedValue({
      data: {
        session: {
          access_token: 'expired-token',
          expires_at: Math.floor(Date.now() / 1000) - 60,
        },
      },
      error: null,
    });

    await service().sendDirectWidgetBlackBoxNotify(
      createEntry({ id: 'entry-expired-session' }),
      'complete',
    );

    expect(invoke).toHaveBeenCalledWith(
      'widget-notify',
      expect.objectContaining({
        body: expect.objectContaining({
          directNotify: true,
          entryId: 'entry-expired-session',
        }),
      }),
    );
  });

  it('direct black-box widget notify should swallow getSession failures', async () => {
    const supabase = TestBed.inject(SupabaseClientService) as unknown as {
      clientAsync: ReturnType<typeof vi.fn>;
      getSession: ReturnType<typeof vi.fn>;
    };
    supabase.clientAsync.mockClear();
    supabase.getSession.mockRejectedValue(new Error('session probe failed'));

    await service().sendDirectWidgetBlackBoxNotify(
      createEntry({ id: 'entry-session-error' }),
      'read',
    );

    expect(supabase.clientAsync).not.toHaveBeenCalled();
  });
}
