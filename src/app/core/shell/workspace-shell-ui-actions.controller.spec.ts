import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { ThemeType } from '../../../models';

interface SignalSetter<T> {
  set(value: T): void;
}

interface UiActionsControllerOptions {
  preferenceService: {
    setTheme(theme: ThemeType): Promise<unknown> | unknown;
  };
  searchController: {
    clear(): void;
    update(query: string): void;
  };
  searchLazyLoad: {
    ensureLoaded(): void;
  };
  uiState: {
    filterMode: SignalSetter<string>;
    floatingWindowPref: SignalSetter<'auto' | 'fixed'>;
    layoutDirection: SignalSetter<'ltr' | 'rtl'>;
  };
}

interface UiActionsController {
  clearUnifiedSearch(): void;
  onUnifiedSearchChange(query: string): void;
  onUnifiedSearchInput(event: Event): void;
  updateFilter(event: Event): void;
  updateFloatPref(event: Event): void;
  updateLayoutDirection(event: Event): void;
  updateTheme(theme: ThemeType): void;
}

type UiActionsControllerConstructor = new (
  options: UiActionsControllerOptions,
) => UiActionsController;

async function loadController(): Promise<UiActionsControllerConstructor> {
  const modulePath = './workspace-shell-ui-actions.controller';
  const controllerModule = await import(/* @vite-ignore */ modulePath)
    .catch(() => ({}));
  const Controller = Reflect.get(
    controllerModule,
    'WorkspaceShellUiActionsController',
  ) as UiActionsControllerConstructor | undefined;

  expect(Controller).toEqual(expect.any(Function));
  return Controller!;
}

function inputEvent(value: string): Event {
  return { target: { value } } as unknown as Event;
}

function createContext(): {
  options: UiActionsControllerOptions;
  searchController: UiActionsControllerOptions['searchController'];
  searchLazyLoad: UiActionsControllerOptions['searchLazyLoad'];
  setTheme: ReturnType<typeof vi.fn>;
  uiState: UiActionsControllerOptions['uiState'];
} {
  const setTheme = vi.fn();
  const searchController = {
    update: vi.fn(),
    clear: vi.fn(),
  };
  const searchLazyLoad = {
    ensureLoaded: vi.fn(),
  };
  const uiState = {
    layoutDirection: { set: vi.fn() },
    floatingWindowPref: { set: vi.fn() },
    filterMode: { set: vi.fn() },
  };

  return {
    setTheme,
    searchController,
    searchLazyLoad,
    uiState,
    options: {
      preferenceService: { setTheme },
      searchController,
      searchLazyLoad,
      uiState,
    },
  };
}

describe('WorkspaceShellUiActionsController', () => {
  it('owns UI preference and unified search behavior outside Actions', async () => {
    await loadController();
    const source = readFileSync(
      join(__dirname, 'workspace-shell-actions.controller.ts'),
      'utf8',
    );

    expect(source).toContain('WorkspaceShellUiActionsController');
    expect(source).toContain('this.uiActions.onUnifiedSearchChange(query)');
    expect(source).not.toContain('readWorkspaceTextInputValue');
    expect(source).not.toContain('if (query.trim())');
  });

  it('parses layout, floating preference and filter input events', async () => {
    const Controller = await loadController();
    const context = createContext();
    const controller = new Controller(context.options);

    controller.updateLayoutDirection(inputEvent('rtl'));
    controller.updateFloatPref(inputEvent('fixed'));
    controller.updateFilter(inputEvent('active'));

    expect(context.uiState.layoutDirection.set).toHaveBeenCalledWith('rtl');
    expect(context.uiState.floatingWindowPref.set).toHaveBeenCalledWith('fixed');
    expect(context.uiState.filterMode.set).toHaveBeenCalledWith('active');
  });

  it('writes theme preferences without depending on the return value', async () => {
    const Controller = await loadController();
    const context = createContext();
    context.setTheme.mockResolvedValue(true);
    const controller = new Controller(context.options);

    expect(() => controller.updateTheme('ocean')).not.toThrow();

    expect(context.setTheme).toHaveBeenCalledWith('ocean');
  });

  it('parses unified search input and lazy-loads only non-empty queries', async () => {
    const Controller = await loadController();
    const context = createContext();
    const controller = new Controller(context.options);

    controller.onUnifiedSearchInput(inputEvent(' roadmap '));
    controller.onUnifiedSearchChange('   ');

    expect(context.searchLazyLoad.ensureLoaded).toHaveBeenCalledTimes(1);
    expect(context.searchController.update).toHaveBeenNthCalledWith(1, ' roadmap ');
    expect(context.searchController.update).toHaveBeenNthCalledWith(2, '   ');
  });

  it('clears unified search through the search controller', async () => {
    const Controller = await loadController();
    const context = createContext();
    const controller = new Controller(context.options);

    controller.clearUnifiedSearch();

    expect(context.searchController.clear).toHaveBeenCalledTimes(1);
  });
});
