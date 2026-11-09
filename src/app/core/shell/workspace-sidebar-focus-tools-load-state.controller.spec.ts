import { Component, signal, type Type } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';

import {
  WorkspaceSidebarFocusToolsLoadStateController,
  type WorkspaceSidebarFocusTool,
} from './workspace-sidebar-focus-tools-load-state.controller';

@Component({ standalone: true, template: '' })
class FocusTriggerFixture {}

@Component({ standalone: true, template: '' })
class OtherFocusTriggerFixture {}

@Component({ standalone: true, template: '' })
class RecorderFixture {}

class UndecoratedCallableFixture {}

class InheritedUndecoratedFixture extends FocusTriggerFixture {}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

function createHarness(options: { recorderEnabled?: boolean } = {}) {
  const focusComponent = signal<Type<unknown> | null>(null);
  const recorderComponent = signal<Type<unknown> | null>(null);
  const onToolsIntent = vi.fn();
  const loadFocusSessionTrigger = vi.fn<() => Promise<unknown>>();
  const loadBlackBoxRecorder = vi.fn<() => Promise<unknown>>();
  const controller = new WorkspaceSidebarFocusToolsLoadStateController({
    onToolsIntent,
    isBlackBoxEnabled: () => options.recorderEnabled ?? true,
    loadFocusSessionTrigger,
    loadBlackBoxRecorder,
    getFocusSessionTriggerComponent: focusComponent,
    getBlackBoxRecorderComponent: recorderComponent,
  });

  return {
    controller,
    focusComponent,
    loadBlackBoxRecorder,
    loadFocusSessionTrigger,
    onToolsIntent,
    recorderComponent,
  };
}

const FOCUS: WorkspaceSidebarFocusTool = 'FOCUS_SESSION_TRIGGER';
const RECORDER: WorkspaceSidebarFocusTool = 'BLACK_BOX_RECORDER';

describe('WorkspaceSidebarFocusToolsLoadStateController', () => {
  it('starts both tools in independent idle attempt zero states', () => {
    const { controller } = createHarness();

    expect(controller.state(FOCUS)).toEqual({ phase: 'idle', attempt: 0 });
    expect(controller.state(RECORDER)).toEqual({ phase: 'idle', attempt: 0 });
  });

  it('deduplicates loading calls for one attempt', async () => {
    const load = deferred<unknown>();
    const { controller, focusComponent, loadFocusSessionTrigger } = createHarness();
    loadFocusSessionTrigger.mockReturnValue(load.promise);

    const first = controller.activate(FOCUS);
    const second = controller.activate(FOCUS);

    expect(first).toBe(second);
    expect(controller.state(FOCUS)).toEqual({ phase: 'loading', attempt: 0 });
    expect(loadFocusSessionTrigger).toHaveBeenCalledOnce();

    focusComponent.set(FocusTriggerFixture);
    load.resolve(FocusTriggerFixture);
    await first;
    expect(controller.state(FOCUS)).toEqual({ phase: 'ready', attempt: 0 });
  });

  it.each([
    ['null result', null, null],
    ['undefined result', undefined, null],
    ['invalid result', { component: 'invalid' }, null],
    ['callable non-component', UndecoratedCallableFixture, UndecoratedCallableFixture],
    ['inherited component metadata', InheritedUndecoratedFixture, InheritedUndecoratedFixture],
    ['missing current component', FocusTriggerFixture, null],
    ['mismatched current component', FocusTriggerFixture, OtherFocusTriggerFixture],
  ])('fails a resolved load with %s', async (_name, resolved, current) => {
    const { controller, focusComponent, loadFocusSessionTrigger } = createHarness();
    focusComponent.set(current as Type<unknown> | null);
    loadFocusSessionTrigger.mockResolvedValue(resolved);

    await controller.activate(FOCUS);

    expect(controller.state(FOCUS)).toEqual({ phase: 'failed', attempt: 0 });
  });

  it('fails rejected loads and increments only a real failed retry', async () => {
    const { controller, focusComponent, loadFocusSessionTrigger } = createHarness();
    loadFocusSessionTrigger.mockRejectedValueOnce(new Error('chunk failed'));

    await controller.activate(FOCUS);
    expect(controller.state(FOCUS)).toEqual({ phase: 'failed', attempt: 0 });

    focusComponent.set(FocusTriggerFixture);
    loadFocusSessionTrigger.mockResolvedValueOnce(FocusTriggerFixture);
    await controller.activate(FOCUS);

    expect(controller.state(FOCUS)).toEqual({ phase: 'ready', attempt: 1 });
    expect(loadFocusSessionTrigger).toHaveBeenCalledTimes(2);
  });

  it('preserves intent behavior while keeping disabled recorder unloaded', async () => {
    const {
      controller,
      focusComponent,
      loadBlackBoxRecorder,
      loadFocusSessionTrigger,
      onToolsIntent,
    } = createHarness({ recorderEnabled: false });
    focusComponent.set(FocusTriggerFixture);
    loadFocusSessionTrigger.mockResolvedValue(FocusTriggerFixture);

    controller.onToolsIntent();
    await controller.activate(FOCUS);

    expect(onToolsIntent).toHaveBeenCalledOnce();
    expect(loadFocusSessionTrigger).toHaveBeenCalledOnce();
    expect(loadBlackBoxRecorder).not.toHaveBeenCalled();
    expect(controller.state(RECORDER)).toEqual({ phase: 'idle', attempt: 0 });
  });

  it('loads and settles enabled tools independently', async () => {
    const {
      controller,
      focusComponent,
      loadBlackBoxRecorder,
      loadFocusSessionTrigger,
      recorderComponent,
    } = createHarness();
    focusComponent.set(FocusTriggerFixture);
    recorderComponent.set(RecorderFixture);
    loadFocusSessionTrigger.mockResolvedValue(FocusTriggerFixture);
    loadBlackBoxRecorder.mockResolvedValue(RecorderFixture);

    controller.onToolsIntent();
    await Promise.all([controller.activate(FOCUS), controller.activate(RECORDER)]);

    expect(controller.state(FOCUS).phase).toBe('ready');
    expect(controller.state(RECORDER).phase).toBe('ready');
  });

  it('never publishes focus for hover-only preloading', async () => {
    const { controller, focusComponent, loadFocusSessionTrigger } = createHarness();
    focusComponent.set(FocusTriggerFixture);
    loadFocusSessionTrigger.mockResolvedValue(FocusTriggerFixture);

    controller.onToolsIntent();
    await controller.activate(FOCUS);

    expect(controller.consumeFocusHandoff(FOCUS, 0)).toBe(false);
  });

  it('consumes one exact focused ready handoff and revalidates component identity', async () => {
    const { controller, focusComponent, loadFocusSessionTrigger } = createHarness();
    focusComponent.set(FocusTriggerFixture);
    loadFocusSessionTrigger.mockResolvedValue(FocusTriggerFixture);
    controller.setFallbackFocused(FOCUS, true);

    await controller.activate(FOCUS);

    expect(controller.consumeFocusHandoff(FOCUS, 1)).toBe(false);
    expect(controller.consumeFocusHandoff(RECORDER, 0)).toBe(false);
    expect(controller.consumeFocusHandoff(FOCUS, 0)).toBe(true);
    expect(controller.consumeFocusHandoff(FOCUS, 0)).toBe(false);

    controller.setFallbackFocused(FOCUS, true);
    focusComponent.set(OtherFocusTriggerFixture);
    expect(controller.consumeFocusHandoff(FOCUS, 0)).toBe(false);
  });

  it('retires focus moved away before settlement', async () => {
    const load = deferred<unknown>();
    const { controller, focusComponent, loadFocusSessionTrigger } = createHarness();
    loadFocusSessionTrigger.mockReturnValue(load.promise);
    controller.setFallbackFocused(FOCUS, true);
    const activation = controller.activate(FOCUS);

    controller.setFallbackFocused(FOCUS, false);
    focusComponent.set(FocusTriggerFixture);
    load.resolve(FocusTriggerFixture);
    await activation;

    expect(controller.consumeFocusHandoff(FOCUS, 0)).toBe(false);
  });

  it('preserves replacement blur after exact readiness', async () => {
    const { controller, focusComponent, loadFocusSessionTrigger } = createHarness();
    focusComponent.set(FocusTriggerFixture);
    loadFocusSessionTrigger.mockResolvedValue(FocusTriggerFixture);
    controller.setFallbackFocused(FOCUS, true);

    await controller.activate(FOCUS);
    controller.setFallbackFocused(FOCUS, false, true);

    expect(controller.consumeFocusHandoff(FOCUS, 0)).toBe(true);
  });

  it('retires a user blur after readiness before replacement', async () => {
    const { controller, focusComponent, loadFocusSessionTrigger } = createHarness();
    focusComponent.set(FocusTriggerFixture);
    loadFocusSessionTrigger.mockResolvedValue(FocusTriggerFixture);
    controller.setFallbackFocused(FOCUS, true);

    await controller.activate(FOCUS);
    controller.setFallbackFocused(FOCUS, false);

    expect(controller.consumeFocusHandoff(FOCUS, 0)).toBe(false);
  });

  it('transfers a focused failed fallback lease to the retry attempt', async () => {
    const { controller, focusComponent, loadFocusSessionTrigger } = createHarness();
    loadFocusSessionTrigger.mockResolvedValueOnce(null);
    await controller.activate(FOCUS);
    controller.setFallbackFocused(FOCUS, true);
    focusComponent.set(FocusTriggerFixture);
    loadFocusSessionTrigger.mockResolvedValueOnce(FocusTriggerFixture);

    await controller.activate(FOCUS);

    expect(controller.consumeFocusHandoff(FOCUS, 0)).toBe(false);
    expect(controller.consumeFocusHandoff(FOCUS, 1)).toBe(true);
  });

  it('suppresses late state and focus publication after teardown', async () => {
    const load = deferred<unknown>();
    const { controller, focusComponent, loadFocusSessionTrigger } = createHarness();
    loadFocusSessionTrigger.mockReturnValue(load.promise);
    controller.setFallbackFocused(FOCUS, true);
    const activation = controller.activate(FOCUS);
    controller.teardown();

    focusComponent.set(FocusTriggerFixture);
    load.resolve(FocusTriggerFixture);
    await activation;

    expect(controller.state(FOCUS)).toEqual({ phase: 'loading', attempt: 0 });
    expect(controller.consumeFocusHandoff(FOCUS, 0)).toBe(false);
    await controller.activate(FOCUS);
    expect(loadFocusSessionTrigger).toHaveBeenCalledOnce();
  });
});
