import { expect, test } from '@playwright/test';

/**
 * §14.1 Cloudflare Pages 部署后 smoke 契约。
 *
 * 用法：
 *   PLAYWRIGHT_BASE_URL=https://<project>.pages.dev \
 *   PLAYWRIGHT_WEB_SERVER_COMMAND=':' \
 *     npx playwright test e2e/cloudflare-smoke.spec.ts --project=chromium
 *
 *   PLAYWRIGHT_BASE_URL=https://app.nanoflow.app \
 *   PLAYWRIGHT_WEB_SERVER_COMMAND=':' \
 *     npx playwright test e2e/cloudflare-smoke.spec.ts --project=chromium
 *
 * 设计原则：
 * - 不假定 BASE_URL 是哪一个 origin（pages.dev / custom domain / preview）。
 * - 不依赖任何登录态或 Supabase 数据；仅触达静态 / SW / version.json 与
 *   首屏 shell。
 * - console error / pageerror / requestfailed / 非预期 4xx 5xx 列入失败。
 * - 必须显式设置 PLAYWRIGHT_BASE_URL；否则整套 smoke 自动 skip，
 *   避免在本地 dev / 默认 e2e run 中触发。
 *
 * 阶段 3 production deploy 后，先以 `https://<project>.pages.dev` 跑一次；
 * custom domain TLS active 后再以 custom domain 跑第二次（详见
 * docs/cloudflare-migration-plan.md §14.2 阶段 3 末项）。
 */

const FORBIDDEN_CONSOLE_PATTERNS = [
  /JIT compiler unavailable/i,
  /JIT-version-skew/i,
  /DI-version-skew/i,
  /ChunkLoadError/i,
  /Loading chunk .* failed/i,
  /Supabase schema/i,
];

const DEPLOYED_BASE_URL = process.env.PLAYWRIGHT_BASE_URL;
const SHOULD_RUN = typeof DEPLOYED_BASE_URL === 'string' && /^https?:\/\//i.test(DEPLOYED_BASE_URL);

interface ConsoleIssue {
  type: 'console' | 'pageerror' | 'requestfailed' | 'badResponse';
  detail: string;
}

test.describe('Cloudflare Pages smoke contract (§14.1)', () => {
  test.skip(!SHOULD_RUN, 'PLAYWRIGHT_BASE_URL 未指向已部署 origin（http(s)://...）；smoke 契约仅在显式部署后跑');

  test('public surface responds and PWA assets are healthy', async ({ page, request, baseURL }) => {
    const issues: ConsoleIssue[] = [];

    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const text = msg.text();
        if (FORBIDDEN_CONSOLE_PATTERNS.some((re) => re.test(text))) {
          issues.push({ type: 'console', detail: text });
        }
      }
    });
    page.on('pageerror', (err) => {
      issues.push({ type: 'pageerror', detail: err.message });
    });
    page.on('requestfailed', (req) => {
      const failure = req.failure()?.errorText ?? 'unknown';
      // chromium 在导航打断时会标 net::ERR_ABORTED；这是正常的，过滤掉。
      if (!/ERR_ABORTED/i.test(failure)) {
        issues.push({ type: 'requestfailed', detail: `${req.url()} ${failure}` });
      }
    });
    page.on('response', (resp) => {
      const url = resp.url();
      // 关注本 origin 的 4xx/5xx；外域（Supabase / Sentry / CDN）不在本 smoke 范围
      if (baseURL && url.startsWith(baseURL) && resp.status() >= 400 && resp.status() !== 404) {
        // 404 由专门的负向测试处理
        issues.push({ type: 'badResponse', detail: `${resp.status()} ${url}` });
      }
    });

    // 1. 打开 /，shell 必须可见
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#initial-loader, app-root')).toBeVisible({ timeout: 15_000 });

    // 2. /version.json 必须 200 + JSON + no-store
    const versionResp = await request.get('/version.json');
    expect(versionResp.status(), '/version.json status').toBe(200);
    const cacheControl = versionResp.headers()['cache-control'] ?? '';
    expect(cacheControl, '/version.json Cache-Control').toMatch(/no-store/i);
    const versionBody = await versionResp.json();
    expect(typeof versionBody.gitSha, 'version.json.gitSha is string').toBe('string');
    expect(typeof versionBody.appVersion, 'version.json.appVersion is string').toBe('string');
    // 不得泄露 secret
    expect(versionBody).not.toHaveProperty('supabaseAnonKey');
    expect(versionBody).not.toHaveProperty('sentryDsn');

    // 3. /index.html 必须 no-store
    const indexResp = await request.get('/index.html');
    expect(indexResp.status()).toBe(200);
    expect(indexResp.headers()['cache-control'] ?? '', '/index.html Cache-Control').toMatch(/no-store/i);

    // 4. /ngsw.json 必须 no-store（若 SW 已发布）
    const ngswResp = await request.get('/ngsw.json');
    if (ngswResp.status() === 200) {
      expect(ngswResp.headers()['cache-control'] ?? '', '/ngsw.json Cache-Control').toMatch(/no-store/i);
    }

    // 5. SPA fallback：随机深路径必须返回 HTML 200，由 Angular Router 接管
    const deepResp = await request.get('/projects');
    expect(deepResp.status(), 'SPA fallback /projects').toBe(200);
    expect(deepResp.headers()['content-type'] ?? '').toMatch(/text\/html/i);

    // 6. shortcut 兼容：manifest 中声明的 entry 必须可访问
    const shortcutResp = await request.get('/#/projects?entry=shortcut&intent=open-workspace');
    // hash route — 服务端只看到 /，所以必须 200 HTML
    expect(shortcutResp.status()).toBe(200);

    // 7. 不得返回 Cloudflare 自动生成的 modulepreload Link 头
    const linkHeader = indexResp.headers()['link'];
    if (linkHeader) {
      expect(linkHeader, '/index.html Link header').not.toMatch(/rel\s*=\s*"?modulepreload/i);
    }

    // 8. 失败汇总
    expect(issues, `smoke captured ${issues.length} issue(s):\n${issues.map((i) => `  [${i.type}] ${i.detail}`).join('\n')}`)
      .toEqual([]);
  });

  test('non-existent JS chunk does not silently return Angular shell HTML', async ({ request }) => {
    // §14.2 负向：缺失 JS/CSS/asset 不能静默返回 200 HTML（否则 PWA 会缓存坏 shell）。
    const missing = await request.get('/chunk-deadbeefdeadbeefdeadbeefdeadbeef.js', { failOnStatusCode: false });
    const ct = (missing.headers()['content-type'] ?? '').toLowerCase();
    // 允许：404 / 200+JS（极小概率 Pages 真返回 JS）；禁止：200 + text/html
    if (missing.status() === 200 && ct.includes('text/html')) {
      throw new Error(
        `SPA fallback ate a missing JS chunk: ${missing.status()} content-type=${ct}. `
        + '_redirects 或 _headers 配置错误 — 缺失的 hashed chunk 必须返回 4xx 或 application/javascript。',
      );
    }
  });

  test('preview origin should carry X-Robots-Tag noindex when applicable', async ({ request, baseURL }) => {
    // 仅当 BASE_URL 是 *.pages.dev 的非 production 子域才必带 noindex；
    // production custom domain 不能带 preview noindex（详见 §14.2 期望）。
    const isPreview = !!baseURL && (/pr-\d+\.|preview\./i.test(baseURL) || /^https:\/\/[^/]+\.pages\.dev/i.test(baseURL));
    test.skip(!isPreview, 'BASE_URL 不是 preview origin，跳过 noindex 检查');

    const resp = await request.get('/');
    const robots = resp.headers()['x-robots-tag'] ?? '';
    expect(robots, '/ X-Robots-Tag').toMatch(/noindex/i);
  });
});
