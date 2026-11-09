import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const localRequire = createRequire(import.meta.url);
const preloadName = 'test-current-receipt-preload.cjs';
const originalNodeOptions = process.env.NODE_OPTIONS;
const fixtureReaderModule = Object.freeze({ readOverlayCurrentReceipt: readFixtureCurrentReceipt });
let loaderInstalled = false;
let restoreModuleLoader: (() => void) | undefined;

export function installFixtureCurrentReceiptModuleLoader(): void {
  if (loaderInstalled) return;
  const moduleLoader = localRequire('node:module') as {
    _load(request: string, parent: unknown, isMain: boolean): unknown;
  };
  const originalLoad = moduleLoader._load;
  const loadFixtureCurrentReceipt = function loadFixtureCurrentReceipt(
    this: unknown,
    request: string,
    parent: unknown,
    isMain: boolean,
  ): unknown {
    if (String(request).endsWith('codegraph-overlay-current-receipt.cjs')) {
      return fixtureReaderModule;
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  moduleLoader._load = loadFixtureCurrentReceipt;
  restoreModuleLoader = () => {
    if (moduleLoader._load !== loadFixtureCurrentReceipt) {
      throw new Error('fixture CURRENT receipt module loader drifted before restore');
    }
    moduleLoader._load = originalLoad;
    restoreModuleLoader = undefined;
    loaderInstalled = false;
  };
  loaderInstalled = true;
}

export function restoreFixtureCurrentReceiptModuleLoader(): void {
  restoreModuleLoader?.();
}

export function configureFixtureCurrentReceipt(root: string): void {
  const preloadPath = currentReaderPreloadPath(root);
  fs.writeFileSync(preloadPath, preloadSource());
  const requireOption = `--require=${JSON.stringify(preloadPath)}`;
  process.env.NODE_OPTIONS = [originalNodeOptions, requireOption].filter(Boolean).join(' ');
}

export function restoreFixtureCurrentReceiptEnvironment(): void {
  if (originalNodeOptions === undefined) delete process.env.NODE_OPTIONS;
  else process.env.NODE_OPTIONS = originalNodeOptions;
}

export function runValidatorWithFixtureCurrentReceipt(
  root: string,
  repoRoot: string,
  scriptPath: string,
) {
  return spawnSync(process.execPath, [
    '--require', currentReaderPreloadPath(root), scriptPath, '--root', root,
  ], { cwd: repoRoot, encoding: 'utf-8' });
}

export function runSyncWithFixtureCurrentReceipt(
  root: string,
  repoRoot: string,
  syncScriptPath: string,
) {
  const runner = [
    `const docsSync = require(${JSON.stringify(syncScriptPath)});`,
    'try {',
    '  const result = docsSync.syncDocs(process.argv[1], {',
    '    participantPolicy: docsSync.LEGACY_PARTIAL_FIXTURE_PARTICIPANT_POLICY,',
    '  });',
    "  const nodes = result.baseline.graphNodes.toLocaleString('en-US');",
    "  const edges = result.baseline.graphEdges.toLocaleString('en-US');",
    '  process.stdout.write(`CodeGraph overlay documentation counts synced (${nodes} nodes, ${edges} edges).\\n`);',
    '} catch (error) {',
    '  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\\n`);',
    '  process.exitCode = 1;',
    '}',
  ].join('\n');
  return spawnSync(process.execPath, [
    '--require', currentReaderPreloadPath(root), '-e', runner, root,
  ], { cwd: repoRoot, encoding: 'utf-8' });
}

function currentReaderPreloadPath(root: string): string {
  return path.join(root, '.codegraph', preloadName);
}

function readFixtureCurrentReceipt(projectRoot: string) {
  try {
    const overlayPath = path.join(projectRoot, '.codegraph', 'nanoflow-overlay.json');
    const overlay = JSON.parse(fs.readFileSync(overlayPath, 'utf8')) as Record<string, unknown>;
    return deepFreeze({
      ok: true as const,
      current: { generationId: 'test-fixture', sequence: '1' },
      overlay,
    });
  } catch {
    return Object.freeze({ ok: false as const, errorCode: 'CURRENT_MISSING' });
  }
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function preloadSource(): string {
  return [
    "'use strict';",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const Module = require('node:module');",
    'const originalLoad = Module._load;',
    'function deepFreeze(value) {',
    "  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;",
    '  for (const nested of Object.values(value)) deepFreeze(nested);',
    '  return Object.freeze(value);',
    '}',
    'Module._load = function loadFixtureCurrentReceipt(request, parent, isMain) {',
    "  if (String(request).endsWith('codegraph-overlay-current-receipt.cjs')) {",
    '    return Object.freeze({',
    '      readOverlayCurrentReceipt(projectRoot) {',
    "        const overlayPath = path.join(projectRoot, '.codegraph', 'nanoflow-overlay.json');",
    '        try {',
    "          const overlay = JSON.parse(fs.readFileSync(overlayPath, 'utf8'));",
    "          return deepFreeze({ ok: true, current: { generationId: 'test-fixture', sequence: '1' }, overlay });",
    '        } catch {',
    "          return Object.freeze({ ok: false, errorCode: 'CURRENT_MISSING' });",
    '        }',
    '      },',
    '    });',
    '  }',
    '  return originalLoad.call(this, request, parent, isMain);',
    '};',
    '',
  ].join('\n');
}
