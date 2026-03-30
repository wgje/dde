/**
 * 关键路径 E2E 测试 - 共享辅助函数和类型
 * 
 * 从 critical-paths.spec.ts 抽取的共享代码
 */
import { expect, Locator, Page } from '@playwright/test';
import {
  ensureAuthenticated as ensureSharedAuthenticated,
  ensureLoginModalVisible,
} from '../shared/auth-helpers';
import { waitForAppReady as waitForSharedAppReady } from '../shared/page-helpers';

// ============================================================================
// 类型定义
// ============================================================================

/** 测试环境配置 */
export interface TestEnvConfig {
  TEST_USER_EMAIL?: string;
  TEST_USER_PASSWORD?: string;
}

/** 测试数据跟踪结构 */
export interface CreatedTestData {
  projectIds: Set<string>;
  taskTitles: Set<string>;
}

export type EditorReadyMode = 'local' | 'cloud' | 'auto';

export interface EnsureEditorReadyOptions {
  mode?: EditorReadyMode;
  requireCloud?: boolean;
}

/** 测试辅助函数接口 */
export interface TestHelpers {
  waitForAppReady(page: Page): Promise<void>;
  ensureCloudAuthenticated(page: Page): Promise<void>;
  ensureEditorReady(page: Page, options?: EnsureEditorReadyOptions): Promise<void>;
  createTask(page: Page, title: string, options?: { content?: string }): Promise<void>;
  createTestProject(page: Page, projectName: string): Promise<string | null>;
  uniqueId(): string;
  cleanupTestTasks(page: Page): Promise<void>;
  trackTaskTitle(title: string): void;
  trackProjectId(id: string): void;
  getKeyboardModifier(): 'Meta' | 'Control';
  getTaskCard(page: Page, title: string, options?: { timeout?: number }): Promise<Locator>;
  waitForTaskCard(page: Page, title: string, options?: { timeout?: number }): Promise<void>;
  openTaskTitleEditor(page: Page, taskTitle: string): Promise<Locator>;
  openTaskContentEditor(page: Page, taskTitle: string): Promise<Locator>;
  openSettings(page: Page): Promise<void>;
  waitForSyncSettled(page: Page, options?: { timeout?: number }): Promise<void>;
  waitForCloudSyncSettled(page: Page, options?: { timeout?: number; observeActivity?: boolean; previousSyncMarker?: string | null }): Promise<void>;
  waitForCloudSyncSuccess(page: Page, timeout?: number): Promise<void>;
  waitForOfflineIndicator(page: Page, timeout?: number): Promise<void>;
  /** 安全可见性检查，替代 .isVisible({ timeout }).catch(() => false) */
  isElementVisible(locator: Locator, timeout?: number): Promise<boolean>;
  /** 条件点击：元素可见则点击并返回 true，不可见返回 false */
  clickIfVisible(locator: Locator, options?: { timeout?: number; force?: boolean }): Promise<boolean>;
}

async function findTaskCardByTitle(page: Page, taskTitle: string, timeout = 5_000): Promise<Locator> {
  const taskCards = page.locator('[data-testid="task-card"]');

  const resolveMatchingCardSelector = async (): Promise<string | null> => {
    const count = await taskCards.count();

    for (let index = 0; index < count; index += 1) {
      const card = taskCards.nth(index);
      const titleLabel = card.locator('[data-testid="task-title-label"]').first();
      const taskId = await card.getAttribute('data-task-id');
      const unassignedTaskId = await card.getAttribute('data-unassigned-task');

      const buildSelector = (): string | null => {
        if (taskId) {
          return `[data-testid="task-card"][data-task-id="${taskId}"]`;
        }

        if (unassignedTaskId) {
          return `[data-testid="task-card"][data-unassigned-task="${unassignedTaskId}"]`;
        }

        return null;
      };

      if (await titleLabel.isVisible().catch(() => false)) {
        const previewTitle = (await titleLabel.textContent())?.trim() ?? '';
        if (previewTitle === taskTitle) {
          return buildSelector();
        }
      }

      const titleInput = card.locator('[data-testid="task-title-input"]').first();
      if (await titleInput.isVisible().catch(() => false)) {
        const inputTitle = await titleInput.inputValue().catch(() => '');
        if (inputTitle === taskTitle) {
          return buildSelector();
        }
      }
    }

    return null;
  };

  await expect
    .poll(async () => (await resolveMatchingCardSelector()) !== null, { timeout, intervals: [200, 300, 500] })
    .toBe(true);

  const selector = await resolveMatchingCardSelector();
  if (!selector) {
    throw new Error(`未能定位任务卡: ${taskTitle}`);
  }

  return page.locator(selector).first();
}

// ============================================================================
// 环境变量验证
// ============================================================================

/** 获取并验证测试环境配置 */
export function getTestEnvConfig(): TestEnvConfig {
  return {
    TEST_USER_EMAIL: process.env['TEST_USER_EMAIL'],
    TEST_USER_PASSWORD: process.env['TEST_USER_PASSWORD'],
  };
}

// ============================================================================
// 测试数据跟踪（用于清理）
// ============================================================================

export const createdTestData: CreatedTestData = {
  projectIds: new Set<string>(),
  taskTitles: new Set<string>(),
};

// ============================================================================
// 测试辅助函数
// ============================================================================

export const testHelpers: TestHelpers = {
  /** 等待应用加载完成 */
  async waitForAppReady(page: Page): Promise<void> {
    await waitForSharedAppReady(page, { timeoutMs: 15_000 });
  },

  /** 强制使用云账号完成认证 */
  async ensureCloudAuthenticated(page: Page): Promise<void> {
    const { TEST_USER_EMAIL, TEST_USER_PASSWORD } = getTestEnvConfig();
    if (!TEST_USER_EMAIL || !TEST_USER_PASSWORD) {
      throw new Error('未配置 TEST_USER_EMAIL / TEST_USER_PASSWORD，无法执行云同步用例');
    }

    await ensureSharedAuthenticated(
      page,
      { email: TEST_USER_EMAIL, password: TEST_USER_PASSWORD },
      {
        projectsPath: '/#/projects',
        maxAttempts: 3,
        submitTimeoutMs: 15_000,
      }
    );
  },

  /**
   * 确保进入可编辑态：
   * 1) mode=cloud 时必须确认处于云登录态，避免本地访客态误判为可编辑
   * 2) mode=local 时必须走本地入口，避免测试被云登录兜底掩盖
   * 3) mode=auto 仅用于兼容旧调用点，优先本地，必要时回退云登录
   */
  async ensureEditorReady(page: Page, options?: EnsureEditorReadyOptions): Promise<void> {
    const addTaskBtn = page.locator('[data-testid="add-task-btn"]');
    const userMenu = page.locator('[data-testid="user-menu"]');

    const { TEST_USER_EMAIL, TEST_USER_PASSWORD } = getTestEnvConfig();
    const hasCloudCreds = !!TEST_USER_EMAIL && !!TEST_USER_PASSWORD;
    const mode = options?.mode ?? (options?.requireCloud ? 'cloud' : 'local');

    if (mode === 'cloud') {
      const editorVisible = await testHelpers.isElementVisible(addTaskBtn, 1200);
      const cloudSessionVisible = await testHelpers.isElementVisible(userMenu, 600);
      if (editorVisible && cloudSessionVisible) {
        return;
      }

      if (!hasCloudCreds) {
        throw new Error('该用例要求云登录，但未配置 TEST_USER_EMAIL / TEST_USER_PASSWORD');
      }

      await testHelpers.ensureCloudAuthenticated(page);
      await addTaskBtn.waitFor({ state: 'visible', timeout: 15_000 });
      await expect(userMenu).toBeVisible({ timeout: 15_000 });
      return;
    }

    if (mode === 'local') {
      if (await testHelpers.isElementVisible(addTaskBtn, 1200)) {
        return;
      }

      await ensureLoginModalVisible(page);

      const localModeButton = page.locator('[data-testid="local-mode-btn"]');
      if (!(await testHelpers.isElementVisible(localModeButton, 1500))) {
        throw new Error('未找到本地模式入口，无法保证 local 用例运行在访客/本地态');
      }

      await localModeButton.click();
      await addTaskBtn.waitFor({ state: 'visible', timeout: 15_000 });
      return;
    }

    if (await testHelpers.isElementVisible(addTaskBtn, 1200)) {
      return;
    }

    await ensureLoginModalVisible(page);

    const localModeButton = page.locator('[data-testid="local-mode-btn"]');
    if (await testHelpers.isElementVisible(localModeButton, 1500)) {
      await localModeButton.click();
      await addTaskBtn.waitFor({ state: 'visible', timeout: 15_000 });
      return;
    }

    if (!hasCloudCreds) {
      throw new Error('未找到本地模式入口，且未配置 TEST_USER_EMAIL / TEST_USER_PASSWORD');
    }

    await testHelpers.ensureCloudAuthenticated(page);
    await addTaskBtn.waitFor({ state: 'visible', timeout: 15_000 });
  },

  /** 使用当前稳定 testid 创建任务，可选同时写入内容 */
  async createTask(page: Page, title: string, options?: { content?: string }): Promise<void> {
    await page.click('[data-testid="add-task-btn"]');

    const titleInput = page.locator('[data-testid="task-title-input"]').first();
    await expect(titleInput).toBeVisible({ timeout: 5_000 });
    await titleInput.fill(title);

    if (options?.content !== undefined) {
      const contentEditor = page.locator('[data-testid="task-content-editor"]').first();
      await expect(contentEditor).toBeVisible({ timeout: 5_000 });
      await contentEditor.fill(options.content);

      const saveButton = page.locator('[data-testid="save-task-btn"]').first();
      if (await testHelpers.isElementVisible(saveButton, 800)) {
        await saveButton.click();
      } else {
        await contentEditor.blur();
      }
    } else {
      await titleInput.press('Enter');
    }

    await testHelpers.waitForTaskCard(page, title, { timeout: 10_000 });
  },

  /** 访客模式下创建测试项目，返回项目 ID */
  async createTestProject(page: Page, projectName: string): Promise<string | null> {
    // 点击创建项目按钮
    await page.click('[data-testid="create-project-btn"]');
    // 等待对话框出现
    await page.waitForSelector('[data-testid="new-project-modal"]');
    // 输入项目名
    await page.fill('[data-testid="project-name-input"]', projectName);
    // 确认创建
    await page.click('[data-testid="create-project-confirm"]');
    // 等待对话框关闭
    await expect(page.locator('[data-testid="new-project-modal"]')).not.toBeVisible();
    
    // 尝试从 DOM 获取项目 ID
    const projectElement = page.locator(`[data-testid="project-item"]:has-text("${projectName}")`);
    await expect(projectElement).toBeVisible({ timeout: 5000 });
    const projectId = await projectElement.getAttribute('data-project-id');
    
    // 记录创建的项目用于清理
    if (projectId) {
      createdTestData.projectIds.add(projectId);
    }
    
    return projectId;
  },

  /** 生成唯一的测试数据 */
  uniqueId(): string {
    return `test-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
  },

  /** 清理测试创建的任务 */
  async cleanupTestTasks(page: Page): Promise<void> {
    // 尝试删除测试创建的任务
    for (const title of createdTestData.taskTitles) {
      try {
        const taskCard = await testHelpers.getTaskCard(page, title, { timeout: 1_000 });
        if (await taskCard.isVisible({ timeout: 1_000 })) {
          await taskCard.click({ button: 'right' });
          const deleteBtn = page.locator('[data-testid="context-menu-delete"]');
          if (await deleteBtn.isVisible({ timeout: 1000 })) {
            await deleteBtn.click();
          }
        }
      } catch {
        // 忽略清理失败
      }
    }
    createdTestData.taskTitles.clear();
  },

  /** 记录任务标题用于清理 */
  trackTaskTitle(title: string): void {
    createdTestData.taskTitles.add(title);
  },

  /** 记录项目 ID 用于清理 */
  trackProjectId(id: string): void {
    createdTestData.projectIds.add(id);
  },

  /** 获取键盘修饰键（Mac: Meta, 其他: Control） */
  getKeyboardModifier(): 'Meta' | 'Control' {
    return process.platform === 'darwin' ? 'Meta' : 'Control';
  },

  /** 获取标题精确匹配的任务卡片 */
  async getTaskCard(page: Page, title: string, options?: { timeout?: number }): Promise<Locator> {
    return findTaskCardByTitle(page, title, options?.timeout ?? 5_000);
  },

  /** 等待任务卡片可见 */
  async waitForTaskCard(page: Page, title: string, options?: { timeout?: number }): Promise<void> {
    const taskCard = await testHelpers.getTaskCard(page, title, options);
    await expect(taskCard).toBeVisible({ timeout: options?.timeout ?? 5_000 });
  },

  /** 打开当前任务的标题编辑器，兼容预览态与旧卡片交互 */
  async openTaskTitleEditor(page: Page, taskTitle: string): Promise<Locator> {
    const taskCard = await findTaskCardByTitle(page, taskTitle);
    const scopedEditInput = taskCard.locator('[data-testid="task-title-input"]').first();

    const findMatchingEditor = async (): Promise<Locator | null> => {
      if (!(await testHelpers.isElementVisible(scopedEditInput, 400))) {
        return null;
      }

      const currentValue = await scopedEditInput.inputValue().catch(() => '');
      return currentValue === taskTitle ? scopedEditInput : null;
    };

    const matchingEditor = await findMatchingEditor();
    if (matchingEditor) {
      return matchingEditor;
    }

    await expect(taskCard).toBeVisible({ timeout: 5_000 });

    await taskCard.click({ force: true });
    const editorAfterClick = await findMatchingEditor();
    if (editorAfterClick) {
      return editorAfterClick;
    }

    const editButton = taskCard.locator('[data-testid="edit-task-btn"], button[title="编辑任务"]').first();
    if (await testHelpers.clickIfVisible(editButton, { timeout: 800, force: true })) {
      const editorAfterEditButton = await findMatchingEditor();
      if (editorAfterEditButton) {
        return editorAfterEditButton;
      }
    }

    await taskCard.dblclick({ force: true });
    await expect
      .poll(async () => {
        const editor = await findMatchingEditor();
        if (!editor) {
          return '';
        }

        return editor.inputValue().catch(() => '');
      }, { timeout: 5_000, intervals: [200, 300, 500] })
      .toBe(taskTitle);

    const editorAfterDoubleClick = await findMatchingEditor();
    if (!editorAfterDoubleClick) {
      throw new Error(`未能打开任务标题编辑器: ${taskTitle}`);
    }

    return editorAfterDoubleClick;
  },

  /** 打开任务内容编辑器，必要时从预览态切到编辑态 */
  async openTaskContentEditor(page: Page, taskTitle: string): Promise<Locator> {
    const taskCard = await findTaskCardByTitle(page, taskTitle);
    await testHelpers.openTaskTitleEditor(page, taskTitle);

    const scopedContentEditor = taskCard.locator('[data-testid="task-content-editor"]').first();
    const resolveVisibleEditor = async (): Promise<Locator | null> => {
      if (await testHelpers.isElementVisible(scopedContentEditor, 600)) {
        return scopedContentEditor;
      }

      return null;
    };

    const existingEditor = await resolveVisibleEditor();
    if (existingEditor) {
      return existingEditor;
    }

    const contentPreview = taskCard.locator('[data-testid="task-content"]').first();
    if (await testHelpers.clickIfVisible(contentPreview, { timeout: 1_000, force: true })) {
      const editorAfterPreviewClick = await resolveVisibleEditor();
      if (editorAfterPreviewClick) {
        return editorAfterPreviewClick;
      }
    }

    const previewToggle = taskCard.locator('button[title="切换预览/编辑"]').first();
    if (await testHelpers.clickIfVisible(previewToggle, { timeout: 1_000, force: true })) {
      const editorAfterToggle = await resolveVisibleEditor();
      if (editorAfterToggle) {
        return editorAfterToggle;
      }
    }

    await expect(scopedContentEditor).toBeVisible({ timeout: 5_000 });
    return scopedContentEditor;
  },

  /** 打开当前设置弹窗 */
  async openSettings(page: Page): Promise<void> {
    const settingsButton = page.locator('[data-testid="workspace-settings-button"], button[aria-label="打开设置"]').first();
    await expect(settingsButton).toBeVisible({ timeout: 10_000 });
    await settingsButton.click({ force: true });
    await expect(page.locator('[data-testid="settings-modal"]').first()).toBeVisible({ timeout: 15_000 });
  },

  /** 严格等待云同步状态恢复到在线且空闲，可选要求成功指示灯 */
  async waitForCloudSyncSettled(page: Page, options?: { timeout?: number; observeActivity?: boolean; previousSyncMarker?: string | null }): Promise<void> {
    const timeout = options?.timeout ?? 15_000;
    const observeActivity = options?.observeActivity ?? false;
    const requireSyncMarkerChange = Object.prototype.hasOwnProperty.call(options ?? {}, 'previousSyncMarker');
    const previousSyncMarker = options?.previousSyncMarker ?? null;
    const indicator = page.locator('[data-testid="sync-status-indicator"]').first();

    await expect(indicator).toBeVisible({ timeout: Math.min(timeout, 5_000) });

    if (observeActivity) {
      await expect
        .poll(async () => {
          const busy = await indicator.getAttribute('data-testid-busy');
          const pending = await indicator.getAttribute('data-testid-pending');

          return busy === 'sync-busy-indicator' || pending === 'pending-sync-indicator';
        }, { timeout: Math.min(timeout, 8_000), intervals: [150, 250, 400] })
        .toBe(true);
    }

    await expect
      .poll(async () => {
        const offline = await indicator.getAttribute('data-testid-offline');
        const pending = await indicator.getAttribute('data-testid-pending');
        const busy = await indicator.getAttribute('data-testid-busy');
        const lastSyncMarker = await indicator.getAttribute('data-testid-last-sync');

        return (offline ?? 'online') === 'online'
          && (pending ?? 'idle') === 'idle'
          && busy !== 'sync-busy-indicator'
          && (!requireSyncMarkerChange || (lastSyncMarker !== null && lastSyncMarker !== previousSyncMarker));
      }, { timeout, intervals: [300, 500, 1_000] })
      .toBe(true);
  },

  /** 等待同步状态恢复到在线且无待处理状态 */
  async waitForSyncSettled(page: Page, options?: { timeout?: number }): Promise<void> {
    const timeout = options?.timeout ?? 15_000;
    const indicator = page.locator('[data-testid="sync-status-indicator"]').first();

    if (await testHelpers.isElementVisible(indicator, 2_000)) {
      await testHelpers.waitForCloudSyncSettled(page, { timeout });
      return;
    }

    // sync-status-indicator 不可见时（如本地模式），退化为等待启动容器和 loading indicator 稳定
    await waitForSharedAppReady(page, { timeoutMs: Math.min(timeout, 5_000) });

    const loadingIndicator = page.locator('[data-testid="loading-indicator"]').first();
    await expect
      .poll(async () => loadingIndicator.isVisible().catch(() => false), {
        timeout: Math.min(timeout, 3_000),
        intervals: [100, 200, 300],
      })
      .toBe(false);
  },

  /** 云同步场景下等待成功指示灯出现 */
  async waitForCloudSyncSuccess(page: Page, timeout = 15_000): Promise<void> {
    await testHelpers.waitForCloudSyncSettled(page, { timeout, observeActivity: true });
  },

  /** 等待离线状态指示器出现 */
  async waitForOfflineIndicator(page: Page, timeout = 5_000): Promise<void> {
    await expect
      .poll(async () => page.evaluate(() => navigator.onLine), { timeout, intervals: [200, 300, 500] })
      .toBe(false);
  },

  /** 安全可见性检查，替代 .isVisible({ timeout }).catch(() => false) 模式 */
  async isElementVisible(locator: Locator, timeout = 2000): Promise<boolean> {
    try {
      await locator.waitFor({ state: 'visible', timeout });
      return true;
    } catch {
      return false;
    }
  },

  /** 条件点击：元素可见则点击并返回 true，超时不可见返回 false */
  async clickIfVisible(locator: Locator, options?: { timeout?: number; force?: boolean }): Promise<boolean> {
    try {
      await locator.waitFor({ state: 'visible', timeout: options?.timeout ?? 2000 });
      await locator.click({ force: options?.force ?? false });
      return true;
    } catch {
      return false;
    }
  },
};
