import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AUTH_CONFIG } from '../config/auth.config';
import type { Project } from '../models';
import type { UserSessionServiceSpecContext } from './user-session.service.spec-context';

export function registerUserSessionSnapshotPrehydrateSpecs(
  getContext: () => UserSessionServiceSpecContext,
): void {
  let context: UserSessionServiceSpecContext;

  beforeEach(() => {
    context = getContext();
  });

  // ====== 快照预填充测试 ======
  describe('prehydrateFromSnapshot', () => {
    it('Store 为空时应从全局快照预填充项目元数据但不 materialize recentTasks', () => {
      (context.mockProjectState['projects'] as ReturnType<typeof vi.fn>).mockReturnValue([]);
      (context.mockAuthService['peekPersistedSessionIdentity'] as ReturnType<typeof vi.fn>).mockReturnValue({
        userId: 'snapshot-user',
        email: 'snapshot@example.com',
      });

      // 模拟 index.html 注入的全局快照
      (window as Window & { __NANOFLOW_LAUNCH_SNAPSHOT__?: unknown }).__NANOFLOW_LAUNCH_SNAPSHOT__ = {
        version: 2,
        savedAt: '2026-03-27T10:00:00.000Z',
        userId: 'snapshot-user',
        activeProjectId: 'a0000000-0000-4000-8000-000000000001',
        lastActiveView: 'text',
        theme: 'default',
        colorMode: 'dark',
        projects: [
          {
            id: 'a0000000-0000-4000-8000-000000000001',
            name: 'Alpha Protocol',
            description: 'Test project',
            updatedAt: '2026-03-27T10:00:00.000Z',
            taskCount: 2,
            openTaskCount: 2,
            recentTasks: [
              { id: 'b0000000-0000-4000-8000-000000000001', title: '阶段 1: 环境搭建', displayId: '1', status: 'active' },
              { id: 'b0000000-0000-4000-8000-000000000002', title: '核心逻辑实现', displayId: '1,a', status: 'active' },
            ],
          },
        ],
      };

      const result = context.service.prehydrateFromSnapshot();

      expect(result).toBe(true);
      expect(context.mockProjectState['setProjectsMetadataOnly']).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            id: 'a0000000-0000-4000-8000-000000000001',
            name: 'Alpha Protocol',
            tasks: [],
            connections: [],
          }),
        ]),
      );
      expect(context.mockProjectState['setProjects']).not.toHaveBeenCalled();
      expect(context.mockProjectState['setActiveProjectId']).toHaveBeenCalledWith('a0000000-0000-4000-8000-000000000001');

      // 清理全局快照
      delete (window as Window & { __NANOFLOW_LAUNCH_SNAPSHOT__?: unknown }).__NANOFLOW_LAUNCH_SNAPSHOT__;
    });

    it('Store 已有数据时应跳过预填充并返回 true', () => {
      const existingProject = context.createProject({ id: 'existing-1' });
      (context.mockProjectState['projects'] as ReturnType<typeof vi.fn>).mockReturnValue([existingProject]);

      const result = context.service.prehydrateFromSnapshot();

      expect(result).toBe(true);
      expect(context.mockProjectState['setProjects']).not.toHaveBeenCalled();
    });

    it('无快照数据时应返回 false', () => {
      (context.mockProjectState['projects'] as ReturnType<typeof vi.fn>).mockReturnValue([]);

      // 确保全局和 localStorage 都没有快照
      delete (window as Window & { __NANOFLOW_LAUNCH_SNAPSHOT__?: unknown }).__NANOFLOW_LAUNCH_SNAPSHOT__;
      localStorage.removeItem('nanoflow.launch-snapshot.v2');

      const result = context.service.prehydrateFromSnapshot();

      expect(result).toBe(false);
      expect(context.mockProjectState['setProjects']).not.toHaveBeenCalled();
    });

    it('从 localStorage 快照预填充', () => {
      (context.mockProjectState['projects'] as ReturnType<typeof vi.fn>).mockReturnValue([]);
      (context.mockAuthService['peekPersistedSessionIdentity'] as ReturnType<typeof vi.fn>).mockReturnValue({
        userId: 'snapshot-user',
        email: 'snapshot@example.com',
      });

      const snapshot = {
        version: 2,
        savedAt: '2026-03-27T10:00:00.000Z',
        userId: 'snapshot-user',
        activeProjectId: 'c0000000-0000-4000-8000-000000000001',
        lastActiveView: 'text',
        theme: 'default',
        colorMode: 'dark',
        projects: [
          {
            id: 'c0000000-0000-4000-8000-000000000001',
            name: 'LocalStorage Project',
            description: '',
            updatedAt: null,
            taskCount: 0,
            openTaskCount: 0,
            recentTasks: [],
          },
        ],
      };
      localStorage.setItem('nanoflow.launch-snapshot.v2', JSON.stringify(snapshot));

      const result = context.service.prehydrateFromSnapshot();

      expect(result).toBe(true);
      expect(context.mockProjectState['setProjectsMetadataOnly']).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ id: 'c0000000-0000-4000-8000-000000000001', name: 'LocalStorage Project' }),
        ]),
      );
      expect(context.mockProjectState['setProjects']).not.toHaveBeenCalled();
    });

    it('owner 未通过本地会话确认时不应预填充快照', () => {
      (context.mockProjectState['projects'] as ReturnType<typeof vi.fn>).mockReturnValue([]);
      (context.mockAuthService['peekPersistedSessionIdentity'] as ReturnType<typeof vi.fn>).mockReturnValue({
        userId: 'current-user',
        email: 'current@example.com',
      });

      localStorage.setItem('nanoflow.launch-snapshot.v2', JSON.stringify({
        version: 2,
        savedAt: '2026-03-27T10:00:00.000Z',
        userId: 'stale-user',
        activeProjectId: 'd0000000-0000-4000-8000-000000000001',
        lastActiveView: 'text',
        theme: 'default',
        colorMode: 'dark',
        projects: [
          {
            id: 'd0000000-0000-4000-8000-000000000001',
            name: 'Stale Project',
            description: '',
            updatedAt: null,
            taskCount: 0,
            openTaskCount: 0,
            recentTasks: [],
          },
        ],
      }));

      const result = context.service.prehydrateFromSnapshot();

      expect(result).toBe(false);
      expect(context.mockProjectState['setProjects']).not.toHaveBeenCalled();
      expect(context.service.startupProjectCatalogStage()).toBe('unresolved');
    });

    it('owner hint 在离线预水合期间变化时只应安装 metadata shell', () => {
      const offlineProject = context.createProject({
        id: 'volatile-owner-project',
        name: 'Sensitive Offline Project',
        tasks: [context.createTask({ id: 'volatile-owner-task', content: 'must not materialize' })],
      });
      (context.mockProjectState['projects'] as ReturnType<typeof vi.fn>).mockReturnValue([]);
      (context.mockAuthService['peekPersistedSessionIdentity'] as ReturnType<typeof vi.fn>)
        .mockReturnValue(null);
      (context.mockAuthService['peekPersistedOwnerHint'] as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce('volatile-user')
        .mockReturnValue(null);
      (
        context.mockSyncCoordinator['core'] as {
          loadOfflineSnapshot: ReturnType<typeof vi.fn>;
        }
      ).loadOfflineSnapshot.mockReturnValue([offlineProject]);

      const result = context.service.prehydrateFromSnapshot();

      expect(result).toBe(true);
      expect(context.mockProjectState['setProjectsMetadataOnly']).toHaveBeenCalledWith([
        expect.objectContaining({
          id: 'volatile-owner-project',
          name: 'Project 1',
          tasks: [],
          connections: [],
        }),
      ]);
      expect(context.mockProjectState['setProjects']).not.toHaveBeenCalled();
      expect(context.service.startupProjectCatalogStage()).toBe('partial');
      expect(context.service.trustedPrehydratedSnapshotVisible()).toBe(false);
    });

    it('仅有匹配 owner hint 时应信任离线快照并展示完整数据', () => {
      const offlineProject = context.createProject({
        id: 'hint-only-project',
        name: 'Hint Only Offline Project',
      });
      (context.mockProjectState['projects'] as ReturnType<typeof vi.fn>).mockReturnValue([]);
      (context.mockAuthService['peekPersistedSessionIdentity'] as ReturnType<typeof vi.fn>).mockReturnValue(null);
      (context.mockAuthService['peekPersistedOwnerHint'] as ReturnType<typeof vi.fn>).mockReturnValue('hint-user');
      (
        context.mockSyncCoordinator['core'] as {
          loadOfflineSnapshot: ReturnType<typeof vi.fn>;
        }
      ).loadOfflineSnapshot.mockReturnValue([offlineProject]);

      localStorage.setItem('nanoflow.launch-snapshot.v2', JSON.stringify({
        version: 2,
        savedAt: '2026-03-27T10:00:00.000Z',
        userId: 'hint-user',
        activeProjectId: 'd0000000-0000-4000-8000-000000000011',
        lastActiveView: 'text',
        theme: 'default',
        colorMode: 'dark',
        projects: [
          {
            id: 'd0000000-0000-4000-8000-000000000011',
            name: 'Sensitive Launch Project',
            description: '',
            updatedAt: '2026-03-27T10:00:00.000Z',
            taskCount: 1,
            openTaskCount: 1,
            recentTasks: [
              {
                id: 'd0000000-0000-4000-8000-000000000012',
                title: 'sensitive recent task',
                displayId: '1',
                status: 'active'
              },
            ],
          },
        ],
      }));

      const result = context.service.prehydrateFromSnapshot();

      // owner hint 匹配即信任离线快照，PWA 数据为设备本地存储
      expect(result).toBe(true);
      expect(context.mockProjectState['setProjects']).toHaveBeenCalledWith([
        expect.objectContaining({ id: 'hint-only-project', name: 'Hint Only Offline Project' }),
      ]);
      expect(context.service.trustedPrehydratedSnapshotVisible()).toBe(false);
      expect(context.service.startupProjectCatalogStage()).toBe('partial');
    });

    it('launch snapshot owner 不可信时应回退到离线快照并以 owner hint 信任完整数据', () => {
      const offlineProject = context.createProject({
        id: 'offline-project-1',
        name: 'Offline Recovery Project',
      });
      (context.mockProjectState['projects'] as ReturnType<typeof vi.fn>).mockReturnValue([]);
      (context.mockAuthService['peekPersistedSessionIdentity'] as ReturnType<typeof vi.fn>).mockReturnValue(null);
      (context.mockAuthService['peekPersistedOwnerHint'] as ReturnType<typeof vi.fn>).mockReturnValue('current-user');
      (
        context.mockSyncCoordinator['core'] as {
          loadOfflineSnapshot: ReturnType<typeof vi.fn>;
        }
      ).loadOfflineSnapshot.mockReturnValue([offlineProject]);

      localStorage.setItem('nanoflow.launch-snapshot.v2', JSON.stringify({
        version: 2,
        savedAt: '2026-03-27T10:00:00.000Z',
        userId: 'stale-user',
        activeProjectId: 'd0000000-0000-4000-8000-000000000021',
        lastActiveView: 'text',
        theme: 'default',
        colorMode: 'dark',
        projects: [
          {
            id: 'd0000000-0000-4000-8000-000000000021',
            name: 'Stale Snapshot Project',
            description: '',
            updatedAt: null,
            taskCount: 0,
            openTaskCount: 0,
            recentTasks: [],
          },
        ],
      }));

      const result = context.service.prehydrateFromSnapshot();

      // owner hint 匹配即信任，展示完整离线数据
      expect(result).toBe(true);
      expect(context.mockProjectState['setProjects']).toHaveBeenCalledWith([
        expect.objectContaining({ id: 'offline-project-1', name: 'Offline Recovery Project' }),
      ]);
      expect(context.mockProjectState['setActiveProjectId']).toHaveBeenCalledWith('offline-project-1');
      expect(context.service.startupProjectCatalogStage()).toBe('partial');
      expect(context.service.trustedPrehydratedSnapshotVisible()).toBe(false);
    });

    it('owner 已通过 persisted session 确认时应恢复完整离线快照内容', () => {
      const offlineProject = context.createProject({
        id: 'confirmed-offline-project',
        name: 'Confirmed Offline Project',
        tasks: [context.createTask({ id: 'confirmed-task', content: 'confirmed task content' })],
      });
      (context.mockProjectState['projects'] as ReturnType<typeof vi.fn>).mockReturnValue([]);
      (context.mockAuthService['peekPersistedSessionIdentity'] as ReturnType<typeof vi.fn>).mockReturnValue({
        userId: 'current-user',
        email: 'current@example.com',
      });
      (context.mockAuthService['peekPersistedOwnerHint'] as ReturnType<typeof vi.fn>).mockReturnValue('current-user');
      (
        context.mockSyncCoordinator['core'] as {
          loadOfflineSnapshot: ReturnType<typeof vi.fn>;
        }
      ).loadOfflineSnapshot.mockReturnValue([offlineProject]);

      const result = context.service.prehydrateFromSnapshot();

      expect(result).toBe(true);
      expect(context.mockProjectState['setProjects']).toHaveBeenCalledWith([
        expect.objectContaining({
          id: 'confirmed-offline-project',
          name: 'Confirmed Offline Project',
          tasks: [expect.objectContaining({ id: 'confirmed-task', content: 'confirmed task content' })],
        }),
      ]);
      expect(context.service.startupProjectCatalogStage()).toBe('partial');
      expect(context.service.trustedPrehydratedSnapshotVisible()).toBe(false);
    });

    it('存在云端 owner hint 时应信任离线快照并展示完整数据', () => {
      const offlineProject = context.createProject({
        id: 'cloud-owned-project',
        name: 'Cloud Owned Project',
      });
      (context.mockProjectState['projects'] as ReturnType<typeof vi.fn>).mockReturnValue([]);
      (context.mockAuthService['peekPersistedOwnerHint'] as ReturnType<typeof vi.fn>).mockReturnValue('cloud-user');
      (
        context.mockSyncCoordinator['core'] as {
          loadOfflineSnapshot: ReturnType<typeof vi.fn>;
        }
      ).loadOfflineSnapshot.mockReturnValue([offlineProject]);

      localStorage.setItem('nanoflow.launch-snapshot.v2', JSON.stringify({
        version: 2,
        savedAt: '2026-03-27T10:00:00.000Z',
        userId: AUTH_CONFIG.LOCAL_MODE_USER_ID,
        activeProjectId: 'd0000000-0000-4000-8000-000000000031',
        lastActiveView: 'text',
        theme: 'default',
        colorMode: 'dark',
        projects: [
          {
            id: 'd0000000-0000-4000-8000-000000000031',
            name: 'Guest Snapshot Project',
            description: '',
            updatedAt: null,
            taskCount: 0,
            openTaskCount: 0,
            recentTasks: [],
          },
        ],
      }));

      const result = context.service.prehydrateFromSnapshot();

      // owner hint 匹配即信任，展示完整离线数据
      expect(result).toBe(true);
      expect(context.mockProjectState['setProjects']).toHaveBeenCalledWith([
        expect.objectContaining({ id: 'cloud-owned-project', name: 'Cloud Owned Project' }),
      ]);
      expect(context.service.trustedPrehydratedSnapshotVisible()).toBe(false);
      expect(context.service.startupProjectCatalogStage()).toBe('partial');
    });
  });

  // ====== 种子数据保护测试 ======
  describe('loadFromCacheOrSeed 种子保护', () => {
    it('已登录用户无缓存时不应创建种子数据', async () => {
      // 设置已登录状态
      context.userIdSignal.set('real-user-123');

      const loadFromCacheOrSeed = (
        context.service as unknown as {
          loadFromCacheOrSeed: (override?: {
            source: string;
            projectCount: number;
            bytes: number;
            migratedLegacy: boolean;
            projects: Project[];
            ownerUserId?: string | null;
          }) => Promise<void>;
        }
      ).loadFromCacheOrSeed.bind(context.service);

      await loadFromCacheOrSeed({
        source: 'none',
        projectCount: 0,
        bytes: 0,
        migratedLegacy: false,
        projects: [],
      });

      // 应设置空列表（非种子数据），等后台同步
      const setProjectsCalls = (context.mockProjectState['setProjects'] as ReturnType<typeof vi.fn>).mock.calls;
      const lastCallProjects = setProjectsCalls[setProjectsCalls.length - 1][0] as Project[];
      expect(lastCallProjects.length).toBe(0);
    });

    it('认证恢复前若已存在 persisted session user，不应提前注入种子数据', async () => {
      context.userIdSignal.set(null);
      (context.mockAuthService['peekPersistedSessionIdentity'] as ReturnType<typeof vi.fn>).mockReturnValue({
        userId: 'real-user-123',
        email: 'real@example.com',
      });

      const loadFromCacheOrSeed = (
        context.service as unknown as {
          loadFromCacheOrSeed: (override?: {
            source: string;
            projectCount: number;
            bytes: number;
            migratedLegacy: boolean;
            projects: Project[];
            ownerUserId?: string | null;
          }) => Promise<void>;
        }
      ).loadFromCacheOrSeed.bind(context.service);

      await loadFromCacheOrSeed({
        source: 'none',
        projectCount: 0,
        bytes: 0,
        migratedLegacy: false,
        projects: [],
      });

      const setProjectsCalls = (context.mockProjectState['setProjects'] as ReturnType<typeof vi.fn>).mock.calls;
      const lastCallProjects = setProjectsCalls[setProjectsCalls.length - 1][0] as Project[];
      expect(lastCallProjects.length).toBe(0);
      expect(context.service.startupProjectCatalogStage()).toBe('partial');
    });

    it('未登录用户无缓存时应创建种子数据', async () => {
      // 未登录状态
      context.userIdSignal.set(null);

      const loadFromCacheOrSeed = (
        context.service as unknown as {
          loadFromCacheOrSeed: (override?: {
            source: string;
            projectCount: number;
            bytes: number;
            migratedLegacy: boolean;
            projects: Project[];
            ownerUserId?: string | null;
          }) => Promise<void>;
        }
      ).loadFromCacheOrSeed.bind(context.service);

      await loadFromCacheOrSeed({
        source: 'none',
        projectCount: 0,
        bytes: 0,
        migratedLegacy: false,
        projects: [],
      });

      // 未登录用户应生成种子数据
      const setProjectsCalls = (context.mockProjectState['setProjects'] as ReturnType<typeof vi.fn>).mock.calls;
      const lastCallProjects = setProjectsCalls[setProjectsCalls.length - 1][0] as Project[];
      expect(lastCallProjects.length).toBeGreaterThan(0);
    });

    it('已登录用户恢复旧缓存项目时应将其标记为 local-only', async () => {
      context.userIdSignal.set('real-user-123');
      const legacyProject = context.createProject({ id: 'legacy-local-project' });

      const loadFromCacheOrSeed = (
        context.service as unknown as {
          loadFromCacheOrSeed: (override?: {
            source: string;
            projectCount: number;
            bytes: number;
            migratedLegacy: boolean;
            projects: Project[];
            ownerUserId?: string | null;
          }) => Promise<void>;
        }
      ).loadFromCacheOrSeed.bind(context.service);

      await loadFromCacheOrSeed({
        source: 'localStorage',
        projectCount: 1,
        bytes: 128,
        migratedLegacy: false,
        ownerUserId: 'real-user-123',
        projects: [legacyProject],
      });

      const setProjectsCalls = (context.mockProjectState['setProjects'] as ReturnType<typeof vi.fn>).mock.calls;
      const lastCallProjects = setProjectsCalls[setProjectsCalls.length - 1][0] as Project[];
      expect(lastCallProjects[0]?.syncSource).toBe('local-only');
      expect(lastCallProjects[0]?.pendingSync).toBe(true);
    });
  });

  describe('startBackgroundSync local-only 保护', () => {
    it('当前项目是 local-only 时应跳过云端探测和按需加载', async () => {
      const localOnlyProject = context.createProject({
        id: 'proj-local-only',
        name: 'Guest Draft',
        syncSource: 'local-only',
      });
      context.saveGuestDraftProjects([localOnlyProject]);
      (context.mockProjectState['projects'] as ReturnType<typeof vi.fn>).mockReturnValue([localOnlyProject]);
      (context.mockProjectState['activeProjectId'] as ReturnType<typeof vi.fn>).mockReturnValue('proj-local-only');

      await (
        context.service as unknown as {
          startBackgroundSync: (userId: string, previousActive: string | null) => Promise<void>;
        }
      ).startBackgroundSync('user-1', null);

      expect((context.mockSyncCoordinator['core'] as Record<string, unknown>)['getAccessibleProjectProbe']).not.toHaveBeenCalled();
      expect(context.mockSyncCoordinator['performDeltaSync']).not.toHaveBeenCalled();
      expect(context.mockSyncCoordinator['loadSingleProjectFromCloud']).not.toHaveBeenCalled();
      expect(context.mockProjectState['setActiveProjectId']).not.toHaveBeenCalledWith(null);
    });
  });
}
