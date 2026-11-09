import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { expect, it } from 'vitest';

import type { CodegraphOverlaySpecContext } from './codegraph-nanoflow-overlay.spec-context';

export function registerCodegraphOverlayMcpRefreshSpecs(context: CodegraphOverlaySpecContext): void {
  const {
    repoRoot,
    scriptPath,
    wrapperScriptPath,
    tempRoots,
    writeFile,
    makeFakeCodegraph,
    waitForLogEvent,
    parseJsonLines,
  } = context;

  it('delegates immutable generation and CURRENT publication to the atomic publisher', () => {
    const generatorSource = fs.readFileSync(scriptPath, 'utf8');
    const publisherSource = fs.readFileSync(
      path.join(repoRoot, 'scripts', 'lib', 'codegraph-overlay-generation-publisher.cjs'),
      'utf8',
    );

    expect(generatorSource).toContain("import overlayGenerationPublisher from './lib/codegraph-overlay-generation-publisher.cjs';");
    expect(generatorSource).toContain('createOverlayGenerationPublisher');
    expect(generatorSource).toContain('publisher.publish({');
    expect(publisherSource).toContain('function writeFsynced');
    expect(publisherSource).toContain('fs.fsyncSync');
    expect(publisherSource).toContain('fs.renameSync(preparingDirectory, finalDirectory)');
    expect(publisherSource).toContain('const currentTempPath =');
    expect(publisherSource).toContain('fs.renameSync(currentTempPath, currentPath)');
    expect(publisherSource).toContain('codegraph-overlay-publication-current-readback-drift');
  });

  it('skips background overlay refresh when another wrapper owns the refresh lock', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-refresh-lock-'));
    tempRoots.push(projectRoot);
    fs.mkdirSync(path.join(projectRoot, '.codegraph'), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, 'scripts'), { recursive: true });
    const lockHolder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    fs.writeFileSync(
      path.join(projectRoot, '.codegraph', 'nanoflow-overlay-refresh.lock'),
      JSON.stringify({ pid: lockHolder.pid, startedAt: new Date().toISOString() }),
    );
    writeFile(
      projectRoot,
      'scripts/generate-codegraph-nanoflow-overlay.mjs',
      [
        '#!/usr/bin/env node',
        'process.stderr.write("refresh should not run");',
        'process.exit(1);',
        '',
      ].join('\n'),
    );

    const fakeCodegraph = makeFakeCodegraph();
    const logPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-log-')), 'wrapper.log');
    tempRoots.push(path.dirname(logPath));
    const child = spawn(
      process.execPath,
      [wrapperScriptPath, fakeCodegraph, 'serve', '--mcp', '--path', projectRoot],
      {
        cwd: repoRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          NANOFLOW_CODEGRAPH_MCP_LOG: logPath,
          NANOFLOW_CODEGRAPH_REFRESH_ON_STARTUP: '1',
        },
      },
    );

    try {
      const skipEvent = await waitForLogEvent(
        logPath,
        'overlay.refresh.skip',
        2_000,
        (entry) => entry.reason === 'lock-held',
      );
      expect(skipEvent).toEqual(expect.objectContaining({
        reason: 'lock-held',
      }));
      expect(parseJsonLines(logPath)).not.toContainEqual(expect.objectContaining({
        event: 'overlay.refresh.error',
      }));
    } finally {
      child.kill();
      lockHolder.kill();
    }
  }, 8_000);

  it('does not run a background overlay refresh on wrapper startup by default', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-refresh-default-'));
    tempRoots.push(projectRoot);
    fs.mkdirSync(path.join(projectRoot, 'scripts'), { recursive: true });
    writeFile(
      projectRoot,
      'scripts/generate-codegraph-nanoflow-overlay.mjs',
      [
        '#!/usr/bin/env node',
        'process.stderr.write("refresh should not run by default");',
        'process.exit(1);',
        '',
      ].join('\n'),
    );

    const fakeCodegraph = makeFakeCodegraph();
    const logPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-log-')), 'wrapper.log');
    tempRoots.push(path.dirname(logPath));
    const child = spawn(
      process.execPath,
      [wrapperScriptPath, fakeCodegraph, 'serve', '--mcp', '--path', projectRoot],
      {
        cwd: repoRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          NANOFLOW_CODEGRAPH_MCP_LOG: logPath,
        },
      },
    );

    try {
      const skipEvent = await waitForLogEvent(logPath, 'overlay.refresh.skip', 2_000);
      expect(skipEvent).toEqual(expect.objectContaining({
        reason: 'disabled-by-default',
      }));
      expect(parseJsonLines(logPath)).not.toContainEqual(expect.objectContaining({
        event: 'overlay.refresh.start',
      }));
      expect(parseJsonLines(logPath)).not.toContainEqual(expect.objectContaining({
        event: 'overlay.refresh.error',
      }));
    } finally {
      child.kill();
    }
  }, 8_000);

  it('ignores stale refresh locks whose owner process is no longer alive', () => {
    const wrapperSource = fs.readFileSync(wrapperScriptPath, 'utf8');

    expect(wrapperSource).toContain('isProcessAlive');
    expect(wrapperSource).toContain("reason: 'stale-lock'");
    expect(wrapperSource).toContain("process.on('exit'");
  });
}
