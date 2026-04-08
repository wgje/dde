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

/** 测试辅助函数接口 */
export interface TestHelpers {
  waitForAppReady(page: Page): Promise<void>;
  ensureCloudAuthenticated(page: Page): Promise<void>;
  ensureEditorReady(page: Page, options?: { requireCloud?: boolean }): Promise<void>;
  createTestProject(page: Page, projectName: string): Promise<string | null>;
  uniqueId(): string;
  cleanupTestTasks(page: Page): Promise<void>;
  trackTaskTitle(title: string): void;
  trackProjectId(id: string): void;
  getKeyboardModifier(): 'Meta' | 'Control';
  waitForTaskCard(page: Page, title: string, options?: { timeout?: number }): Promise<void>;
  /** 安全可见性检查，替代 .isVisible({ timeout }).catch(() => false) */
  isElementVisible(locator: Locator, timeout?: number): Promise<boolean>;
  /** 条件点击：元素可见则点击并返回 true，不可见返回 false */
  clickIfVisible(locator: Locator, options?: { timeout?: number; force?: boolean }): Promise<boolean>;
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
    // 等待路由加载
    await page.waitForSelector('[data-testid="app-container"]', { timeout: 10000 });
    // 等待loading状态消失
    await expect(page.locator('[data-testid="loading-indicator"]')).not.toBeVisible({ timeout: 10000 });
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
   * 1) 已有 add-task-btn 直接通过
   * 2) 有云凭据优先登录云账号
   * 3) 无云凭据时降级进入本地模式
   */
  async ensureEditorReady(page: Page, options?: { requireCloud?: boolean }): Promise<void> {
    const addTaskBtn = page.locator('[data-testid="add-task-btn"]');
    if (await testHelpers.isElementVisible(addTaskBtn, 1200)) {
      return;
    }

    const { TEST_USER_EMAIL, TEST_USER_PASSWORD } = getTestEnvConfig();
    const hasCloudCreds = !!TEST_USER_EMAIL && !!TEST_USER_PASSWORD;
    const requireCloud = options?.requireCloud ?? false;

    if (hasCloudCreds) {
      await testHelpers.ensureCloudAuthenticated(page);
    } else if (!requireCloud) {
      await ensureLoginModalVisible(page);
      await page.click('[data-testid="local-mode-btn"]');
    } else {
      throw new Error('该用例要求云登录，但未配置 TEST_USER_EMAIL / TEST_USER_PASSWORD');
    }

    await addTaskBtn.waitFor({ state: 'visible', timeout: 15_000 });
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
    const taskTitles = Array.from(createdTestData.taskTitles);
    for (const title of taskTitles) {
      try {
        const taskCard = page.locator(`[data-testid="task-card"]:has-text("${title}")`);
        if (await taskCard.isVisible({ timeout: 1000 })) {
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

  /** 等待任务卡片可见 */
  async waitForTaskCard(page: Page, title: string, options?: { timeout?: number }): Promise<void> {
    const timeout = options?.timeout ?? 5000;
    await expect(page.locator(`[data-testid="task-card"]:has-text("${title}")`))
      .toBeVisible({ timeout });
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
