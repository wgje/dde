import { expect, Page, test } from '@playwright/test';

import { testHelpers } from './critical-paths/helpers';

function projectItem(page: Page, projectId: string) {
  return page.locator(`[data-testid="project-item"][data-project-id="${projectId}"]`).first();
}

function requireProjectId(projectId: string | null, label: string): string {
  if (!projectId) throw new Error(`${label} did not expose a project id`);
  return projectId;
}

async function activateProject(page: Page, projectId: string, taskTitle: string): Promise<void> {
  const item = projectItem(page, projectId);
  const enter = item.locator('xpath=..').getByRole('button', { name: /进入项目|enter/i }).first();
  const route = new RegExp(`#/projects/${projectId}(?:/|$)`);
  await expect(item).toBeVisible({ timeout: 10_000 });
  await item.click({ force: true });
  await expect.poll(async () => {
    if (await testHelpers.isElementVisible(enter, 400)) await enter.click({ force: true });
    return route.test(page.url())
      && testHelpers.isElementVisible(page.getByText(taskTitle, { exact: true }).first(), 400);
  }, { timeout: 20_000, intervals: [100, 250, 500, 1_000] }).toBe(true);
  await testHelpers.waitForAppReady(page);
  await expect(item).toHaveClass(/bg-indigo-50/, { timeout: 10_000 });
}

test('project owner change retires the source-owned delete modal without deleting either project', async ({ page }) => {
  await page.goto('/');
  await testHelpers.waitForAppReady(page);
  await testHelpers.ensureEditorReady(page, { mode: 'local' });

  const suffix = testHelpers.uniqueId();
  const taskATitle = `Delete owner A ${suffix}`;
  const projectAId = requireProjectId(
    await testHelpers.createTestProject(page, `DeleteOwnerA-${suffix}`), 'project A',
  );
  await testHelpers.createTask(page, taskATitle);
  const taskBTitle = `Delete owner B ${suffix}`;
  const projectBId = requireProjectId(
    await testHelpers.createTestProject(page, `DeleteOwnerB-${suffix}`), 'project B',
  );
  await testHelpers.createTask(page, taskBTitle);

  await activateProject(page, projectAId, taskATitle);
  const projectA = projectItem(page, projectAId);
  await projectA.getByRole('button', { name: '项目详情' }).click();
  const projectDetails = projectA.locator('xpath=..').getByTestId('project-intro-card');
  const deleteButton = projectDetails.getByRole('button', { name: '删除项目' });
  await expect(deleteButton).toBeVisible();
  await deleteButton.click();
  const deleteHeading = page.getByRole('heading', { name: '删除项目' });
  await expect(deleteHeading).toBeVisible();

  const acceptProjectSwitchDialog = (dialog: import('@playwright/test').Dialog) => dialog.accept();
  page.on('dialog', acceptProjectSwitchDialog);
  const projectB = projectItem(page, projectBId);
  // The open modal backdrop blocks pointer input; dispatch the sidebar event to exercise the owner-change race.
  await projectB.dispatchEvent('click');

  await expect(deleteHeading).toHaveCount(0);
  const projectBDetails = projectB.locator('xpath=..').getByTestId('project-intro-card');
  await expect(projectBDetails).toBeVisible();
  await projectBDetails.getByRole('button', { name: /进入项目|enter/i }).click();
  const projectBRoute = new RegExp(`#/projects/${projectBId}(?:/|$)`);
  await expect.poll(() => projectBRoute.test(page.url())
    && testHelpers.isElementVisible(page.getByText(taskBTitle, { exact: true }).first(), 400),
  { timeout: 20_000, intervals: [100, 250, 500, 1_000] }).toBe(true);
  page.off('dialog', acceptProjectSwitchDialog);
  await testHelpers.waitForAppReady(page);

  await expect(projectA).toBeVisible();
  await expect(projectB).toHaveClass(/bg-indigo-50/);
  await expect(page.getByText(taskBTitle, { exact: true }).first()).toBeVisible();
  await expect(page.getByText(taskATitle, { exact: true })).toHaveCount(0);
});
