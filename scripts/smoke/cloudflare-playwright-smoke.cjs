#!/usr/bin/env node
/**
 * Browser smoke for deployed Cloudflare Pages origins.
 *
 * Required:
 *   PLAYWRIGHT_BASE_URL=https://nanoflow.pages.dev npm run smoke:cloudflare-playwright
 *
 * This intentionally does not start a local dev server. It validates the
 * deployed static surface, PWA assets, and browser-level failures that curl
 * header checks cannot see.
 */

const { chromium } = require('@playwright/test');

const baseUrl = process.env.PLAYWRIGHT_BASE_URL;
if (!baseUrl || !/^https?:\/\//i.test(baseUrl)) {
  console.error('PLAYWRIGHT_BASE_URL must be an http(s) deployed origin.');
  process.exit(2);
}

function normalizeProxyServer(server) {
  if (!server) return undefined;
  return server.replace(/^socks5h:/i, 'socks5:');
}

function resolveProxyOptions() {
  const server = normalizeProxyServer(
    process.env.PLAYWRIGHT_PROXY
      || process.env.HTTPS_PROXY
      || process.env.HTTP_PROXY
      || process.env.ALL_PROXY
      || process.env.https_proxy
      || process.env.http_proxy
      || process.env.all_proxy
  );

  if (!server) return undefined;

  const bypass = process.env.NO_PROXY || process.env.no_proxy;
  return bypass ? { server, bypass } : { server };
}

const forbiddenConsolePatterns = [
  /JIT compiler unavailable/i,
  /JIT-version-skew/i,
  /DI-version-skew/i,
  /ChunkLoadError/i,
  /Loading chunk .* failed/i,
  /Failed to fetch dynamically imported module/i,
  /Supabase schema/i,
];

function readLocalFile(relativePath) {
  const fs = require('node:fs');
  const path = require('node:path');
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

function absolute(pathname) {
  return new URL(pathname, baseUrl).toString();
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function hasLocalChunkSelfHealContract() {
  try {
    const handler = readLocalFile('src/services/global-error-handler.service.ts');
    const spec = readLocalFile('src/services/global-error-handler.service.spec.ts');

    return /ChunkLoadError|Failed to fetch.*chunk|Loading chunk.*failed|Failed to fetch dynamically imported module/i.test(handler)
      && handler.includes('handleChunkLoadError')
      && handler.includes('__NANOFLOW_FORCE_CLEAR_CACHE__')
      && spec.includes('Failed to fetch dynamically imported module')
      && spec.includes('chunk_load_error_reload_timestamp');
  } catch {
    return false;
  }
}

async function assertNoStore(request, pathname) {
  const response = await request.get(absolute(pathname), { failOnStatusCode: false });
  assert(response.status() === 200, `${pathname} expected 200, got ${response.status()}`);
  const cacheControl = response.headers()['cache-control'] || '';
  assert(/no-store/i.test(cacheControl), `${pathname} expected no-store, got "${cacheControl}"`);
  return response;
}

async function main() {
  const proxy = resolveProxyOptions();
  const browser = await chromium.launch(proxy ? { proxy } : undefined);
  const context = await browser.newContext({ baseURL: baseUrl, serviceWorkers: 'allow' });
  const page = await context.newPage();
  const issues = [];

  page.on('console', (message) => {
    const text = message.text();
    if (message.type() === 'error' && forbiddenConsolePatterns.some((pattern) => pattern.test(text))) {
      issues.push(`[console] ${text}`);
    }
  });

  page.on('pageerror', (error) => {
    issues.push(`[pageerror] ${error.message}`);
  });

  page.on('requestfailed', (request) => {
    const failure = request.failure()?.errorText || 'unknown';
    if (!/ERR_ABORTED/i.test(failure)) {
      issues.push(`[requestfailed] ${request.url()} ${failure}`);
    }
  });

  page.on('response', (response) => {
    const url = response.url();
    if (url.startsWith(baseUrl) && response.status() >= 500) {
      issues.push(`[response] ${response.status()} ${url}`);
    }
  });

  await page.setViewportSize({ width: 1366, height: 900 });
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.locator('#initial-loader, app-root').first().waitFor({ state: 'visible', timeout: 15_000 });

  const versionResponse = await assertNoStore(context.request, '/version.json');
  const version = await versionResponse.json();
  assert(typeof version.gitSha === 'string' && version.gitSha.length > 0, 'version.json missing gitSha');
  assert(typeof version.appVersion === 'string' && version.appVersion.length > 0, 'version.json missing appVersion');
  assert(!('supabaseAnonKey' in version), 'version.json leaks supabaseAnonKey');
  assert(!('sentryDsn' in version), 'version.json leaks sentryDsn');

  const indexResponse = await assertNoStore(context.request, '/index.html');
  const linkHeader = indexResponse.headers()['link'] || '';
  assert(!/rel\s*=\s*"?modulepreload/i.test(linkHeader), '/index.html exposes modulepreload Link header');

  const ngswResponse = await context.request.get(absolute('/ngsw.json'), { failOnStatusCode: false });
  if (ngswResponse.status() === 200) {
    const cacheControl = ngswResponse.headers()['cache-control'] || '';
    assert(/no-store/i.test(cacheControl), `/ngsw.json expected no-store, got "${cacheControl}"`);
  }

  const swState = await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return { supported: false, registrations: 0 };
    const registrations = await navigator.serviceWorker.getRegistrations();
    return {
      supported: true,
      registrations: registrations.length,
      controller: Boolean(navigator.serviceWorker.controller),
    };
  });
  assert(swState.supported === true, 'serviceWorker API is not available');

  const mobilePage = await context.newPage();
  await mobilePage.setViewportSize({ width: 390, height: 844 });
  await mobilePage.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await mobilePage.locator('#initial-loader, app-root').first().waitFor({ state: 'visible', timeout: 15_000 });
  await mobilePage.close();

  const missingChunk = await context.request.get(absolute('/chunk-deadbeefdeadbeef.js'), { failOnStatusCode: false });
  const contentType = (missingChunk.headers()['content-type'] || '').toLowerCase();
  const missingChunkIsSpaFallback = missingChunk.status() === 200 && contentType.includes('text/html');
  if (missingChunkIsSpaFallback) {
    assert(
      hasLocalChunkSelfHealContract(),
      'missing JS chunk returned 200 text/html and GlobalErrorHandler chunk self-heal contract was not found',
    );
    console.log('missing chunk negative test used Pages SPA fallback; GlobalErrorHandler chunk self-heal contract present');
  }

  await browser.close();

  if (issues.length > 0) {
    throw new Error(`Browser smoke captured ${issues.length} issue(s):\n${issues.join('\n')}`);
  }

  console.log(`Cloudflare browser smoke passed: ${baseUrl}`);
  console.log(`version gitSha=${version.gitSha} sw=${JSON.stringify(swState)}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
