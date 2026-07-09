import { test, expect, devices, type Page } from '@playwright/test';
import { waitForAppReady } from './shared/page-helpers';

test.use({ ...devices['Pixel 5'] });

async function waitForMobileTextReady(page: Page): Promise<void> {
  const textLabel = page.locator('[data-testid="mobile-text-view-label"]');
  if (!(await textLabel.isVisible({ timeout: 10_000 }).catch(() => false))) {
    await waitForAppReady(page, { timeoutMs: 30_000 }).catch(() => undefined);
  }

  await expect(textLabel).toContainText('文本', { timeout: 10_000 });
}

type FlowPrewarmTraceEntry = {
  status?: string;
  reason?: string;
  at?: number;
};

type MobileTextReadyMarkerWindow = Window & {
  __NANOFLOW_MOBILE_TEXT_READY_AT__?: number;
  __NANOFLOW_FLUSH_DEFERRED_IDLE__?: () => void;
};

function installMobileLaunchSnapshot(page: Page, options: {
  projectName: string;
  routeIntentKind?: 'project' | 'flow';
  pathView?: 'text' | 'flow';
}): Promise<void> {
  return page.addInitScript(({ projectName, routeIntentKind, pathView }) => {
    localStorage.setItem('nanoflow.launch-snapshot.v2', JSON.stringify({
      version: 2,
      savedAt: new Date().toISOString(),
      activeProjectId: 'project-1',
      lastActiveView: 'text',
      preferredView: 'text',
      resolvedLaunchView: 'text',
      routeIntent: { kind: routeIntentKind, projectId: 'project-1', taskId: null },
      mobileDegraded: pathView === 'flow',
      degradeReason: pathView === 'flow' ? 'mobile-default-text' : null,
      theme: 'default',
      colorMode: 'light',
      projects: [{
        id: 'project-1',
        name: projectName,
        description: 'mobile flow prewarm',
        updatedAt: new Date().toISOString(),
        taskCount: 1,
        openTaskCount: 1,
        recentTasks: [{ id: 'task-1', title: 'Task 1', displayId: '1', status: 'active' }],
      }],
      currentProject: null,
    }));
  }, {
    projectName: options.projectName,
    routeIntentKind: options.routeIntentKind ?? 'project',
    pathView: options.pathView ?? 'text',
  });
}

async function waitForFlowPrewarmTraceStatus(
  page: Page,
  statuses: string[],
  timeout = 10_000,
  minAt?: number
): Promise<FlowPrewarmTraceEntry[]> {
  await page.waitForFunction(({ expectedStatuses, minAt }) => {
    const trace = (
      window as Window & {
        __NANOFLOW_FLOW_PREWARM_TRACE__?: FlowPrewarmTraceEntry[];
      }
    ).__NANOFLOW_FLOW_PREWARM_TRACE__ ?? [];
    return trace.some(entry =>
      expectedStatuses.includes(entry.status ?? '')
      && typeof entry.at === 'number'
      && entry.at >= minAt
    );
  }, { expectedStatuses: statuses, minAt: minAt ?? 0 }, { timeout });

  return page.evaluate(() => (
    window as Window & {
      __NANOFLOW_FLOW_PREWARM_TRACE__?: FlowPrewarmTraceEntry[];
    }
  ).__NANOFLOW_FLOW_PREWARM_TRACE__ ?? []);
}

test.describe('Mobile Startup Shell', () => {
  test('should render text startup without horizontal overflow and keep dock collapsed on mobile', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('nanoflow.parking-dock-open', 'true');
      localStorage.setItem('nanoflow.launch-snapshot.v2', JSON.stringify({
        version: 2,
        savedAt: new Date().toISOString(),
        activeProjectId: 'project-1',
        lastActiveView: 'flow',
        preferredView: 'flow',
        resolvedLaunchView: 'text',
        routeIntent: { kind: 'flow', projectId: 'project-1', taskId: null },
        mobileDegraded: true,
        degradeReason: 'mobile-default-text',
        theme: 'default',
        colorMode: 'light',
        projects: [{
          id: 'project-1',
          name: 'Inbox',
          description: 'mobile shell',
          updatedAt: new Date().toISOString(),
          taskCount: 1,
          openTaskCount: 1,
          recentTasks: [{ id: 'task-1', title: 'Task 1', displayId: '1', status: 'active' }],
        }],
        currentProject: null,
      }));
    });

    await page.goto('/projects/project-1/flow', { waitUntil: 'domcontentloaded' });

    await expect(page.locator('#initial-loader')).toBeVisible();
    await waitForMobileTextReady(page);
    await expect(page.locator('[data-testid="dock-v3-semicircle"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="dock-v3-panel"]')).toHaveCount(0);

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test('should clamp flow drawer layout to the visual viewport after switching from text view', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('nanoflow.launch-snapshot.v2', JSON.stringify({
        version: 2,
        savedAt: new Date().toISOString(),
        activeProjectId: 'project-1',
        lastActiveView: 'text',
        preferredView: 'text',
        resolvedLaunchView: 'text',
        routeIntent: { kind: 'project', projectId: 'project-1', taskId: null },
        mobileDegraded: false,
        degradeReason: null,
        theme: 'default',
        colorMode: 'light',
        projects: [{
          id: 'project-1',
          name: 'Viewport Project',
          description: 'mobile flow viewport clamp',
          updatedAt: new Date().toISOString(),
          taskCount: 1,
          openTaskCount: 1,
          recentTasks: [{ id: 'task-1', title: 'Task 1', displayId: '1', status: 'active' }],
        }],
        currentProject: null,
      }));

      const listeners = new Map<string, Set<(event: Event) => void>>();
      const mockVisualViewport = {
        width: window.innerWidth,
        height: window.innerHeight,
        offsetTop: 0,
        offsetLeft: 0,
        pageTop: 0,
        pageLeft: 0,
        scale: 1,
        addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
          const callback = typeof listener === 'function'
            ? listener
            : listener.handleEvent.bind(listener);
          if (!listeners.has(type)) {
            listeners.set(type, new Set());
          }
          listeners.get(type)?.add(callback);
        },
        removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
          const callback = typeof listener === 'function'
            ? listener
            : listener.handleEvent.bind(listener);
          listeners.get(type)?.delete(callback);
        },
      };

      Object.defineProperty(window, 'visualViewport', {
        configurable: true,
        value: mockVisualViewport,
      });

      (window as Window & {
        __setMockVisualViewport?: (height: number, offsetTop?: number) => void;
      }).__setMockVisualViewport = (height: number, offsetTop = 0) => {
        mockVisualViewport.height = height;
        mockVisualViewport.offsetTop = offsetTop;
        mockVisualViewport.width = window.innerWidth;

        for (const type of ['resize', 'scroll']) {
          for (const listener of listeners.get(type) ?? []) {
            listener(new Event(type));
          }
        }
      };
    });

    await page.goto('/projects/project-1/text', { waitUntil: 'domcontentloaded' });
    await waitForMobileTextReady(page);

    await page.locator('[data-testid="flow-view-tab"]').first().click();
    await page.waitForSelector('[data-testid="flow-diagram"]', { timeout: 30000 });

    await page.evaluate(() => {
      const setter = (window as Window & {
        __setMockVisualViewport?: (height: number, offsetTop?: number) => void;
      }).__setMockVisualViewport;
      setter?.(660, 0);
      window.dispatchEvent(new Event('resize'));
    });

    await page.waitForFunction(() => {
      const viewport = document.querySelector('.mobile-drawer-viewport');
      if (!viewport) return false;
      const rect = viewport.getBoundingClientRect();
      return Math.abs(rect.height - 630) < 2 && rect.bottom <= 661;
    });

    const metrics = await page.evaluate(() => {
      const viewport = document.querySelector('.mobile-drawer-viewport')?.getBoundingClientRect();
      const diagram = document.querySelector('[data-testid="flow-diagram"]')?.getBoundingClientRect();
      return {
        viewportHeight: viewport?.height ?? 0,
        viewportBottom: viewport?.bottom ?? 0,
        diagramBottom: diagram?.bottom ?? 0,
      };
    });

    expect(metrics.viewportHeight).toBeGreaterThan(628);
    expect(metrics.viewportHeight).toBeLessThan(632);
    expect(metrics.viewportBottom).toBeLessThanOrEqual(661);
    expect(metrics.diagramBottom).toBeLessThanOrEqual(661);
  });

  test('should expose startup trace from static loader into Angular startup', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('nanoflow.launch-snapshot.v2', JSON.stringify({
        version: 2,
        savedAt: new Date().toISOString(),
        activeProjectId: 'project-1',
        lastActiveView: 'text',
        preferredView: 'text',
        resolvedLaunchView: 'text',
        routeIntent: { kind: 'project', projectId: 'project-1', taskId: null },
        mobileDegraded: false,
        degradeReason: null,
        theme: 'default',
        colorMode: 'light',
        projects: [{
          id: 'project-1',
          name: 'Trace Project',
          description: 'startup trace',
          updatedAt: new Date().toISOString(),
          taskCount: 0,
          openTaskCount: 0,
          recentTasks: [],
        }],
        currentProject: null,
      }));
    });

    await page.goto('/projects/project-1/text', { waitUntil: 'domcontentloaded' });

    await page.waitForFunction(() => {
      const records = (window as Window & {
        __NANOFLOW_STARTUP_TRACE__?: Array<{ event?: string }>;
      }).__NANOFLOW_STARTUP_TRACE__ ?? [];
      return records.some((entry) => entry.event === 'loader.initial_visible')
        && records.some((entry) => entry.event === 'app.start');
    });

    const events = await page.evaluate(() =>
      (
        window as Window & {
          __NANOFLOW_STARTUP_TRACE__?: Array<{ event?: string }>;
        }
      ).__NANOFLOW_STARTUP_TRACE__?.map((entry) => entry.event) ?? []
    );

    expect(events).toContain('loader.initial_visible');
    expect(events).toContain('app.start');
  });

  test('keeps mobile text ready while flow prewarm starts after startup', async ({ page }) => {
    await page.addInitScript(() => {
      const callbacks = new Map<number, IdleRequestCallback>();
      let nextIdleHandle = 1;
      window.requestIdleCallback = (callback: IdleRequestCallback): number => {
        const handle = nextIdleHandle;
        nextIdleHandle += 1;
        callbacks.set(handle, callback);
        return handle;
      };
      window.cancelIdleCallback = (handle: number): void => {
        callbacks.delete(handle);
      };
      (window as MobileTextReadyMarkerWindow).__NANOFLOW_FLUSH_DEFERRED_IDLE__ = () => {
        const pending = [...callbacks.entries()];
        callbacks.clear();
        for (const [, callback] of pending) {
          setTimeout(() => callback({
            didTimeout: false,
            timeRemaining: () => 50,
          }), 0);
        }
      };
    });
    await installMobileLaunchSnapshot(page, {
      projectName: 'Prewarm Text Project',
      routeIntentKind: 'flow',
      pathView: 'flow',
    });

    await page.goto('/projects/project-1/flow', { waitUntil: 'domcontentloaded' });

    await waitForMobileTextReady(page);
    const textReadyAt = await page.evaluate(() => {
      const marker = typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? performance.now()
        : Date.now();
      (window as MobileTextReadyMarkerWindow).__NANOFLOW_MOBILE_TEXT_READY_AT__ = marker;
      (window as MobileTextReadyMarkerWindow).__NANOFLOW_FLUSH_DEFERRED_IDLE__?.();
      return marker;
    });
    const trace = await waitForFlowPrewarmTraceStatus(
      page,
      ['scheduled', 'loading'],
      10_000,
      textReadyAt
    );

    await expect(page.locator('[data-testid="mobile-text-view-label"]')).toContainText('文本');
    expect(trace.some(entry =>
      (entry.status === 'scheduled' || entry.status === 'loading')
      && typeof entry.at === 'number'
      && entry.at >= textReadyAt
    )).toBe(true);
  });

  test('switches from mobile text to visible flow diagram after flow prewarm is ready', async ({ page }) => {
    await installMobileLaunchSnapshot(page, {
      projectName: 'Prewarm Flow Project',
      routeIntentKind: 'project',
      pathView: 'text',
    });

    await page.goto('/projects/project-1/text', { waitUntil: 'domcontentloaded' });

    await waitForMobileTextReady(page);
    await waitForFlowPrewarmTraceStatus(page, ['ready'], 20_000);

    await page.locator('[data-testid="flow-view-tab"]').first().click();
    await expect(page.locator('[data-testid="flow-diagram"]').first()).toBeVisible({ timeout: 30_000 });
  });
});
