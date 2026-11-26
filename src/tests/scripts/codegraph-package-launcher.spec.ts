import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
const { resolveCodegraphPackageLaunch, resolveNpmExecLaunch } = require('../../../scripts/lib/codegraph-package-launcher.cjs');
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
it('keeps Windows worktree argv literal and rejects mismatched cached versions', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph launcher ')); roots.push(root);
  const pkg = path.join(root, 'cache', '_npx', 'fixture', 'node_modules', '@colbymchenry', 'codegraph');
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'npm-shim.js'), '');
  const metadata = { name: '@colbymchenry/codegraph', version: '1.6.2', bin: { codegraph: 'npm-shim.js' } };
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify(metadata));
  const args = ['serve', '--mcp', '--path', 'D:/Code/work tree & literal'];
  const options = { root, env: { npm_config_cache: path.join(root, 'cache') } };
  const launch = resolveCodegraphPackageLaunch('@colbymchenry/codegraph@1.6.2', args, options);
  expect(launch.command).toBe(process.execPath);
  expect(launch.args.slice(1)).toEqual(args);
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ ...metadata, version: '1.6.1' }));
  expect(resolveCodegraphPackageLaunch('@colbymchenry/codegraph@1.6.2', args, options)).toBeNull();
});

it('returns unavailable rather than constructing a shell command when npm cli is missing', () => {
  const { resolveNpmCli } = require('../../../scripts/lib/codegraph-package-launcher.cjs') as { resolveNpmCli(path?: string): string | null };
  expect(resolveNpmCli(path.join(os.tmpdir(), 'missing-npm-cli.js'))).toBeNull();
});

it('provides a shell-free npm exec launcher when the pinned shim is not cached', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph npm exec ')); roots.push(root);
  const npmCli = path.join(root, 'npm-cli.js'); fs.writeFileSync(npmCli, '');
  const launch = resolveNpmExecLaunch('@colbymchenry/codegraph@1.6.2', ['init', '--yes', 'D:/Code/a b'], npmCli);
  expect(launch.command).toBe(process.execPath);
  expect(launch.args).toEqual([npmCli, 'exec', '--yes', '--package=@colbymchenry/codegraph@1.6.2', '--', 'codegraph', 'init', '--yes', 'D:/Code/a b']);
});
