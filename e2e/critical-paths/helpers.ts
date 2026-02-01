/**
 * 关键路径 E2E 测试 - 共享辅助函数和类型
 * 
 * 从 critical-paths.spec.ts 抽取的共享代码
 */
import { expect, Page } from '@playwright/test';

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
  createTestProject(page: Page, projectName: string): Promise<string | null>;
  uniqueId(): string;
  cleanupTestTasks(page: Page): Promise<void>;
  trackTaskTitle(title: string): void;
  trackProjectId(id: string): void;
  getKeyboardModifier(): 'Meta' | 'Control';
  waitForTaskCard(page: Page, title: string, options?: { timeout?: number }): Promise<void>;
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
  }
};
