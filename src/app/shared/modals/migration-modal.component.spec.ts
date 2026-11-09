import { Injector, runInInjectionContext, signal } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthService } from '../../../services/auth.service';
import { LoggerService } from '../../../services/logger.service';
import {
  MigrationService,
  type MigrationResult,
} from '../../../services/migration.service';
import { ToastService } from '../../../services/toast.service';
import { MigrationModalComponent } from './migration-modal.component';

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(res => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('MigrationModalComponent', () => {
  let component: MigrationModalComponent;
  let executeMigration: ReturnType<typeof vi.fn>;
  let toastError: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    executeMigration = vi.fn();
    toastError = vi.fn();
    const migrationService = {
      showMigrationDialog: signal(true),
      getMigrationSummary: vi.fn(() => ({
        localCount: 1,
        remoteCount: 0,
        localOnlyCount: 1,
        conflictCount: 0,
      })),
      executeMigration,
    } as unknown as MigrationService;
    const injector = Injector.create({
      providers: [
        { provide: MigrationService, useValue: migrationService },
        { provide: AuthService, useValue: { currentUserId: vi.fn(() => 'user-1') } },
        { provide: ToastService, useValue: { error: toastError } },
        { provide: LoggerService, useValue: { error: vi.fn() } },
      ],
    });

    component = runInInjectionContext(injector, () => new MigrationModalComponent());
  });

  it('keeps processing state independent from dialog visibility', () => {
    expect(component.isProcessing()).toBe(false);
  });

  it('blocks close and duplicate execution until the active migration settles', async () => {
    const deferred = createDeferred<MigrationResult>();
    executeMigration.mockReturnValueOnce(deferred.promise);
    component.selectedStrategy = 'merge';
    const closeSpy = vi.fn();
    const migratedSpy = vi.fn();
    component.close.subscribe(closeSpy);
    component.migrated.subscribe(migratedSpy);

    const migration = component.executeMigration();
    expect(component.isProcessing()).toBe(true);

    component.requestClose();
    void component.executeMigration();

    expect(closeSpy).not.toHaveBeenCalled();
    expect(executeMigration).toHaveBeenCalledTimes(1);

    deferred.resolve({ success: true, migratedProjects: 1, strategy: 'merge' });
    await migration;

    expect(migratedSpy).toHaveBeenCalledTimes(1);
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(component.isProcessing()).toBe(false);
  });

  it('ignores a late failed settlement after destroy', async () => {
    const deferred = createDeferred<MigrationResult>();
    executeMigration.mockReturnValueOnce(deferred.promise);
    component.selectedStrategy = 'keep-local';
    const closeSpy = vi.fn();
    component.close.subscribe(closeSpy);

    const migration = component.executeMigration();
    component.ngOnDestroy();
    deferred.resolve({
      success: false,
      migratedProjects: 0,
      strategy: 'keep-local',
      error: 'remote unavailable',
    });
    await migration;

    expect(component.errorMessage()).toBeNull();
    expect(toastError).not.toHaveBeenCalled();
    expect(closeSpy).not.toHaveBeenCalled();
  });

  it('emits close while idle', () => {
    const closeSpy = vi.fn();
    component.close.subscribe(closeSpy);

    component.requestClose();

    expect(closeSpy).toHaveBeenCalledTimes(1);
  });
});
