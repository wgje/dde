import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthService } from '../../../services/auth.service';
import { deleteDataSafetyRestoreMarkerJournalDatabaseForTests } from '../../../services/data-safety-restore-marker-journal';
import { LoggerService } from '../../../services/logger.service';
import {
  LocalBackupUiRestoreWriterPausedError,
  localBackupUiRestoreWriterQuiescence,
} from '../../../services/local-backup-ui-restore-writer-quiescence.service';
import { SupabaseClientService } from '../../../services/supabase-client.service';
import { ToastService } from '../../../services/toast.service';
import { ExternalSourceLinkService } from './external-source-link.service';

describe('ExternalSourceLink restore writer quiescence', () => {
  const owner = signal('external-owner');
  const clientAsync = vi.fn(async () => ({ from: vi.fn() }));

  beforeEach(async () => {
    localStorage.clear();
    await deleteDataSafetyRestoreMarkerJournalDatabaseForTests();
    clientAsync.mockClear();
    TestBed.configureTestingModule({
      providers: [
        ExternalSourceLinkService,
        { provide: AuthService, useValue: { currentUserId: owner } },
        { provide: SupabaseClientService, useValue: { clientAsync } },
        { provide: ToastService, useValue: { success: vi.fn(), info: vi.fn(), error: vi.fn() } },
        { provide: LoggerService, useValue: { category: () => ({
          info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
        }) } },
      ],
    });
  });

  afterEach(async () => {
    TestBed.resetTestingModule();
    localStorage.clear();
    await deleteDataSafetyRestoreMarkerJournalDatabaseForTests();
  });

  it('rejects flush before reading pending links or opening a remote client', async () => {
    const handle = await localBackupUiRestoreWriterQuiescence.prepare(owner());
    const service = TestBed.inject(ExternalSourceLinkService);

    await expect(service.flushPendingLinks())
      .rejects.toBeInstanceOf(LocalBackupUiRestoreWriterPausedError);
    await expect(service.ensureLoaded())
      .rejects.toBeInstanceOf(LocalBackupUiRestoreWriterPausedError);
    await expect(service.importPointers([{
      id: crypto.randomUUID(),
      taskId: crypto.randomUUID(),
      sourceType: 'siyuan-block',
      targetId: '20260727093000-abcdefg',
      uri: 'siyuan://blocks/20260727093000-abcdefg',
      label: 'Restore guard',
      hpath: '/Restore guard',
      role: 'reference',
      sortOrder: 0,
      deletedAt: null,
      createdAt: '2026-07-27T00:00:00.000Z',
      updatedAt: '2026-07-27T00:00:00.000Z',
    }])).rejects.toBeInstanceOf(LocalBackupUiRestoreWriterPausedError);
    expect(clientAsync).not.toHaveBeenCalled();
    await handle.abortBeforeMutation();
  });
});
