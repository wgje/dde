import { expect, Page, test } from '@playwright/test';
import { testHelpers } from './helpers';
import { waitForAppReady } from '../shared/page-helpers';

const LOCAL_MODE_KEY = 'nanoflow.local-mode';
const AUTH_CACHE_KEY = 'nanoflow.auth-cache';

async function ensureLocalModeFlag(page: Page): Promise<void> {
  await page.evaluate(({ localModeKey, authCacheKey }) => {
    localStorage.setItem(localModeKey, 'true');
    localStorage.removeItem(authCacheKey);
    window.dispatchEvent(new Event('nanoflow:local-mode-changed'));
  }, { localModeKey: LOCAL_MODE_KEY, authCacheKey: AUTH_CACHE_KEY });
}

async function dismissLoginModalIfVisible(page: Page): Promise<void> {
  const loginModal = page.locator('[data-testid="login-modal"]').first();
  if (!(await testHelpers.isElementVisible(loginModal, 500))) {
    return;
  }

  const localModeButton = loginModal.locator('[data-testid="local-mode-btn"]').first();
  if (await testHelpers.isElementVisible(localModeButton, 1000)) {
    await localModeButton.click({ force: true });
  } else {
    await loginModal.getByRole('button', { name: '取消' }).first().click({ force: true }).catch(() => {});
  }

  await ensureLocalModeFlag(page);
  await expect(loginModal).toBeHidden({ timeout: 5000 });
}

async function bootstrapLocalWorkspace(page: Page): Promise<void> {
  await page.goto('/');

  const localModeBtn = page.locator('[data-testid="local-mode-btn"]').first();
  if (await testHelpers.isElementVisible(localModeBtn, 8000)) {
    await localModeBtn.click();
  } else {
    await waitForAppReady(page, { timeoutMs: 30_000, recoverStaticLoader: true });
  }
  await ensureLocalModeFlag(page);
  await dismissLoginModalIfVisible(page);

  await expect(page.locator('[data-testid="project-selector"]')).toBeVisible({ timeout: 15000 });
}

function isReloadNavigationInterruption(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('net::ERR_ABORTED') || message.includes('frame was detached');
}

async function reloadWorkspaceAfterStorageSeed(page: Page): Promise<void> {
  try {
    await page.reload({ waitUntil: 'domcontentloaded' });
  } catch (error) {
    if (!isReloadNavigationInterruption(error)) {
      throw error;
    }

    await page.goto('/', { waitUntil: 'domcontentloaded' });
  }

  await waitForAppReady(page, { timeoutMs: 30_000, recoverStaticLoader: true });
}

async function activateSeededProjectAndWaitForDockRestore(
  page: Page,
  projectName: string,
  expectedHudTitles: string[],
): Promise<void> {
  await testHelpers.clickIfVisible(
    page.locator('[data-testid="local-mode-btn"]').first(),
    { timeout: 1200, force: true },
  );

  const seededProject = page.locator('[data-testid="project-item"]').filter({ hasText: projectName }).first();
  await expect(seededProject).toBeVisible({ timeout: 10_000 });
  await seededProject.click({ force: true });

  if (!(await testHelpers.isElementVisible(page.locator('[data-testid="project-shell-main-content"]').first(), 1500))) {
    await seededProject.click({ force: true });
    await enterVisibleProjectWorkspace(page);
  }

  const focusStage = page.locator('[data-testid="dock-v3-focus-stage"]');
  await expect(page.locator('app-parking-dock').first()).toBeAttached({ timeout: 15_000 });
  if (!(await testHelpers.isElementVisible(focusStage, 15_000))) {
    await reloadWorkspaceAfterStorageSeed(page);
    await testHelpers.clickIfVisible(
      page.locator('[data-testid="local-mode-btn"]').first(),
      { timeout: 1200, force: true },
    );
    const reloadedProject = page.locator('[data-testid="project-item"]').filter({ hasText: projectName }).first();
    await expect(reloadedProject).toBeVisible({ timeout: 10_000 });
    await reloadedProject.click({ force: true });
    if (!(await testHelpers.isElementVisible(page.locator('[data-testid="project-shell-main-content"]').first(), 1500))) {
      await reloadedProject.click({ force: true });
      await enterVisibleProjectWorkspace(page);
    }
  }

  await expect(focusStage).toBeVisible({ timeout: 15_000 });
  const statusHud = page.locator('[data-testid="dock-v3-status-machine"]').first();
  for (const title of expectedHudTitles) {
    await expect(statusHud).toContainText(title, { timeout: 15_000 });
  }
}

async function enterVisibleProjectWorkspace(page: Page): Promise<void> {
  const enterButton = page.getByRole('button', { name: /enter/i }).first();
  if (await testHelpers.isElementVisible(enterButton, 1500)) {
    await enterButton.click({ force: true });
  }

  await expect(page.locator('[data-testid="project-shell-main-content"]').first()).toBeVisible({ timeout: 10000 });
}

function projectItemByName(page: Page, projectName: string) {
  return page.locator('[data-testid="project-item"]').filter({ hasText: projectName }).first();
}

async function expandProjectIntroCard(page: Page, projectName: string, projectId: string): Promise<void> {
  const projectItem = page.locator(`[data-testid="project-item"][data-project-id="${projectId}"]`).first();
  await expect(projectItem).toBeVisible({ timeout: 10000 });

  const projectEntry = projectItem.locator('xpath=..');
  const enterButton = projectEntry.getByRole('button', { name: /进入项目|enter/i }).first();
  if (!(await testHelpers.isElementVisible(enterButton, 800))) {
    await projectItem.click({ force: true });
  }

  await expect(enterButton, `项目 ${projectName} 的详情卡未展开`).toBeVisible({ timeout: 10000 });
}

async function enterProjectWorkspace(page: Page, projectName: string, projectId: string): Promise<void> {
  const projectRoutePattern = new RegExp(`#/projects/${projectId}(?:/|$)`);
  await expandProjectIntroCard(page, projectName, projectId);
  const projectEntry = page.locator(`[data-testid="project-item"][data-project-id="${projectId}"]`).first().locator('xpath=..');
  const enterButton = projectEntry.getByRole('button', { name: /进入项目|enter/i }).first();

  await expect
    .poll(async () => {
      if (projectRoutePattern.test(page.url())) {
        return 'active';
      }

      if (await testHelpers.isElementVisible(enterButton, 500)) {
        await enterButton.click({ timeout: 1000 });
      }
      return projectRoutePattern.test(page.url()) ? 'active' : 'waiting';
    }, { timeout: 20000, intervals: [100, 250, 500, 1000] })
    .toBe('active');
  await waitForAppReady(page, { timeoutMs: 30_000, recoverStaticLoader: true });
  await expectProjectActive(page, projectName, projectId);
  await expect(page.locator('[data-testid="project-shell-main-content"]').first()).toBeVisible({ timeout: 10000 });
}

async function expectProjectActive(page: Page, projectName: string, projectId: string): Promise<void> {
  const projectItem = page.locator(`[data-testid="project-item"][data-project-id="${projectId}"]`).first();
  await expect
    .poll(async () => {
      if (await testHelpers.isElementVisible(projectItem, 500)) {
        return true;
      }

      await waitForAppReady(page, { timeoutMs: 30_000, recoverStaticLoader: true }).catch(() => undefined);
      return testHelpers.isElementVisible(projectItem, 500);
    }, {
      timeout: 45_000,
      intervals: [250, 500, 1_000],
      message: `项目 ${projectName} 未在启动恢复后重新出现在项目列表`,
    })
    .toBe(true);
  await expect(projectItem).toBeVisible({ timeout: 10000 });
  await expect(projectItem, `项目 ${projectName} 未切换为当前活动项目`).toHaveClass(/bg-indigo-50/, { timeout: 10000 });
}

async function createAndActivateProject(page: Page, projectName: string): Promise<void> {
  const projectModal = page.locator('[data-testid="new-project-modal"]');
  const projectItem = projectItemByName(page, projectName);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await testHelpers.isElementVisible(projectItem, 500)) {
      break;
    }

    try {
      const createProjectButton = page.locator('[data-testid="create-project-btn"]:visible').first();
      await expect(createProjectButton).toBeVisible({ timeout: 8000 });
      await expect
        .poll(async () => {
          await createProjectButton.evaluate((element: HTMLElement) => element.click());
          return testHelpers.isElementVisible(projectModal, 500);
        }, { timeout: 8000, intervals: [100, 300, 700, 1000] })
        .toBe(true);
      await expect(projectModal).toBeVisible({ timeout: 1000 });

      const nameInput = page.locator('[data-testid="project-name-input"]').first();
      await expect(nameInput).toBeVisible({ timeout: 5000 });
      await nameInput.fill(projectName);
      const submit = page.locator('[data-testid="create-project-confirm"]').first();
      await expect(submit).toBeEnabled({ timeout: 5000 });
      await submit.click({ force: true });
      await expect(projectModal).toBeHidden({ timeout: 8000 });
    } catch (error) {
      if (attempt === 2) {
        throw error;
      }
      await waitForAppReady(page, { timeoutMs: 30_000, recoverStaticLoader: true });
      await expect(projectModal).toBeHidden({ timeout: 3000 }).catch(() => {});
    }
  }

  await expect(projectItem).toBeVisible({ timeout: 10000 });
  const projectId = await projectItem.getAttribute('data-project-id');
  expect(projectId, `项目 ${projectName} 缺少 data-project-id`).toBeTruthy();

  await enterProjectWorkspace(page, projectName, projectId!);
  await expectProjectActive(page, projectName, projectId!);
}

async function ensureTextReady(page: Page): Promise<void> {
  const textTab = page.locator('[data-testid="text-view-tab"]').first();
  await testHelpers.clickIfVisible(textTab, { timeout: 1200, force: true });
}

async function ensureFlowReady(page: Page): Promise<void> {
  const diagram = page.locator('[data-testid="flow-diagram"][aria-busy="false"]').first();
  const flowTab = page.locator('[data-testid="flow-view-tab"]').first();
  const flowRetry = page.getByRole('button', { name: /流程图|加载|重试|刷新页面/i }).first();

  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await testHelpers.isElementVisible(diagram, 1000)) {
      return;
    }

    await testHelpers.clickIfVisible(flowTab, { timeout: 3000, force: true });
    await testHelpers.clickIfVisible(flowRetry, { timeout: 1500, force: true });

    if (await testHelpers.isElementVisible(diagram, 15000)) {
      return;
    }

    const appContainerVisible = await testHelpers.isElementVisible(
      page.locator('[data-testid="app-container"]').first(),
      1000,
    );
    if (!appContainerVisible) {
      await page.goto('/', { waitUntil: 'domcontentloaded' });
      await testHelpers.waitForAppReady(page);
    }
  }

  await expect(diagram).toBeVisible({ timeout: 15000 });
}

async function closeMobileSidebarIfVisible(page: Page): Promise<void> {
  const sidebar = page.locator('[data-testid="project-selector"]').first();

  const isMobile = await page.evaluate(() => window.innerWidth < 768).catch(() => false);
  if (!isMobile) {
    return;
  }

  await expect(sidebar).toBeAttached({ timeout: 5000 });

  const isClosed = async () => sidebar.evaluate((element) => {
    const style = getComputedStyle(element);
    return element.getAttribute('aria-hidden') === 'true' || style.pointerEvents === 'none';
  }).catch(() => true);

  if (await isClosed()) {
    return;
  }

  const backdrop = page.locator('[data-testid="project-selector-backdrop"]').first();
  const closeButton = page.locator('[aria-label="关闭侧边栏"]').first();

  await expect
    .poll(async () => {
      if (await isClosed()) {
        return 'closed';
      }

      if (await testHelpers.isElementVisible(closeButton, 300)) {
        await closeButton.click({ force: true }).catch(() => undefined);
      } else if (await testHelpers.isElementVisible(backdrop, 300)) {
        await backdrop.click({ force: true }).catch(() => undefined);
      } else {
        await page.evaluate(() => window.dispatchEvent(new Event('toggle-sidebar'))).catch(() => undefined);
      }

      if (!(await isClosed())) {
        await page.evaluate(() => window.dispatchEvent(new Event('toggle-sidebar'))).catch(() => undefined);
      }

      return await isClosed() ? 'closed' : 'open';
    }, {
      timeout: 8000,
      intervals: [100, 200, 400, 800],
    })
    .toBe('closed');
  await expect(backdrop).toBeHidden({ timeout: 3000 });
}

async function setMobileViewport(page: Page, size = { width: 390, height: 844 }): Promise<void> {
  await page.setViewportSize(size);
  await expect
    .poll(async () => page.evaluate(() => window.innerWidth), {
      timeout: 5000,
      intervals: [100, 200, 400],
    })
    .toBe(size.width);
  await expect(page.locator('[data-testid="project-selector"]').first())
    .toHaveAttribute('data-mobile-overlay', 'true', { timeout: 5000 });
}

async function ensureDockPanelVisible(page: Page): Promise<void> {
  await dismissLoginModalIfVisible(page);
  await closeMobileSidebarIfVisible(page);
  const panel = page.locator('[data-testid="dock-v3-panel"]').first();
  const visibleTrigger = page.locator('[data-testid="dock-v3-semicircle"]:visible').first();
  const trigger = await testHelpers.isElementVisible(visibleTrigger, 800)
    ? visibleTrigger
    : page.locator('[data-testid="dock-v3-semicircle"]').first();
  const expanded = await trigger.getAttribute('aria-expanded').catch(() => null);
  if (expanded === 'true' && await testHelpers.isElementVisible(panel, 800)) {
    return;
  }

  await expect(trigger).toBeVisible({ timeout: 8000 });
  await expect
    .poll(async () => {
      if (await testHelpers.isElementVisible(panel, 300)) {
        return 'expanded';
      }

      await trigger.click();
      return (await trigger.getAttribute('aria-expanded')) === 'true' ? 'expanded' : 'collapsed';
    }, { timeout: 8000, intervals: [100, 200, 400, 800] })
    .toBe('expanded');
  await expect(panel).toBeVisible({ timeout: 8000 });
}

async function dragTaskToDock(page: Page, sourceSelector: string): Promise<void> {
  const source = page.locator(sourceSelector).first();
  const target = page.locator('[data-testid="dock-v3-drop-zone"]').first();
  const dockItems = page.locator('[data-testid="dock-v3-item"]');

  await expect(source).toBeVisible({ timeout: 10000 });
  await expect(target).toBeVisible({ timeout: 10000 });
  const initialDockCount = await dockItems.count();

  const dragMeta = await source.evaluate((element) => {
    const taskId =
      element.getAttribute('data-unassigned-task')
      ?? element.getAttribute('data-task-id')
      ?? element.getAttribute('data-testid')?.replace(/^flow-palette-task-/, '')
      ?? '';
    const sourceKind = element.getAttribute('data-testid')?.startsWith('flow-palette-task-') ? 'flow' : 'text';

    return {
      taskId,
      sourceKind,
    };
  });
  expect(dragMeta.taskId, `拖拽源 ${sourceSelector} 缺少任务 ID`).toBeTruthy();

  await expect
    .poll(async () => {
      const currentCount = await dockItems.count();
      if (currentCount > initialDockCount) {
        return currentCount;
      }

      await dispatchTaskDropSequence(page, source, target, dragMeta);
      return dockItems.count();
    }, {
      timeout: 12_000,
      intervals: [150, 300, 600, 900],
      message: `任务 ${dragMeta.taskId} 未在超时内入坞`,
    })
    .toBeGreaterThan(initialDockCount);
}

async function dispatchTaskDropSequence(
  page: Page,
  source: ReturnType<Page['locator']>,
  target: ReturnType<Page['locator']>,
  dragMeta: { taskId: string; sourceKind: string },
): Promise<void> {
  await expect(source).toBeVisible({ timeout: 2000 });
  await expect(target).toBeVisible({ timeout: 2000 });

  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();
  const eventInit = {
    bubbles: true,
    cancelable: true,
    clientX: Math.round((targetBox?.x ?? 0) + (targetBox?.width ?? 0) / 2),
    clientY: Math.round((targetBox?.y ?? 0) + (targetBox?.height ?? 0) / 2),
  };
  const dataTransfer = await page.evaluateHandle(({ taskId, sourceKind }) => {
    const payload = {
      v: 1,
      type: 'task',
      taskId,
      projectId: null,
      source: sourceKind,
      fromProjectId: null,
    };
    const serialized = JSON.stringify(payload);
    const transfer = new DataTransfer();
    transfer.setData('application/x-nanoflow-task', serialized);
    transfer.setData('text/task-id', taskId);
    transfer.setData('text/plain', taskId);
    transfer.setData('application/json', serialized);
    transfer.effectAllowed = 'move';
    return transfer;
  }, dragMeta);

  await source.dispatchEvent('dragstart', {
    ...eventInit,
    clientX: Math.round((sourceBox?.x ?? 0) + (sourceBox?.width ?? 0) / 2),
    clientY: Math.round((sourceBox?.y ?? 0) + (sourceBox?.height ?? 0) / 2),
    dataTransfer,
  });
  await target.dispatchEvent('dragenter', { ...eventInit, dataTransfer });
  await target.dispatchEvent('dragover', { ...eventInit, dataTransfer });
  await target.dispatchEvent('drop', { ...eventInit, dataTransfer });
  await source.dispatchEvent('dragend', { ...eventInit, dataTransfer });
  await dataTransfer.dispose();
}

async function clickVisibleFocusToggle(page: Page): Promise<boolean> {
  const selectors = [
    '[data-testid="focus-session-trigger"]',
    '[data-testid="project-shell-focus-session-toggle"]',
  ];

  for (const selector of selectors) {
    const toggle = page.locator(selector).first();
    if (await testHelpers.isElementVisible(toggle, 1200)) {
      await toggle.evaluate((element: HTMLElement) => element.click());
      return true;
    }
  }

  return false;
}

async function triggerFocusToggle(page: Page): Promise<void> {
  const clicked = await clickVisibleFocusToggle(page);
  if (clicked) return;

  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('dock-focus-session-toggle'));
  });
}

async function dispatchFocusExitShortcut(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'L',
      altKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    }));
  });
}

async function waitForFocusTransitionStable(page: Page): Promise<void> {
  const mainContent = page.locator('[data-testid="project-shell-main-content"]').first();
  if (!(await mainContent.count())) {
    // 等待主内容容器出现（回退：元素尚未渲染）
    await expect(mainContent).toBeAttached({ timeout: 3000 }).catch(async () => {
      await waitForAppReady(page, { timeoutMs: 30_000, recoverStaticLoader: true });
    });
    return;
  }

  await expect
    .poll(async () => {
      const shellVisible = await testHelpers.isElementVisible(mainContent, 250);
      if (!shellVisible) {
        const recovered = await waitForAppReady(page, {
          timeoutMs: 30_000,
          recoverStaticLoader: true,
        })
          .then(() => true)
          .catch(() => false);
        return recovered ? 'stable' : 'missing';
      }

      const phase = await mainContent.getAttribute('data-dock-takeover-phase');
      return phase === 'entering' || phase === 'exiting' || phase === 'restoring'
        ? 'transitioning'
        : 'stable';
    }, { timeout: 10000, intervals: [200, 300, 500] })
    .toBe('stable');
}

async function enterFocusMode(page: Page): Promise<void> {
  const focusStage = page.locator('[data-testid="dock-v3-focus-stage"]').first();
  const mainContent = page.locator('[data-testid="project-shell-main-content"]').first();
  const disabledInlineTrigger = page.getByRole('button', { name: '进入专注后可用' }).first();

  await expect
    .poll(async () => {
      if (await testHelpers.isElementVisible(focusStage, 250)) {
        return 'stage';
      }

      const phase = await mainContent.getAttribute('data-dock-takeover-phase').catch(() => null);
      if (phase === 'entering' || phase === 'focused' || phase === 'restoring') {
        return await testHelpers.isElementVisible(focusStage, 500) ? 'stage' : 'transitioning';
      }

      if (await testHelpers.isElementVisible(disabledInlineTrigger, 150)) {
        await expect(disabledInlineTrigger).toBeDisabled({ timeout: 500 }).catch(() => undefined);
      }
      await triggerFocusToggle(page);
      if (await testHelpers.isElementVisible(focusStage, 250)) {
        return 'stage';
      }

      return 'waiting';
    }, {
      timeout: 30_000,
      intervals: [100, 250, 500, 1000],
    })
    .toBe('stage');
  await waitForFocusTransitionStable(page);
}

async function openExitConfirm(page: Page): Promise<void> {
  const confirm = page.locator('[data-testid="dock-v3-exit-confirm"]').first();
  if (await testHelpers.isElementVisible(confirm, 800)) {
    return;
  }

  const focusStage = page.locator('[data-testid="dock-v3-focus-stage"]').first();
  if (!(await testHelpers.isElementVisible(focusStage, 800))) {
    await enterFocusMode(page);
  }

  await waitForFocusTransitionStable(page);

  await expect
    .poll(async () => {
      if (await testHelpers.isElementVisible(confirm, 250)) {
        return 'confirm';
      }

      await triggerFocusToggle(page);
      if (await testHelpers.isElementVisible(confirm, 500)) {
        return 'confirm';
      }

      await dispatchFocusExitShortcut(page);
      return await testHelpers.isElementVisible(confirm, 500) ? 'confirm' : 'waiting';
    }, {
      timeout: 10_000,
      intervals: [100, 250, 500, 1000],
    })
    .toBe('confirm');
}

async function saveAndExitFocus(page: Page): Promise<void> {
  await openDestructiveExitChoices(page);
  await page.locator('[data-testid="dock-v3-exit-save"]').click({ force: true });
  await expect(page.locator('[data-testid="dock-v3-focus-stage"]')).toBeHidden({ timeout: 10000 });
  await waitForFocusTransitionStable(page);
}

async function openDestructiveExitChoices(page: Page): Promise<void> {
  await openExitConfirm(page);
  await page.locator('[data-testid="dock-v3-exit-request-end"]').click({ force: true });
  await expect(page.locator('[data-testid="dock-v3-exit-save"]')).toBeVisible({ timeout: 5000 });
}

async function measureDockTargets(page: Page): Promise<Record<string, { width: number; height: number } | null>> {
  return page.evaluate(() => {
    const selectors = {
      plannerToggle: '[data-testid="dock-v3-planner-toggle"]',
      waitButton: '[data-testid="dock-v3-wait-trigger"]',
      muteButton: '[data-testid="dock-v3-status-mute"]',
    } as const;

    return Object.fromEntries(
      Object.entries(selectors).map(([key, selector]) => {
        const element = Array.from(document.querySelectorAll<HTMLElement>(selector)).find(candidate => {
          const rect = candidate.getBoundingClientRect();
          const style = window.getComputedStyle(candidate);
          return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        }) ?? null;
        if (!element) return [key, null];
        const rect = element.getBoundingClientRect();
        return [key, { width: rect.width, height: rect.height }];
      }),
    );
  });
}

async function createDockTaskByForm(page: Page, title: string): Promise<void> {
  await ensureDockPanelVisible(page);
  const panel = page.locator('[data-testid="dock-v3-panel"]').first();
  const toggle = panel.locator('[data-testid="dock-v3-create-toggle"]').first();
  await expect(toggle).toBeVisible({ timeout: 10000 });
  if ((await toggle.getAttribute('aria-expanded').catch(() => null)) !== 'true') {
    await expect(toggle).toBeEnabled({ timeout: 15000 });
    await expect
      .poll(async () => {
        await toggle.evaluate((el: HTMLElement) => el.click());
        return toggle.getAttribute('aria-expanded');
      }, { timeout: 5000, intervals: [100, 200, 400, 800] })
      .toBe('true');
  }

  const form = panel.locator('[data-testid="dock-v3-new-task-form"]').first();
  await expect(form).toBeVisible({ timeout: 5000 });

  await form.locator('input').first().fill(title);
  const selects = form.locator('select');
  if ((await selects.count()) > 0) {
    await selects.nth(0).selectOption('backup').catch(() => {});
  }
  if ((await selects.count()) > 1) {
    await selects.nth(1).selectOption('low').catch(() => {});
  }
  await form.getByPlaceholder('预计(min)').first().fill('15');

  const submit = panel.locator('[data-testid="dock-v3-create-submit"]').first();
  await expect(submit).toBeEnabled({ timeout: 5000 });
  await submit.evaluate((el: HTMLElement) => el.click());
  await expect(page.locator('[data-testid="dock-v3-item"]').filter({ hasText: title }).first()).toBeVisible({ timeout: 10000 });
}

async function createInlineTaskInFocus(page: Page, times = 1): Promise<void> {
  const fab = page.locator('[data-testid="dock-v3-backup-fab"]').first();
  if (!(await testHelpers.isElementVisible(fab, 1500))) {
    await testHelpers.clickIfVisible(
      page.locator('[data-testid="dock-v3-focus-toggle"]').first(),
      { timeout: 1500, force: true },
    );
  }

  await expect(fab).toBeVisible({ timeout: 10000 });
  for (let i = 0; i < times; i += 1) {
    await fab.click({ force: true });
  }
}

async function seedDockSnapshot(page: Page, snapshot: Record<string, unknown>): Promise<void> {
  await page.evaluate(async ({ payload, localModeKey, authCacheKey }) => {
    localStorage.setItem(localModeKey, 'true');
    localStorage.removeItem(authCacheKey);
    window.dispatchEvent(new Event('nanoflow:local-mode-changed'));

    const serialized = JSON.stringify(payload);
    localStorage.setItem('nanoflow.dock-snapshot.v3.local-user', serialized);
    localStorage.setItem('nanoflow.dock-snapshot.v3.anonymous', serialized);

    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('keyval-store');
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve(req.result);
    });

    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('keyval', 'readwrite');
      const store = tx.objectStore('keyval');
      store.put(payload, 'nanoflow.focus-session.v5.local-user');
      store.put(payload, 'nanoflow.focus-session.v5.anonymous');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });

    db.close();
  }, { payload: snapshot, localModeKey: LOCAL_MODE_KEY, authCacheKey: AUTH_CACHE_KEY });
}

async function createTextTask(page: Page, title: string) {
  await ensureTextReady(page);
  const createButton = page.locator('app-text-unassigned button').filter({ hasText: '新建' }).first();
  await expect(createButton).toBeVisible({ timeout: 10000 });
  await createButton.click({ force: true });

  const titleInput = page.locator('[data-unassigned-task] [data-title-input]').first();
  await expect(titleInput).toBeVisible({ timeout: 10000 });
  await titleInput.fill(title);
  await titleInput.press('Enter');

  const taskCard = page.locator(`[data-unassigned-task]:has-text("${title}")`).first();
  await expect(taskCard).toBeVisible({ timeout: 10000 });
  return taskCard;
}

async function createFlowPaletteTask(page: Page, title: string): Promise<string> {
  await createTextTask(page, title);
  await ensureFlowReady(page);
  await page.locator('[data-testid="flow-palette-tab-unassigned"]').first().click({ force: true });

  await expect(page.locator('[data-testid^="flow-palette-task-"]').filter({ hasText: title }).first()).toBeVisible({ timeout: 10000 });
  return title;
}

async function prepareWaitChain(page: Page, prefix: string): Promise<{ mainTitle: string; subTitle: string }> {
  const mainTitle = `${prefix}-A`;
  const subTitle = `${prefix}-B`;
  await createDockTaskByForm(page, mainTitle);
  await createDockTaskByForm(page, subTitle);
  await enterFocusMode(page);
  await switchDockItemToConsole(page, mainTitle);

  const waitTrigger = page.locator('[data-testid="dock-v3-wait-trigger"]').first();
  await expect(waitTrigger).toBeVisible({ timeout: 10000 });
  await waitTrigger.evaluate((el: HTMLElement) => el.click());
  await expect(page.locator('[data-testid="dock-v3-wait-menu"]').first()).toBeVisible({ timeout: 5000 });

  const shortWaitPreset = page.locator('[data-testid="dock-v3-wait-preset"]').filter({ hasText: '5 分钟' }).first();
  await expect(shortWaitPreset).toBeVisible({ timeout: 5000 });
  await shortWaitPreset.evaluate((el: HTMLElement) => el.click());

  const pendingChoice = page.locator('[data-testid="dock-v3-pending-choice-0"]').first();
  await expect(pendingChoice).toBeVisible({ timeout: 10000 });
  await pendingChoice.click({ force: true });

  return { mainTitle, subTitle };
}

async function reachFragmentCountdownFromShortWait(page: Page, prefix: string): Promise<void> {
  const mainTitle = `${prefix}-A`;
  await createDockTaskByForm(page, mainTitle);
  await createDockTaskByForm(page, `${prefix}-B`);
  await enterFocusMode(page);
  await switchDockItemToConsole(page, mainTitle);

  const waitTrigger = page.locator('[data-testid="dock-v3-wait-trigger"]').first();
  await expect(waitTrigger).toBeVisible({ timeout: 10000 });
  await waitTrigger.evaluate((el: HTMLElement) => el.click());
  await expect(page.locator('[data-testid="dock-v3-wait-menu"]').first()).toBeVisible({ timeout: 5000 });

  const shortWaitPreset = page.locator('[data-testid="dock-v3-wait-preset"]').filter({ hasText: '5 分钟' }).first();
  await expect(shortWaitPreset).toBeVisible({ timeout: 5000 });
  await shortWaitPreset.evaluate((el: HTMLElement) => el.click());

  const pendingChoice = page.locator('[data-testid="dock-v3-pending-choice-0"]').first();
  await expect(pendingChoice).toBeVisible({ timeout: 10000 });
  await pendingChoice.click({ force: true });

  await completeFocusedTaskUntilFragmentCountdown(page);
}

async function completeFocusedTaskUntilFragmentCountdown(page: Page): Promise<void> {
  const countdown = page.locator('[data-testid="fragment-countdown-number"]');
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await confirmFocusedTaskCompletion(page);
    if (await testHelpers.isElementVisible(countdown, 2500)) {
      return;
    }
  }
  await expect(countdown).toBeVisible({ timeout: 10000 });
}

async function confirmFocusedTaskCompletion(page: Page): Promise<void> {
  await expect
    .poll(async () => page.locator('[data-testid="dock-v3-console-card"].is-animating').count(), {
      timeout: 10000,
      intervals: [100, 150, 250],
    })
    .toBe(0);
  const completeBtn = page.locator('[data-testid="dock-v3-complete-btn"]').first();
  await expect(completeBtn).toBeVisible({ timeout: 10000 });
  await completeBtn.evaluate((el: HTMLElement) => el.click());
  // H-11 fix: 等待完成按钮消失或 console card 更新，替代盲等 900ms
  await expect(completeBtn).toBeHidden({ timeout: 10000 }).catch(() => {
    // 按钮可能仍可见（下一个任务的完成按钮），容忍超时
  });
}

async function switchDockItemToConsole(page: Page, title: string): Promise<void> {
  const targetItem = page.locator('[data-testid="dock-v3-item"]').filter({ hasText: title }).first();
  const firstConsoleCard = page.locator('[data-testid="dock-v3-console-card"]').first();

  await expect(targetItem).toBeVisible({ timeout: 10000 });
  await targetItem.scrollIntoViewIfNeeded();
  await expect
    .poll(async () => {
      if ((await firstConsoleCard.textContent().catch(() => '')).includes(title)) {
        return 'focused';
      }

      if (await testHelpers.isElementVisible(targetItem, 500)) {
        await targetItem.evaluate((element: HTMLElement) => element.click());
      }

      await expect
        .poll(async () => page.locator('[data-testid="dock-v3-console-card"].is-animating').count(), {
          timeout: 2_000,
          intervals: [100, 150, 250],
        })
        .toBe(0)
        .catch(() => undefined);

      return (await firstConsoleCard.textContent().catch(() => '')).includes(title) ? 'focused' : 'waiting';
    }, {
      timeout: 15_000,
      intervals: [150, 300, 600],
      message: `停泊坞任务 ${title} 未切换到主控台前台`,
    })
    .toBe('focused');
}

async function readDockSnapshotFromIdb(page: Page): Promise<any | null> {
  return page.evaluate(async () => {
    const keyPrefix = 'nanoflow.focus-session.v5.';
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('keyval-store');
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve(req.result);
    });

    const result = await new Promise<any | null>((resolve, reject) => {
      const tx = db.transaction('keyval', 'readonly');
      const store = tx.objectStore('keyval');
      const keysReq = store.getAllKeys();
      const valuesReq = store.getAll();

      tx.onabort = () => reject(tx.error);
      tx.onerror = () => reject(tx.error);
      tx.oncomplete = () => {
        const keys = (keysReq.result ?? []) as unknown[];
        const values = (valuesReq.result ?? []) as unknown[];
        let latest: any | null = null;
        let latestTs = Number.NEGATIVE_INFINITY;

        for (let i = 0; i < keys.length; i += 1) {
          const key = keys[i];
          if (typeof key !== 'string' || !key.startsWith(keyPrefix)) continue;
          const value = values[i] as { savedAt?: unknown } | undefined;
          if (!value) continue;
          const ts =
            typeof value.savedAt === 'string' && Number.isFinite(Date.parse(value.savedAt))
              ? Date.parse(value.savedAt)
              : 0;
          if (!latest || ts >= latestTs) {
            latest = value;
            latestTs = ts;
          }
        }

        resolve(latest);
      };
    });
    db.close();
    return result;
  });
}

async function readBlackBoxEntryFromIdb(page: Page, entryId: string): Promise<any | null> {
  return page.evaluate(async (id: string) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('focus_mode');
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve(req.result);
    });

    const value = await new Promise<any>((resolve, reject) => {
      const tx = db.transaction('black_box_entries', 'readonly');
      const store = tx.objectStore('black_box_entries');
      const req = store.get(id);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve(req.result ?? null);
    });

    db.close();
    return value;
  }, entryId);
}

test.describe('ParkingDock V3 critical paths', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(90_000);

  test('dock-v3 panel is always visible and focus stage toggles on/off', async ({ page }) => {
    await bootstrapLocalWorkspace(page);
    await createAndActivateProject(page, `DockV3-${testHelpers.uniqueId()}`);
    const taskTitle = `DockItem-${testHelpers.uniqueId()}`;

    await expect(page.locator('[data-testid="dock-v3-panel"]')).toBeVisible({ timeout: 10000 });
    await createDockTaskByForm(page, taskTitle);
    await expect(page.locator('[data-testid="dock-v3-item"]').filter({ hasText: taskTitle })).toHaveCount(1);

    await enterFocusMode(page);
    await expect(page.locator('[data-testid="dock-v3-first-main-hint"]')).toBeVisible({ timeout: 3000 });
    await saveAndExitFocus(page);
  });

  test('full mode shows advanced entry and keeps dock hints/drop-zone', async ({ page }) => {
    await bootstrapLocalWorkspace(page);
    await createAndActivateProject(page, `DockStrict-${testHelpers.uniqueId()}`);

    await expect(page.locator('[data-testid="dock-v3-create-toggle"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="dock-v3-drop-zone"]')).toBeVisible({ timeout: 8000 });
  });

  test('cross-project drag keeps dock pool persistent after project switch', async ({ page }) => {
    await bootstrapLocalWorkspace(page);

    const projectA = `DockCrossA-${testHelpers.uniqueId()}`;
    const projectB = `DockCrossB-${testHelpers.uniqueId()}`;

    await createAndActivateProject(page, projectA);
    await createDockTaskByForm(page, `Cross-${testHelpers.uniqueId()}`);

    const countBefore = await page.locator('[data-testid="dock-v3-item"]').count();
    expect(countBefore).toBeGreaterThanOrEqual(1);

    await createAndActivateProject(page, projectB);
    await expect(page.locator('[data-testid="dock-v3-item"]')).toHaveCount(countBefore);
  });

  test('text view task can be dragged directly into the dock', async ({ page }) => {
    await bootstrapLocalWorkspace(page);
    await createAndActivateProject(page, `DockTextDrag-${testHelpers.uniqueId()}`);

    const taskTitle = `TextDrag-${testHelpers.uniqueId()}`;
    await createTextTask(page, taskTitle);
    await ensureDockPanelVisible(page);
    await dragTaskToDock(page, `[data-unassigned-task]:has-text("${taskTitle}")`);

    await expect(page.locator('[data-testid="dock-v3-item"]')).toHaveCount(1, { timeout: 10000 });
  });

  test('flow view task can be dragged directly into the dock', async ({ page }) => {
    await bootstrapLocalWorkspace(page);
    await createAndActivateProject(page, `DockFlowDrag-${testHelpers.uniqueId()}`);

    const flowTaskTitle = await createFlowPaletteTask(page, `FlowDrag-${testHelpers.uniqueId()}`);
    await ensureDockPanelVisible(page);
    await dragTaskToDock(page, '[data-testid^="flow-palette-task-"]:has-text("' + flowTaskTitle + '")');

    await expect(page.locator('[data-testid="dock-v3-item"]').filter({ hasText: flowTaskTitle }).first()).toBeVisible({ timeout: 10000 });
  });

  test('attribute sync keeps dock planner interactions available', async ({ page }) => {
    await bootstrapLocalWorkspace(page);
    await createAndActivateProject(page, `DockSync-${testHelpers.uniqueId()}`);
    const taskTitle = `Sync-${testHelpers.uniqueId()}`;
    await createDockTaskByForm(page, taskTitle);

    const dockItem = page.locator('[data-testid="dock-v3-item"]').filter({ hasText: taskTitle }).first();
    await expect(dockItem).toBeVisible({ timeout: 10000 });
    await dockItem.locator('[data-testid="dock-v3-planner-toggle"]').evaluate((el: HTMLElement) => el.click());
    await expect(page.locator('[data-testid="dock-v3-planner-panel"]').first()).toBeVisible({ timeout: 5000 });
    await page.locator('[data-testid="dock-v3-planner-load-high"]').first().evaluate((el: HTMLElement) => el.click());
    await page.locator('[data-testid="dock-v3-planner-expected"]').filter({ hasText: '45m' }).first().evaluate((el: HTMLElement) => el.click());
    await page.locator('[data-testid="dock-v3-planner-wait"]').filter({ hasText: '15m' }).first().evaluate((el: HTMLElement) => el.click());
    await expect(page.locator('[data-testid="dock-v3-planner-panel"]').first()).toBeVisible({ timeout: 5000 });
  });

  test('focus scrim should keep backup FAB and planner actions responsive', async ({ page }) => {
    await bootstrapLocalWorkspace(page);
    await createAndActivateProject(page, `DockFocusActions-${testHelpers.uniqueId()}`);
    const taskTitle = `FocusActions-${testHelpers.uniqueId()}`;

    await createDockTaskByForm(page, taskTitle);
    await enterFocusMode(page);
    await ensureDockPanelVisible(page);

    const initialCount = await page.locator('[data-testid="dock-v3-item"]').count();
    await createInlineTaskInFocus(page, 1);
    await expect(page.locator('[data-testid="dock-v3-item"]')).toHaveCount(initialCount + 1, { timeout: 10000 });

    const dockItem = page.locator('[data-testid="dock-v3-item"]').filter({ hasText: taskTitle }).first();
    await dockItem.scrollIntoViewIfNeeded();
    await dockItem.locator('[data-testid="dock-v3-planner-toggle"]').evaluate((el: HTMLElement) => el.click());
    await expect(page.locator('[data-testid="dock-v3-planner-panel"]').first()).toBeVisible({ timeout: 5000 });
    await page.locator('[data-testid="dock-v3-planner-expected"]').filter({ hasText: '45m' }).first().evaluate((el: HTMLElement) => el.click());
    await page.locator('[data-testid="dock-v3-planner-wait"]').filter({ hasText: '15m' }).first().evaluate((el: HTMLElement) => el.click());
    await expect(page.locator('[data-testid="dock-v3-planner-panel"]').first()).toBeVisible({ timeout: 5000 });
  });

  test('pending decision path actions remain available in focus mode', async ({ page }) => {
    await bootstrapLocalWorkspace(page);
    await createAndActivateProject(page, `DockDecision-${testHelpers.uniqueId()}`);

    await createDockTaskByForm(page, `Decision-A-${testHelpers.uniqueId()}`);
    await createDockTaskByForm(page, `Decision-B-${testHelpers.uniqueId()}`);
    await createDockTaskByForm(page, `Decision-C-${testHelpers.uniqueId()}`);
    await createDockTaskByForm(page, `Decision-D-${testHelpers.uniqueId()}`);
    await enterFocusMode(page);

    const waitTrigger = page.locator('[data-testid="dock-v3-wait-trigger"]').first();
    if (await testHelpers.isElementVisible(waitTrigger, 2000)) {
      await waitTrigger.click({ force: true });
      await testHelpers.clickIfVisible(
        page.locator('[data-testid="dock-v3-wait-preset"]').filter({ hasText: '30 分钟' }).first(),
        { timeout: 1500, force: true },
      );
    }

    await testHelpers.clickIfVisible(
      page.locator('[data-testid="dock-v3-complete-btn"]').first(),
      { timeout: 2000, force: true },
    );

    await expect(page.locator('[data-testid="dock-v3-focus-stage"]')).toBeVisible({ timeout: 10000 });
  });

  test('focus stack card interactions should keep console stable', async ({ page }) => {
    await bootstrapLocalWorkspace(page);
    await createAndActivateProject(page, `DockSmooth-${testHelpers.uniqueId()}`);

    await createDockTaskByForm(page, `Smooth-A-${testHelpers.uniqueId()}`);
    await createDockTaskByForm(page, `Smooth-B-${testHelpers.uniqueId()}`);
    await createDockTaskByForm(page, `Smooth-C-${testHelpers.uniqueId()}`);
    await enterFocusMode(page);

    const cards = page.locator('[data-testid="dock-v3-console-card"]');
    await expect(cards.first()).toBeVisible({ timeout: 10000 });
    if ((await cards.count()) > 1) {
      await cards.nth(1).click({ force: true });
    } else {
      await cards.first().click({ force: true });
    }
    await expect(cards.first()).toBeVisible({ timeout: 10000 });
  });

  test('background dock cards should announce and sync front-task switches while scrim is on', async ({ page }) => {
    await bootstrapLocalWorkspace(page);
    await createAndActivateProject(page, `DockSecondary-${testHelpers.uniqueId()}`);

    await createDockTaskByForm(page, `Secondary-A-${testHelpers.uniqueId()}`);
    await createDockTaskByForm(page, `Secondary-B-${testHelpers.uniqueId()}`);
    await enterFocusMode(page);
    await ensureDockPanelVisible(page);

    const dockItems = page.locator('[data-testid="dock-v3-item"]');
    await expect(dockItems).toHaveCount(2, { timeout: 10000 });
    const secondaryTitle = `Secondary-B`;
    await switchDockItemToConsole(page, secondaryTitle);

    await expect(page.locator('[data-testid="dock-v3-console-card"]').first()).toContainText(/Secondary-B/, { timeout: 10000 });
    await expect(page.locator('[data-testid="dock-v3-status-machine"]').first()).toContainText(/Secondary-B/, { timeout: 10000 });
    await expect
      .poll(async () => (await page.locator('[data-testid="dock-v3-dock-feedback"]').textContent().catch(() => '')).trim(), {
        timeout: 3000,
        intervals: [100, 200, 500],
      })
      .toMatch(/已切换到前台|已改选前台任务/);
  });

  test('status hud should render all four visible states directly when four entries are present', async ({ page }) => {
    await bootstrapLocalWorkspace(page);
    await createAndActivateProject(page, `DockHudOverflow-${testHelpers.uniqueId()}`);
    const nowIso = new Date().toISOString();
    const waitStartedAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();

    await seedDockSnapshot(page, {
      version: 7,
      entries: [
        {
          taskId: 'hud-focus',
          title: 'HUD Focus',
          sourceProjectId: null,
          status: 'focusing',
          load: 'low',
          expectedMinutes: 25,
          waitMinutes: null,
          waitStartedAt: null,
          lane: 'combo-select',
          zoneSource: 'manual',
          isMain: true,
          dockedOrder: 0,
          detail: '',
          sourceKind: 'dock-created',
          sourceBlackBoxEntryId: null,
          inlineArchiveStatus: 'pending',
          systemSelected: false,
          recommendedScore: null,
        },
        {
          taskId: 'hud-wait-a',
          title: 'HUD Wait A',
          sourceProjectId: null,
          status: 'suspended_waiting',
          load: 'low',
          expectedMinutes: 15,
          waitMinutes: 30,
          waitStartedAt,
          lane: 'combo-select',
          zoneSource: 'manual',
          isMain: false,
          dockedOrder: 1,
          detail: '',
          sourceKind: 'dock-created',
          sourceBlackBoxEntryId: null,
          inlineArchiveStatus: 'pending',
          systemSelected: false,
          recommendedScore: null,
        },
        {
          taskId: 'hud-wait-b',
          title: 'HUD Wait B',
          sourceProjectId: null,
          status: 'suspended_waiting',
          load: 'high',
          expectedMinutes: 20,
          waitMinutes: 45,
          waitStartedAt,
          lane: 'backup',
          zoneSource: 'manual',
          isMain: false,
          dockedOrder: 2,
          detail: '',
          sourceKind: 'dock-created',
          sourceBlackBoxEntryId: null,
          inlineArchiveStatus: 'pending',
          systemSelected: false,
          recommendedScore: null,
        },
        {
          taskId: 'hud-stalled',
          title: 'HUD Stalled',
          sourceProjectId: null,
          status: 'stalled',
          load: 'low',
          expectedMinutes: 10,
          waitMinutes: null,
          waitStartedAt: null,
          lane: 'backup',
          zoneSource: 'manual',
          isMain: false,
          dockedOrder: 3,
          detail: '',
          sourceKind: 'dock-created',
          sourceBlackBoxEntryId: null,
          inlineArchiveStatus: 'pending',
          systemSelected: false,
          recommendedScore: null,
        },
      ],
      focusMode: true,
      isDockExpanded: true,
      muteWaitTone: false,
      session: {
        firstDragIntervened: true,
        focusBlurOn: true,
        focusScrimOn: true,
        mainTaskId: 'hud-focus',
        comboSelectIds: ['hud-focus', 'hud-wait-a'],
        backupIds: ['hud-wait-b', 'hud-stalled'],
      },
      firstDragDone: true,
      dailySlots: [],
      suspendChainRootTaskId: null,
      suspendRecommendationLocked: false,
      pendingDecision: null,
      lastRuleDecision: null,
      dailyResetDate: '2026-03-15',
      savedAt: nowIso,
    });

    await reloadWorkspaceAfterStorageSeed(page);
    await activateSeededProjectAndWaitForDockRestore(page, 'DockHudOverflow', [
      'HUD Focus',
      'HUD Wait A',
      'HUD Wait B',
      'HUD Stalled',
    ]);
    const statusHud = page.locator('[data-testid="dock-v3-status-machine"]').first();
    await expect(page.locator('[data-testid="dock-v3-status-overflow"]')).toHaveCount(0);
  });

  test('repeated focus task switches should leave no ghost or stuck takeover phase', async ({ page }) => {
    await bootstrapLocalWorkspace(page);
    await createAndActivateProject(page, `DockRepeat-${testHelpers.uniqueId()}`);

    await createDockTaskByForm(page, `Repeat-A-${testHelpers.uniqueId()}`);
    await createDockTaskByForm(page, `Repeat-B-${testHelpers.uniqueId()}`);
    await createDockTaskByForm(page, `Repeat-C-${testHelpers.uniqueId()}`);
    await enterFocusMode(page);

    const cards = page.locator('[data-testid="dock-v3-console-card"]');
    await expect(cards.first()).toBeVisible({ timeout: 10000 });

    const clickCardAt = async (index: number): Promise<void> => {
      const count = await cards.count();
      const safeIndex = Math.min(index, Math.max(0, count - 1));
      await cards.nth(safeIndex).click({ force: true });
      await expect(cards.first()).toBeVisible({ timeout: 10000 });
    };

    await clickCardAt(1);
    await clickCardAt(2);
    await clickCardAt(1);

    await expect(page.locator('[data-testid="dock-v3-focus-stage"]')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('[data-testid="dock-v4-flip-ghost"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="project-shell-main-content"]')).toHaveAttribute('data-dock-takeover-phase', 'focused');
  });

  test('topmost backdrop click should close the help overlay before touching focus mode', async ({ page }) => {
    await bootstrapLocalWorkspace(page);
    await createAndActivateProject(page, `DockScrim-${testHelpers.uniqueId()}`);

    await createDockTaskByForm(page, `Scrim-${testHelpers.uniqueId()}`);
    await enterFocusMode(page);
    
    // 使用 Alt+H 快捷键打开帮助覆盖层
    await page.keyboard.press('Alt+H');
    await expect(page.locator('[data-testid="dock-v3-help-overlay"]')).toBeVisible({ timeout: 5000 });

    const backdrop = page.locator('[data-testid="dock-v3-focus-backdrop"]');
    await expect(backdrop).toHaveClass(/active/, { timeout: 8000 });

    await page.locator('[data-testid="dock-v3-help-overlay"]').click({ position: { x: 20, y: 20 } });
    await expect(page.locator('[data-testid="dock-v3-help-overlay"]')).toBeHidden({ timeout: 5000 });
    await expect(page.locator('[data-testid="dock-v3-focus-stage"]')).toBeVisible({ timeout: 8000 });
    await expect(backdrop).toHaveClass(/active/, { timeout: 8000 });
  });

  test('offline backup FAB creation should keep working and survive reconnect', async ({ page, context }) => {
    await bootstrapLocalWorkspace(page);
    await createAndActivateProject(page, `DockOffline-${testHelpers.uniqueId()}`);

    await createDockTaskByForm(page, `Offline-${testHelpers.uniqueId()}`);
    await enterFocusMode(page);

    await testHelpers.setOffline(page, context, true);
    await createInlineTaskInFocus(page, 1);
    await expect(page.locator('[data-testid="dock-v3-item"]').first()).toBeVisible({ timeout: 10000 });

    await testHelpers.setOffline(page, context, false);
    // 等待同步防抖完成后 focus-stage 重新可见，替代盲等 3.5s
    await expect(page.locator('[data-testid="dock-v3-focus-stage"]')).toBeVisible({ timeout: 15000 });
  });

  test('exit confirm should support keep/clear/save three branches without archive prompt', async ({ page }) => {
    await bootstrapLocalWorkspace(page);
    await createAndActivateProject(page, `DockExit-${testHelpers.uniqueId()}`);

    await createDockTaskByForm(page, `Exit-${testHelpers.uniqueId()}`);
    await enterFocusMode(page);

    await openExitConfirm(page);
    await page.locator('[data-testid="dock-v3-exit-keep"]').click({ force: true });
    await expect(page.locator('[data-testid="dock-v3-focus-stage"]')).toBeVisible({ timeout: 10000 });
    const backdrop = page.locator('[data-testid="dock-v3-focus-backdrop"]').first();
    await expect(backdrop).not.toHaveClass(/active/, { timeout: 10000 });

    const scrimToggle = page.locator('[data-testid="dock-v3-focus-toggle"]').first();
    if (await testHelpers.isElementVisible(scrimToggle, 1500)) {
      await scrimToggle.evaluate((el: HTMLElement) => el.click());
      await expect(backdrop).toHaveClass(/active/, { timeout: 10000 });
    }

    await openDestructiveExitChoices(page);
    await page.locator('[data-testid="dock-v3-exit-clear"]').click({ force: true });
    await expect(page.locator('[data-testid="dock-v3-focus-stage"]')).toBeHidden({ timeout: 10000 });
    await waitForFocusTransitionStable(page);
    await expect(page.locator('[data-testid="dock-v3-item"]')).toHaveCount(0, { timeout: 10000 });

    await createDockTaskByForm(page, `ExitSave-${testHelpers.uniqueId()}`);
    await enterFocusMode(page);
    await saveAndExitFocus(page);
    await expect(page.locator('[data-testid="dock-v3-item"]')).toHaveCount(1, { timeout: 10000 });
  });

  test('save-exit should keep sidebar restore in a dedicated restoring phase before returning interactive', async ({ page }) => {
    await bootstrapLocalWorkspace(page);
    await createAndActivateProject(page, `DockRestorePhase-${testHelpers.uniqueId()}`);

    await createDockTaskByForm(page, `Restore-${testHelpers.uniqueId()}`);
    await enterFocusMode(page);

    await openDestructiveExitChoices(page);
    await page.locator('[data-testid="dock-v3-exit-save"]').click({ force: true });

    const mainContent = page.locator('[data-testid="project-shell-main-content"]').first();
    const projectSelector = page.locator('[data-testid="project-selector"]').first();

    await expect(mainContent).toHaveAttribute('data-dock-takeover-phase', 'restoring', { timeout: 10000 });
    await expect
      .poll(async () => projectSelector.evaluate((el) => window.getComputedStyle(el).pointerEvents))
      .toBe('none');

    await waitForFocusTransitionStable(page);
    await expect
      .poll(async () => projectSelector.evaluate((el) => window.getComputedStyle(el).pointerEvents))
      .toBe('auto');
  });

  test('shared black-box entries should persist sourceBlackBoxEntryId and focus_meta in local stores', async ({ page }) => {
    await bootstrapLocalWorkspace(page);
    await createAndActivateProject(page, `DockShared-${testHelpers.uniqueId()}`);
    await ensureLocalModeFlag(page);

    const taskTitle = `Shared-${testHelpers.uniqueId()}`;
    await createDockTaskByForm(page, taskTitle);

    let sharedEntry: {
      sourceProjectId?: string | null;
      sourceBlackBoxEntryId?: string | null;
    } | null = null;

    await expect.poll(async () => {
      const snapshot = await readDockSnapshotFromIdb(page);
      const entries = ((snapshot as { entries?: Array<{ sourceProjectId?: string | null; sourceBlackBoxEntryId?: string | null }> })?.entries ?? []);
      sharedEntry = entries.find(entry => typeof entry.sourceBlackBoxEntryId === 'string' && entry.sourceBlackBoxEntryId.length > 0) ?? null;
      return sharedEntry;
    }, { timeout: 10_000, intervals: [500] }).toBeTruthy();

    const resolvedSharedEntry = sharedEntry as {
      sourceProjectId?: string | null;
      sourceBlackBoxEntryId?: string | null;
    } | null;

    expect(resolvedSharedEntry?.sourceProjectId ?? null).toBeNull();

    const blackBoxEntryId = resolvedSharedEntry?.sourceBlackBoxEntryId;
    expect(blackBoxEntryId).toBeTruthy();

    let blackBoxEntry: any | null = null;
    await expect.poll(async () => {
      blackBoxEntry = await readBlackBoxEntryFromIdb(page, blackBoxEntryId as string);
      return blackBoxEntry;
    }, { timeout: 10_000, intervals: [500] }).toBeTruthy();

    expect(blackBoxEntry).toBeTruthy();
    expect((blackBoxEntry as { projectId?: string | null })?.projectId ?? null).toBeNull();
    expect((blackBoxEntry as { focusMeta?: { source?: string } })?.focusMeta?.source).toBe('focus-console-inline');
  });

  test('status machine can switch back to main task and mark the interrupted subtask as stalled', async ({ page }) => {
    await bootstrapLocalWorkspace(page);
    await createAndActivateProject(page, `DockStatus-${testHelpers.uniqueId()}`);

    const chain = await prepareWaitChain(page, `Status-${testHelpers.uniqueId()}`);
    // H-10 fix: 等待可观测 UI 状态（suspended entry 出现），而非硬编码 16s
    const suspendedEntry = page.locator('[data-testid="dock-v3-status-entry-suspended"]').filter({ hasText: chain.mainTitle }).first();
    await expect(suspendedEntry).toBeVisible({ timeout: 320_000 });
    await suspendedEntry.evaluate((el: HTMLElement) => el.click());

    const stalledEntry = page.locator('[data-testid="dock-v3-status-entry-stalled"]').filter({ hasText: chain.subTitle }).first();
    await expect(stalledEntry).toBeVisible({ timeout: 10000 });
  });

  test('main completion should restore the stalled task before fresh recommendations', async ({ page }) => {
    await bootstrapLocalWorkspace(page);
    await createAndActivateProject(page, `DockRestore-${testHelpers.uniqueId()}`);

    const chain = await prepareWaitChain(page, `Restore-${testHelpers.uniqueId()}`);
    // H-10 fix: 等待可观测 UI 状态而非硬编码 16s
    const suspendedForRestore = page.locator('[data-testid="dock-v3-status-entry-suspended"]').filter({ hasText: chain.mainTitle }).first();
    await expect(suspendedForRestore).toBeVisible({ timeout: 320_000 });
    await suspendedForRestore.evaluate((el: HTMLElement) => el.click());
    await expect(page.locator('[data-testid="dock-v3-status-entry-stalled"]').filter({ hasText: chain.subTitle }).first()).toBeVisible({ timeout: 10000 });

    await confirmFocusedTaskCompletion(page);
    await expect(page.locator('[data-testid="dock-v3-console-card"]').first()).toContainText(chain.subTitle, { timeout: 10000 });
  });

  test('dock completion should sync completed status back to text and flow views', async ({ page }) => {
    await bootstrapLocalWorkspace(page);
    await createAndActivateProject(page, `DockSyncViews-${testHelpers.uniqueId()}`);

    const taskTitle = await createFlowPaletteTask(page, `SyncViews-${testHelpers.uniqueId()}`);
    await ensureDockPanelVisible(page);
    await dragTaskToDock(page, '[data-testid^="flow-palette-task-"]:has-text("' + taskTitle + '")');
    await enterFocusMode(page);

    await confirmFocusedTaskCompletion(page);
    await saveAndExitFocus(page);

    await ensureTextReady(page);
    const textTask = page.locator(`[data-unassigned-task]:has-text("${taskTitle}")`).first();
    await expect(textTask).toBeVisible({ timeout: 10000 });
    await textTask.click({ force: true });
    await expect(
      textTask.locator('[data-testid="text-unassigned-status-badge"]'),
    ).toContainText('Completed', { timeout: 10000 });

    await ensureFlowReady(page);
    await page.locator('[data-testid="flow-palette-tab-unassigned"]').first().click({ force: true });
    await page.locator('[data-testid^="flow-palette-task-"]').filter({ hasText: taskTitle }).first().click({ force: true });
    await expect(page.locator('[data-testid="flow-task-status-badge"]').first()).toContainText('完成', { timeout: 10000 });
  });

  test('follower lease should keep dock interactions read-only in the browser', async ({ page }) => {
    await page.addInitScript((leaseKey: string) => {
      window.localStorage.setItem(
        leaseKey,
        JSON.stringify({
          tabId: 'leader-tab',
          updatedAt: Date.now(),
          expiresAt: Date.now() + 60_000,
        }),
      );
    }, 'nanoflow.focus-console.leader-lease');

    await bootstrapLocalWorkspace(page);
    await createAndActivateProject(page, `DockFollower-${testHelpers.uniqueId()}`);

    const panel = page.locator('[data-testid="dock-v3-panel"]').first();
    const createToggle = panel.locator('[data-testid="dock-v3-create-toggle"]').first();
    await expect(createToggle).toBeVisible({ timeout: 10000 });
    await expect(createToggle).toBeDisabled();
    await expect(panel.locator('[data-testid="dock-v3-new-task-form"]').first()).toBeHidden({ timeout: 2000 });

    const dockFocusToggle = page.locator('[data-testid="dock-v3-focus-toggle"]').first();
    await expect(dockFocusToggle).toBeVisible({ timeout: 10000 });
    await expect(dockFocusToggle).toBeDisabled();
    await expect(page.locator('[data-testid="dock-v3-focus-stage"]')).toBeHidden({ timeout: 2000 });
  });

  test('short-wait subtask completion should surface fragment countdown and keep the wait chain stable on skip/accept', async ({ page }) => {
    await bootstrapLocalWorkspace(page);

    await createAndActivateProject(page, `DockFragmentSkip-${testHelpers.uniqueId()}`);
    await reachFragmentCountdownFromShortWait(page, `Skip-${testHelpers.uniqueId()}`);
    await page.locator('[data-testid="fragment-countdown-skip"]').click({ force: true });
    await expect(page.locator('[data-testid="fragment-countdown-number"]')).toBeHidden({ timeout: 10000 });
    await expect(page.locator('[data-testid="dock-v3-focus-stage"]')).toBeVisible({ timeout: 10000 });

    await openDestructiveExitChoices(page);
    await page.locator('[data-testid="dock-v3-exit-clear"]').click({ force: true });
    await expect(page.locator('[data-testid="dock-v3-focus-stage"]')).toBeHidden({ timeout: 10000 });
    await waitForFocusTransitionStable(page);
    await expect(page.locator('[data-testid="dock-v3-item"]')).toHaveCount(0, { timeout: 10000 });

    await reachFragmentCountdownFromShortWait(page, `Accept-${testHelpers.uniqueId()}`);
    await page.locator('[data-testid="fragment-countdown-accept"]').click({ force: true });
    await expect(page.locator('[data-testid="fragment-countdown-number"]')).toBeHidden({ timeout: 10000 });
    await expect(page.locator('[data-testid="dock-v3-focus-scene"]')).toHaveAttribute('data-scene', 'fragment', { timeout: 10000 });
  });

  test('mobile dock affordances should stay inside the viewport', async ({ page }) => {
    await bootstrapLocalWorkspace(page);
    await createAndActivateProject(page, `DockMobile-${testHelpers.uniqueId()}`);
    await setMobileViewport(page);
    await closeMobileSidebarIfVisible(page);
    await expect(page.locator('[data-testid="dock-v3-semicircle"]:visible').first()).toBeVisible({ timeout: 5000 });

    const viewport = page.viewportSize();
    const semiCircle = page.locator('[data-testid="dock-v3-semicircle"]:visible').first();
    let semiBox = await semiCircle.boundingBox();
    await expect
      .poll(async () => {
        semiBox = await semiCircle.boundingBox();
        return semiBox === null ? 'missing' : 'ready';
      }, { timeout: 5000, intervals: [100, 150, 250] })
      .toBe('ready');
    expect(semiBox).toBeTruthy();
    expect(viewport).toBeTruthy();
    expect((semiBox?.y ?? 0) + (semiBox?.height ?? 0)).toBeLessThanOrEqual((viewport?.height ?? 0));

    await createDockTaskByForm(page, `Mobile-${testHelpers.uniqueId()}`);
    const dockItem = page.locator('[data-testid="dock-v3-item"]').first();
    await dockItem.locator('[data-testid="dock-v3-planner-toggle"]').evaluate((el: HTMLElement) => el.click());

    const panel = page.locator('[data-testid="dock-v3-planner-panel"]').first();
    await expect(panel).toBeVisible({ timeout: 5000 });
    const panelBox = await panel.boundingBox();
    expect(panelBox).toBeTruthy();
    expect((panelBox?.y ?? 0) + (panelBox?.height ?? 0)).toBeLessThanOrEqual((viewport?.height ?? 0));
  });

  test('focus helper entry and key touch targets should remain comfortably clickable on desktop and mobile', async ({ page }) => {
    await bootstrapLocalWorkspace(page);
    await createAndActivateProject(page, `DockTouch-${testHelpers.uniqueId()}`);
    await createDockTaskByForm(page, `Touch-${testHelpers.uniqueId()}`);
    await enterFocusMode(page);
    await ensureDockPanelVisible(page);

    const desktopTargets = await measureDockTargets(page);
    expect(desktopTargets.waitButton?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect(desktopTargets.plannerToggle?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect(desktopTargets.muteButton?.height ?? 0).toBeGreaterThanOrEqual(44);

    // 使用 Alt+H 快捷键打开帮助覆盖层
    await page.keyboard.press('Alt+H');
    await expect(page.locator('[data-testid="dock-v3-help-overlay"]')).toBeVisible({ timeout: 5000 });
    await page.keyboard.press('Alt+H');
    await expect(page.locator('[data-testid="dock-v3-help-overlay"]')).toBeHidden({ timeout: 5000 });

    await setMobileViewport(page);
    await waitForFocusTransitionStable(page);
    await closeMobileSidebarIfVisible(page);
    await ensureDockPanelVisible(page);
    await expect(page.locator('[data-testid="dock-v3-console-card"]:visible').first()).toBeVisible({ timeout: 5000 });

    const mobileTargets = await measureDockTargets(page);
    expect(mobileTargets.waitButton?.height ?? 0).toBeGreaterThanOrEqual(44);

    const focusCard = page.locator('[data-testid="dock-v3-console-card"]:visible').first();
    const dockPanel = page.locator('[data-testid="dock-v3-panel"]:visible').first();
    let focusCardBox = await focusCard.boundingBox();
    await expect
      .poll(async () => {
        focusCardBox = await focusCard.boundingBox();
        return focusCardBox === null ? 'missing' : 'ready';
      }, { timeout: 5000, intervals: [100, 150, 250] })
      .toBe('ready');
    let dockPanelBox = await dockPanel.boundingBox();
    await expect
      .poll(async () => {
        dockPanelBox = await dockPanel.boundingBox();
        return dockPanelBox === null ? 'missing' : 'ready';
      }, { timeout: 5000, intervals: [100, 150, 250] })
      .toBe('ready');
    expect(focusCardBox).toBeTruthy();
    expect(dockPanelBox).toBeTruthy();
    expect(((focusCardBox?.y ?? 0) + (focusCardBox?.height ?? 0))).toBeLessThanOrEqual((dockPanelBox?.y ?? 0) + 8);
  });
});
