import * as go from 'gojs';

interface OverviewObservedBindingRuntime {
  debug: (message: string) => void;
  getDiagram: () => go.Diagram | null;
  getOverview: () => go.Overview | null;
  isDestroyed: () => boolean;
  removePendingInitialLayoutHandler: () => void;
  setPendingInitialLayoutHandler: (handler: ((event: go.DiagramEvent) => void) | null) => void;
}

interface OverviewHealHookRuntime {
  getOverview: () => go.Overview | null;
  isDestroyed: () => boolean;
}

type OverviewHealWindow = Window & {
  __NANOFLOW_OVERVIEW_HEAL__?: () => void;
};

function getOverviewAutoScaleNone(): number {
  const goWithAutoScale = go as typeof go & {
    AutoScale?: { None?: number };
    Overview?: { None?: number };
  };
  return goWithAutoScale.AutoScale?.None ?? goWithAutoScale.Overview?.None ?? 0;
}

export function configureOverviewContainerRendering(container: HTMLDivElement, backgroundColor: string): void {
  container.style.backgroundColor = backgroundColor;
  container.style.imageRendering = 'auto';

  const vendorStyle = container.style as CSSStyleDeclaration & Record<string, string>;
  vendorStyle['webkitFontSmoothing'] = 'antialiased';
  vendorStyle['mozOsxFontSmoothing'] = 'grayscale';
}

export function createOverviewInstance(container: HTMLDivElement): go.Overview {
  return new go.Overview(container, {
    'animationManager.isEnabled': false,
    autoScale: getOverviewAutoScaleNone(),
    isEnabled: false,
    observed: null,
    'computePixelRatio': () => Math.min(window.devicePixelRatio || 1, 2),
  });
}

export function bindOverviewObservedWhenReady(runtime: OverviewObservedBindingRuntime): void {
  if (runtime.isDestroyed()) return;

  const overview = runtime.getOverview();
  const diagram = runtime.getDiagram();
  if (!overview || !diagram) return;

  runtime.removePendingInitialLayoutHandler();

  if (diagram.documentBounds.isReal()) {
    overview.observed = diagram;
    return;
  }

  runtime.debug('Overview observed 延后绑定：documentBounds 尚未就绪');

  const handler = (_event: go.DiagramEvent): void => {
    if (runtime.isDestroyed()) return;

    const currentOverview = runtime.getOverview();
    const currentDiagram = runtime.getDiagram();
    if (!currentOverview || !currentDiagram || !currentDiagram.documentBounds.isReal()) return;

    currentOverview.observed = currentDiagram;
    runtime.removePendingInitialLayoutHandler();
    currentOverview.requestUpdate();
  };

  runtime.setPendingInitialLayoutHandler(handler);
  diagram.addDiagramListener('InitialLayoutCompleted', handler);
  diagram.addDiagramListener('LayoutCompleted', handler);
}

export function installOverviewHealHook(
  hookInstalled: boolean,
  runtime: OverviewHealHookRuntime,
): boolean {
  if (hookInstalled) return true;

  try {
    (window as OverviewHealWindow).__NANOFLOW_OVERVIEW_HEAL__ = () => {
      if (runtime.isDestroyed()) return;

      const overview = runtime.getOverview();
      if (!overview) return;

      try {
        overview.requestUpdate();
      } catch {
        // Avoid recursively re-entering global error handling from the heal path.
      }
    };
    return true;
  } catch {
    return false;
  }
}

export function removeOverviewHealHook(hookInstalled: boolean): boolean {
  if (!hookInstalled) return false;

  try {
    delete (window as OverviewHealWindow).__NANOFLOW_OVERVIEW_HEAL__;
  } catch {
    // ignore
  }
  return false;
}
