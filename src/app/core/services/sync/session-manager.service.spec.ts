import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { SessionManagerService } from './session-manager.service';
import { SupabaseClientService } from '../../../../services/supabase-client.service';
import { LoggerService } from '../../../../services/logger.service';
import { ToastService } from '../../../../services/toast.service';
import { EventBusService } from '../../../../services/event-bus.service';
import { SyncStateService } from './sync-state.service';
import { SentryLazyLoaderService } from '../../../../services/sentry-lazy-loader.service';

describe('SessionManagerService', () => {
  let service: SessionManagerService;
  let sessionExpired = false;

  const mockAuth = {
    getSession: vi.fn(),
    refreshSession: vi.fn(),
  };

  beforeEach(() => {
    sessionExpired = false;
    mockAuth.getSession.mockReset();
    mockAuth.refreshSession.mockReset();

    const mockLoggerCategory = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };

    TestBed.configureTestingModule({
      providers: [
        SessionManagerService,
        {
          provide: SupabaseClientService,
          useValue: {
            isConfigured: true,
            clientAsync: vi.fn().mockResolvedValue({ auth: mockAuth }),
          },
        },
        {
          provide: LoggerService,
          useValue: {
            category: vi.fn().mockReturnValue(mockLoggerCategory),
          },
        },
        {
          provide: ToastService,
          useValue: {
            warning: vi.fn(),
          },
        },
        {
          provide: EventBusService,
          useValue: {
            onSessionRestored$: {
              pipe: vi.fn().mockReturnValue({ subscribe: vi.fn() }),
            },
          },
        },
        {
          provide: SyncStateService,
          useValue: {
            isSessionExpired: vi.fn(() => sessionExpired),
            setSessionExpired: vi.fn((value: boolean) => {
              sessionExpired = value;
            }),
          },
        },
        {
          provide: SentryLazyLoaderService,
          useValue: {
            addBreadcrumb: vi.fn(),
          },
        },
      ],
    });

    service = TestBed.inject(SessionManagerService);
  });

  it('should return ok without refresh when session is valid', async () => {
    mockAuth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'user-1' } } },
    });

    const result = await service.validateOrRefreshOnResume('resume:test');

    expect(result).toEqual({ ok: true, refreshed: false, deferred: false });
    expect(mockAuth.refreshSession).not.toHaveBeenCalled();
  });

  it('should refresh session when validation fails', async () => {
    mockAuth.getSession.mockResolvedValue({
      data: { session: null },
    });
    mockAuth.refreshSession.mockResolvedValue({
      data: { session: { user: { id: 'user-2' }, expires_at: 1 } },
      error: null,
    });

    const result = await service.validateOrRefreshOnResume('resume:test');

    expect(result).toEqual({ ok: true, refreshed: true, deferred: false });
    expect(mockAuth.refreshSession).toHaveBeenCalledTimes(1);
  });

  it('should mark session expired when validate and refresh both fail', async () => {
    const syncState = TestBed.inject(SyncStateService) as unknown as {
      setSessionExpired: ReturnType<typeof vi.fn>;
    };
    const toast = TestBed.inject(ToastService) as unknown as {
      warning: ReturnType<typeof vi.fn>;
    };

    mockAuth.getSession.mockResolvedValue({
      data: { session: null },
    });
    mockAuth.refreshSession.mockResolvedValue({
      data: { session: null },
      error: { message: 'refresh failed' },
    });

    const result = await service.validateOrRefreshOnResume('resume:test');

    expect(result).toEqual({ ok: false, refreshed: false, deferred: false, reason: 'refresh-failed' });
    expect(syncState.setSessionExpired).toHaveBeenCalledWith(true);
    expect(toast.warning).toHaveBeenCalled();
  });

  it('should return deferred when supabase client is not ready on resume', async () => {
    const supabase = TestBed.inject(SupabaseClientService) as unknown as {
      clientAsync: ReturnType<typeof vi.fn>;
    };

    supabase.clientAsync.mockResolvedValueOnce(null);

    const syncState = TestBed.inject(SyncStateService) as unknown as {
      setSessionExpired: ReturnType<typeof vi.fn>;
    };
    const toast = TestBed.inject(ToastService) as unknown as {
      warning: ReturnType<typeof vi.fn>;
    };

    const result = await service.validateOrRefreshOnResume('resume:test');

    expect(result).toEqual({ ok: false, refreshed: false, deferred: true, reason: 'client-unready' });
    expect(syncState.setSessionExpired).not.toHaveBeenCalledWith(true);
    expect(toast.warning).not.toHaveBeenCalled();
  });
});
