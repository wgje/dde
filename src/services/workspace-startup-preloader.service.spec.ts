import { Injector } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
import {
  WORKSPACE_STARTUP_ASSET_LOADER,
  type WorkspaceStartupAssetLoader,
  WorkspaceStartupPreloaderService,
} from './workspace-startup-preloader.service';

describe('WorkspaceStartupPreloaderService', () => {
  it('should preload styles and route shells only once', async () => {
    const loader: WorkspaceStartupAssetLoader = {
      loadWorkspaceStyles: vi.fn().mockResolvedValue(undefined),
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
    await Promise.all([service.preloadWorkspaceStyles(), service.preloadRouteShells()]);
    service.start();
    await Promise.all([service.preloadWorkspaceStyles(), service.preloadRouteShells()]);

    expect(loader.loadWorkspaceStyles).toHaveBeenCalledTimes(1);
    expect(loader.preloadWorkspaceShell).toHaveBeenCalledTimes(1);
    expect(loader.preloadProjectShell).toHaveBeenCalledTimes(1);
    expect(service.workspaceStylesReady()).toBe(true);
    expect(service.routeShellsReady()).toBe(true);
  });
});
