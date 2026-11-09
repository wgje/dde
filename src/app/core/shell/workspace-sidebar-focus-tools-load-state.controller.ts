import {
  reflectComponentType,
  signal,
  type Type,
  type WritableSignal,
} from '@angular/core';

export type WorkspaceSidebarFocusTool =
  | 'FOCUS_SESSION_TRIGGER'
  | 'BLACK_BOX_RECORDER';

export type WorkspaceSidebarFocusToolsLoadPhase =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'failed';

export interface WorkspaceSidebarFocusToolsLoadState {
  readonly phase: WorkspaceSidebarFocusToolsLoadPhase;
  readonly attempt: number;
}

export interface WorkspaceSidebarFocusToolsLoadStateControllerOptions {
  onToolsIntent: () => void;
  isBlackBoxEnabled: () => boolean;
  loadFocusSessionTrigger: () => Promise<unknown>;
  loadBlackBoxRecorder: () => Promise<unknown>;
  getFocusSessionTriggerComponent: () => Type<unknown> | null;
  getBlackBoxRecorderComponent: () => Type<unknown> | null;
}

interface FocusLease {
  readonly attempt: number;
  consumed: boolean;
}

interface ToolRecord {
  readonly stateSignal: WritableSignal<WorkspaceSidebarFocusToolsLoadState>;
  generation: number;
  promise: Promise<void> | null;
  readyComponent: Type<unknown> | null;
  fallbackFocused: boolean;
  focusLease: FocusLease | null;
  replacementBlurArmed: boolean;
}

function createToolRecord(): ToolRecord {
  return {
    stateSignal: signal({ phase: 'idle', attempt: 0 }),
    generation: 0,
    promise: null,
    readyComponent: null,
    fallbackFocused: false,
    focusLease: null,
    replacementBlurArmed: false,
  };
}

function isComponentType(value: unknown): value is Type<unknown> {
  if (typeof value !== 'function') return false;
  const component = value as Type<unknown>;
  return reflectComponentType(component)?.type === component;
}

export class WorkspaceSidebarFocusToolsLoadStateController {
  private readonly records: Record<WorkspaceSidebarFocusTool, ToolRecord> = {
    FOCUS_SESSION_TRIGGER: createToolRecord(),
    BLACK_BOX_RECORDER: createToolRecord(),
  };
  private tornDown = false;

  constructor(
    private readonly options: WorkspaceSidebarFocusToolsLoadStateControllerOptions,
  ) {}

  state(tool: WorkspaceSidebarFocusTool): WorkspaceSidebarFocusToolsLoadState {
    return this.records[tool].stateSignal();
  }

  onToolsIntent(): void {
    if (this.tornDown) return;

    this.options.onToolsIntent();
    void this.activate('FOCUS_SESSION_TRIGGER');
    if (this.options.isBlackBoxEnabled()) {
      void this.activate('BLACK_BOX_RECORDER');
    }
  }

  activate(tool: WorkspaceSidebarFocusTool): Promise<void> {
    if (this.tornDown) return Promise.resolve();

    const record = this.records[tool];
    const currentState = record.stateSignal();
    if (currentState.phase === 'loading' && record.promise) {
      return record.promise;
    }
    if (
      currentState.phase === 'ready'
      && record.readyComponent === this.currentComponent(tool)
    ) {
      return Promise.resolve();
    }

    const attempt = currentState.phase === 'failed'
      ? currentState.attempt + 1
      : currentState.attempt;
    if (record.fallbackFocused) {
      record.focusLease = { attempt, consumed: false };
    }
    record.readyComponent = null;
    record.replacementBlurArmed = false;
    record.stateSignal.set({ phase: 'loading', attempt });
    const generation = ++record.generation;

    let loadResult: Promise<unknown>;
    try {
      loadResult = this.load(tool)();
    } catch (error) {
      loadResult = Promise.reject(error);
    }

    const promise = Promise.resolve(loadResult)
      .then(
        component => this.settleResolved(tool, attempt, generation, component),
        () => this.settleFailed(tool, attempt, generation),
      )
      .finally(() => {
        if (record.promise === promise) {
          record.promise = null;
        }
      });
    record.promise = promise;
    return promise;
  }

  setFallbackFocused(
    tool: WorkspaceSidebarFocusTool,
    focused: boolean,
    replacementBlur = false,
  ): void {
    if (this.tornDown) return;

    const record = this.records[tool];
    const state = record.stateSignal();
    record.fallbackFocused = focused;
    if (focused) {
      record.focusLease = { attempt: state.attempt, consumed: false };
      return;
    }

    if (
      state.phase === 'ready'
      && record.replacementBlurArmed
      && replacementBlur
      && record.focusLease?.attempt === state.attempt
    ) {
      record.replacementBlurArmed = false;
      return;
    }
    record.focusLease = null;
    record.replacementBlurArmed = false;
  }

  consumeFocusHandoff(
    tool: WorkspaceSidebarFocusTool,
    attempt: number,
  ): boolean {
    if (this.tornDown) return false;

    const record = this.records[tool];
    const state = record.stateSignal();
    const lease = record.focusLease;
    if (
      state.phase !== 'ready'
      || state.attempt !== attempt
      || !lease
      || lease.attempt !== attempt
      || lease.consumed
      || !record.readyComponent
      || record.readyComponent !== this.currentComponent(tool)
    ) {
      return false;
    }

    lease.consumed = true;
    record.focusLease = null;
    record.replacementBlurArmed = false;
    return true;
  }

  teardown(): void {
    if (this.tornDown) return;
    this.tornDown = true;
    for (const record of Object.values(this.records)) {
      record.generation += 1;
      record.promise = null;
      record.focusLease = null;
      record.fallbackFocused = false;
      record.replacementBlurArmed = false;
    }
  }

  private settleResolved(
    tool: WorkspaceSidebarFocusTool,
    attempt: number,
    generation: number,
    component: unknown,
  ): void {
    if (!this.isCurrent(tool, attempt, generation)) return;

    const currentComponent = this.currentComponent(tool);
    if (
      !isComponentType(component)
      || !isComponentType(currentComponent)
      || component !== currentComponent
    ) {
      this.settleFailed(tool, attempt, generation);
      return;
    }

    const record = this.records[tool];
    record.readyComponent = currentComponent;
    record.stateSignal.set({ phase: 'ready', attempt });
    record.replacementBlurArmed = Boolean(
      record.fallbackFocused && record.focusLease?.attempt === attempt,
    );
  }

  private settleFailed(
    tool: WorkspaceSidebarFocusTool,
    attempt: number,
    generation: number,
  ): void {
    if (!this.isCurrent(tool, attempt, generation)) return;

    const record = this.records[tool];
    record.readyComponent = null;
    record.replacementBlurArmed = false;
    record.stateSignal.set({ phase: 'failed', attempt });
  }

  private isCurrent(
    tool: WorkspaceSidebarFocusTool,
    attempt: number,
    generation: number,
  ): boolean {
    if (this.tornDown) return false;
    const record = this.records[tool];
    const state = record.stateSignal();
    return record.generation === generation
      && state.phase === 'loading'
      && state.attempt === attempt;
  }

  private load(tool: WorkspaceSidebarFocusTool): () => Promise<unknown> {
    return tool === 'FOCUS_SESSION_TRIGGER'
      ? this.options.loadFocusSessionTrigger
      : this.options.loadBlackBoxRecorder;
  }

  private currentComponent(tool: WorkspaceSidebarFocusTool): Type<unknown> | null {
    return tool === 'FOCUS_SESSION_TRIGGER'
      ? this.options.getFocusSessionTriggerComponent()
      : this.options.getBlackBoxRecorderComponent();
  }
}
