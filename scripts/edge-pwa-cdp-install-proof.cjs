#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('@playwright/test');

const DEFAULT_URL = 'https://dde-eight.vercel.app/';
const DEFAULT_PROFILE_DIR = path.resolve(__dirname, '..', 'tmp', 'pwa-widget-prod-cdp-profile');
const DEFAULT_REPORT_FILE = path.resolve(__dirname, '..', 'tmp', 'pwa-widget-prod-cdp-report.json');
const DEFAULT_SCREENSHOT_FILE = path.resolve(__dirname, '..', 'tmp', 'pwa-widget-prod-cdp-page.png');
const DEFAULT_EDGE_PATHS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

function log(message, details) {
  if (details === undefined) {
    console.error(`[edge-pwa-cdp] ${message}`);
    return;
  }

  console.error(`[edge-pwa-cdp] ${message}`, details);
}

function fail(message, details) {
  log(message, details);
  process.exit(1);
}

function parseOptionValue(args, optionName) {
  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (current === optionName) {
      const next = args[index + 1];
      return typeof next === 'string' && next.length > 0 ? next : null;
    }

    const prefix = `${optionName}=`;
    if (current.startsWith(prefix)) {
      return current.slice(prefix.length);
    }
  }

  return null;
}

function hasFlag(args, flagName) {
  return args.includes(flagName);
}

function ensureParentDirectory(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function resolveEdgePath(explicitPath) {
  if (explicitPath) {
    const normalized = path.resolve(explicitPath);
    if (!fs.existsSync(normalized)) {
      fail(`指定的 Edge 路径不存在: ${normalized}`);
    }
    return normalized;
  }

  for (const candidate of DEFAULT_EDGE_PATHS) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  fail('未找到 Microsoft Edge，可通过 --edge-path 显式指定');
}

function removeProfileDirectory(profileDir) {
  if (fs.existsSync(profileDir)) {
    fs.rmSync(profileDir, { recursive: true, force: true });
  }
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readTextIfExists(filePath, encoding = 'utf8') {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  return fs.readFileSync(filePath, encoding);
}

function resolveManifestId(appManifest, appIdInfo, pageUrl) {
  const pageOrigin = new URL(pageUrl);
  const rawManifestId = appManifest?.manifest?.id
    || appIdInfo?.recommendedId
    || appManifest?.manifest?.startUrl
    || '/';

  try {
    return new URL(rawManifestId, pageOrigin).toString();
  } catch {
    return new URL('/', pageOrigin).toString();
  }
}

function buildManifestIdCandidates(appManifest, appIdInfo, pageUrl) {
  const pageOrigin = new URL(pageUrl);
  const candidates = [
    appManifest?.manifest?.id,
    appIdInfo?.recommendedId,
    appManifest?.manifest?.startUrl,
    '/',
  ]
    .filter((value) => typeof value === 'string' && value.length > 0)
    .map((value) => {
      try {
        return new URL(value, pageOrigin).toString();
      } catch {
        return null;
      }
    })
    .filter((value) => typeof value === 'string' && value.length > 0);

  return [...new Set(candidates)];
}

function buildSiteEngagementKey(targetUrl) {
  const url = new URL(targetUrl);
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  return `${url.protocol}//${url.hostname}:${port},*`;
}

function sanitizeInstallabilityErrors(payload) {
  if (!payload || !Array.isArray(payload.installabilityErrors)) {
    return [];
  }

  return payload.installabilityErrors.map((item) => ({
    errorId: item?.errorId ?? null,
    errorArguments: Array.isArray(item?.errorArguments)
      ? item.errorArguments.map((arg) => ({ name: arg?.name ?? null, value: arg?.value ?? null }))
      : [],
  }));
}

function sanitizeManifestResult(payload) {
  if (!payload) {
    return { manifestUrl: null, manifest: null, errors: [] };
  }

  return {
    manifestUrl: payload.url ?? null,
    errors: Array.isArray(payload.errors)
      ? payload.errors.map((item) => ({
        message: item?.message ?? null,
        critical: item?.critical ?? null,
        line: item?.line ?? null,
        column: item?.column ?? null,
      }))
      : [],
    manifest: payload.manifest
      ? {
          id: payload.manifest.id ?? null,
          startUrl: payload.manifest.startUrl ?? null,
          scope: payload.manifest.scope ?? null,
          name: payload.manifest.name ?? null,
          shortName: payload.manifest.shortName ?? null,
          display: payload.manifest.display ?? null,
          displayOverrides: payload.manifest.displayOverrides ?? null,
        }
      : null,
  };
}

function sanitizeAppIdResult(payload) {
  if (!payload) {
    return { appId: null, recommendedId: null };
  }

  return {
    appId: payload.appId ?? null,
    recommendedId: payload.recommendedId ?? null,
  };
}

function extractSyncDataEvidence(profileDir, targetUrl) {
  const syncDataDir = path.join(profileDir, 'Default', 'Sync Data', 'LevelDB');
  const targetOrigin = new URL(targetUrl).origin;
  const linkedAppIds = new Set();
  const matchedFiles = [];
  let widgetTagFound = false;
  let templateUrlFound = false;
  let dataUrlFound = false;

  if (!fs.existsSync(syncDataDir)) {
    return {
      linkedAppIds: [],
      matchedFiles: [],
      widgetTagFound: false,
      templateUrlFound: false,
      dataUrlFound: false,
    };
  }

  const syncFiles = fs.readdirSync(syncDataDir)
    .filter((name) => name.endsWith('.log'))
    .map((name) => path.join(syncDataDir, name));

  for (const filePath of syncFiles) {
    const text = readTextIfExists(filePath, 'latin1');
    if (!text || !text.includes(targetOrigin)) {
      continue;
    }

    matchedFiles.push(filePath);
    if (text.includes('nanoflow-focus-summary')) {
      widgetTagFound = true;
    }
    if (text.includes('/widgets/templates/focus-summary.json')) {
      templateUrlFound = true;
    }
    if (text.includes('/widgets/templates/focus-data.json')) {
      dataUrlFound = true;
    }

    for (const match of text.matchAll(/web_apps-dt-([a-z]{32})/g)) {
      linkedAppIds.add(match[1]);
    }
  }

  return {
    linkedAppIds: [...linkedAppIds],
    matchedFiles,
    widgetTagFound,
    templateUrlFound,
    dataUrlFound,
  };
}

function extractProfileEvidence(profileDir, targetUrl, appIdInfo, manifestId, syncDataEvidence) {
  const localStatePath = path.join(profileDir, 'Local State');
  const preferencesPath = path.join(profileDir, 'Default', 'Preferences');
  const localState = readJsonIfExists(localStatePath);
  const preferences = readJsonIfExists(preferencesPath);
  const target = new URL(targetUrl);
  const originKey = `${target.origin}/`;
  const siteEngagementKey = buildSiteEngagementKey(targetUrl);
  const appId = appIdInfo?.appId ?? null;

  const appShims = localState?.app_shims ?? null;
  const installMetrics = preferences?.web_app_install_metrics ?? null;
  const dailyMetrics = preferences?.web_apps?.daily_metrics ?? null;
  const appWindowPlacement = preferences?.browser?.app_window_placement ?? null;
  const siteEngagement = preferences?.profile?.content_settings?.exceptions?.site_engagement ?? null;
  const appShimKeys = appShims ? Object.keys(appShims) : [];
  const installMetricKeys = installMetrics ? Object.keys(installMetrics) : [];
  const appWindowPlacementKeys = appWindowPlacement ? Object.keys(appWindowPlacement) : [];

  const resolvedAppKeyCandidates = new Set(syncDataEvidence?.linkedAppIds ?? []);
  if (appId && appShims && appShims[appId]) {
    resolvedAppKeyCandidates.add(appId);
  }
  if (appId && installMetrics && installMetrics[appId]) {
    resolvedAppKeyCandidates.add(appId);
  }
  if (resolvedAppKeyCandidates.size === 0
    && appShimKeys.length === 1
    && installMetricKeys.length === 1
    && appShimKeys[0] === installMetricKeys[0]) {
    resolvedAppKeyCandidates.add(appShimKeys[0]);
  }

  const resolvedAppKey = resolvedAppKeyCandidates.size === 1
    ? [...resolvedAppKeyCandidates][0]
    : null;

  const appShimEntry = resolvedAppKey && appShims ? appShims[resolvedAppKey] ?? null : null;
  const installMetricEntry = resolvedAppKey && installMetrics ? installMetrics[resolvedAppKey] ?? null : null;
  const appWindowPlacementEntry = resolvedAppKey && appWindowPlacement ? appWindowPlacement[`_crx__${resolvedAppKey}`] ?? null : null;
  const dailyMetricEntry = dailyMetrics ? dailyMetrics[originKey] ?? null : null;
  const siteEngagementEntry = siteEngagement ? siteEngagement[siteEngagementKey] ?? null : null;

  const installState = {
    appShimPresent: Boolean(appShimEntry),
    installMetricPresent: Boolean(installMetricEntry),
    dailyMetricInstalled: dailyMetricEntry?.installed === true,
    appWindowPlacementPresent: Boolean(appWindowPlacementEntry),
    lastShortcutLaunchTime: siteEngagementEntry?.setting?.lastShortcutLaunchTime ?? null,
  };

  return {
    profileDir,
    manifestId,
    appId,
    localStatePath,
    preferencesPath,
    originKey,
    siteEngagementKey,
    resolvedAppKey,
    appShimKeys,
    installMetricKeys,
    appWindowPlacementKeys,
    syncDataEvidence,
    installState,
    appShimEntry,
    installMetricEntry,
    dailyMetricEntry,
    appWindowPlacementEntry,
    siteEngagementEntry,
  };
}

async function safeSend(session, method, params) {
  try {
    return { ok: true, result: await session.send(method, params) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function tryCdpCommand(sessions, method, buildParams) {
  const attempts = [];

  for (const sessionDescriptor of sessions) {
    const paramsList = buildParams(sessionDescriptor.name);
    for (const params of paramsList) {
      const result = await safeSend(sessionDescriptor.session, method, params);
      attempts.push({
        transport: sessionDescriptor.name,
        params,
        ok: result.ok,
        error: result.ok ? null : result.error,
      });

      if (result.ok) {
        return {
          ok: true,
          result: result.result,
          attempts,
          transport: sessionDescriptor.name,
          params,
        };
      }
    }
  }

  return {
    ok: false,
    attempts,
    error: attempts[attempts.length - 1]?.error ?? 'Unknown CDP failure',
  };
}

async function waitForServiceWorkerReady(page, timeoutMs) {
  return page.evaluate(async (timeout) => {
    if (!('serviceWorker' in navigator)) {
      return false;
    }

    const timeoutPromise = new Promise((resolve) => {
      setTimeout(() => resolve(false), timeout);
    });

    const readyPromise = navigator.serviceWorker.ready.then(() => true).catch(() => false);
    return Promise.race([readyPromise, timeoutPromise]);
  }, timeoutMs);
}

async function waitForServiceWorkerTarget(context, timeoutMs) {
  const existingWorkers = context.serviceWorkers();
  if (existingWorkers.length > 0) {
    return existingWorkers[0];
  }

  try {
    return await context.waitForEvent('serviceworker', { timeout: timeoutMs });
  } catch {
    return null;
  }
}

async function captureWidgetRuntime(serviceWorker) {
  if (!serviceWorker || typeof serviceWorker.evaluate !== 'function') {
    return {
      serviceWorkerFound: false,
      widgetsApiAvailable: false,
      installableWidgets: [],
      installedWidgets: [],
      allWidgets: [],
    };
  }

  return serviceWorker.evaluate(async () => {
    const toPlainWidget = (widget) => ({
      installable: widget?.installable ?? null,
      definition: widget?.definition ? {
        tag: widget.definition.tag ?? null,
        name: widget.definition.name ?? null,
        description: widget.definition.description ?? null,
        multiple: widget.definition.multiple ?? null,
        auth: widget.definition.auth ?? null,
        update: widget.definition.update ?? null,
        msAcTemplate: widget.definition.msAcTemplate ?? widget.definition.ms_ac_template ?? null,
        data: widget.definition.data ?? null,
      } : null,
      instances: Array.isArray(widget?.instances)
        ? widget.instances.map((instance) => ({
            id: instance?.id ?? null,
            hostId: instance?.host?.id ?? null,
            updated: instance?.updated ? String(instance.updated) : null,
            hasPayload: Boolean(instance?.payload),
          }))
        : [],
    });

    const fallback = {
      serviceWorkerFound: true,
      widgetsApiAvailable: Boolean(self.widgets),
      installableWidgets: [],
      installedWidgets: [],
      allWidgets: [],
      tagLookup: null,
    };

    if (!self.widgets) {
      return fallback;
    }

    const installableWidgets = await self.widgets.matchAll({ installable: true }).catch(() => []);
    const installedWidgets = await self.widgets.matchAll({ installed: true }).catch(() => []);
    const allWidgets = await self.widgets.matchAll({}).catch(() => []);
    const tagWidget = await self.widgets.getByTag('nanoflow-focus-summary').catch(() => null);

    return {
      serviceWorkerFound: true,
      widgetsApiAvailable: true,
      installableWidgets: installableWidgets.map(toPlainWidget),
      installedWidgets: installedWidgets.map(toPlainWidget),
      allWidgets: allWidgets.map(toPlainWidget),
      tagLookup: tagWidget ? toPlainWidget(tagWidget) : null,
    };
  });
}

async function capturePageState(page) {
  return page.evaluate(async () => {
    const manifestLink = document.querySelector('link[rel="manifest"]');
    const serviceWorkerRegistrations = 'serviceWorker' in navigator
      ? await navigator.serviceWorker.getRegistrations().then((items) => items.length).catch(() => 0)
      : 0;

    return {
      url: location.href,
      title: document.title,
      manifestHref: manifestLink ? manifestLink.href : null,
      serviceWorkerRegistrations,
      displayModeStandalone: window.matchMedia('(display-mode: standalone)').matches,
    };
  });
}

async function main() {
  const args = process.argv.slice(2);
  const targetUrl = parseOptionValue(args, '--url') || DEFAULT_URL;
  const profileDir = path.resolve(parseOptionValue(args, '--profile-dir') || DEFAULT_PROFILE_DIR);
  const reportFile = path.resolve(parseOptionValue(args, '--report-file') || DEFAULT_REPORT_FILE);
  const screenshotFile = path.resolve(parseOptionValue(args, '--screenshot-file') || DEFAULT_SCREENSHOT_FILE);
  const edgePath = resolveEdgePath(parseOptionValue(args, '--edge-path'));
  const launchUrl = parseOptionValue(args, '--launch-url')
    || new URL('/#/projects?entry=shortcut&intent=open-workspace', targetUrl).toString();
  const freshProfile = hasFlag(args, '--fresh') || parseOptionValue(args, '--profile-dir') === null;
  const headless = hasFlag(args, '--headless');

  if (freshProfile) {
    log('清理旧 profile', profileDir);
    removeProfileDirectory(profileDir);
  }

  ensureParentDirectory(reportFile);
  ensureParentDirectory(screenshotFile);

  const report = {
    targetUrl,
    launchUrl,
    profileDir,
    edgePath,
    freshProfile,
    startedAt: new Date().toISOString(),
    installArtifactsConfirmed: false,
    widgetManifestArtifactsConfirmed: false,
    pageState: null,
    manifest: null,
    appId: null,
    installabilityErrors: [],
    serviceWorkerReady: false,
    widgetRuntime: null,
    installCommand: null,
    openCurrentPageInApp: null,
    osAppState: null,
    launchResult: null,
    profileEvidence: null,
    screenshotFile,
    error: null,
  };

  let context = null;
  let browserSession = null;

  try {
    context = await chromium.launchPersistentContext(profileDir, {
      executablePath: edgePath,
      headless,
      viewport: null,
      args: [
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-sync',
        '--disable-features=msEdgeFre',
      ],
    });

    const browser = context.browser();
    if (!browser) {
      throw new Error('Playwright 未返回 browser 实例');
    }

    browserSession = await browser.newBrowserCDPSession();
    const page = context.pages()[0] || await context.newPage();
    const pageSession = await context.newCDPSession(page);

    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForLoadState('load', { timeout: 120000 });

    report.serviceWorkerReady = await waitForServiceWorkerReady(page, 20000);
    report.pageState = await capturePageState(page);
    const serviceWorker = await waitForServiceWorkerTarget(context, 10000);
    report.widgetRuntime = await captureWidgetRuntime(serviceWorker);

    try {
      await page.screenshot({ path: screenshotFile, fullPage: true });
    } catch (error) {
      log('页面截图失败，继续执行', error instanceof Error ? error.message : String(error));
    }

    const manifestResult = await safeSend(pageSession, 'Page.getAppManifest');
    const appIdResult = await safeSend(pageSession, 'Page.getAppId');
    const installabilityResult = await safeSend(pageSession, 'Page.getInstallabilityErrors');

    report.manifest = manifestResult.ok ? sanitizeManifestResult(manifestResult.result) : { error: manifestResult.error };
    report.appId = appIdResult.ok ? sanitizeAppIdResult(appIdResult.result) : { error: appIdResult.error };
    report.installabilityErrors = installabilityResult.ok
      ? sanitizeInstallabilityErrors(installabilityResult.result)
      : [{ errorId: installabilityResult.error, errorArguments: [] }];

    const manifestId = resolveManifestId(
      manifestResult.ok ? manifestResult.result : null,
      appIdResult.ok ? appIdResult.result : null,
      page.url(),
    );
    const manifestIdCandidates = buildManifestIdCandidates(
      manifestResult.ok ? manifestResult.result : null,
      appIdResult.ok ? appIdResult.result : null,
      page.url(),
    );

    report.manifest = {
      ...(report.manifest || {}),
      manifestId,
      manifestIdCandidates,
    };

    const cdpSessions = [
      { name: 'page', session: pageSession },
      { name: 'browser', session: browserSession },
    ];

    const installResult = await tryCdpCommand(cdpSessions, 'PWA.install', () => {
      return manifestIdCandidates.map((candidate) => ({ manifestId: candidate }));
    });
    report.installCommand = installResult.ok
      ? {
          ok: true,
          transport: installResult.transport,
          params: installResult.params,
          result: installResult.result,
          attempts: installResult.attempts,
        }
      : {
          ok: false,
          error: installResult.error,
          attempts: installResult.attempts,
        };

    const effectiveManifestId = installResult.ok
      ? installResult.params.manifestId
      : manifestId;

    const beforeOpenInAppPages = new Set(context.pages());
    const openInAppResult = await safeSend(pageSession, 'PWA.openCurrentPageInApp');
    report.openCurrentPageInApp = openInAppResult.ok
      ? {
          ok: true,
          result: openInAppResult.result,
        }
      : {
          ok: false,
          error: openInAppResult.error,
        };

    try {
      const openedInAppPage = await context.waitForEvent('page', {
        timeout: 10000,
        predicate: (candidate) => !beforeOpenInAppPages.has(candidate),
      });
      await openedInAppPage.waitForLoadState('domcontentloaded', { timeout: 10000 });
      report.openCurrentPageInApp = {
        ...(report.openCurrentPageInApp || {}),
        openedPageUrl: openedInAppPage.url(),
      };
    } catch {
      // 某些 Edge 版本不会把 app window 透传为当前 context 的 page。
    }

    const osAppStateResult = await tryCdpCommand(cdpSessions, 'PWA.getOsAppState', () => {
      return manifestIdCandidates.map((candidate) => ({ manifestId: candidate }));
    });
    report.osAppState = osAppStateResult.ok
      ? {
          ok: true,
          transport: osAppStateResult.transport,
          params: osAppStateResult.params,
          result: osAppStateResult.result,
          attempts: osAppStateResult.attempts,
        }
      : {
          ok: false,
          error: osAppStateResult.error,
          attempts: osAppStateResult.attempts,
        };

    const beforeLaunchPages = new Set(context.pages());
    const launchResult = await tryCdpCommand(cdpSessions, 'PWA.launch', () => {
      return [
        { manifestId: effectiveManifestId, url: launchUrl },
        { manifestId: effectiveManifestId, url: targetUrl },
        { manifestId: effectiveManifestId },
      ];
    });
    report.launchResult = launchResult.ok
      ? {
          ok: true,
          transport: launchResult.transport,
          params: launchResult.params,
          result: launchResult.result,
          attempts: launchResult.attempts,
        }
      : {
          ok: false,
          error: launchResult.error,
          attempts: launchResult.attempts,
        };

    try {
      const launchedPage = await context.waitForEvent('page', {
        timeout: 10000,
        predicate: (candidate) => !beforeLaunchPages.has(candidate),
      });
      await launchedPage.waitForLoadState('domcontentloaded', { timeout: 10000 });
      report.launchResult = {
        ...(report.launchResult || {}),
        launchedPageUrl: launchedPage.url(),
      };
    } catch {
      // 部分 Edge 版本不会把 PWA app window 暴露为同一 context 的 page，忽略即可。
    }

    await context.close();
    context = null;

    report.profileEvidence = extractProfileEvidence(
      profileDir,
      targetUrl,
      appIdResult.ok ? sanitizeAppIdResult(appIdResult.result) : null,
      effectiveManifestId,
      extractSyncDataEvidence(profileDir, targetUrl),
    );

    report.installArtifactsConfirmed = Boolean(
      report.profileEvidence.installState.appShimPresent
      || report.profileEvidence.installState.installMetricPresent
      || report.profileEvidence.installState.dailyMetricInstalled,
    );
    report.widgetManifestArtifactsConfirmed = Boolean(
      report.profileEvidence.resolvedAppKey
      && report.profileEvidence.syncDataEvidence.widgetTagFound
      && report.profileEvidence.syncDataEvidence.templateUrlFound
      && report.profileEvidence.syncDataEvidence.dataUrlFound,
    );
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
  } finally {
    if (context) {
      await context.close().catch(() => {});
    }

    report.finishedAt = new Date().toISOString();
    fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }

  console.log(JSON.stringify(report, null, 2));

  if (!report.installArtifactsConfirmed || !report.widgetManifestArtifactsConfirmed) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  fail('脚本执行失败', error instanceof Error ? error.message : String(error));
});
