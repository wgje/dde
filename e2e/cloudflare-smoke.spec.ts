import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type APIRequestContext, type APIResponse } from '@playwright/test';

/**
 * Cloudflare Pages deployed-origin smoke contract.
 *
 * Usage:
 *   PLAYWRIGHT_BASE_URL=https://nanoflow.pages.dev npm run smoke:cloudflare-e2e
 *
 * This spec intentionally avoids login state and Supabase data. It validates the
 * static shell, freshness-critical assets, SPA fallback, shortcut hash routes,
 * and the deployed-origin browser failure surface.
 */

const FORBIDDEN_CONSOLE_PATTERNS = [
  /JIT compiler unavailable/i,
  /JIT-version-skew/i,
  /DI-version-skew/i,
  /ChunkLoadError/i,
  /Loading chunk .* failed/i,
  /Failed to fetch dynamically imported module/i,
  /Supabase schema/i,
];

const deployedBaseUrl = process.env.PLAYWRIGHT_BASE_URL;
const shouldRun = typeof deployedBaseUrl === 'string' && /^https?:\/\//i.test(deployedBaseUrl);

interface ConsoleIssue {
  type: 'console' | 'pageerror' | 'requestfailed' | 'badResponse';
  detail: string;
}

async function requestGetWithRetry(
  request: APIRequestContext,
  url: string,
  options: Parameters<APIRequestContext['get']>[1] = {},
): Promise<APIResponse> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await request.get(url, options);
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        await new Promise(resolve => setTimeout(resolve, attempt * 500));
      }
    }
  }

  throw lastError;
}

function hasLocalChunkSelfHealContract(): boolean {
  try {
    const root = process.cwd();
    const handler = fs.readFileSync(path.join(root, 'src/services/global-error-handler.service.ts'), 'utf8');
    const spec = fs.readFileSync(path.join(root, 'src/services/global-error-handler.service.spec.ts'), 'utf8');

    return /ChunkLoadError|Failed to fetch.*chunk|Loading chunk.*failed|Failed to fetch dynamically imported module/i.test(handler)
      && handler.includes('handleChunkLoadError')
      && handler.includes('__NANOFLOW_FORCE_CLEAR_CACHE__')
      && spec.includes('Failed to fetch dynamically imported module')
      && spec.includes('chunk_load_error_reload_timestamp');
  } catch {
    return false;
  }
}

test.describe('Cloudflare Pages smoke contract', () => {
  test.skip(!shouldRun, 'PLAYWRIGHT_BASE_URL must point at a deployed http(s) origin');

  test('public surface responds and PWA assets are healthy', async ({ page, request, baseURL }) => {
    const issues: ConsoleIssue[] = [];

    page.on('console', (message) => {
      if (message.type() !== 'error') return;
      const text = message.text();
      if (FORBIDDEN_CONSOLE_PATTERNS.some((pattern) => pattern.test(text))) {
        issues.push({ type: 'console', detail: text });
      }
    });
    page.on('pageerror', (error) => {
      issues.push({ type: 'pageerror', detail: error.message });
    });
    page.on('requestfailed', (request) => {
      const failure = request.failure()?.errorText ?? 'unknown';
      if (!/ERR_ABORTED/i.test(failure)) {
        issues.push({ type: 'requestfailed', detail: `${request.url()} ${failure}` });
      }
    });
    page.on('response', (response) => {
      const url = response.url();
      if (baseURL && url.startsWith(baseURL) && response.status() >= 400 && response.status() !== 404) {
        issues.push({ type: 'badResponse', detail: `${response.status()} ${url}` });
      }
    });

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#initial-loader, app-root').first()).toBeVisible({ timeout: 15_000 });

    const versionResponse = await request.get('/version.json');
    expect(versionResponse.status(), '/version.json status').toBe(200);
    expect(versionResponse.headers()['cache-control'] ?? '', '/version.json Cache-Control').toMatch(/no-store/i);
    const version = await versionResponse.json();
    expect(typeof version.gitSha, 'version.json.gitSha is string').toBe('string');
    expect(typeof version.appVersion, 'version.json.appVersion is string').toBe('string');
    expect(version).not.toHaveProperty('supabaseAnonKey');
    expect(version).not.toHaveProperty('sentryDsn');

    const indexResponse = await request.get('/index.html');
    expect(indexResponse.status(), '/index.html status').toBe(200);
    expect(indexResponse.headers()['cache-control'] ?? '', '/index.html Cache-Control').toMatch(/no-store/i);
    expect(indexResponse.headers()['link'] ?? '', '/index.html Link header').not.toMatch(/rel\s*=\s*"?modulepreload/i);

    const ngswResponse = await request.get('/ngsw.json');
    if (ngswResponse.status() === 200) {
      expect(ngswResponse.headers()['cache-control'] ?? '', '/ngsw.json Cache-Control').toMatch(/no-store/i);
    }

    const deepResponse = await request.get('/projects');
    expect(deepResponse.status(), 'SPA fallback /projects').toBe(200);
    expect(deepResponse.headers()['content-type'] ?? '', 'SPA fallback content-type').toMatch(/text\/html/i);

    const shortcutResponse = await request.get('/#/projects?entry=shortcut&intent=open-workspace');
    expect(shortcutResponse.status(), 'manifest shortcut hash route').toBe(200);

    expect(
      issues,
      `smoke captured ${issues.length} issue(s):\n${issues.map((issue) => `  [${issue.type}] ${issue.detail}`).join('\n')}`,
    ).toEqual([]);
  });

  test('non-existent JS chunk is either a real 4xx or backed by chunk self-heal', async ({ request }) => {
    const missing = await requestGetWithRetry(
      request,
      '/chunk-deadbeefdeadbeefdeadbeefdeadbeef.js',
      { failOnStatusCode: false },
    );
    const contentType = (missing.headers()['content-type'] ?? '').toLowerCase();

    if (missing.status() === 200 && contentType.includes('text/html')) {
      expect(hasLocalChunkSelfHealContract(), 'GlobalErrorHandler chunk self-heal contract present').toBe(true);
    }
  });

  test('preview origin carries X-Robots-Tag noindex when applicable', async ({ request, baseURL }) => {
    const isPagesDev = !!baseURL && /^https:\/\/[^/]+\.pages\.dev/i.test(baseURL);
    const isPreview = !!baseURL && (/pr-\d+\.|preview\./i.test(baseURL) || (isPagesDev && !/^https:\/\/nanoflow\.pages\.dev\/?$/i.test(baseURL)));
    test.skip(!isPreview, 'BASE_URL is not a preview origin');

    const response = await request.get('/');
    expect(response.headers()['x-robots-tag'] ?? '', '/ X-Robots-Tag').toMatch(/noindex/i);
  });
});
