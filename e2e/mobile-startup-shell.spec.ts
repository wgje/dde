import { test, expect, devices } from '@playwright/test';

test.use({ ...devices['Pixel 5'] });

test.describe('Mobile Startup Shell', () => {
  test('should render launch shell without horizontal overflow and keep text launch label on mobile', async ({ page }) => {
    await page.addInitScript(() => {
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
    await expect(page.locator('#snapshot-view-label')).toContainText('文本');

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
