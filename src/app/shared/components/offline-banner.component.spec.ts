import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OfflineBannerComponent } from './offline-banner.component';
import { SyncStateService } from '../../core/services/sync/sync-state.service';
import { ActionQueueService } from '../../../services/action-queue.service';
import { ToastService } from '../../../services/toast.service';
import { UiStateService } from '../../../services/ui-state.service';
import { AuthService } from '../../../services/auth.service';
import { NetworkAwarenessService } from '../../../services/network-awareness.service';
import { AUTH_CONFIG } from '../../../config';
import { DEMO_BANNER_DISMISS_STORAGE_KEY } from './demo-banner.helpers';

function makeSyncState() {
  return signal({
    isSyncing: false,
    isOnline: true,
    offlineMode: false,
    sessionExpired: false,
    lastSyncTime: null,
    pendingCount: 0,
    syncError: null,
    backgroundSyncNotice: null,
    hasConflict: false,
    conflictData: null,
  });
}

describe('OfflineBannerComponent', () => {
  let fixture: ComponentFixture<OfflineBannerComponent>;
  let component: OfflineBannerComponent;
  let isMobile: ReturnType<typeof signal<boolean>>;
  let currentUserId: ReturnType<typeof signal<string | null>>;
  let networkOnline: ReturnType<typeof signal<boolean>>;
  let syncState: ReturnType<typeof makeSyncState>;

  beforeEach(() => {
    localStorage.clear();
    isMobile = signal(false);
    currentUserId = signal<string | null>(null);
    networkOnline = signal(true);
    syncState = makeSyncState();

    TestBed.configureTestingModule({
      imports: [OfflineBannerComponent],
      providers: [
        {
          provide: SyncStateService,
          useValue: {
            syncState,
          },
        },
        {
          provide: ActionQueueService,
          useValue: {
            queueFrozen: signal(false),
          },
        },
        {
          provide: ToastService,
          useValue: {
            info: vi.fn(),
            success: vi.fn(),
          },
        },
        {
          provide: UiStateService,
          useValue: {
            isMobile,
          },
        },
        {
          provide: AuthService,
          useValue: {
            currentUserId,
          },
        },
        {
          provide: NetworkAwarenessService,
          useValue: {
            isOnline: networkOnline,
          },
        },
      ],
    });

    fixture = TestBed.createComponent(OfflineBannerComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps the desktop offline indicator near the safe-area top edge', () => {
    expect(component.offlineIndicatorTop()).toBe('calc(env(safe-area-inset-top, 0px) + 8px)');
  });

  it('places the mobile offline indicator below the compact top controls when no demo banner is visible', () => {
    isMobile.set(true);
    fixture.detectChanges();

    expect(component.offlineIndicatorTop()).toBe('calc(env(safe-area-inset-top, 0px) + 42px)');
  });

  it('moves the mobile offline indicator below the demo banner for local-mode users', () => {
    isMobile.set(true);
    currentUserId.set(AUTH_CONFIG.LOCAL_MODE_USER_ID);
    fixture.detectChanges();

    expect(component.offlineIndicatorTop()).toBe('calc(env(safe-area-inset-top, 0px) + 104px)');
  });

  it('returns to the compact mobile offset when the demo banner was dismissed', () => {
    isMobile.set(true);
    currentUserId.set(AUTH_CONFIG.LOCAL_MODE_USER_ID);
    localStorage.setItem(DEMO_BANNER_DISMISS_STORAGE_KEY, JSON.stringify({ timestamp: Date.now() }));
    fixture.detectChanges();

    expect(component.offlineIndicatorTop()).toBe('calc(env(safe-area-inset-top, 0px) + 42px)');
  });

  it('clears a pending fade-out timer with handle 0 when destroyed', () => {
    const fadeOutTimer = 0 as unknown as ReturnType<typeof setTimeout>;
    const setTimeoutSpy = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation(() => fadeOutTimer);
    const clearTimeoutSpy = vi
      .spyOn(globalThis, 'clearTimeout')
      .mockImplementation(() => undefined);

    networkOnline.set(false);
    fixture.detectChanges();
    networkOnline.set(true);
    syncState.update(state => ({ ...state, isOnline: true, offlineMode: false }));
    fixture.detectChanges();

    expect(setTimeoutSpy).toHaveBeenCalled();
    clearTimeoutSpy.mockClear();

    fixture.destroy();

    expect(clearTimeoutSpy).toHaveBeenCalledWith(0);
  });
});
