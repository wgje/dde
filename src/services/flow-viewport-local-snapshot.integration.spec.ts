import { Injector, runInInjectionContext } from '@angular/core';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectOfflineSnapshotService } from '../app/core/services/sync/project-offline-snapshot.service';
import { AuthService } from './auth.service';
import { LoggerService } from './logger.service';
import { SentryLazyLoaderService } from './sentry-lazy-loader.service';
import type { Project } from '../models';

function createSnapshots(owner: () => string) {
  const injector = Injector.create({ providers: [ProjectOfflineSnapshotService,
    { provide: AuthService, useValue: { currentUserId: owner } },
    { provide: LoggerService, useValue: { category: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) } },
    { provide: SentryLazyLoaderService, useValue: { captureException: vi.fn(), captureMessage: vi.fn(), addBreadcrumb: vi.fn() } },
  ] });
  return runInInjectionContext(injector, () => injector.get(ProjectOfflineSnapshotService));
}
afterEach(() => { localStorage.clear(); vi.unstubAllGlobals(); });
describe('Flow viewport owner-scoped local snapshot recovery', () => {
  it('persists exact viewport in IndexedDB across service recreation, exports and restores by original project ID', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory()); localStorage.clear();
    let owner = 'viewport-owner-a';
    const snapshots = createSnapshots(() => owner);
    const project: Project = { id: '00000000-0000-4000-8000-000000001234', name: 'Local viewport',
      description: '', createdDate: '2026-11-27T00:00:00.000Z', tasks: [], connections: [],
      pendingSync: false, viewState: { scale: 1.4, positionX: 14, positionY: 28 } };
    await snapshots.saveOfflineSnapshotAndWait([project], owner);
    // Remove only this synthetic test's mirror: prove restart is read from IDB.
    localStorage.clear();
    const reopened = createSnapshots(() => owner);
    const loaded = await reopened.loadOfflineSnapshotAsync({ ownerUserId: owner });
    expect(loaded).toEqual([project]);
    const exported = JSON.stringify({ projects: loaded });
    await reopened.saveOfflineSnapshotAndWait(JSON.parse(exported).projects, owner);
    expect((await reopened.loadOfflineSnapshotAsync({ ownerUserId: owner }))?.[0])
      .toMatchObject({ id: project.id, viewState: project.viewState, pendingSync: false });
    owner = 'viewport-owner-b';
    expect(await reopened.loadOfflineSnapshotAsync({ ownerUserId: owner })).toBeNull();
  });
});
