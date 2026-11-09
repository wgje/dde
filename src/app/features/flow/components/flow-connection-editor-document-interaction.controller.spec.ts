import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ConnectionEditorDocumentInteractionContext } from './flow-connection-editor.helpers';
import { FlowConnectionEditorDocumentInteractionController } from './flow-connection-editor-document-interaction.controller';

function createHarness() {
  let editMode = true;
  let composing = false;
  let destroyed = false;
  let closeRequested = false;
  let sessionKey: string | null = 'session-a';
  let interaction: ConnectionEditorDocumentInteractionContext | null = {
    clickedInside: true,
    isInteractiveElement: false,
  };
  const debug = vi.fn();
  const exitEditMode = vi.fn();
  const queueCompositionAction = vi.fn();
  const saveAndClose = vi.fn();
  const controller = new FlowConnectionEditorDocumentInteractionController({
    closeRequested: () => closeRequested,
    currentSessionKey: () => sessionKey,
    debug,
    exitEditMode,
    isComposing: () => composing,
    isDestroyed: () => destroyed,
    isEditMode: () => editMode,
    queueCompositionAction,
    resolveInteraction: () => interaction,
    saveAndClose,
  });

  return {
    controller,
    debug,
    exitEditMode,
    queueCompositionAction,
    saveAndClose,
    setCloseRequested: (value: boolean) => {
      closeRequested = value;
    },
    setComposing: (value: boolean) => {
      composing = value;
    },
    setDestroyed: (value: boolean) => {
      destroyed = value;
    },
    setEditMode: (value: boolean) => {
      editMode = value;
    },
    setInteraction: (value: ConnectionEditorDocumentInteractionContext | null) => {
      interaction = value;
    },
    setSessionKey: (value: string | null) => {
      sessionKey = value;
    },
  };
}

describe('FlowConnectionEditorDocumentInteractionController', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps edit mode for interactive elements', () => {
    const { controller, exitEditMode, saveAndClose, setInteraction } = createHarness();
    setInteraction({ clickedInside: true, isInteractiveElement: true });

    controller.handleClick(document.createElement('button'));

    expect(exitEditMode).not.toHaveBeenCalled();
    expect(saveAndClose).not.toHaveBeenCalled();
  });

  it('exits edit mode for a blank click inside the editor', () => {
    const { controller, exitEditMode } = createHarness();

    controller.handleClick(document.createElement('div'));

    expect(exitEditMode).toHaveBeenCalledTimes(1);
  });

  it('queues an inside click while IME composition is active', () => {
    const { controller, exitEditMode, queueCompositionAction, setComposing } = createHarness();
    setComposing(true);

    controller.handleClick(document.createElement('div'));

    expect(queueCompositionAction).toHaveBeenCalledWith('exit-edit');
    expect(exitEditMode).not.toHaveBeenCalled();
  });

  it('saves and closes for an outside click in edit or preview mode', () => {
    const { controller, saveAndClose, setEditMode, setInteraction } = createHarness();
    setInteraction({ clickedInside: false, isInteractiveElement: false });

    controller.handleClick(document.body);
    setEditMode(false);
    controller.handleClick(document.body);

    expect(saveAndClose).toHaveBeenCalledTimes(2);
  });

  it('delays touch exit and drops it when the session changes', async () => {
    vi.useFakeTimers();
    const { controller, exitEditMode, setSessionKey } = createHarness();

    controller.handleTouchStart(document.createElement('div'));
    setSessionKey('session-b');
    await vi.advanceTimersByTimeAsync(50);

    expect(exitEditMode).not.toHaveBeenCalled();

    controller.handleTouchStart(document.createElement('div'));
    await vi.advanceTimersByTimeAsync(50);
    expect(exitEditMode).toHaveBeenCalledTimes(1);
  });

  it('ignores touch handling after destroy or close request', async () => {
    vi.useFakeTimers();
    const {
      controller,
      exitEditMode,
      setCloseRequested,
      setDestroyed,
    } = createHarness();

    setDestroyed(true);
    controller.handleTouchStart(document.createElement('div'));
    setDestroyed(false);
    controller.handleTouchStart(document.createElement('div'));
    setCloseRequested(true);
    await vi.advanceTimersByTimeAsync(50);

    expect(exitEditMode).not.toHaveBeenCalled();
  });
});
