import type { DestroyRef, Injector } from '@angular/core';
import { NavigationEnd } from '@angular/router';
import { Subject } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';

import { LocalBackupService } from '../../../services/local-backup.service';
import {
  ProjectShellLifecycleController,
} from './project-shell-lifecycle.controller';

function createContext() {
  const events = new Subject<unknown>();
  let destroySubscription: () => void = () => undefined;
  const destroyRef = {
    onDestroy: vi.fn((callback: () => void) => {
      destroySubscription = callback;
      return () => undefined;
    }),
  } as unknown as DestroyRef;
  const localBackup = {
    setProjectsProvider: vi.fn(),
  };
  const injector = {
    get: vi.fn((token: unknown) => {
      if (token === LocalBackupService) return localBackup;
      throw new Error('unexpected injector token');
    }),
  } as unknown as Injector;
  const routeController = {
    handleRouteChange: vi.fn(),
    destroy: vi.fn(),
  };
  const textViewSwipe = { destroy: vi.fn() };
  const contentResize = { cleanup: vi.fn() };
  const projects = [{
    id: 'project-1',
    name: 'Project 1',
    tasks: [],
    connections: [],
  }];

  return {
    contentResize,
    destroyRef,
    destroySubscription: () => destroySubscription(),
    events,
    injector,
    localBackup,
    projects,
    routeController,
    textViewSwipe,
  };
}

describe('ProjectShellLifecycleController', () => {
  it('registers the backup provider and tracks navigation until destroy', () => {
    const context = createContext();
    const controller = new ProjectShellLifecycleController({
      contentResize: context.contentResize,
      destroyRef: context.destroyRef,
      getProjects: () => context.projects,
      injector: context.injector,
      routeController: context.routeController,
      routerEvents: context.events,
      textViewSwipe: context.textViewSwipe,
    });

    expect(context.injector.get).not.toHaveBeenCalled();

    controller.initialize();

    expect(context.localBackup.setProjectsProvider).toHaveBeenCalledOnce();
    const provider = context.localBackup.setProjectsProvider.mock.calls[0]?.[0];
    expect(provider()).toBe(context.projects);
    expect(context.routeController.handleRouteChange).toHaveBeenCalledOnce();

    context.events.next({ type: 'other' });
    context.events.next(new NavigationEnd(1, '/before', '/after'));
    expect(context.routeController.handleRouteChange).toHaveBeenCalledTimes(2);

    context.destroySubscription();
    context.events.next(new NavigationEnd(2, '/after', '/final'));
    expect(context.routeController.handleRouteChange).toHaveBeenCalledTimes(2);
  });

  it('destroys child controllers in the existing order', () => {
    const context = createContext();
    const order: string[] = [];
    context.textViewSwipe.destroy.mockImplementation(() => order.push('swipe'));
    context.routeController.destroy.mockImplementation(() => order.push('route'));
    context.contentResize.cleanup.mockImplementation(() => order.push('resize'));
    const controller = new ProjectShellLifecycleController({
      contentResize: context.contentResize,
      destroyRef: context.destroyRef,
      getProjects: () => context.projects,
      injector: context.injector,
      routeController: context.routeController,
      routerEvents: context.events,
      textViewSwipe: context.textViewSwipe,
    });

    controller.destroy();

    expect(order).toEqual(['swipe', 'route', 'resize']);
  });
});
