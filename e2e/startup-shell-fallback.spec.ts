import { test, expect } from '@playwright/test';

test.describe('Startup Shell Fallback', () => {
  test('should show initial loader without blank screen when snapshot payload is corrupted', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('nanoflow.launch-snapshot.v1', '{broken');
      localStorage.removeItem('nanoflow.launch-snapshot.v2');
    });

    await page.goto('/projects', { waitUntil: 'domcontentloaded' });

    await expect(page.locator('#initial-loader')).toBeVisible();
  });

  test('should bootstrap from legacy launch alias without leaving the user on launch.html', async ({ page }) => {
    await page.goto('/launch.html', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#initial-loader')).toBeVisible();

    await page.waitForURL((url) => !url.pathname.endsWith('/launch.html'));

    await page.waitForFunction(() => {
      const records = (window as Window & {
        __NANOFLOW_STARTUP_TRACE__?: Array<{ event?: string }>;
      }).__NANOFLOW_STARTUP_TRACE__ ?? [];

      return !window.location.pathname.endsWith('/launch.html')
        && records.some((entry) => entry.event === 'app.start');
    });

    await expect(page).not.toHaveURL(/launch\.html$/);
  });

  test('should prefer explicit shortcut workspace intent over persisted launch snapshot route restore', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('nanoflow.launch-snapshot.v2', JSON.stringify({
        version: 2,
        savedAt: new Date().toISOString(),
        activeProjectId: 'project-1',
        lastActiveView: 'flow',
        preferredView: 'flow',
        resolvedLaunchView: 'flow',
        routeIntent: { kind: 'task', projectId: 'project-1', taskId: 'task-9' },
        mobileDegraded: false,
        degradeReason: null,
        theme: 'default',
        colorMode: 'light',
        projects: [{
          id: 'project-1',
          name: 'Shortcut Project',
          description: 'startup shortcut',
          updatedAt: new Date().toISOString(),
          taskCount: 1,
          openTaskCount: 1,
          recentTasks: [{ id: 'task-9', title: 'Task 9', displayId: '9', status: 'active' }],
        }],
        currentProject: {
          id: 'project-1',
          name: 'Shortcut Project',
          description: 'startup shortcut',
          updatedAt: new Date().toISOString(),
          taskCount: 1,
          openTaskCount: 1,
          recentTasks: [{ id: 'task-9', title: 'Task 9', displayId: '9', status: 'active' }],
        },
      }));
    });

    await page.goto('/#/projects?entry=shortcut&intent=open-workspace', { waitUntil: 'domcontentloaded' });

    await page.waitForFunction(() => !window.location.hash.includes('/task/'));
    await expect(page).toHaveURL(/#\/projects$/);
    await expect(page.locator('[data-testid="project-selector"]')).toBeVisible();
  });

  test('should retain the raw shortcut hash in startup trace before one-shot consumption', async ({ page }) => {
    await page.goto('/#/projects?entry=shortcut&intent=open-workspace', { waitUntil: 'domcontentloaded' });

    await page.waitForFunction(() => {
      const records = (window as Window & {
        __NANOFLOW_STARTUP_TRACE__?: Array<{ event?: string }>;
      }).__NANOFLOW_STARTUP_TRACE__ ?? [];

      return records.some((entry) => entry.event === 'loader.initial_visible')
        && records.some((entry) => entry.event === 'app.start');
    });

    const trace = await page.evaluate(() =>
      (
        window as Window & {
          __NANOFLOW_STARTUP_TRACE__?: Array<{
            event: string;
            data?: Record<string, unknown> | null;
          }>;
        }
      ).__NANOFLOW_STARTUP_TRACE__ ?? []
    );

    const loaderEvent = trace.find((entry) => entry.event === 'loader.initial_visible');
    const appStartEvent = trace.find((entry) => entry.event === 'app.start');

    expect(loaderEvent?.data?.['pathname']).toBe('/');
    expect(loaderEvent?.data?.['hashPath']).toBe('#/projects');
    expect(loaderEvent?.data?.['hasSearch']).toBe(false);
    expect(loaderEvent?.data?.['hasOpaqueHash']).toBe(false);
    expect(loaderEvent?.data?.['entryCarrier']).toBe('hash');
    expect(loaderEvent?.data?.['entry']).toBe('shortcut');
    expect(loaderEvent?.data?.['intent']).toBe('open-workspace');
    expect(appStartEvent?.data?.['pathname']).toBe('/');
    expect(appStartEvent?.data?.['hashPath']).toBe('#/projects');
    expect(appStartEvent?.data?.['hasSearch']).toBe(false);
    expect(appStartEvent?.data?.['hasOpaqueHash']).toBe(false);
    expect(appStartEvent?.data?.['entryCarrier']).toBe('hash');
    expect(appStartEvent?.data?.['entry']).toBe('shortcut');
    expect(appStartEvent?.data?.['intent']).toBe('open-workspace');
    await expect(page).toHaveURL(/#\/projects$/);
  });

  test('should avoid copying opaque hash tokens into startup trace', async ({ page }) => {
    await page.goto('/#access_token=test-access&refresh_token=test-refresh&type=recovery', {
      waitUntil: 'domcontentloaded',
    });

    await page.waitForFunction(() => {
      const records = (window as Window & {
        __NANOFLOW_STARTUP_TRACE__?: Array<{ event?: string }>;
      }).__NANOFLOW_STARTUP_TRACE__ ?? [];

      return records.some((entry) => entry.event === 'loader.initial_visible')
        && records.some((entry) => entry.event === 'app.start');
    });

    const trace = await page.evaluate(() =>
      (
        window as Window & {
          __NANOFLOW_STARTUP_TRACE__?: Array<{
            event: string;
            data?: Record<string, unknown> | null;
          }>;
        }
      ).__NANOFLOW_STARTUP_TRACE__ ?? []
    );

    const loaderEvent = trace.find((entry) => entry.event === 'loader.initial_visible');
    const appStartEvent = trace.find((entry) => entry.event === 'app.start');

    for (const entry of [loaderEvent, appStartEvent]) {
      const data = entry?.data ?? {};
      expect(data['hashPath']).toBe('');
      expect(data['hasOpaqueHash']).toBe(true);
      expect(data['entry']).toBeNull();
      expect(data['intent']).toBeNull();
      expect(JSON.stringify(data)).not.toContain('test-access');
      expect(JSON.stringify(data)).not.toContain('test-refresh');
    }
  });

  test('should preload sidebar tools for focus and blackbox shortcut intents', async ({ page }) => {
    await page.goto('/#/projects?entry=shortcut&intent=open-focus-tools', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('[data-testid="focus-session-trigger"]')).toBeVisible();
    await expect(page).toHaveURL(/#\/projects$/);

    await page.goto('/#/projects?entry=shortcut&intent=open-blackbox-recorder', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('[data-testid="black-box-recorder"]')).toBeVisible();
    await expect(page).toHaveURL(/#\/projects$/);
  });

  test('should reapply shortcut startup intent after the one-shot query has been consumed', async ({ page }) => {
    await page.goto('/#/projects?entry=shortcut&intent=open-focus-tools', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('[data-testid="focus-session-trigger"]')).toBeVisible();
    await expect(page).toHaveURL(/#\/projects$/);

    await page.evaluate(() => {
      window.dispatchEvent(new Event('toggle-sidebar'));
      window.location.hash = '#/projects?entry=shortcut&intent=open-focus-tools';
    });

    await expect(page.locator('[data-testid="focus-session-trigger"]')).toBeVisible();
    await expect(page).toHaveURL(/#\/projects$/);
  });

  test('should safely degrade invalid shortcut intents to the workspace root', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('nanoflow.launch-snapshot.v2', JSON.stringify({
        version: 2,
        savedAt: new Date().toISOString(),
        activeProjectId: 'project-1',
        lastActiveView: 'flow',
        preferredView: 'flow',
        resolvedLaunchView: 'flow',
        routeIntent: { kind: 'flow', projectId: 'project-1', taskId: null },
        mobileDegraded: false,
        degradeReason: null,
        theme: 'default',
        colorMode: 'light',
        projects: [{
          id: 'project-1',
          name: 'Invalid Shortcut Project',
          description: 'invalid shortcut',
          updatedAt: new Date().toISOString(),
          taskCount: 0,
          openTaskCount: 0,
          recentTasks: [],
        }],
        currentProject: {
          id: 'project-1',
          name: 'Invalid Shortcut Project',
          description: 'invalid shortcut',
          updatedAt: new Date().toISOString(),
          taskCount: 0,
          openTaskCount: 0,
          recentTasks: [],
        },
      }));
    });

    await page.goto('/#/projects?entry=shortcut&intent=unknown-intent', { waitUntil: 'domcontentloaded' });

    await page.waitForFunction(() => !window.location.hash.includes('/flow'));
    await expect(page).toHaveURL(/#\/projects$/);
  });
});
