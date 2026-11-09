import { expect, Page, test } from '@playwright/test';

import { testHelpers } from './helpers';

function projectItem(page: Page, projectId: string) {
  return page.locator(`[data-testid="project-item"][data-project-id="${projectId}"]`).first();
}

function requireProjectId(projectId: string | null, name: string): string {
  if (!projectId) throw new Error(`${name} did not expose a project id`);
  return projectId;
}

async function activateProject(page: Page, projectId: string, taskTitle: string): Promise<void> {
  const item = projectItem(page, projectId);
  const route = new RegExp(`#/projects/${projectId}(?:/|$)`);
  await expect(item).toBeVisible({ timeout: 10_000 });
  if (!route.test(page.url())) {
    const box = await item.boundingBox();
    expect(box).toBeTruthy();
    if (!box) throw new Error(`Project item ${projectId} has no visible bounds`);
    await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
  }
  await expect.poll(() => route.test(page.url()), {
    timeout: 20_000,
    intervals: [100, 250, 500, 1_000],
  }).toBe(true);
  await testHelpers.waitForAppReady(page);
  await expect(item).toHaveClass(/bg-indigo-50/, { timeout: 10_000 });
  await expect(page.getByText(taskTitle, { exact: true }).first()).toBeVisible({ timeout: 10_000 });
}

async function setFiveMinuteReminder(page: Page, taskTitle: string): Promise<void> {
  const titleInput = await testHelpers.openTaskTitleEditor(page, taskTitle, { timeout: 10_000 });
  const card = titleInput.locator('xpath=ancestor::*[@data-testid="task-card"]').first();
  const park = card.locator('[data-testid="text-unassigned-park-button"]');
  await expect(park).toBeVisible();
  await park.click();
  await expect(page.getByText(taskTitle, { exact: true }).first()).toBeVisible({ timeout: 10_000 });

  const parkedTitleInput = await testHelpers.openTaskTitleEditor(page, taskTitle, { timeout: 10_000 });
  const parkedCard = parkedTitleInput.locator('xpath=ancestor::*[@data-testid="task-card"]').first();
  const reminder = parkedCard.locator('[data-testid="text-unassigned-reminder-trigger"]');
  await reminder.click();
  await parkedCard.locator('[data-testid="text-unassigned-reminder-preset-5"]').click();
  await expect(reminder).toHaveText('提醒已设');
}

test('parking reminder action preserves source-project ownership after a desktop project switch', async ({ page }) => {
  page.on('dialog', dialog => dialog.accept());
  await page.clock.install({ time: new Date('2026-07-31T08:00:00.000Z') });
  await page.goto('/');
  await testHelpers.waitForAppReady(page);
  await testHelpers.ensureEditorReady(page, { mode: 'local' });

  const suffix = testHelpers.uniqueId();
  const sharedTitle = `Parking shared task ${suffix}`;
  const projectAId = requireProjectId(
    await testHelpers.createTestProject(page, `Parking owner A ${suffix}`), 'project A',
  );
  await testHelpers.createTask(page, sharedTitle);
  await setFiveMinuteReminder(page, sharedTitle);
  await page.clock.fastForward(5 * 60_000);

  const notice = page.locator('[data-testid="parking-notice"]');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText(sharedTitle);

  const projectBId = requireProjectId(
    await testHelpers.createTestProject(page, `Parking owner B ${suffix}`), 'project B',
  );
  await testHelpers.createTask(page, sharedTitle);
  await activateProject(page, projectBId, sharedTitle);
  const taskB = page.locator('[data-testid="task-card"]').filter({ hasText: sharedTitle }).first();
  await expect(taskB).toBeVisible();
  await expect(notice).toBeVisible();

  await notice.getByRole('button', { name: '忽略' }).click();
  await page.clock.fastForward(350);
  await expect(notice).toHaveCount(0);
  await expect(taskB).toBeVisible();

  await activateProject(page, projectAId, sharedTitle);
  const titleInputA = await testHelpers.openTaskTitleEditor(page, sharedTitle, { timeout: 10_000 });
  const taskA = titleInputA.locator('xpath=ancestor::*[@data-testid="task-card"]').first();
  await expect(taskA.locator('[data-testid="text-unassigned-reminder-trigger"]')).toHaveText('提醒');
});
