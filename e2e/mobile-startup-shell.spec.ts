import { test, expect, devices } from '@playwright/test';

test.use({ ...devices['Pixel 5'] });

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
    await expect(page.locator('[data-testid="mobile-text-view-label"]')).toContainText('文本');
    await expect(page.locator('[data-testid="dock-v3-semicircle"]')).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('[data-testid="dock-v3-panel"]')).toHaveClass(/focus-collapsed/);

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
    await expect(page.locator('[data-testid="mobile-text-view-label"]')).toContainText('文本');

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
});
