import { describe, expect, it, vi } from 'vitest';
import * as go from 'gojs';

import {
  bindOverviewObservedWhenReady,
  configureOverviewContainerRendering,
  createOverviewInstance,
  installOverviewHealHook,
  removeOverviewHealHook,
} from './flow-overview-lifecycle.helpers';

type HealWindow = Window & {
  __NANOFLOW_OVERVIEW_HEAL__?: () => void;
};

describe('flow-overview-lifecycle.helpers', () => {
  it('configures overview container rendering styles', () => {
    const container = document.createElement('div');

    configureOverviewContainerRendering(container, '#101010');

    expect(container.style.backgroundColor).toBe('#101010');
    expect(container.style.imageRendering).toBe('auto');
    expect((container.style as CSSStyleDeclaration & Record<string, string>)['webkitFontSmoothing']).toBe('antialiased');
    expect((container.style as CSSStyleDeclaration & Record<string, string>)['mozOsxFontSmoothing']).toBe('grayscale');
  });

  it('creates overview with manual scale control and no eager observed diagram', () => {
    const container = document.createElement('div');

    const overview = createOverviewInstance(container) as go.Overview & {
      autoScale: number;
      isEnabled: boolean;
      observed: go.Diagram | null;
    };

    expect(overview.autoScale).toBe((go as typeof go & { AutoScale?: { None?: number }; Overview?: { None?: number } }).AutoScale?.None ?? go.Overview.None ?? 0);
    expect(overview.isEnabled).toBe(false);
    expect(overview.observed).toBeNull();
  });

  it('binds observed immediately when diagram document bounds are ready', () => {
    const overview = createOverviewInstance(document.createElement('div'));
    const diagram = {
      documentBounds: new go.Rect(0, 0, 100, 100),
      addDiagramListener: vi.fn(),
    } as unknown as go.Diagram;
    const removePendingInitialLayoutHandler = vi.fn();

    bindOverviewObservedWhenReady({
      debug: vi.fn(),
      getDiagram: () => diagram,
      getOverview: () => overview,
      isDestroyed: () => false,
      removePendingInitialLayoutHandler,
      setPendingInitialLayoutHandler: vi.fn(),
    });

    expect(overview.observed).toBe(diagram);
    expect(removePendingInitialLayoutHandler).toHaveBeenCalledOnce();
    expect(diagram.addDiagramListener).not.toHaveBeenCalled();
  });

  it('defers observed binding until a layout event makes document bounds real', () => {
    const overview = createOverviewInstance(document.createElement('div'));
    let documentBounds = new go.Rect(0, 0, Number.NaN, Number.NaN);
    const diagram = {
      get documentBounds(): go.Rect {
        return documentBounds;
      },
      addDiagramListener: vi.fn(),
    } as unknown as go.Diagram;
    const removePendingInitialLayoutHandler = vi.fn();
    const setPendingInitialLayoutHandler = vi.fn();

    bindOverviewObservedWhenReady({
      debug: vi.fn(),
      getDiagram: () => diagram,
      getOverview: () => overview,
      isDestroyed: () => false,
      removePendingInitialLayoutHandler,
      setPendingInitialLayoutHandler,
    });

    expect(overview.observed).toBeNull();
    expect(diagram.addDiagramListener).toHaveBeenCalledWith('InitialLayoutCompleted', expect.any(Function));
    expect(diagram.addDiagramListener).toHaveBeenCalledWith('LayoutCompleted', expect.any(Function));

    documentBounds = new go.Rect(0, 0, 300, 200);
    const layoutHandler = setPendingInitialLayoutHandler.mock.calls[0]?.[0];
    if (!layoutHandler) throw new Error('Expected pending layout handler');
    layoutHandler({} as go.DiagramEvent);

    expect(overview.observed).toBe(diagram);
    expect(removePendingInitialLayoutHandler).toHaveBeenCalledTimes(2);
  });

  it('installs and removes the global overview heal hook', () => {
    const requestUpdate = vi.fn();
    const overview = { requestUpdate } as unknown as go.Overview;
    const installed = installOverviewHealHook(false, {
      getOverview: () => overview,
      isDestroyed: () => false,
    });

    expect(installed).toBe(true);
    expect(typeof (window as HealWindow).__NANOFLOW_OVERVIEW_HEAL__).toBe('function');

    (window as HealWindow).__NANOFLOW_OVERVIEW_HEAL__?.();
    expect(requestUpdate).toHaveBeenCalledOnce();

    expect(removeOverviewHealHook(installed)).toBe(false);
    expect((window as HealWindow).__NANOFLOW_OVERVIEW_HEAL__).toBeUndefined();
  });
});
