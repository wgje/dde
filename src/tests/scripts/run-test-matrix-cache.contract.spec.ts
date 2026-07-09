import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

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
