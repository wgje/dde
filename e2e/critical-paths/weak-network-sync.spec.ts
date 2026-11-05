/**
 * 关键路径: 弱网同步行为（目标3 离线弱网同步收口）
 *
 * 模式参考 offline-mode.spec.ts / sync-flow.spec.ts：不依赖真实 Supabase——
 * 本机未配置 TEST_USER_EMAIL/TEST_USER_PASSWORD 时云用例会被跳过，因此本文件
 * 用 Playwright route 拦截把 Supabase auth + sync RPC 全量 mock 成受控假服务端，
 * 在其上注入弱网故障（5xx/429、请求挂起），验证 §5.2 本地优先写路径：
 *
 * 场景1：Supabase 任务写请求返回 503/429 若干次 → UI 不回滚、重试队列指示存在
 *        → 放行 → 最终同步完成指示。
 * 场景2：任务写请求挂起不响应 → 本地写立即生效、无阻塞 loading → 放行恢复
 *        → 后台补同步收口。
 */
import { test, expect, Locator, Page, Route } from '@playwright/test';
import { testHelpers, createdTestData } from './helpers';
import { environment } from '../../src/environments/environment';
import { resolveSupabaseStorageKey } from '../../src/services/supabase-client-configuration';

const TEST_USER_ID = '11111111-2222-4333-8444-555555555555';
const TEST_USER_EMAIL = 'weak-network-e2e@example.com';
const LOCAL_SUPABASE_SANDBOX_URL = 'http://127.0.0.1:54321';
const localSupabaseSandbox = new URL(LOCAL_SUPABASE_SANDBOX_URL);

interface MockSupabaseController {
  /** 剩余需要以 5xx/429 拒绝的任务写请求次数（0 = 放行） */
  failingTaskWritesRemaining: number;
  /** 为 true 时挂起所有任务写请求（不响应） */
  hangTaskWrites: boolean;
  /** 已观测到的任务写请求次数 */
  taskWriteAttempts: number;
  /** 已返回 applied 的任务写请求次数 */
  successfulTaskWrites: number;
  /** 已成功返回 applied 的任务 ID */
  successfulTaskIds: Set<string>;
  /** fail-closed fence 拦截到的未声明出站 */
  unexpectedRemoteEgress: string[];
  /** 放行所有被挂起的任务写请求 */
  releaseHeldTaskWrites(): Promise<void>;
}

const mockControllersByPage = new WeakMap<Page, MockSupabaseController>();

function base64Url(input: string): string {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function createFakeJwt(expiresAtSeconds: number): string {
  const header = base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64Url(JSON.stringify({
    sub: TEST_USER_ID,
    email: TEST_USER_EMAIL,
    aud: 'authenticated',
    role: 'authenticated',
    exp: expiresAtSeconds,
    session_id: 'weak-network-session',
  }));
  return `${header}.${payload}.fake-signature`;
}

function createFakeUser(): Record<string, unknown> {
  const iso = new Date().toISOString();
  return {
    id: TEST_USER_ID,
    aud: 'authenticated',
    role: 'authenticated',
    email: TEST_USER_EMAIL,
    email_confirmed_at: iso,
    phone: '',
    confirmed_at: iso,
    last_sign_in_at: iso,
    app_metadata: { provider: 'email', providers: ['email'] },
    user_metadata: {},
    identities: [],
    created_at: iso,
    updated_at: iso,
  };
}

function createFakeSessionBody(): Record<string, unknown> {
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  return {
    access_token: createFakeJwt(expiresAt),
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: expiresAt,
    refresh_token: 'weak-network-fake-refresh-token',
    user: createFakeUser(),
  };
}

async function fulfillJson(route: Route, status: number, body: unknown): Promise<void> {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

/** PostgREST maybeSingle 零行语义：406 + PGRST116（supabase-js 转换为 data:null）。 */
async function fulfillNoRows(route: Route): Promise<void> {
  await fulfillJson(route, 406, {
    code: 'PGRST116',
    message: 'JSON object requested, multiple (or no) rows returned',
    details: 'Results contain 0 rows',
    hint: null,
  });
}

function readSyncRpcPayload(route: Route): Record<string, unknown> {
  try {
    const body = route.request().postDataJSON() as { payload?: Record<string, unknown> } | null;
    return body?.payload ?? {};
  } catch {
    return {};
  }
}

async function fulfillAppliedTaskWrite(
  route: Route,
  controller: MockSupabaseController,
): Promise<void> {
  const payload = readSyncRpcPayload(route);
  const task = (payload['task'] ?? {}) as { id?: string };
  const taskId = typeof task.id === 'string' ? task.id : null;
  await fulfillJson(route, 200, {
    status: 'applied',
    task_id: taskId,
    updated_at: new Date().toISOString(),
  });
  controller.successfulTaskWrites += 1;
  if (taskId) {
    controller.successfulTaskIds.add(taskId);
  }
}

/** 按 RPC 名派发受控假 sync 服务端；未识别的 RPC 返回 PGRST202 让应用走既有降级路径。 */
async function handleRpcRoute(route: Route, url: string, controller: MockSupabaseController, heldTaskWrites: Route[]): Promise<void> {
  if (url.includes('/rpc/sync_check_protocol')) {
    await fulfillJson(route, 200, { minProtocolVersion: 1, deploymentEpoch: 0 });
    return;
  }

  if (url.includes('/rpc/sync_upsert_task')) {
    controller.taskWriteAttempts += 1;
    if (controller.hangTaskWrites) {
      heldTaskWrites.push(route);
      return;
    }
    if (controller.failingTaskWritesRemaining > 0) {
      controller.failingTaskWritesRemaining -= 1;
      const useRateLimit = controller.failingTaskWritesRemaining % 2 === 0;
      await fulfillJson(
        route,
        useRateLimit ? 429 : 503,
        useRateLimit
          ? { code: '429', message: 'Too Many Requests (weak-network mock)' }
          : { code: '503', message: 'Service Unavailable (weak-network mock)' },
      );
      return;
    }
    await fulfillAppliedTaskWrite(route, controller);
    return;
  }

  if (url.includes('/rpc/sync_upsert_project')) {
    const payload = readSyncRpcPayload(route);
    const project = (payload['project'] ?? {}) as { id?: string };
    await fulfillJson(route, 200, {
      status: 'applied',
      project_id: project.id ?? null,
      updated_at: new Date().toISOString(),
    });
    return;
  }

  if (url.includes('/rpc/sync_upsert_connection')) {
    const payload = readSyncRpcPayload(route);
    const connection = (payload['connection'] ?? {}) as { id?: string };
    await fulfillJson(route, 200, {
      status: 'applied',
      connection_id: connection.id ?? null,
      updated_at: new Date().toISOString(),
    });
    return;
  }

  if (url.includes('/rpc/sync_upsert_user_preferences')) {
    await fulfillJson(route, 200, { status: 'applied', user_id: TEST_USER_ID, updated_at: new Date().toISOString() });
    return;
  }

  if (url.includes('/rpc/sync_upsert_blackbox_entry')) {
    const payload = readSyncRpcPayload(route);
    const entry = (payload['entry'] ?? {}) as { id?: string };
    await fulfillJson(route, 200, { status: 'applied', entry_id: entry.id ?? null, updated_at: new Date().toISOString() });
    return;
  }

  if (url.includes('/rpc/sync_delete_tasks') || url.includes('/rpc/sync_delete_project')) {
    await fulfillJson(route, 200, { status: 'applied', deleted_count: 0 });
    return;
  }

  await fulfillJson(route, 404, {
    code: 'PGRST202',
    message: 'Could not find the function in the schema cache (weak-network mock)',
  });
}

/** REST 数据面：读请求返回空集，偶发写走 REST 时回显 updated_at，避免误报冲突。 */
async function handleRestDataRoute(route: Route): Promise<void> {
  const request = route.request();
  const accept = request.headers()['accept'] ?? '';
  const wantsSingleObject = accept.includes('vnd.pgrst.object+json');

  if (request.method() === 'GET' || request.method() === 'HEAD') {
    if (wantsSingleObject) {
      await fulfillNoRows(route);
      return;
    }
    await fulfillJson(route, 200, []);
    return;
  }

  const row = { updated_at: new Date().toISOString() };
  await fulfillJson(route, wantsSingleObject ? 200 : 201, wantsSingleObject ? row : [row]);
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost'
    || hostname === '127.0.0.1'
    || hostname === '::1'
    || hostname === '[::1]';
}

function isAllowedLocalAppTransport(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    const targetsSandbox = url.hostname === localSupabaseSandbox.hostname
      && url.port === localSupabaseSandbox.port;
    return isLoopbackHostname(url.hostname) && !targetsSandbox;
  } catch {
    return false;
  }
}

async function installLocalOnlyNetworkFence(
  page: Page,
  controller: MockSupabaseController,
): Promise<void> {
  // Playwright runs matching HTTP routes in reverse registration order.
  await page.route('**/*', async route => {
    const request = route.request();
    const url = request.url();
    if (isAllowedLocalAppTransport(url)) {
      await route.continue();
      return;
    }

    controller.unexpectedRemoteEgress.push('HTTP ' + request.method() + ' ' + url);
    await route.abort('blockedbyclient');
  });

  await page.routeWebSocket(/.*/, async webSocket => {
    const url = webSocket.url();
    if (isAllowedLocalAppTransport(url)) {
      webSocket.connectToServer();
      return;
    }

    controller.unexpectedRemoteEgress.push('WebSocket ' + url);
    await webSocket.close({ code: 1008, reason: 'Blocked by local-only weak-network fence' });
  });
}

/**
 * 安装 Supabase mock：auth 面签发固定假会话，数据面由受控假 sync RPC 服务端响应。
 * 必须在 page.goto 之前调用。
 */
async function installMockSupabase(page: Page): Promise<MockSupabaseController> {
  const heldTaskWrites: Route[] = [];
  const controller: MockSupabaseController = {
    failingTaskWritesRemaining: 0,
    hangTaskWrites: false,
    taskWriteAttempts: 0,
    successfulTaskWrites: 0,
    successfulTaskIds: new Set<string>(),
    unexpectedRemoteEgress: [],
    async releaseHeldTaskWrites() {
      controller.hangTaskWrites = false;
      const pending = heldTaskWrites.splice(0, heldTaskWrites.length);
      await Promise.all(pending.map(route => fulfillAppliedTaskWrite(route, controller)));
    },
  };
  mockControllersByPage.set(page, controller);
  await installLocalOnlyNetworkFence(page, controller);

  await page.route(
    /https:\/\/[^/]+\.ingest(?:\.[a-z0-9-]+)?\.sentry\.io\//i,
    route => fulfillJson(route, 200, {}),
  );
  await page.route('https://cdn.jsdelivr.net/**', route => route.fulfill({
    status: 200,
    contentType: 'text/css',
    body: '',
  }));

  await page.route('**/auth/v1/**', async route => {
    const url = route.request().url();
    if (url.includes('/auth/v1/token')) {
      await fulfillJson(route, 200, createFakeSessionBody());
      return;
    }
    if (url.includes('/auth/v1/user')) {
      await fulfillJson(route, 200, createFakeUser());
      return;
    }
    if (url.includes('/auth/v1/logout')) {
      await route.fulfill({ status: 204, body: '' });
      return;
    }
    if (url.includes('/auth/v1/health')) {
      await fulfillJson(route, 200, { date: new Date().toISOString() });
      return;
    }
    await fulfillJson(route, 200, {});
  });

  await page.route('**/rest/v1/**', async route => {
    const url = route.request().url();
    if (url.includes('/rest/v1/rpc/')) {
      await handleRpcRoute(route, url, controller, heldTaskWrites);
      return;
    }
    await handleRestDataRoute(route);
  });

  return controller;
}

/** 使用假会话完成登录并进入可编辑工作区（不依赖 TEST_USER_EMAIL/PASSWORD）。 */
async function loginWithMockedSupabase(page: Page): Promise<void> {
  const storageKey = resolveSupabaseStorageKey(environment.supabaseUrl);
  if (!storageKey) throw new Error('Supabase storage key is unavailable');
  const session = createFakeSessionBody();
  await page.addInitScript(({ storageKey: key, nextSession }) => {
    localStorage.setItem(key, JSON.stringify(nextSession));
    localStorage.removeItem(`${key}-code-verifier`);
    localStorage.setItem(`${key}-user`, JSON.stringify(nextSession.user));
  }, { storageKey, nextSession: session });

  await page.goto('/');
  await testHelpers.waitForAppReady(page);
  await expect(page.locator('[data-testid="user-menu"]').first()).toBeVisible({ timeout: 15_000 });
}

async function createWorkspaceWithProject(page: Page): Promise<void> {
  const addTaskBtn = page.locator('[data-testid="add-task-btn"]').first();
  const projectName = `弱网同步-${testHelpers.uniqueId()}`;
  const projectId = await testHelpers.createTestProject(page, projectName);
  if (projectId) {
    testHelpers.trackProjectId(projectId);
  }

  const projectItem = page.locator(`[data-testid="project-item"]:has-text("${projectName}")`).first();
  await expect(projectItem).toBeVisible({ timeout: 10_000 });
  await testHelpers.clickIfVisible(projectItem, { timeout: 5_000, force: true });
  await expect(projectItem.locator('button[aria-label="项目详情"]')).toBeAttached({ timeout: 10_000 });
  await expect(addTaskBtn).toBeVisible({ timeout: 15_000 });
  await testHelpers.waitForSyncSettled(page, { timeout: 45_000 });
}

async function readSyncIndicatorAttribute(page: Page, attribute: string): Promise<string | null> {
  return page
    .locator('[data-testid="sync-status-indicator"]')
    .first()
    .getAttribute(attribute)
    .catch(() => null);
}

async function waitForPendingSyncIndicator(page: Page, timeout = 20_000): Promise<void> {
  await expect
    .poll(async () => {
      const pending = await readSyncIndicatorAttribute(page, 'data-testid-pending');
      const busy = await readSyncIndicatorAttribute(page, 'data-testid-busy');
      return pending === 'pending-sync-indicator' || busy === 'sync-busy-indicator';
    }, { timeout, intervals: [200, 300, 500] })
    .toBe(true);
}

async function waitForSyncSuccessIndicator(page: Page, timeout = 45_000): Promise<void> {
  await expect
    .poll(async () => {
      const pending = await readSyncIndicatorAttribute(page, 'data-testid-pending');
      const busy = await readSyncIndicatorAttribute(page, 'data-testid-busy');
      const offline = await readSyncIndicatorAttribute(page, 'data-testid-offline');
      const success = await readSyncIndicatorAttribute(page, 'data-testid-success');
      return offline === null
        && pending === null
        && busy === null
        && success === 'sync-success-indicator';
    }, { timeout, intervals: [300, 500, 1_000] })
    .toBe(true);
}

async function readTaskCardId(taskCard: Locator, taskTitle: string): Promise<string> {
  const taskId = await taskCard.getAttribute('data-task-id')
    ?? await taskCard.getAttribute('data-unassigned-task');
  if (!taskId) {
    throw new Error(`弱网用例任务缺少可识别 ID: ${taskTitle}`);
  }
  return taskId;
}

async function prepareSyncedTaskForMutation(
  page: Page,
  supabaseMock: MockSupabaseController,
): Promise<{ initialTaskTitle: string; taskId: string; titleInput: Locator }> {
  const initialTaskTitle = '新任务';
  const addTaskButton = page.locator('[data-testid="add-task-btn"]').first();
  await expect(addTaskButton).toBeEnabled({ timeout: 15_000 });
  await addTaskButton.click({ force: true });

  const taskCard = await testHelpers.getTaskCard(page, initialTaskTitle, { timeout: 10_000 });
  const taskId = await readTaskCardId(taskCard, initialTaskTitle);
  await testHelpers.waitForSyncSettled(page, { timeout: 45_000 });
  await expect.poll(
    () => supabaseMock.successfulTaskIds.has(taskId),
    { timeout: 45_000, intervals: [300, 500, 1_000] },
  ).toBe(true);
  supabaseMock.successfulTaskIds.delete(taskId);
  const titleInput = await testHelpers.openTaskTitleEditor(page, initialTaskTitle, { timeout: 10_000 });
  return { initialTaskTitle, taskId, titleInput };
}

test.describe('关键路径: 弱网同步行为', () => {
  test.setTimeout(150_000);
  test.use({ bypassCSP: true });

  test('服务端 5xx/429 抖动期间 UI 不回滚且进入重试队列，放行后最终同步完成', async ({ page }) => {
    const supabaseMock = await installMockSupabase(page);
    await loginWithMockedSupabase(page);
    await createWorkspaceWithProject(page);
    const { taskId, titleInput } = await prepareSyncedTaskForMutation(page, supabaseMock);

    // 注入弱网故障：接下来的任务更新连续返回 503/429（不放行）
    const attemptsBeforeFailure = supabaseMock.taskWriteAttempts;
    const successfulWritesBeforeFailure = supabaseMock.successfulTaskWrites;
    supabaseMock.failingTaskWritesRemaining = 100;

    const taskTitle = `弱网5xx-${testHelpers.uniqueId()}`;
    testHelpers.trackTaskTitle(taskTitle);
    await titleInput.fill(taskTitle);
    await titleInput.press('Enter');

    // 本地更新立即生效：任务卡片可见，且在服务端持续 5xx/429 期间不回滚
    const taskCard = await testHelpers.getTaskCard(page, taskTitle, { timeout: 10_000 });
    await expect(taskCard).toBeVisible();
    expect(await readTaskCardId(taskCard, taskTitle)).toBe(taskId);

    // 重试队列指示存在（pending / busy 指示进入后台重试通道）
    await waitForPendingSyncIndicator(page, 25_000);
    await expect
      .poll(() => supabaseMock.taskWriteAttempts, { timeout: 25_000, intervals: [300, 500, 1_000] })
      .toBeGreaterThan(attemptsBeforeFailure);
    expect(supabaseMock.successfulTaskWrites).toBe(successfulWritesBeforeFailure);

    // 故障窗口内再次确认 UI 未回滚、无阻塞 loading
    await expect(taskCard).toBeVisible();
    await expect(page.locator('[data-testid="loading-indicator"]')).toBeHidden();

    // 放行：故障计数耗尽后 mock 返回 applied，后台重试应自动收口
    supabaseMock.failingTaskWritesRemaining = 0;
    await testHelpers.waitForSyncSettled(page, { timeout: 45_000 });
    await waitForSyncSuccessIndicator(page, 45_000);
    await expect
      .poll(() => supabaseMock.successfulTaskIds.has(taskId), { timeout: 45_000, intervals: [300, 500, 1_000] })
      .toBe(true);
    await expect(taskCard).toBeVisible();
  });

  test('任务写请求挂起期间本地写立即生效且无阻塞 loading，放行后补同步', async ({ page }) => {
    const supabaseMock = await installMockSupabase(page);
    await loginWithMockedSupabase(page);
    await createWorkspaceWithProject(page);
    const { taskId, titleInput } = await prepareSyncedTaskForMutation(page, supabaseMock);

    // 注入弱网故障：任务更新请求挂起不响应（模拟慢网/黑洞路由）
    const attemptsBeforeHang = supabaseMock.taskWriteAttempts;
    const successfulWritesBeforeHang = supabaseMock.successfulTaskWrites;
    supabaseMock.hangTaskWrites = true;

    const taskTitle = `弱网挂起-${testHelpers.uniqueId()}`;
    testHelpers.trackTaskTitle(taskTitle);

    const createdAt = Date.now();
    await titleInput.fill(taskTitle);
    await titleInput.press('Enter');
    const localWriteMs = Date.now() - createdAt;

    // 本地写立即生效：更新流程不等待云端响应（远端此刻被挂起）
    const taskCard = await testHelpers.getTaskCard(page, taskTitle, { timeout: 10_000 });
    await expect(taskCard).toBeVisible();
    expect(await readTaskCardId(taskCard, taskTitle)).toBe(taskId);
    expect(localWriteMs).toBeLessThan(20_000);

    // 无阻塞 loading：全局 loading 指示不可见，新增按钮保持可交互
    await expect(page.locator('[data-testid="loading-indicator"]')).toBeHidden();
    await expect(page.locator('[data-testid="add-task-btn"]').first()).toBeEnabled();

    // 等待写请求真实抵达挂起通道（3s 防抖 + 入队），期间 UI 仍不回滚
    await expect
      .poll(() => supabaseMock.taskWriteAttempts, { timeout: 25_000, intervals: [300, 500, 1_000] })
      .toBeGreaterThan(attemptsBeforeHang);
    expect(supabaseMock.successfulTaskWrites).toBe(successfulWritesBeforeHang);
    await expect(taskCard).toBeVisible();

    // 放行挂起请求：后台补同步收口，无需用户手动触发
    await supabaseMock.releaseHeldTaskWrites();
    await testHelpers.waitForSyncSettled(page, { timeout: 60_000 });
    await waitForSyncSuccessIndicator(page, 60_000);
    await expect
      .poll(() => supabaseMock.successfulTaskIds.has(taskId), { timeout: 60_000, intervals: [300, 500, 1_000] })
      .toBe(true);
    await expect(taskCard).toBeVisible();
  });
});

test.afterEach(async ({ page }) => {
  const controller = mockControllersByPage.get(page);
  mockControllersByPage.delete(page);
  createdTestData.taskTitles.clear();
  createdTestData.projectIds.clear();
  if (controller) {
    expect(
      controller.unexpectedRemoteEgress,
      'Local-only weak-network fence blocked unexpected egress:\n'
        + controller.unexpectedRemoteEgress.join('\n'),
    ).toEqual([]);
  }
});
