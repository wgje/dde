import { expect, test, type Locator, type Page } from '@playwright/test';
import { testHelpers } from './helpers';
import { waitForAppReady } from '../shared/page-helpers';

const LOCAL_MODE_KEY = 'nanoflow.local-mode';
const AUTH_CACHE_KEY = 'nanoflow.auth-cache';

async function settleWorkspaceOverlays(page: Page): Promise<void> {
  const demoBanner = page.locator('.demo-banner-shell').first();
  const closeButton = page.locator('app-demo-banner button[aria-label="关闭提示"]').first();
  if (await testHelpers.isElementVisible(closeButton, 2_000)) {
    await closeButton.click();
  }
  await expect(demoBanner).toHaveCount(0, { timeout: 10_000 });
  await expect(page.locator('[data-testid="startup-hint-overlay"]')).toHaveCount(0, { timeout: 5_000 });
  await expect(page.locator('[data-testid="android-widget-callback-overlay"]')).toHaveCount(0, { timeout: 5_000 });
}

async function bootstrapLocalWorkspace(page: Page): Promise<void> {
  await page.goto('/');
  const localModeButton = page.locator('[data-testid="local-mode-btn"]').first();
  if (await testHelpers.isElementVisible(localModeButton, 8_000)) {
    await localModeButton.click();
  } else {
    await waitForAppReady(page, { timeoutMs: 30_000, recoverStaticLoader: true });
  }
  await page.evaluate(({ localModeKey, authCacheKey }) => {
    localStorage.setItem(localModeKey, 'true');
    localStorage.removeItem(authCacheKey);
    window.dispatchEvent(new Event('nanoflow:local-mode-changed'));
  }, { localModeKey: LOCAL_MODE_KEY, authCacheKey: AUTH_CACHE_KEY });
  await waitForAppReady(page, { timeoutMs: 30_000, recoverStaticLoader: true });
  await settleWorkspaceOverlays(page);
  await expect(page.locator('[data-testid="project-selector"]')).toBeVisible({ timeout: 15_000 });
}

async function createTextUnassignedTask(page: Page, title: string): Promise<Locator> {
  const createButton = page.locator('app-text-unassigned button').filter({ hasText: '新建' }).first();
  await expect(createButton).toBeVisible({ timeout: 10_000 });
  await createButton.click();
  const titleInput = page.locator('[data-unassigned-task] [data-title-input]').first();
  await expect(titleInput).toBeVisible({ timeout: 10_000 });
  await titleInput.fill(title);
  await titleInput.press('Enter');
  const card = page.locator(`[data-unassigned-task]:has-text("${title}")`).first();
  await expect(card).toBeVisible({ timeout: 10_000 });
  return card;
}

async function ensureStageExists(page: Page, stageNumber: number): Promise<void> {
  while (await page.locator('[data-stage-number]').count() < stageNumber) {
    const addStageButton = page.getByText('+ 新阶段').first();
    await expect(addStageButton).toBeVisible({ timeout: 5_000 });
    await addStageButton.click();
  }

  await expect(page.locator(`[data-stage-number="${stageNumber}"]`).first()).toBeVisible({ timeout: 5_000 });
}

async function assignTaskToStage(page: Page, taskTitle: string, stageNumber: number): Promise<string> {
  const taskCard = await testHelpers.getTaskCard(page, taskTitle, { timeout: 5_000 });
  const stageCard = page.locator(`[data-stage-number="${stageNumber}"]`).first();
  const stageTaskList = page.locator(`[data-stage-number="${stageNumber}"] [data-stage-task-list="${stageNumber}"]`).first();

  await expect(taskCard).toBeVisible({ timeout: 5_000 });
  await expect(stageCard).toBeVisible({ timeout: 5_000 });
  if ((await stageTaskList.getAttribute('aria-hidden')) === 'true') {
    await stageCard.locator('header').first().click();
  }
  await expect(stageTaskList).toBeVisible({ timeout: 5_000 });
  await taskCard.dragTo(stageTaskList);

  const stagedCard = stageTaskList.locator('[data-testid="task-card"]').filter({ hasText: taskTitle }).first();
  await expect(stagedCard).toBeVisible({ timeout: 5_000 });
  const taskId = await stagedCard.getAttribute('data-task-id');
  expect(taskId).toBeTruthy();
  if (!taskId) throw new Error(`Assigned task ${taskTitle} is missing data-task-id`);
  await expect.poll(() => readPersistedTask(page, taskId), {
    timeout: 10_000,
    intervals: [250, 500, 1_000],
  }).toMatchObject({ id: taskId, stage: stageNumber });
  return taskId;
}

async function readPersistedTask(page: Page, taskId: string): Promise<{ id: string; parentId: string | null; stage: number | null } | null> {
  return page.evaluate(async id => {
    const find = (value: unknown): { id: string; parentId: string | null; stage: number | null } | null => {
      if (!value || typeof value !== 'object') return null;
      if (Array.isArray(value)) {
        for (const item of value) {
          const found = find(item);
          if (found) return found;
        }
        return null;
      }
      const record = value as Record<string, unknown>;
      if (record['id'] === id && ('parentId' in record || 'stage' in record)) {
        return {
          id,
          parentId: typeof record['parentId'] === 'string' ? record['parentId'] : null,
          stage: typeof record['stage'] === 'number' ? record['stage'] : null,
        };
      }
      for (const child of Object.values(record)) {
        const found = find(child);
        if (found) return found;
      }
      return null;
    };

    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key) continue;
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      try {
        const found = find(JSON.parse(raw));
        if (found) return found;
      } catch {
        // Ignore unrelated non-JSON storage values.
      }
    }

    if (typeof indexedDB.databases !== 'function') return null;
    for (const database of await indexedDB.databases()) {
      if (!database.name) continue;
      const opened = await new Promise<IDBDatabase | null>(resolve => {
        const request = indexedDB.open(database.name!);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
        request.onupgradeneeded = () => {
          request.transaction?.abort();
          resolve(null);
        };
      });
      if (!opened) continue;
      try {
        for (const storeName of Array.from(opened.objectStoreNames)) {
          const values = await new Promise<unknown[]>(resolve => {
            const request = opened.transaction(storeName, 'readonly').objectStore(storeName).getAll();
            request.onsuccess = () => resolve(request.result as unknown[]);
            request.onerror = () => resolve([]);
          });
          const found = find(values);
          if (found) return found;
        }
      } finally {
        opened.close();
      }
    }
    return null;
  }, taskId);
}

async function waitForParent(page: Page, taskId: string, parentId: string | null): Promise<void> {
  await expect.poll(() => readPersistedTask(page, taskId), { timeout: 15_000, intervals: [250, 500, 1_000] })
    .toMatchObject({ id: taskId, parentId });
}

async function dispatchRealDrop(page: Page, source: Locator, target: Locator): Promise<void> {
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  try {
    await source.dispatchEvent('dragstart', { dataTransfer });
    await target.dispatchEvent('dragenter', { dataTransfer });
    await target.dispatchEvent('dragover', { dataTransfer });
    await target.dispatchEvent('drop', { dataTransfer });
    await source.dispatchEvent('dragend', { dataTransfer });
  } finally {
    await dataTransfer.dispose();
  }
}

test.describe('Floating task tree browser drops', () => {
  test.describe.configure({ mode: 'serial' });

  test('Text unassigned card drop persists the reparent after reload', async ({ page }) => {
    await bootstrapLocalWorkspace(page);
    await testHelpers.ensureEditorReady(page, { mode: 'local' });
    await settleWorkspaceOverlays(page);
    const projectId = await testHelpers.createTestProject(page, `浮动树 Text ${testHelpers.uniqueId()}`);
    expect(projectId).not.toBeNull();
    if (projectId) testHelpers.trackProjectId(projectId);

    const source = await createTextUnassignedTask(page, `Text source ${testHelpers.uniqueId()}`);
    const target = await createTextUnassignedTask(page, `Text target ${testHelpers.uniqueId()}`);
    const sourceId = await source.getAttribute('data-unassigned-task');
    const targetId = await target.getAttribute('data-unassigned-task');
    expect(sourceId).toBeTruthy();
    expect(targetId).toBeTruthy();

    await dispatchRealDrop(page, source, target);
    await waitForParent(page, sourceId!, targetId!);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForAppReady(page, { timeoutMs: 30_000, recoverStaticLoader: true });
    await waitForParent(page, sourceId!, targetId!);
  });

  test('Flow unassigned drop honors a specific target and rejects blank or assigned targets', async ({ page }) => {
    await bootstrapLocalWorkspace(page);
    await testHelpers.ensureEditorReady(page, { mode: 'local' });
    await settleWorkspaceOverlays(page);
    const projectId = await testHelpers.createTestProject(page, `浮动树 Flow ${testHelpers.uniqueId()}`);
    expect(projectId).not.toBeNull();
    if (projectId) testHelpers.trackProjectId(projectId);

    const sourceTitle = `Flow source ${testHelpers.uniqueId()}`;
    const firstTargetTitle = `Flow first ${testHelpers.uniqueId()}`;
    const targetTitle = `Flow target ${testHelpers.uniqueId()}`;
    const assignedTitle = `Flow assigned ${testHelpers.uniqueId()}`;
    await createTextUnassignedTask(page, sourceTitle);
    await createTextUnassignedTask(page, firstTargetTitle);
    await createTextUnassignedTask(page, targetTitle);
    await testHelpers.createTask(page, assignedTitle);
    await ensureStageExists(page, 1);
    const assignedId = await assignTaskToStage(page, assignedTitle, 1);

    const flowTab = page.locator('[data-testid="flow-view-tab"]').first();
    if (await testHelpers.isElementVisible(flowTab, 2_000)) await flowTab.click();
    await expect(page.locator('[data-testid="flow-diagram"]').first()).toBeVisible({ timeout: 15_000 });
    const unassignedTab = page.locator('[data-testid="flow-palette-tab-unassigned"]').first();
    if (await testHelpers.isElementVisible(page.locator('[data-testid="flow-open-right-panel"]').first(), 1_000)) {
      await page.locator('[data-testid="flow-open-right-panel"]').first().click();
    }
    await expect(unassignedTab).toBeVisible({ timeout: 10_000 });
    await unassignedTab.click();

    const source = page.locator('[data-testid^="flow-palette-task-"]').filter({ hasText: sourceTitle }).first();
    const target = page.locator('[data-testid^="flow-palette-task-"]').filter({ hasText: targetTitle }).first();
    const sourceId = await source.getAttribute('data-unassigned-task-id');
    const targetId = await target.getAttribute('data-unassigned-task-id');
    expect(sourceId).toBeTruthy();
    expect(targetId).toBeTruthy();

    await source.dragTo(target);
    await waitForParent(page, sourceId!, targetId!);

    const blankTarget = page.locator('div.border-dashed').filter({ has: page.locator('[data-testid^="flow-palette-task-"]') }).first();
    const blankBox = await blankTarget.boundingBox();
    expect(blankBox).toBeTruthy();
    await dispatchRealDrop(page, source, blankTarget);
    await waitForParent(page, sourceId!, targetId!);

    await expect.poll(() => readPersistedTask(page, assignedId), {
      timeout: 10_000,
      intervals: [250, 500, 1_000],
    }).toMatchObject({ id: assignedId, stage: 1 });
    await expect(page.locator('[data-testid^="flow-palette-task-"]').filter({ hasText: assignedTitle }))
      .toHaveCount(0);
    await waitForParent(page, sourceId!, targetId!);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForAppReady(page, { timeoutMs: 30_000, recoverStaticLoader: true });
    await waitForParent(page, sourceId!, targetId!);
  });
});
