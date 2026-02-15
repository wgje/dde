import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { SimpleSyncService } from '../../app/core/services/simple-sync.service';
import { UserSessionService } from '../../services/user-session.service';
import { requireAuthGuard } from '../../services/guards/auth.guard';
import { AUTH_CONFIG } from '../../config';
import type { ActivatedRouteSnapshot, RouterStateSnapshot } from '@angular/router';
import { AuthService } from '../../services/auth.service';
import { ModalService } from '../../services/modal.service';

describe('Local Mode Micro Perf Budget', () => {
  describe('SimpleSyncService', () => {
    let service: SimpleSyncService;

    beforeEach(() => {
      TestBed.configureTestingModule({ providers: [SimpleSyncService] });
      service = TestBed.inject(SimpleSyncService);
    });

    it('saveProjectToCloud local mode budget <10ms', async () => {
      const project = {
        id: 'test-project',
        name: 'Test Project',
        description: '',
        tasks: [],
        connections: [],
        version: 1,
        createdDate: new Date().toISOString(),
      };

      const getSessionSpy = vi.spyOn(service as never, 'getSupabaseClient').mockReturnValue(null as never);

      const perfStart = performance.now();
      const result = await service.saveProjectToCloud(project, AUTH_CONFIG.LOCAL_MODE_USER_ID);
      const perfEnd = performance.now();

      expect(result.success).toBe(false);
      expect(getSessionSpy).not.toHaveBeenCalled();
      expect(perfEnd - perfStart).toBeLessThan(10);
    });
  });

  describe('UserSessionService', () => {
    let service: UserSessionService;

    beforeEach(() => {
      TestBed.configureTestingModule({ providers: [UserSessionService] });
      service = TestBed.inject(UserSessionService);
    });

    it('loadProjects local mode budget <50ms', async () => {
      vi.spyOn(service, 'currentUserId').mockReturnValue(AUTH_CONFIG.LOCAL_MODE_USER_ID);
      const loadFromCacheSpy = vi.spyOn(service as never, 'loadFromCacheOrSeed').mockImplementation(() => undefined);

      const perfStart = performance.now();
      await service.loadProjects();
      const perfEnd = performance.now();

      expect(loadFromCacheSpy).toHaveBeenCalled();
      expect(perfEnd - perfStart).toBeLessThan(50);
    });
  });

  describe('AuthGuard', () => {
    it('requireAuthGuard local mode budget <10ms', async () => {
      localStorage.setItem(AUTH_CONFIG.LOCAL_MODE_CACHE_KEY, 'true');

      TestBed.configureTestingModule({
        providers: [
          {
            provide: AuthService,
            useValue: {
              isConfigured: true,
              authState: vi.fn().mockReturnValue({ isCheckingSession: false, userId: null }),
              currentUserId: vi.fn().mockReturnValue(null),
            },
          },
          { provide: ModalService, useValue: { open: vi.fn() } },
        ],
      });

      const mockRoute = {} as ActivatedRouteSnapshot;
      const mockState = { url: '/projects' } as RouterStateSnapshot;

      const perfStart = performance.now();
      const result = await TestBed.runInInjectionContext(() => requireAuthGuard(mockRoute, mockState));
      const perfEnd = performance.now();

      expect(result).toBe(true);
      expect(perfEnd - perfStart).toBeLessThan(10);
    });
  });
});
