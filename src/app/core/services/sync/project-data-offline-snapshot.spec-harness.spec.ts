import { describe, expect, it, vi } from './project-data.service.spec-context';
import {
  createProjectDataOfflineSnapshotService,
  type StartupOfflineSnapshotProjectDataService,
} from './project-data-offline-snapshot.spec-harness';

describe('project-data offline snapshot spec harness', () => {
  it('creates a ProjectDataService test instance with owner and placeholder overrides', async () => {
    const service = createProjectDataOfflineSnapshotService({
      authService: {
        currentUserId: vi.fn(() => 'owner-user'),
        peekPersistedSessionIdentity: vi.fn(() => null),
      },
      startupPlaceholderState: {
        isHintOnlyActive: vi.fn(() => true),
      },
    }) as StartupOfflineSnapshotProjectDataService;

    service.saveOfflineSnapshot([
      {
        id: 'harness-project',
        name: 'Harness Project',
        description: '',
        createdDate: '2026-03-31T00:00:00.000Z',
        tasks: [],
        connections: [],
      },
    ] as any);
    await Promise.resolve();

    const snapshot = await service.loadStartupOfflineSnapshot();

    expect(snapshot.projectCount).toBe(0);
  }, 10000);
});
