import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';

function readWorkspaceFile(filePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), filePath), 'utf8');
}

describe('run-test-matrix scheduler contracts', () => {
  it('propagates dependency failures until no pending segment can inherit the failure', () => {
    const source = readWorkspaceFile('scripts/run-test-matrix.cjs');

    expect(source).toMatch(/while\s*\(\s*markDependencyFailures\(/);
  });

  it('marks unrunnable pending segments instead of leaving the pool promise unresolved', () => {
    const source = readWorkspaceFile('scripts/run-test-matrix.cjs');

    expect(source).toContain('markUnrunnablePendingTasks');
    expect(source).toContain('blocked_dependency_unresolved');
  });

  it('splits large Vitest file lists before spawning to avoid Windows command length limits', () => {
    const source = readWorkspaceFile('scripts/run-test-matrix.cjs');

    expect(source).toContain('MAX_VITEST_FILES_PER_SEGMENT');
    expect(source).toContain('pushSegmentChunks');
    expect(source).toContain("segmentName: `${segmentName}-${String(index + 1).padStart(2, '0')}`");
  });
});

describe('run-test-matrix Vitest cache isolation contract', () => {
  it('assigns each spawned Vitest segment an isolated transform cache directory', () => {
    const matrixSource = readWorkspaceFile('scripts/run-test-matrix.cjs');
    const vitestConfigSource = readWorkspaceFile('vitest.config.mts');

    expect(vitestConfigSource).toContain('process.env.VITEST_CACHE_DIR');
    expect(matrixSource).toContain('VITEST_CACHE_DIR');
    expect(matrixSource).toContain('buildVitestCacheDir');
    expect(matrixSource).toContain('fs.rmSync(vitestCacheDir, { recursive: true, force: true })');
  });

  it('keeps heavy node-lane specs isolated from shared transform and prototype pollution', () => {
    const matrixSource = readWorkspaceFile('scripts/run-test-matrix.cjs');
    const nodeMinimalConfig = matrixSource.match(
      /\[LANE_NAMES\.nodeMinimal\]:\s*\{[\s\S]*?forceIsolateFiles:\s*\[([\s\S]*?)\]/,
    )?.[1] ?? '';

    expect(nodeMinimalConfig).toContain("'src/app/core/shell/workspace-shell-sidebar-resize-delegation.spec.ts'");
    expect(nodeMinimalConfig).toContain("'src/app/core/shell/workspace-shell-startup-entry-intent.factory.spec.ts'");
    expect(nodeMinimalConfig).toContain("'src/workspace-shell.component.spec.ts'");
  });

  it('automatically isolates specs that reset the shared module registry', () => {
    const matrixSource = readWorkspaceFile('scripts/run-test-matrix.cjs');

    expect(matrixSource).toContain('moduleRegistryMutationPattern');
    expect(matrixSource).toContain('requiresModuleRegistryIsolation(file)');
    expect(matrixSource).toMatch(
      /forcedIsolateSet\.has\(file\)\s*\|\|\s*requiresModuleRegistryIsolation\(file\)/,
    );
  });

  it('runs CodeGraph overlay specs as an exclusive segment outside other lanes', () => {
    const matrixSource = readWorkspaceFile('scripts/run-test-matrix.cjs');
    const nodeMinimalConfig = matrixSource.match(
      /\[LANE_NAMES\.nodeMinimal\]:\s*\{[\s\S]*?exclusiveFiles:\s*\[([\s\S]*?)\]/,
    )?.[1] ?? '';

    expect(nodeMinimalConfig).toContain("'src/tests/scripts/codegraph-nanoflow-overlay.spec.ts'");
    expect(nodeMinimalConfig).toContain(
      "'src/tests/scripts/codegraph-nanoflow-overlay-source-boundaries.spec.ts'",
    );
    expect(matrixSource).toContain("segmentName: 'exclusive'");
    expect(matrixSource).toContain('exclusiveActive');
  });

  it('keeps specs that use TestBed through helpers in the TestBed service lane', () => {
    const matrixSource = readWorkspaceFile('scripts/run-test-matrix.cjs');

    expect(matrixSource).toContain("'src/services/dock-cloud-sync.service.spec.ts'");
    expect(matrixSource).toContain('LANE_NAMES.testbedService');
  });

  it('classifies specs that instantiate browser event constructors into a DOM lane', () => {
    const matrixSource = readWorkspaceFile('scripts/run-test-matrix.cjs');
    const domPattern = matrixSource.match(/const domPattern = \/([^\n]+)\//)?.[1] ?? '';

    expect(domPattern).toContain('MouseEvent');
    expect(domPattern).toContain('PointerEvent');
  });

  it('keeps stateful DockCloudSync TestBed specs out of the shared service segment', () => {
    const matrixSource = readWorkspaceFile('scripts/run-test-matrix.cjs');
    const testbedServiceConfig = matrixSource.match(
      /\[LANE_NAMES\.testbedService\]:\s*\{[\s\S]*?forceIsolateFiles:\s*\[([\s\S]*?)\]/,
    )?.[1] ?? '';

    expect(testbedServiceConfig).toContain("'src/services/dock-cloud-sync.service.spec.ts'");
  });

  it('keeps high-state DockEngine TestBed specs out of the shared service segment', () => {
    const matrixSource = readWorkspaceFile('scripts/run-test-matrix.cjs');
    const testbedServiceConfig = matrixSource.match(
      /\[LANE_NAMES\.testbedService\]:\s*\{[\s\S]*?forceIsolateFiles:\s*\[([\s\S]*?)\]/,
    )?.[1] ?? '';

    expect(testbedServiceConfig).toContain("'src/services/dock-engine.service.spec.ts'");
  });

  it('keeps touch-listener service specs out of the shared service segment', () => {
    const matrixSource = readWorkspaceFile('scripts/run-test-matrix.cjs');
    const testbedServiceConfig = matrixSource.match(
      /\[LANE_NAMES\.testbedService\]:\s*\{[\s\S]*?forceIsolateFiles:\s*\[([\s\S]*?)\]/,
    )?.[1] ?? '';

    expect(testbedServiceConfig).toContain("'src/app/features/flow/services/flow-touch.service.spec.ts'");
  });

  it('keeps snapshot persistence TestBed specs out of the shared service segment', () => {
    const matrixSource = readWorkspaceFile('scripts/run-test-matrix.cjs');
    const testbedServiceConfig = matrixSource.match(
      /\[LANE_NAMES\.testbedService\]:\s*\{[\s\S]*?forceIsolateFiles:\s*\[([\s\S]*?)\]/,
    )?.[1] ?? '';

    expect(testbedServiceConfig).toContain("'src/services/dock-snapshot-persistence.service.spec.ts'");
  });

  it('keeps high-state TaskSyncOperations TestBed specs out of the shared service segment', () => {
    const matrixSource = readWorkspaceFile('scripts/run-test-matrix.cjs');
    const testbedServiceConfig = matrixSource.match(
      /\[LANE_NAMES\.testbedService\]:\s*\{[\s\S]*?forceIsolateFiles:\s*\[([\s\S]*?)\]/,
    )?.[1] ?? '';

    expect(testbedServiceConfig).toContain("'src/app/core/services/sync/task-sync-operations.service.spec.ts'");
  });
});


describe('run-test-matrix executable classification', () => {
  const require = createRequire(import.meta.url);
  const matrix = require(path.join(process.cwd(), 'scripts/run-test-matrix.cjs')) as {
    classifyAllFiles(files: string[], overrides: Record<string, string>, root?: string): Map<string, string>;
  };
  it('traces indirect helper TestBed use instead of assigning the IndexedDB adapter to node', () => {
    const file = 'src/services/data-safety-indexeddb-adapter.spec.ts';
    expect(readWorkspaceFile(file)).not.toMatch(/\bTestBed\b/);
    expect(matrix.classifyAllFiles([file], {}).get(file)).toBe('lane_testbed_service');
  });
});


describe('run-test-matrix runtime helper import closure', () => {
  const roots: string[] = [];
  const require = createRequire(import.meta.url);
  const matrix = require(path.join(process.cwd(), 'scripts/run-test-matrix.cjs')) as {
    classifyAllFiles(files: string[], overrides: Record<string, string>, root: string): Map<string, string>;
  };
  afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
  function fixture(files: Record<string, string>): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-matrix-helper-classification-'));
    roots.push(root);
    for (const [file, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), content);
    }
    return root;
  }
  it('traces multi-hop runtime imports and re-exports with cycles', () => {
    const root = fixture({
      'entry.spec.ts': "import { register } from './bridge'; register();",
      'bridge.ts': "export { register } from './helpers';",
      'helpers.ts': "import './bridge'; import { TestBed as Bed } from '@angular/core/testing'; export function register() { Bed.configureTestingModule({}); }",
    });
    expect(matrix.classifyAllFiles(['entry.spec.ts'], {}, root).get('entry.spec.ts')).toBe('lane_testbed_service');
  });
  it.each(["import type { Fixture } from './helpers';", "import { type Fixture } from './helpers';", "export type { Fixture } from './helpers';", "export { type Fixture } from './helpers';"])(
    'keeps type-only declarations and comment/string import decoys from adding dependencies: %s', declaration => {
    const root = fixture({
      'entry.spec.ts': declaration + " // import './helpers';\nconst text = \"import './helpers';\";",
      'helpers.ts': "import { TestBed } from '@angular/core/testing'; export type Fixture = typeof TestBed;",
    });
    expect(matrix.classifyAllFiles(['entry.spec.ts'], {}, root).get('entry.spec.ts')).toBe('lane_node_minimal');
  });
  it('honors explicit existing lane overrides and propagates component helper evidence', () => {
    const root = fixture({
      'entry.spec.ts': "import('./helpers');",
      'helpers.ts': "import { TestBed } from '@angular/core/testing'; TestBed.createComponent(View);",
    });
    expect(matrix.classifyAllFiles(['entry.spec.ts'], {}, root).get('entry.spec.ts')).toBe('lane_testbed_component');
    expect(matrix.classifyAllFiles(['entry.spec.ts'], { 'entry.spec.ts': 'lane_browser_minimal' }, root).get('entry.spec.ts')).toBe('lane_browser_minimal');
  });
});
