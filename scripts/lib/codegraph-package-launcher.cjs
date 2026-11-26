'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Execute the official pinned npm shim with argv, avoiding cmd.exe/npx.cmd
// double quoting of Windows worktree paths. Never load code from an arbitrary
// cache entry: package name/version and the declared executable must match.
function resolveCodegraphPackageLaunch(target, args, options = {}) {
  const match = /^@colbymchenry\/codegraph@([0-9]+\.[0-9]+\.[0-9]+)$/.exec(target);
  if (!match) return null;
  const env = options.env || process.env;
  const roots = [path.join(options.root || process.cwd(), 'node_modules')];
  const cache = env.npm_config_cache || env.NANOFLOW_CODEGRAPH_NPM_CACHE;
  if (cache) {
    try {
      for (const entry of fs.readdirSync(path.join(cache, '_npx'))) {
        roots.push(path.join(cache, '_npx', entry, 'node_modules'));
      }
    } catch { /* npm cache can be absent on the first run. */ }
  }
  for (const root of roots) {
    try {
      const packageRoot = path.join(root, '@colbymchenry', 'codegraph');
      const metadata = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
      if (metadata.name !== '@colbymchenry/codegraph' || metadata.version !== match[1]) continue;
      const bin = typeof metadata.bin === 'string' ? metadata.bin : metadata.bin?.codegraph;
      if (typeof bin !== 'string') continue;
      const entry = path.resolve(packageRoot, bin);
      const relative = path.relative(packageRoot, entry);
      if (relative.startsWith('..') || path.isAbsolute(relative) || !fs.statSync(entry).isFile()) continue;
      return { command: process.execPath, args: [entry, ...args], mode: 'pinned-npm-shim' };
    } catch { /* Continue to another independently verified cache entry. */ }
  }
  return null;
}
function resolveNpmCli(npmCliPath = null) {
  const candidates = npmCliPath ? [npmCliPath] : [
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.resolve(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  return candidates.find(entry => fs.existsSync(entry)) ?? null;
}
function resolveNpmExecLaunch(target, args, npmCliPath = null) {
  const npmCli = resolveNpmCli(npmCliPath);
  const candidates = npmCli ? [npmCli] : [];
  for (const entry of candidates) {
    if (fs.existsSync(entry)) return {
      command: process.execPath,
      args: [entry, 'exec', '--yes', '--package=' + target, '--', 'codegraph', ...args],
      mode: 'npm-cli-argv',
    };
  }
  return null;
}
module.exports = Object.freeze({ resolveCodegraphPackageLaunch, resolveNpmCli, resolveNpmExecLaunch });
