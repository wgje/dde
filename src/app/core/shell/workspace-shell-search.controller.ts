import type { WritableSignal } from '@angular/core';
import type { UiStateService } from '../../../services/ui-state.service';

const SEARCH_DEBOUNCE_DELAY_MS = 300;

type WorkspaceShellSearchUiState = Pick<
  UiStateService,
  'projectSearchQuery' | 'searchQuery' | 'clearSearch'
>;

export function readWorkspaceTextInputValue(event: Event | string): string {
  if (typeof event === 'string') return event;
  const target = event.target as { value?: unknown } | null;
  return typeof target?.value === 'string' ? target.value : '';
}

/** Coordinates the workspace shell's unified search input and debounce. */
export class WorkspaceShellSearchController {
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private debounceGeneration = 0;

  constructor(
    private readonly uiState: WorkspaceShellSearchUiState,
    private readonly unifiedSearchQuery: WritableSignal<string>,
  ) {}

  update(query: string): void {
    this.unifiedSearchQuery.set(query);

    this.cancelDebounceTimer();

    const generation = ++this.debounceGeneration;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    try {
      debounceTimer = setTimeout(() => {
        if (generation !== this.debounceGeneration || this.debounceTimer !== debounceTimer) {
          return;
        }

        this.applySearchQuery(query);
        this.debounceTimer = null;
      }, SEARCH_DEBOUNCE_DELAY_MS);
      this.debounceTimer = debounceTimer;
    } catch {
      if (generation === this.debounceGeneration) {
        this.debounceTimer = null;
        this.applySearchQuery(query);
      }
    }
  }

  clear(): void {
    this.unifiedSearchQuery.set('');
    this.cleanup();
    this.uiState.clearSearch();
  }

  hasActiveQuery(): boolean {
    return this.unifiedSearchQuery().trim().length > 0
      || this.uiState.searchQuery().trim().length > 0
      || this.uiState.projectSearchQuery().trim().length > 0;
  }

  cleanup(): void {
    this.cancelDebounceTimer();
  }

  private cancelDebounceTimer(): void {
    const debounceTimer = this.debounceTimer;
    this.debounceTimer = null;
    this.debounceGeneration += 1;
    if (debounceTimer === null) return;

    try {
      clearTimeout(debounceTimer);
    } catch {
      // Stale debounce callbacks are invalidated by generation before cleanup.
    }
  }

  private applySearchQuery(query: string): void {
    this.uiState.projectSearchQuery.set(query);
    this.uiState.searchQuery.set(query);
  }
}
