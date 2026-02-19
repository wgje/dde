import { expect, Page, Response } from '@playwright/test';
import {
  ensureAuthenticated,
  type AuthEnsureResult,
} from '../shared/auth-helpers';

interface PerfAuthConfig {
  email: string;
  password: string;
  projectId?: string;
}

export interface PerfAuthResult extends AuthEnsureResult {
  authStageDataRequests: number;
}

function readPerfAuthConfig(): PerfAuthConfig {
  const email = process.env['E2E_PERF_EMAIL']?.trim();
  const password = process.env['E2E_PERF_PASSWORD']?.trim();
  const projectId = process.env['E2E_PERF_PROJECT_ID']?.trim();

  if (!email || !password) {
    throw new Error(
      '缺少认证态弱网测试凭据：请设置 E2E_PERF_EMAIL 与 E2E_PERF_PASSWORD'
    );
  }

  return { email, password, projectId: projectId || undefined };
}

export function getPerfTargetPath(): string {
  const { projectId } = readPerfAuthConfig();
  return projectId ? `/#/projects/${projectId}` : '/#/projects';
}

/**
 * 确保页面处于已登录状态（用于认证态弱网预算测试）。
 */
export async function ensurePerfAuthenticated(page: Page): Promise<PerfAuthResult> {
  const { email, password } = readPerfAuthConfig();
  let authStageDataRequests = 0;

  const onResponse = (response: Response) => {
    const type = response.request().resourceType();
    if (type === 'fetch' || type === 'xhr') {
      authStageDataRequests += 1;
    }
  };
  page.on('response', onResponse);

  try {
    const authResult = await ensureAuthenticated(
      page,
      { email, password },
      {
        projectsPath: '/#/projects',
        maxAttempts: 3,
        submitTimeoutMs: 15_000,
        modalTimeoutMs: 10_000,
        retryDelayMs: 600,
      }
    );

    await expect(page).toHaveURL(/#\/projects(?:$|[/?])/);
    return {
      ...authResult,
      authStageDataRequests,
    };
  } finally {
    page.off('response', onResponse);
  }
}
