/**
 * scripts/prepare-manifest-widgets.cjs
 *
 * 在 Angular 构建产物 (dist/browser/manifest.webmanifest) 上按环境变量
 * 决定是否暴露：
 *   - manifest.widgets[]（Windows 11 Widgets Board 定义）
 *   - manifest.shortcuts[] 中指向 widget 专属意图的入口
 *
 * 目的：满足策划案 REL-02 / REL-03 / P15-04 的两波发布硬约束：
 *   「第一次发布 sw-composed.js 的版本不得同时上线组合 SW、manifest
 *    widgets 暴露和正式 Widget 生产流量」
 *
 * 环境变量（字符串，未设置即视为默认）：
 *   - WIDGET_MANIFEST_EXPOSE_WIDGETS
 *       'false' | '0' | 'off' | 'no' → 剥离 manifest.widgets
 *       其他（含未设置）                → 保留（默认暴露）
 *   - WIDGET_MANIFEST_EXPOSE_SHORTCUTS
 *       'false' | '0' | 'off' | 'no' → 剥离所有 widget 专属 shortcut
 *       'widgets-only'                → 仅剥离 widget 专属 shortcut（工作区 shortcut 保留）
 *       其他（含未设置）                → 保留全部（默认暴露）
 *
 * 与策划案约束对齐：
 *   - 仅改动 dist/browser 下的产物，不污染仓库源文件 (public/manifest.webmanifest)
 *   - 同步更新 ngsw.json 的 hashTable 条目，避免 Service Worker 启动时哈希校验失败
 *   - 脚本幂等：基于产物实际内容计算，不依赖前一次运行结果
 *
 * 回滚策略：
 *   - 显式设置 WIDGET_MANIFEST_EXPOSE_WIDGETS=false 即可在不重发
 *     sw-composed.js 底座的情况下单独把 widgets 能力撤回（RB-02）。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_DIST_DIR = path.join(__dirname, '..', 'dist', 'browser');
const DEFAULT_MANIFEST_FILENAME = 'manifest.webmanifest';

/** Widget 专属 shortcut 的 intent 标识（与 src/utils/startup-entry-intent.ts 对齐） */
const WIDGET_ONLY_SHORTCUT_INTENTS = new Set([
  'open-focus-tools',
  'open-blackbox-recorder',
]);

function sha1(content) {
  return crypto.createHash('sha1').update(content).digest('hex');
}

function isOptOut(value) {
  if (typeof value !== 'string') return false;
  return ['false', '0', 'off', 'no', 'disabled'].includes(value.trim().toLowerCase());
}

function isWidgetsOnlyShortcutOptOut(value) {
  if (typeof value !== 'string') return false;
  return value.trim().toLowerCase() === 'widgets-only';
}

/** 从 shortcut.url (可能是相对路径) 提取 intent query 值 */
function extractIntent(rawUrl) {
  if (typeof rawUrl !== 'string') return null;
  // 支持 ./#/projects?entry=shortcut&intent=open-focus-tools 这类 hash+query
  const qIndex = rawUrl.indexOf('?');
  if (qIndex < 0) return null;
  const query = rawUrl.slice(qIndex + 1);
  // 手写解析，避免对 URL 构造器传入相对 URL 报错
  for (const part of query.split('&')) {
    const [key, value] = part.split('=');
    if (decodeURIComponent(key || '').trim() === 'intent') {
      return decodeURIComponent(value || '').trim();
    }
  }
  return null;
}

function applyManifestFilters(manifest, decisions) {
  const originalWidgetsCount = Array.isArray(manifest.widgets) ? manifest.widgets.length : 0;
  const originalShortcutsCount = Array.isArray(manifest.shortcuts) ? manifest.shortcuts.length : 0;

  if (decisions.stripWidgets && Array.isArray(manifest.widgets)) {
    delete manifest.widgets;
  }

  let strippedShortcuts = 0;
  if (decisions.stripShortcutsMode && Array.isArray(manifest.shortcuts)) {
    const kept = [];
    for (const sc of manifest.shortcuts) {
      if (decisions.stripShortcutsMode === 'all') {
        strippedShortcuts++;
        continue;
      }
      // widgets-only：仅剥离指向 widget 意图的 shortcut
      const intent = extractIntent(sc && sc.url);
      if (intent && WIDGET_ONLY_SHORTCUT_INTENTS.has(intent)) {
        strippedShortcuts++;
        continue;
      }
      kept.push(sc);
    }
    if (kept.length === 0) {
      delete manifest.shortcuts;
    } else {
      manifest.shortcuts = kept;
    }
  }

  return {
    originalWidgetsCount,
    originalShortcutsCount,
    widgetsStripped: decisions.stripWidgets ? originalWidgetsCount : 0,
    shortcutsStripped: strippedShortcuts,
  };
}

function resolveDecisions(env = process.env) {
  const exposeWidgetsRaw = env.WIDGET_MANIFEST_EXPOSE_WIDGETS;
  const exposeShortcutsRaw = env.WIDGET_MANIFEST_EXPOSE_SHORTCUTS;

  const stripWidgets = isOptOut(exposeWidgetsRaw);

  let stripShortcutsMode = null;
  if (isOptOut(exposeShortcutsRaw)) {
    stripShortcutsMode = 'all';
  } else if (isWidgetsOnlyShortcutOptOut(exposeShortcutsRaw)) {
    stripShortcutsMode = 'widgets-only';
  }

  return { stripWidgets, stripShortcutsMode };
}

function patchNgswManifestHash(ngswPath, manifestFilename, newManifestContent) {
  if (!fs.existsSync(ngswPath)) return false;
  const ngsw = JSON.parse(fs.readFileSync(ngswPath, 'utf8'));
  if (!ngsw.hashTable || typeof ngsw.hashTable !== 'object') return false;
  const key = `/${manifestFilename}`;
  if (!Object.prototype.hasOwnProperty.call(ngsw.hashTable, key)) return false;
  ngsw.hashTable[key] = sha1(newManifestContent);
  fs.writeFileSync(ngswPath, JSON.stringify(ngsw, null, 2));
  return true;
}

function prepareManifestWidgets(options = {}) {
  const distDir = options.distDir || DEFAULT_DIST_DIR;
  const manifestFilename = options.manifestFilename || DEFAULT_MANIFEST_FILENAME;
  const manifestPath = path.join(distDir, manifestFilename);
  const ngswPath = path.join(distDir, 'ngsw.json');
  const decisions = options.decisions || resolveDecisions(options.env || process.env);

  if (!decisions.stripWidgets && !decisions.stripShortcutsMode) {
    return {
      applied: false,
      reason: 'exposure-enabled',
      decisions,
      manifestPath,
    };
  }

  if (!fs.existsSync(manifestPath)) {
    // 允许缺失（比如只做 vitest 单元运行时没有 dist/）
    return {
      applied: false,
      reason: 'manifest-missing',
      decisions,
      manifestPath,
    };
  }

  const raw = fs.readFileSync(manifestPath, 'utf8');
  const manifest = JSON.parse(raw);
  const summary = applyManifestFilters(manifest, decisions);

  const newContent = `${JSON.stringify(manifest, null, 2)}\n`;
  fs.writeFileSync(manifestPath, newContent, 'utf8');

  const ngswPatched = patchNgswManifestHash(ngswPath, manifestFilename, newContent);

  return {
    applied: true,
    decisions,
    manifestPath,
    ngswPath,
    ngswPatched,
    summary,
  };
}

function main() {
  try {
    const result = prepareManifestWidgets();
    if (!result.applied) {
      if (result.reason === 'exposure-enabled') {
        console.log(
          '[prepare-manifest-widgets] 未设置 opt-out 环境变量，保留 manifest.widgets / shortcuts 默认暴露',
        );
      } else if (result.reason === 'manifest-missing') {
        console.warn(
          `[prepare-manifest-widgets] 跳过：manifest 不存在 (${result.manifestPath})`,
        );
      }
      return;
    }
    console.log(
      `[prepare-manifest-widgets] 已按环境变量剥离 widgets=${result.summary.widgetsStripped} / shortcuts=${result.summary.shortcutsStripped}`
        + ` 并 ${result.ngswPatched ? '已' : '未'} 同步 ngsw.json hashTable`,
    );
  } catch (err) {
    console.error('[prepare-manifest-widgets] 失败：', err && err.message ? err.message : err);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  DEFAULT_DIST_DIR,
  DEFAULT_MANIFEST_FILENAME,
  WIDGET_ONLY_SHORTCUT_INTENTS,
  applyManifestFilters,
  extractIntent,
  isOptOut,
  isWidgetsOnlyShortcutOptOut,
  patchNgswManifestHash,
  prepareManifestWidgets,
  resolveDecisions,
  sha1,
  main,
};
