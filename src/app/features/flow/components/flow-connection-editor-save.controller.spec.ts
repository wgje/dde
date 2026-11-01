import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConnectionEditorSaveContext } from './flow-connection-editor.helpers';

type ControllerModule = typeof import('./flow-connection-editor-save.controller');
type ControllerOptions = ConstructorParameters<ControllerModule['FlowConnectionEditorSaveController']>[0];

describe('FlowConnectionEditorSaveController', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function createHarness(overrides: Partial<ControllerOptions> = {}) {
    const { FlowConnectionEditorSaveController } = await import('./flow-connection-editor-save.controller');
    const activeSessionContext: ConnectionEditorSaveContext = {
      sourceId: 'source-1',
      targetId: 'target-1',
      title: 'Before',
      description: 'Before description',
    };
    let saveTimer: ReturnType<typeof setTimeout> | null = null;
    const options: ControllerOptions = {
      close: vi.fn(),
      debug: vi.fn(),
      getActiveSessionContext: vi.fn(() => activeSessionContext),
      getNow: vi.fn(() => 1200),
      getSaveTimer: vi.fn(() => saveTimer),
      isComposing: vi.fn(() => false),
      isDestroyed: vi.fn(() => false),
      isEditMode: vi.fn(() => false),
      queueCompositionAction: vi.fn(),
      refocusInput: vi.fn(),
      saveContent: vi.fn(),
      setSaveTimer: vi.fn((timer: ReturnType<typeof setTimeout> | null) => {
        saveTimer = timer;
      }),
      setIgnoreOutsideUntil: vi.fn(),
      syncEditorStateFromDom: vi.fn(),
    };
    Object.assign(options, overrides);

    return {
      activeSessionContext,
      controller: new FlowConnectionEditorSaveController(options),
      options,
    };
  }

  it('saveAndClose marks the close request, saves the active context, and closes once', async () => {
    const { activeSessionContext, controller, options } = await createHarness();

    controller.saveAndClose();
    controller.saveAndClose();

    expect(controller.isCloseRequested()).toBe(true);
    expect(options.setIgnoreOutsideUntil).toHaveBeenCalledOnce();
    expect(options.setIgnoreOutsideUntil).toHaveBeenCalledWith(1450);
    expect(options.saveContent).toHaveBeenCalledTimes(1);
    expect(options.saveContent).toHaveBeenCalledWith(activeSessionContext);
    expect(options.close).toHaveBeenCalledTimes(1);
  });

  it('saveAndClose queues composition work instead of saving immediately while composing', async () => {
    const { controller, options } = await createHarness({
      isComposing: vi.fn(() => true),
    });

    controller.saveAndClose();

    expect(controller.isCloseRequested()).toBe(true);
    expect(options.syncEditorStateFromDom).toHaveBeenCalled();
    expect(options.debug).toHaveBeenCalledWith('IME 输入中，等待 compositionend 后保存并关闭');
    expect(options.queueCompositionAction).toHaveBeenCalledWith('save-and-close');
    expect(options.saveContent).not.toHaveBeenCalled();
    expect(options.close).not.toHaveBeenCalled();
  });

  it('persistCurrentEdits cancels a pending debounced save before saving immediately', async () => {
    const { activeSessionContext, controller, options } = await createHarness();

    controller.scheduleDebouncedSave();
    controller.persistCurrentEdits(activeSessionContext);
    vi.advanceTimersByTime(500);

    expect(options.saveContent).toHaveBeenCalledTimes(1);
    expect(options.saveContent).toHaveBeenCalledWith(activeSessionContext);
  });

  it('scheduleDebouncedSave only emits once after the debounce window', async () => {
    const { controller, options } = await createHarness();

    controller.scheduleDebouncedSave();
    controller.scheduleDebouncedSave();
    vi.advanceTimersByTime(499);

    expect(options.saveContent).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);

    expect(options.saveContent).toHaveBeenCalledTimes(1);
    expect(options.saveContent).toHaveBeenCalledWith();
  });

  it('skips a debounced save that reaches the timer while composing', async () => {
    let composing = false;
    const { controller, options } = await createHarness({
      isComposing: vi.fn(() => composing),
    });

    controller.scheduleDebouncedSave();
    composing = true;
    vi.advanceTimersByTime(500);

    expect(options.saveContent).not.toHaveBeenCalled();
  });

  it('flushes a debounced DOM draft on destroy after composition defers the timer', async () => {
    const visibleDomDraft = 'Visible IME draft';
    let syncedDraft = 'Before';
    const persistedDrafts: string[] = [];
    const syncEditorStateFromDom = vi.fn(() => {
      syncedDraft = visibleDomDraft;
    });
    const saveContent = vi.fn(() => {
      syncEditorStateFromDom();
      persistedDrafts.push(syncedDraft);
    });
    const { activeSessionContext, controller } = await createHarness({
      isComposing: vi.fn(() => true),
      saveContent,
      syncEditorStateFromDom,
    });

    controller.scheduleDebouncedSave();
    vi.advanceTimersByTime(500);

    expect(saveContent).not.toHaveBeenCalled();

    controller.flushPendingSaveOnDestroy(activeSessionContext);

    expect(syncEditorStateFromDom).toHaveBeenCalledOnce();
    expect(saveContent).toHaveBeenCalledOnce();
    expect(saveContent).toHaveBeenCalledWith(activeSessionContext);
    expect(persistedDrafts).toEqual([visibleDomDraft]);
  });

  it('flushPendingSaveOnDestroy flushes pending work and swallows save failures', async () => {
    const { activeSessionContext, controller } = await createHarness({
      saveContent: vi.fn(() => {
        throw new Error('save failed');
      }),
    });

    controller.scheduleDebouncedSave();

    expect(() => controller.flushPendingSaveOnDestroy(activeSessionContext)).not.toThrow();
  });

  it('resumeAfterSaveFailure clears the close request and refocuses in edit mode', async () => {
    const { controller, options } = await createHarness({
      isEditMode: vi.fn(() => true),
    });

    controller.saveAndClose();
    controller.resumeAfterSaveFailure();

    expect(controller.isCloseRequested()).toBe(false);
    expect(options.setIgnoreOutsideUntil).toHaveBeenLastCalledWith(0);
    expect(options.refocusInput).toHaveBeenCalledTimes(1);
  });
});
