import type { StaticProvider } from '@angular/core';
import {
  AuthService,
  Injector,
  LoggerService,
  ProjectCloudListService,
  ProjectDataService,
  ProjectDetailLoaderService,
  ProjectOfflineSnapshotService,
  ProjectParkedTasksDataService,
  ProjectSyncProbeService,
  ProjectTaskDataService,
  RequestThrottleService,
  SentryLazyLoaderService,
  StartupPlaceholderStateService,
  SupabaseClientService,
  SyncStateService,
  TombstoneService,
  vi,
} from './project-data.service.spec-context';

type OfflineSnapshotAuthMock = {
  currentUserId: ReturnType<typeof vi.fn>;
  peekPersistedSessionIdentity?: ReturnType<typeof vi.fn>;
  peekPersistedOwnerHint?: ReturnType<typeof vi.fn>;
};

type StartupPlaceholderStateMock = {
  isHintOnlyActive: ReturnType<typeof vi.fn>;
};

export type StartupOfflineSnapshotProjectDataService = ProjectDataService & {
  loadStartupOfflineSnapshot: () => Promise<{
    source: 'idb' | 'localStorage' | 'none';
    projectCount: number;
    bytes: number;
    migratedLegacy: boolean;
    projects: unknown[];
    ownerUserId?: string | null;
  }>;
};

export interface ProjectDataOfflineSnapshotServiceOptions {
  authService?: OfflineSnapshotAuthMock;
  startupPlaceholderState?: StartupPlaceholderStateMock;
}

function createProjectDataOfflineSnapshotProviders(
  options: ProjectDataOfflineSnapshotServiceOptions,
): StaticProvider[] {
  return [
    { provide: ProjectDataService, useClass: ProjectDataService },
    { provide: ProjectOfflineSnapshotService, useClass: ProjectOfflineSnapshotService },
    { provide: ProjectParkedTasksDataService, useClass: ProjectParkedTasksDataService },
    { provide: ProjectSyncProbeService, useClass: ProjectSyncProbeService },
    { provide: ProjectCloudListService, useClass: ProjectCloudListService },
    { provide: ProjectDetailLoaderService, useClass: ProjectDetailLoaderService },
    { provide: ProjectTaskDataService, useClass: ProjectTaskDataService },
    { provide: SupabaseClientService, useValue: { isConfigured: false, clientAsync: vi.fn() } },
    { provide: AuthService, useValue: options.authService ?? { currentUserId: vi.fn(() => 'user-1') } },
    { provide: LoggerService, useValue: createLoggerMock() },
    { provide: RequestThrottleService, useValue: { execute: vi.fn() } },
    { provide: SyncStateService, useValue: { setSyncError: vi.fn() } },
    {
      provide: TombstoneService,
      useValue: {
        getTombstonesWithCache: vi.fn().mockResolvedValue({ data: [], error: null }),
        getLocalTombstones: vi.fn().mockReturnValue(new Set()),
      },
    },
    {
      provide: SentryLazyLoaderService,
      useValue: {
        addBreadcrumb: vi.fn(),
        captureException: vi.fn(),
        captureMessage: vi.fn(),
      },
    },
    ...(options.startupPlaceholderState
      ? [{ provide: StartupPlaceholderStateService, useValue: options.startupPlaceholderState }]
      : []),
  ];
}

function createLoggerMock(): { category: () => Record<'debug' | 'info' | 'warn' | 'error', ReturnType<typeof vi.fn>> } {
  return {
    category: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
}

export function createProjectDataOfflineSnapshotService(
  options: ProjectDataOfflineSnapshotServiceOptions = {},
): ProjectDataService {
  return createProjectDataOfflineSnapshotInjector(options).get(ProjectDataService);
}

export function createStartupOfflineSnapshotProjectDataService(
  options: ProjectDataOfflineSnapshotServiceOptions = {},
): StartupOfflineSnapshotProjectDataService {
  return createProjectDataOfflineSnapshotService(options) as StartupOfflineSnapshotProjectDataService;
}

export function createProjectDataOfflineSnapshotInjector(
  options: ProjectDataOfflineSnapshotServiceOptions = {},
): Injector {
  return Injector.create({
    providers: createProjectDataOfflineSnapshotProviders(options),
  });
}
