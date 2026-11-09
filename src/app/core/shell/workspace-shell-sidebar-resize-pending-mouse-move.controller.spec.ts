import { describe, expect, it, vi } from 'vitest';

interface PendingMouseMoveController {
  clear(): void;
  flush(action: (event: MouseEvent) => void): void;
  queue(event: MouseEvent): void;
}

describe('WorkspaceShellSidebarResizePendingMouseMoveController', () => {
  it('keeps only the latest event and clears it before flushing', async () => {
    const modulePath = './workspace-shell-sidebar-resize-pending-mouse-move.controller';
    const controllerModule = await import(/* @vite-ignore */ modulePath)
      .catch(() => ({}));
    const Controller = Reflect.get(
      controllerModule,
      'WorkspaceShellSidebarResizePendingMouseMoveController',
    ) as (new () => PendingMouseMoveController) | undefined;

    expect(Controller).toEqual(expect.any(Function));

    const controller = new Controller!();
    const first = new MouseEvent('mousemove', { clientX: 1 });
    const latest = new MouseEvent('mousemove', { clientX: 2 });
    const action = vi.fn(() => controller.flush(action));

    controller.queue(first);
    controller.queue(latest);
    controller.flush(action);

    expect(action).toHaveBeenCalledTimes(1);
    expect(action).toHaveBeenCalledWith(latest);

    controller.queue(first);
    controller.clear();
    controller.flush(action);
    expect(action).toHaveBeenCalledTimes(1);
  });
});
