'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { withSetupLock } = require('./lib/codegraph-worktree-setup-lock.cjs');
const { resolveNpmCache } = require('./codegraph-worktree-bootstrap.cjs');

function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}
function hash(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }function runtimeClosureDigest(root) {
  const { REQUIRED_RUNTIME_CLOSURE } = require(path.join(root, 'scripts', 'codegraph-worktree-bootstrap.cjs'));
  const entries = REQUIRED_RUNTIME_CLOSURE.map(relativePath => {
    const filePath = path.join(root, relativePath);
    if (!fs.existsSync(filePath)) throw new Error('codegraph-setup-runtime-closure-missing: ' + relativePath);
    return `${relativePath}:${hash(fs.readFileSync(filePath))}`;
  });
  return hash(Buffer.from(entries.join('\n')));
}
function ensureTargetDependencies(root) {
  const dependencyPath = path.join(root, 'node_modules');
  if (!fs.existsSync(dependencyPath)) {
    const npmCli = require('./lib/codegraph-package-launcher.cjs').resolveNpmCli();
    if (!npmCli) throw new Error('codegraph-setup-npm-cli-missing');
    const install = spawnSync(process.execPath, [npmCli, 'ci', '--no-audit', '--no-fund'], {
      cwd: root, encoding: 'utf8', windowsHide: true, timeout: 20 * 60 * 1000, maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, npm_config_cache: resolveNpmCache(process.env, process.platform, require('node:os').homedir()) },
    });
    if (install.status !== 0) throw new Error('codegraph-setup-npm-ci-failed: ' + String(install.stderr || install.stdout || install.error?.message));
  }
  const dependencyReal = fs.realpathSync(dependencyPath);
  if (!isInside(root, dependencyReal)) throw new Error('codegraph-setup-node-modules-outside-worktree');
  const ts = require.resolve('typescript/package.json', { paths: [root] });
  const tsReal = fs.realpathSync(ts);
  if (!isInside(dependencyReal, tsReal)) throw new Error('codegraph-setup-typescript-resolution-escaped-worktree');
  return { path: dependencyReal, typescriptPath: tsReal };
}

function rootFromArgs(argv, fallback = process.cwd()) {
  const index = argv.indexOf('--root');
  if (index < 0) return fallback;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error('codegraph-setup-root-argument-missing');
  return value;
}
function prepareWorktree(root = process.cwd(), options = {}) {
  root = path.resolve(root);
  if (!fs.existsSync(root)) return { status: 'PENDING_WORKTREE_ROOT', root };
  const git = (options.spawnSync || spawnSync)('git', ['-C', root, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', windowsHide: true });
  if (git.status !== 0) throw new Error('codegraph-setup-not-a-git-worktree');
  const commonDirectory = path.resolve(git.stdout.trim());
  if (!fs.statSync(commonDirectory).isDirectory()) throw new Error('codegraph-setup-git-common-dir-invalid');
  const dotGit = path.join(root, '.git');
  if (fs.existsSync(dotGit) && fs.statSync(dotGit).isDirectory()
    && path.resolve(dotGit).toLowerCase() === commonDirectory.toLowerCase()) {
    return { status: 'MAIN_ROOT_UNCHANGED', root };
  }
  // --git-common-dir resolves to the main checkout's .git directory for both
  // slash styles and linked worktrees, avoiding Windows separator assumptions.
  const sourceRoot = path.dirname(commonDirectory);
  fs.mkdirSync(path.join(root, '.codegraph'), { recursive: true });

  return withSetupLock(root, () => {
    const lockBytes = fs.readFileSync(path.join(root, 'package-lock.json'));
    const markerPath = path.join(root, '.codegraph', 'worktree-runtime.json');
    const currentPath = path.join(root, '.codegraph', 'nanoflow-generations', 'CURRENT.json');
    const dependenciesRoot = fs.existsSync(path.join(root, 'node_modules')) ? fs.realpathSync(path.join(root, 'node_modules')) : null;
    const runtimeClosureSha256 = runtimeClosureDigest(root);
    if (fs.existsSync(markerPath) && fs.existsSync(currentPath) && dependenciesRoot) {
      try {
        const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
        const currentBytes = fs.readFileSync(currentPath);
        const current = require('./lib/codegraph-overlay-current-receipt.cjs').readOverlayCurrentReceipt(root);
        if (marker.schemaVersion === 1 && path.resolve(marker.root).toLowerCase() === root.toLowerCase()
          && marker.packageLockSha256 === hash(lockBytes) && marker.runtimeClosureSha256 === runtimeClosureSha256
          && marker.dependenciesRoot === dependenciesRoot
          && fs.existsSync(path.join(root, '.codegraph', 'codegraph.db'))
          && marker.currentSha256 === hash(currentBytes) && current.ok
          && fs.existsSync(path.join(root, '.codegraph', 'codegraph.db'))) {
          return { status: 'READY', root, current: currentPath, generationId: current.current.generationId, reused: true };
        }
      } catch { /* Continue through the canonical bootstrap path. */ }
    }

    const dependencies = ensureTargetDependencies(root);
    const bootstrap = path.join(root, 'scripts', 'codegraph-worktree-bootstrap.cjs');
    if (!fs.existsSync(bootstrap)) throw new Error('codegraph-setup-bootstrap-missing');
    const result = (options.spawnSync || spawnSync)(process.execPath, [bootstrap, '--root', root, '--source-root', sourceRoot, '--require-ready', '--json'], {
      cwd: root, encoding: 'utf8', windowsHide: true, timeout: 25 * 60 * 1000, maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, NANOFLOW_CODEGRAPH_WORKTREE_SETUP_LOCK_ROOT: root, npm_config_cache: resolveNpmCache(process.env, process.platform, require('node:os').homedir()) },
    });
    if (result.status !== 0) throw new Error('codegraph-worktree-setup-incomplete: ' + String(result.stderr || result.stdout || result.error?.message));
    const report = JSON.parse(result.stdout);
    const current = require('./lib/codegraph-overlay-current-receipt.cjs').readOverlayCurrentReceipt(root);
    if (!current.ok) throw new Error('codegraph-worktree-setup-current-invalid: ' + current.errorCode);
    const marker = { schemaVersion: 1, root, packageLockSha256: hash(lockBytes), runtimeClosureSha256, dependenciesRoot: dependencies.path, currentSha256: hash(fs.readFileSync(currentPath)), generationId: current.current.generationId, publishedAt: new Date().toISOString() };
    fs.writeFileSync(markerPath, JSON.stringify(marker));
    return { ...report, status: 'READY', currentAfter: { status: 'ready', path: currentPath, generationId: current.current.generationId, sequence: current.current.sequence }, reused: false };
  }, options.lockOptions);
}

if (require.main === module) {
  const bestEffort = process.argv.includes('--best-effort');
  try { process.stdout.write(JSON.stringify(prepareWorktree(rootFromArgs(process.argv.slice(2))), null, 2) + '\n'); }
  catch (error) {
    process.stderr.write(`[codegraph-worktree-setup] ${String(error.message)}\n`);
    if (!bestEffort) process.exitCode = 78;
  }
}
module.exports = Object.freeze({ prepareWorktree, ensureTargetDependencies, rootFromArgs });
