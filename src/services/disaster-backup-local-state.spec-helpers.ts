import { Injector, signal } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
import { DisasterBackupService } from './disaster-backup.service';
import { LoggerService } from './logger.service';
import { AuthService } from './auth.service';
import { ThemeService } from './theme.service';
import { UiStateService } from './ui-state.service';
import { PreferenceService } from './preference.service';
import { FocusPreferenceService } from './focus-preference.service';
import { BlackBoxService } from './black-box.service';
import { ConflictStorageService } from './conflict-storage.service';
import { SupabaseClientService } from './supabase-client.service';
import type { Project } from '../models';
import { ExternalSourceLinkService } from '../app/core/external-sources/external-source-link.service';
import { ExternalSourceCacheService } from '../app/core/external-sources/external-source-cache.service';
import { AttachmentUploadOutboxService } from './attachment-upload-outbox.service';

interface BackupTableClient {
  client: unknown;
}

interface DisasterBackupLocalStateSpecContext {
  createProject: () => Project;
  createBackupTableClient: (
    tableData: Record<string, unknown[]>,
    options?: { error?: unknown },
  ) => BackupTableClient;
  seedStore: (
    dbName: string,
    version: number,
    ensureStores: (db: IDBDatabase) => void,
    writer: (db: IDBDatabase) => Promise<void>,
  ) => Promise<void>;
}

function createLocalOnlyInjector(ownerUserId: string | null = 'user-1'): Injector {
  return Injector.create({
    providers: [
      { provide: DisasterBackupService, useClass: DisasterBackupService },
      { provide: LoggerService, useValue: { category: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) } },
      { provide: AuthService, useValue: { currentUserId: vi.fn(() => ownerUserId) } },
      { provide: ThemeService, useValue: { theme: signal('forest'), colorMode: signal('dark') } },
      { provide: UiStateService, useValue: { layoutDirection: signal('rtl'), floatingWindowPref: signal('fixed') } },
      { provide: PreferenceService, useValue: { autoResolveConflicts: signal(false) } },
      { provide: FocusPreferenceService, useValue: { preferences: signal({}), getPreferences: vi.fn(() => ({})) } },
      { provide: BlackBoxService, useValue: { entriesMap: signal(new Map()) } },
      { provide: ConflictStorageService, useValue: { getAllConflicts: vi.fn().mockResolvedValue([]) } },
      { provide: SupabaseClientService, useValue: { isConfigured: false, client: vi.fn() } },
      { provide: ExternalSourceLinkService, useValue: { ensureLoaded: vi.fn().mockResolvedValue(undefined), activeLinksForTask: vi.fn(() => []) } },
      { provide: ExternalSourceCacheService, useValue: { loadPendingLinks: vi.fn().mockResolvedValue([]) } },
      { provide: AttachmentUploadOutboxService, useValue: { listPendingUploads: vi.fn().mockResolvedValue([]) } },
    ],
  });
}

export function registerDisasterBackupLocalStateSpecs(context: DisasterBackupLocalStateSpecContext): void {
  describe('local disaster backup remote/local fallback coverage', () => {
    it('buildLocalPayload should fail on retryable remote errors that are not browser suspension', async () => {
      const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
      const queryError = { code: 503, message: 'service unavailable' };
      const { client } = context.createBackupTableClient({}, { error: queryError });

      const injector = Injector.create({
        providers: [
          { provide: DisasterBackupService, useClass: DisasterBackupService },
          { provide: LoggerService, useValue: { category: () => logger } },
          { provide: AuthService, useValue: { currentUserId: vi.fn(() => 'user-1') } },
          { provide: ThemeService, useValue: { theme: signal('forest'), colorMode: signal('dark') } },
          { provide: UiStateService, useValue: { layoutDirection: signal('rtl'), floatingWindowPref: signal('fixed') } },
          { provide: PreferenceService, useValue: { autoResolveConflicts: signal(false) } },
          { provide: FocusPreferenceService, useValue: { preferences: signal({}), getPreferences: vi.fn(() => ({})) } },
          { provide: BlackBoxService, useValue: { entriesMap: signal(new Map()) } },
          { provide: ConflictStorageService, useValue: { getAllConflicts: vi.fn().mockResolvedValue([]) } },
          { provide: SupabaseClientService, useValue: { isConfigured: true, client: vi.fn(() => client) } },
          { provide: ExternalSourceLinkService, useValue: { ensureLoaded: vi.fn().mockResolvedValue(undefined), activeLinksForTask: vi.fn(() => []) } },
          { provide: ExternalSourceCacheService, useValue: { loadPendingLinks: vi.fn().mockResolvedValue([]) } },
          { provide: AttachmentUploadOutboxService, useValue: { listPendingUploads: vi.fn().mockResolvedValue([]) } },
        ],
      });

      const service = injector.get(DisasterBackupService);

      await expect(service.buildLocalPayload([context.createProject()], {
        autoBackupEnabled: true,
        autoBackupIntervalMs: 900000,
      })).rejects.toThrow(/Backup table user_preferences query failed/i);
      expect(logger.error).toHaveBeenCalledWith(
        'Failed to fetch backup table',
        expect.objectContaining({ table: 'user_preferences', error: queryError }),
      );
    });

    it('buildLocalPayload should fallback to owner-scoped action queue IndexedDB backup', async () => {
      await context.seedStore(
        'nanoflow-queue-backup',
        1,
        (db) => {
          if (!db.objectStoreNames.contains('queue-backup')) {
            db.createObjectStore('queue-backup', { keyPath: 'id' });
          }
        },
        async (db) => {
          await new Promise<void>((resolve, reject) => {
            const tx = db.transaction('queue-backup', 'readwrite');
            tx.objectStore('queue-backup').put({
              id: 'queue-backup:user-1',
              ownerUserId: 'user-1',
              actions: [{ id: 'action-backed-up', entityType: 'project' }],
              savedAt: '2026-03-09T00:00:00.000Z',
            });
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
          });
        },
      );

      const service = createLocalOnlyInjector().get(DisasterBackupService);
      const payload = await service.buildLocalPayload([context.createProject()], {
        autoBackupEnabled: false,
        autoBackupIntervalMs: 900000,
      });

      expect(payload.localState!.actionQueue).toEqual([
        expect.objectContaining({ id: 'action-backed-up', entityType: 'project' }),
      ]);
    });

    it('buildLocalPayload should include the newest anonymous dock snapshot when current-user scope is empty', async () => {
      localStorage.setItem('nanoflow.dock-snapshot.v3.anonymous', JSON.stringify({
        savedAt: '2026-03-12T00:00:00.000Z',
        session: { mainTaskId: 'anon-legacy-task' },
      }));

      await context.seedStore(
        'keyval-store',
        1,
        (db) => {
          if (!db.objectStoreNames.contains('keyval')) {
            db.createObjectStore('keyval');
          }
        },
        async (db) => {
          await new Promise<void>((resolve, reject) => {
            const tx = db.transaction('keyval', 'readwrite');
            tx.objectStore('keyval').put({
              savedAt: '2026-03-13T00:00:00.000Z',
              entries: [{ taskId: 'anon-idb-task', lane: 'backup' }],
            }, 'nanoflow.focus-session.v5.anonymous');
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
          });
        },
      );

      const service = createLocalOnlyInjector(null).get(DisasterBackupService);
      const payload = await service.buildLocalPayload([context.createProject()], {
        autoBackupEnabled: false,
        autoBackupIntervalMs: 900000,
      });

      expect(payload.localState?.dockSnapshot).toEqual(expect.objectContaining({
        localStorage: JSON.stringify({
          savedAt: '2026-03-12T00:00:00.000Z',
          session: { mainTaskId: 'anon-legacy-task' },
        }),
        indexedDb: expect.objectContaining({
          savedAt: '2026-03-13T00:00:00.000Z',
          entries: [expect.objectContaining({ taskId: 'anon-idb-task', lane: 'backup' })],
        }),
      }));
    });

    it('buildLocalPayload should include pending attachment upload outbox bytes in local data safety package', async () => {
      const pendingBlob = new Blob([new Uint8Array([78, 70])], { type: 'text/plain' });
      const listPendingUploads = vi.fn().mockResolvedValue([{
        attachmentId: 'attachment-1',
        blobKey: 'attachment-1',
        fileName: 'offline.txt',
        mimeType: 'text/plain',
        size: 2,
        createdAt: '2026-06-18T00:00:00.000Z',
        blob: pendingBlob,
      }]);
      const injector = Injector.create({
        providers: [
          { provide: DisasterBackupService, useClass: DisasterBackupService },
          { provide: LoggerService, useValue: { category: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) } },
          { provide: AuthService, useValue: { currentUserId: vi.fn(() => 'user-1') } },
          { provide: ThemeService, useValue: { theme: signal('forest'), colorMode: signal('dark') } },
          { provide: UiStateService, useValue: { layoutDirection: signal('rtl'), floatingWindowPref: signal('fixed') } },
          { provide: PreferenceService, useValue: { autoResolveConflicts: signal(false) } },
          { provide: FocusPreferenceService, useValue: { preferences: signal({}), getPreferences: vi.fn(() => ({})) } },
          { provide: BlackBoxService, useValue: { entriesMap: signal(new Map()) } },
          { provide: ConflictStorageService, useValue: { getAllConflicts: vi.fn().mockResolvedValue([]) } },
          { provide: SupabaseClientService, useValue: { isConfigured: false, client: vi.fn() } },
          { provide: ExternalSourceLinkService, useValue: { ensureLoaded: vi.fn().mockResolvedValue(undefined), activeLinksForTask: vi.fn(() => []) } },
          { provide: ExternalSourceCacheService, useValue: { loadPendingLinks: vi.fn().mockResolvedValue([]) } },
          { provide: AttachmentUploadOutboxService, useValue: { listPendingUploads } },
        ],
      });

      const payload = await injector.get(DisasterBackupService).buildLocalPayload([context.createProject()], {
        autoBackupEnabled: false,
        autoBackupIntervalMs: 900000,
      });

      expect(listPendingUploads).toHaveBeenCalled();
      expect(payload.localState?.attachmentUploadOutbox).toEqual([{
        attachmentId: 'attachment-1',
        blobKey: 'attachment-1',
        fileName: 'offline.txt',
        mimeType: 'text/plain',
        size: 2,
        createdAt: '2026-06-18T00:00:00.000Z',
        encoding: 'base64',
        blobBase64: 'TkY=',
      }]);
      expect(JSON.parse(JSON.stringify(payload.localState?.attachmentUploadOutbox))).toEqual(
        payload.localState?.attachmentUploadOutbox,
      );
    });
  });
}
