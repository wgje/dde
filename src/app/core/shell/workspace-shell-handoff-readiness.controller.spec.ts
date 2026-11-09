import { describe, expect, it, vi } from 'vitest';

import {
  WorkspaceShellHandoffReadinessController,
  type WorkspaceShellHandoffReadinessControllerOptions,
} from './workspace-shell-handoff-readiness.controller';

function createController(
  overrides: Partial<WorkspaceShellHandoffReadinessControllerOptions> = {},
) {
  let snapshotHandoffEnabled = true;
  let workspaceHandoffReady = true;
  const markWorkspaceHandoffReady = vi.fn();
  const markLayoutStable = vi.fn();
  const noteLoaderHidden = vi.fn();
  const markHandoffReady = vi.fn();
  const markApplicationReady = vi.fn();
  const flushWidgetWorkspaceGateRecheck = vi.fn();
  const documentRef = document;
  const controller = new WorkspaceShellHandoffReadinessController({
    isSnapshotHandoffEnabled: () => snapshotHandoffEnabled,
    isWorkspaceHandoffReady: () => workspaceHandoffReady,
    markWorkspaceHandoffReady,
    markLayoutStable,
    getDocument: () => documentRef,
    noteLoaderHidden,
    markHandoffReady,
    markApplicationReady,
    flushWidgetWorkspaceGateRecheck,
    ...overrides,
  });

  return {
    controller,
    flushWidgetWorkspaceGateRecheck,
    markApplicationReady,
    markHandoffReady,
    markLayoutStable,
    markWorkspaceHandoffReady,
    noteLoaderHidden,
    setSnapshotHandoffEnabled: (value: boolean) => {
      snapshotHandoffEnabled = value;
    },
    setWorkspaceHandoffReady: (value: boolean) => {
      workspaceHandoffReady = value;
    },
  };
}

describe('WorkspaceShellHandoffReadinessController', () => {
  it('signals layout stability only once when snapshot handoff is enabled', () => {
    const { controller, markLayoutStable, markWorkspaceHandoffReady } = createController();

    controller.signalWorkspaceHandoffReady();
    controller.signalWorkspaceHandoffReady();

    expect(markLayoutStable).toHaveBeenCalledTimes(1);
    expect(markWorkspaceHandoffReady).not.toHaveBeenCalled();
  });

  it('marks workspace handoff ready directly when snapshot handoff is disabled', () => {
    const { controller, markLayoutStable, markWorkspaceHandoffReady, setSnapshotHandoffEnabled } = createController();
    setSnapshotHandoffEnabled(false);

    controller.signalWorkspaceHandoffReady();
    controller.signalWorkspaceHandoffReady();

    expect(markWorkspaceHandoffReady).toHaveBeenCalledTimes(1);
    expect(markLayoutStable).not.toHaveBeenCalled();
  });

  it('does not commit workspace handoff before boot stage is ready', () => {
    const { controller, markApplicationReady, setWorkspaceHandoffReady } = createController();
    setWorkspaceHandoffReady(false);

    controller.commitWorkspaceHandoffIfReady();

    expect(markApplicationReady).not.toHaveBeenCalled();
  });

  it('commits workspace handoff once and hides the initial loader', () => {
    const loader = document.createElement('div');
    loader.id = 'initial-loader';
    loader.style.display = 'flex';
    document.body.appendChild(loader);
    const {
      controller,
      flushWidgetWorkspaceGateRecheck,
      markApplicationReady,
      markHandoffReady,
      noteLoaderHidden,
    } = createController();

    try {
      controller.commitWorkspaceHandoffIfReady();
      controller.commitWorkspaceHandoffIfReady();

      expect(loader.style.display).toBe('none');
      expect(noteLoaderHidden).toHaveBeenCalledTimes(1);
      expect(markHandoffReady).toHaveBeenCalledTimes(1);
      expect(markApplicationReady).toHaveBeenCalledTimes(1);
      expect(flushWidgetWorkspaceGateRecheck).toHaveBeenCalledTimes(1);
    } finally {
      loader.remove();
    }
  });

  it('retries only the unfinished handoff commit step after widget gate flush fails', () => {
    const flushError = new Error('widget gate flush failed');
    const {
      controller,
      flushWidgetWorkspaceGateRecheck,
      markApplicationReady,
      markHandoffReady,
      noteLoaderHidden,
    } = createController();
    flushWidgetWorkspaceGateRecheck
      .mockImplementationOnce(() => {
        throw flushError;
      })
      .mockImplementationOnce(() => undefined);

    expect(() => controller.commitWorkspaceHandoffIfReady()).toThrow(flushError);
    expect(() => controller.commitWorkspaceHandoffIfReady()).not.toThrow();

    expect(noteLoaderHidden).toHaveBeenCalledTimes(1);
    expect(markHandoffReady).toHaveBeenCalledTimes(1);
    expect(markApplicationReady).toHaveBeenCalledTimes(1);
    expect(flushWidgetWorkspaceGateRecheck).toHaveBeenCalledTimes(2);
  });

  it('commits without a document in server-like environments', () => {
    const { controller, markApplicationReady } = createController({
      getDocument: () => undefined,
    });

    controller.commitWorkspaceHandoffIfReady();

    expect(markApplicationReady).toHaveBeenCalledTimes(1);
  });
});
