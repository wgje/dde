import { Injector } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
import {
  WORKSPACE_STARTUP_ASSET_LOADER,
  type WorkspaceStartupAssetLoader,
  WorkspaceStartupPreloaderService,
} from './workspace-startup-preloader.service';

describe('WorkspaceStartupPreloaderService', () => {
  it('should preload workspace shell first and defer project shell until loader handoff', async () => {
    const loader: WorkspaceStartupAssetLoader = {
      preloadWorkspaceShell: vi.fn().mockResolvedValue(undefined),
      preloadProjectShell: vi.fn().mockResolvedValue(undefined),
    };

    const injector = Injector.create({
      providers: [
        { provide: WORKSPACE_STARTUP_ASSET_LOADER, useValue: loader },
        { provide: WorkspaceStartupPreloaderService, useClass: WorkspaceStartupPreloaderService },
      ],
    });
    const service = injector.get(WorkspaceStartupPreloaderService);

    service.start();
    await Promise.resolve();
    service.start();

    expect(loader.preloadWorkspaceShell).toHaveBeenCalledTimes(1);
    expect(loader.preloadProjectShell).not.toHaveBeenCalled();
    expect(service.routeShellsReady()).toBe(false);

    await service.continueAfterLoaderHidden();
    await service.continueAfterLoaderHidden();

    expect(loader.preloadWorkspaceShell).toHaveBeenCalledTimes(1);
    expect(loader.preloadProjectShell).toHaveBeenCalledTimes(1);
    // styles.css 已恢复到静态构建，workspaceStylesReady 始终为 true
    expect(service.workspaceStylesReady()).toBe(true);
    expect(service.routeShellsReady()).toBe(true);
  });
});
