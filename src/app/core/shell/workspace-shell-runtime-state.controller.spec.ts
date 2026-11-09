import { describe, expect, it } from 'vitest';

import { WorkspaceShellRuntimeStateController } from './workspace-shell-runtime-state.controller';

describe('WorkspaceShellRuntimeStateController', () => {
  it('tracks the shell destroyed state behind a runtime delegate', () => {
    const runtimeState = new WorkspaceShellRuntimeStateController();

    expect(runtimeState.destroyed()).toBe(false);

    runtimeState.markDestroyed();

    expect(runtimeState.destroyed()).toBe(true);
  });

  it('exposes stable delegates for shell surface wiring', () => {
    const runtimeState = new WorkspaceShellRuntimeStateController();
    const destroyed = runtimeState.destroyedDelegate;
    const markDestroyed = runtimeState.markDestroyedDelegate;

    expect(destroyed()).toBe(false);

    markDestroyed();

    expect(destroyed()).toBe(true);
    expect(runtimeState.destroyedDelegate).toBe(destroyed);
    expect(runtimeState.markDestroyedDelegate).toBe(markDestroyed);
  });
});
