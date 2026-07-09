import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createWorkspaceShellSidebarResizeDeferred,
  createWorkspaceShellSidebarResizeMouseEvent,
  createWorkspaceShellSidebarResizeDelegate,
  flushWorkspaceShellSidebarResizeMicrotasks,
} from './workspace-shell-sidebar-resize.spec-helpers';

describe('workspace shell sidebar resize spec helpers', () => {
  it('creates mouse events that track preventDefault calls', () => {
    const event = createWorkspaceShellSidebarResizeMouseEvent();

    expect(event.defaultPrevented).toBe(false);

    event.preventDefault();

    expect(event.defaultPrevented).toBe(true);
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });

  it('creates stateful resize delegates for controller specs', () => {
    const record: string[] = [];
    const delegate = createWorkspaceShellSidebarResizeDelegate(record);
    const event = createWorkspaceShellSidebarResizeMouseEvent();

    expect(delegate.isResizingAny()).toBe(false);

    delegate.startSidebarResize(event);
    delegate.onMouseUp();
    delegate.startContentResize(event);
    delegate.teardown();

    expect(delegate.isResizingAny()).toBe(false);
    expect(record).toEqual([
      'startSidebarResize',
      'onMouseUp',
      'startContentResize',
      'teardown',
    ]);
  });

  it('creates deferred promises and flushes resize microtasks', async () => {
    const deferred = createWorkspaceShellSidebarResizeDeferred<string>();

    deferred.resolve('loaded');
    await flushWorkspaceShellSidebarResizeMicrotasks();

    await expect(deferred.promise).resolves.toBe('loaded');
  });

  it('keeps sidebar resize controller specs on the shared helper API', () => {
    const interactionHostSpec = readFileSync(
      join(__dirname, 'workspace-shell-interaction-sidebar-resize-host.factory.spec.ts'),
      'utf8',
    );

    expect(interactionHostSpec).toContain(
      'createWorkspaceShellSidebarResizeMouseEvent',
    );
    expect(interactionHostSpec).toContain(
      'flushWorkspaceShellSidebarResizeMicrotasks',
    );
    expect(interactionHostSpec).not.toContain('function createMouseEvent');
    expect(interactionHostSpec).not.toContain('function flushMicrotasks');
  });
});
