import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LoggerService } from '../../../../services/logger.service';
import { SentryLazyLoaderService } from '../../../../services/sentry-lazy-loader.service';
import { mockSentryLazyLoaderService } from '../../../../test-setup.mocks';
import { DB_CONFIG, IndexedDBService } from './indexeddb.service';
import { SyncCursorPersistenceService } from './sync-cursor-persistence.service';

function deleteRawDatabase(dbName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(dbName);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error(`Failed to delete ${dbName}`));
    request.onblocked = () => reject(new Error(`Delete blocked for ${dbName}`));
  });
}

describe('SyncCursorPersistenceService', () => {
  let indexedDBService: IndexedDBService;
  let service: SyncCursorPersistenceService;

  beforeEach(async () => {
    await deleteRawDatabase(DB_CONFIG.name).catch(() => undefined);

    TestBed.configureTestingModule({
      providers: [
        IndexedDBService,
        SyncCursorPersistenceService,
        {
          provide: LoggerService,
          useValue: {
            category: vi.fn(() => ({
              debug: vi.fn(),
              info: vi.fn(),
              warn: vi.fn(),
              error: vi.fn(),
            })),
          },
        },
        { provide: SentryLazyLoaderService, useValue: mockSentryLazyLoaderService },
      ],
    });

    indexedDBService = TestBed.inject(IndexedDBService);
    service = TestBed.inject(SyncCursorPersistenceService);
  });

  afterEach(async () => {
    await indexedDBService.deleteDatabase().catch(() => undefined);
    TestBed.resetTestingModule();
  });

  it('initializes the main IndexedDB schema with a sync_cursors store', async () => {
    const db = await indexedDBService.initDatabase();

    expect(db.version).toBeGreaterThanOrEqual(3);
    expect(db.objectStoreNames.contains(DB_CONFIG.stores.syncCursors)).toBe(true);
  });

  it('persists and reloads a project combination cursor scoped by user and project', async () => {
    const cursor = {
      updatedAt: '2026-04-29T08:00:00.000Z',
      entityType: 'connection' as const,
      id: 'conn-z',
    };

    await service.commitProjectCursor('project-1', 'user-1', cursor);

    await expect(service.loadProjectCursor('project-1', 'user-1')).resolves.toEqual(cursor);
    await expect(service.loadProjectCursor('project-1', 'user-2')).resolves.toBeNull();
  });

  it('does not let an older cursor overwrite the persisted newer cursor', async () => {
    const newer = {
      updatedAt: '2026-04-29T08:00:00.000Z',
      entityType: 'connection' as const,
      id: 'conn-z',
    };
    const older = {
      updatedAt: '2026-04-29T08:00:00.000Z',
      entityType: 'task' as const,
      id: 'task-a',
    };

    await service.commitProjectCursor('project-1', 'user-1', newer);
    await expect(service.commitProjectCursor('project-1', 'user-1', older)).resolves.toEqual(newer);

    await expect(service.loadProjectCursor('project-1', 'user-1')).resolves.toEqual(newer);
  });

  it('keeps the newer cursor when concurrent commits race in separate tabs', async () => {
    const newer = {
      updatedAt: '2026-04-29T08:00:00.000Z',
      entityType: 'connection' as const,
      id: 'conn-z',
    };
    const older = {
      updatedAt: '2026-04-29T08:00:00.000Z',
      entityType: 'task' as const,
      id: 'task-a',
    };

    await indexedDBService.initDatabase();
    await Promise.all([
      service.commitProjectCursor('project-1', 'user-1', newer),
      service.commitProjectCursor('project-1', 'user-1', older),
    ]);

    await expect(service.loadProjectCursor('project-1', 'user-1')).resolves.toEqual(newer);
  });
});
