import { Injector, signal } from '@angular/core';
import { expect, it, vi } from 'vitest';

import type { Project } from '../models';
import { ExternalSourceCacheService } from '../app/core/external-sources/external-source-cache.service';
import { ExternalSourceLinkService } from '../app/core/external-sources/external-source-link.service';
import { AuthService } from './auth.service';
import { BlackBoxService } from './black-box.service';
import { ConflictStorageService } from './conflict-storage.service';
import { DisasterBackupService } from './disaster-backup.service';
import { FocusPreferenceService } from './focus-preference.service';
import { LoggerService } from './logger.service';
import { PreferenceService } from './preference.service';
import { SupabaseClientService } from './supabase-client.service';
import { ThemeService } from './theme.service';
import { UiStateService } from './ui-state.service';

export interface DisasterBackupOwnerScopeSpecContext {
  createProject(): Project;
  seedStore(
    dbName: string,
    version: number,
    ensureStores: (db: IDBDatabase) => void,
    writer: (db: IDBDatabase) => Promise<void>,
  ): Promise<void>;
}

export function registerDisasterBackupOwnerScopeSpecs(
  context: DisasterBackupOwnerScopeSpecContext,
): void {
  const { createProject, seedStore } = context;

  it('buildLocalPayload should not mix anonymous dock snapshots into logged-in backups', async () => {
    localStorage.setItem('nanoflow.dock-snapshot.v3.user-1', JSON.stringify({
      savedAt: '2026-03-10T00:00:00.000Z',
      session: { mainTaskId: 'owner-task' },
    }));
    localStorage.setItem('nanoflow.dock-snapshot.v3.anonymous', JSON.stringify({
      savedAt: '2026-03-12T00:00:00.000Z',
      session: { mainTaskId: 'anonymous-task' },
    }));

    await seedStore(
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
            savedAt: '2026-03-10T00:00:00.000Z',
            entries: [{ taskId: 'owner-task' }],
          }, 'nanoflow.focus-session.v5.user-1');
          tx.objectStore('keyval').put({
            savedAt: '2026-03-12T00:00:00.000Z',
            entries: [{ taskId: 'anonymous-task' }],
          }, 'nanoflow.focus-session.v5.anonymous');
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      },
    );

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
      ],
    });

    const service = injector.get(DisasterBackupService);
    const payload = await service.buildLocalPayload([createProject()], {
      autoBackupEnabled: true,
      autoBackupIntervalMs: 900000,
    });

    expect(payload.localState?.dockSnapshot?.localStorage).toContain('owner-task');
    expect(payload.localState?.dockSnapshot?.localStorage).not.toContain('anonymous-task');
    expect(JSON.stringify(payload.localState?.dockSnapshot?.indexedDb)).toContain('owner-task');
    expect(JSON.stringify(payload.localState?.dockSnapshot?.indexedDb)).not.toContain('anonymous-task');
  });
}
